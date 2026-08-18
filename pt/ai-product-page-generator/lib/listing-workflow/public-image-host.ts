import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const workflowPathPrefix = "api/files/generated/listing-workflow";

let githubTokenPromise: Promise<string> | null = null;
// ponytail: 单进程全局锁覆盖当前单仓库发布；多实例部署时升级为仓库级分布式锁。
let publishQueue: Promise<void> = Promise.resolve();

function githubToken() {
  if (!githubTokenPromise) {
    githubTokenPromise = execFileAsync("gh", ["auth", "token"], {
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    }).then(({ stdout }) => stdout.trim());
  }
  return githubTokenPromise;
}

function repositoryConfig() {
  const repository = process.env.LISTING_IMAGE_GITHUB_REPO?.trim();
  const branch = process.env.LISTING_IMAGE_GITHUB_BRANCH?.trim() || "main";
  if (!repository) throw new Error("缺少 LISTING_IMAGE_GITHUB_REPO");
  return { repository, branch };
}

function githubContentPath(fileName: string) {
  return [workflowPathPrefix, path.basename(fileName)]
    .flatMap((part) => part.split("/"))
    .map(encodeURIComponent)
    .join("/");
}

function jsDelivrUrl(repository: string, ref: string, contentPath: string) {
  return `https://cdn.jsdelivr.net/gh/${repository}@${ref}/${contentPath}`;
}

export function isLegacyTemporaryImageUrl(value: string) {
  return /(?:\.free\.pinggy\.net|trycloudflare\.com|localhost|127\.0\.0\.1)/i.test(value);
}

export function isPermanentWorkflowImageUrl(value: string) {
  const { repository } = repositoryConfig();
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:cdn\\.jsdelivr\\.net/gh/${escaped}@|raw\\.githubusercontent\\.com/${escaped}/)`,
    "i",
  ).test(value);
}

function existingContentPath(value: string) {
  const { repository } = repositoryConfig();
  const rawPrefix = `https://raw.githubusercontent.com/${repository}/`;
  if (value.startsWith(rawPrefix)) {
    const pathWithBranch = value.slice(rawPrefix.length).split("/");
    pathWithBranch.shift();
    return pathWithBranch.join("/");
  }
  const jsDelivrMarker = `/gh/${repository}@`;
  const markerIndex = value.indexOf(jsDelivrMarker);
  if (markerIndex >= 0) {
    const afterRepo = value.slice(markerIndex + jsDelivrMarker.length);
    return afterRepo.slice(afterRepo.indexOf("/") + 1);
  }
  return "";
}

async function waitForPublicImage(url: string) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1", "User-Agent": "banana-mall-image-check/1.0" },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    lastStatus = response?.status ?? 0;
    if (
      response?.ok &&
      String(response.headers.get("content-type") ?? "").startsWith("image/")
    ) {
      await response.body?.cancel();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(`固定图片地址尚未生效（HTTP ${lastStatus || "网络错误"}）`);
}

async function publishBytesUnlocked(fileName: string, bytes: Buffer) {
  const { repository, branch } = repositoryConfig();
  const token = await githubToken();
  if (!token) throw new Error("GitHub 登录令牌为空");
  const contentPath = githubContentPath(fileName);
  const endpoint = `https://api.github.com/repos/${repository}/contents/${contentPath}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const existing = await fetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (existing.ok) {
    const existingPayload = await existing.json().catch(() => null) as {
      download_url?: string;
    } | null;
    const publicUrl = jsDelivrUrl(repository, branch, contentPath);
    try {
      await waitForPublicImage(publicUrl);
      return publicUrl;
    } catch (error) {
      const rawUrl = existingPayload?.download_url?.trim();
      if (!rawUrl) throw error;
      await waitForPublicImage(rawUrl);
      return rawUrl;
    }
  }
  const response = await fetch(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `Publish workflow image ${fileName}`,
      content: bytes.toString("base64"),
      branch,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    message?: string;
    commit?: { sha?: string };
    content?: { download_url?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${payload?.message || "图片发布失败"}`);
  }
  const publicUrl = jsDelivrUrl(repository, payload?.commit?.sha || branch, contentPath);
  try {
    await waitForPublicImage(publicUrl);
    return publicUrl;
  } catch (error) {
    const rawUrl = payload?.content?.download_url?.trim();
    if (!rawUrl) throw error;
    await waitForPublicImage(rawUrl);
    return rawUrl;
  }
}

function publishBytes(fileName: string, bytes: Buffer) {
  const result = publishQueue.then(() => publishBytesUnlocked(fileName, bytes));
  publishQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function publishWorkflowImage(input: {
  absolutePath: string;
  fileName: string;
}) {
  try {
    const publicUrl = await publishBytes(
      path.basename(input.fileName),
      await fs.readFile(input.absolutePath),
    );
    return { publicUrl, warning: null };
  } catch (error) {
    return {
      publicUrl: null,
      warning: error instanceof Error
        ? `图片已保存在本地，GitHub/jsDelivr 发布失败：${error.message}`
        : "图片已保存在本地，GitHub/jsDelivr 发布失败。",
    };
  }
}

function extensionFromUrl(url: string, contentType: string) {
  const fromUrl = url.match(/\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i)?.[1];
  if (fromUrl) return fromUrl.toLowerCase().replace("jpeg", "jpg");
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  if (/gif/i.test(contentType)) return "gif";
  if (/avif/i.test(contentType)) return "avif";
  return "jpg";
}

export async function ensurePermanentWorkflowImageUrl(value: string) {
  const url = value.trim();
  if (!url) throw new Error("图片地址为空");
  if (/^https:\/\/[^/]*\.ozonstatic\.(?:cn|ru)\//i.test(url)) {
    await waitForPublicImage(url);
    return url;
  }
  const { repository, branch } = repositoryConfig();
  if (isPermanentWorkflowImageUrl(url)) {
    const contentPath = existingContentPath(url);
    const permanent = contentPath
      ? jsDelivrUrl(repository, branch, contentPath)
      : url;
    await waitForPublicImage(permanent);
    return permanent;
  }

  const localName = decodeURIComponent(
    url.match(/\/api\/files\/generated\/listing-workflow\/([^?#/]+)/i)?.[1] ?? "",
  );
  if (localName) {
    const absolutePath = path.join(
      process.cwd(),
      "storage",
      "generated",
      "listing-workflow",
      path.basename(localName),
    );
    const bytes = await fs.readFile(absolutePath).catch(() => null);
    if (bytes) return publishBytes(path.basename(localName), bytes);
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 banana-mall-image-mirror/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`来源图片下载失败：HTTP ${response.status}`);
  const contentType = String(response.headers.get("content-type") ?? "");
  if (!contentType.startsWith("image/")) throw new Error("来源地址没有返回图片");
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  const extension = extensionFromUrl(url, contentType);
  return publishBytes(`mirror-${digest}.${extension}`, bytes);
}

export async function ensurePermanentWorkflowImageUrls(values: string[]) {
  const output: string[] = [];
  for (const value of values) {
    const permanent = await ensurePermanentWorkflowImageUrl(value);
    if (!output.includes(permanent)) output.push(permanent);
  }
  return output;
}
