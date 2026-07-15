import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export const BROWSER_AI_PROVIDER_ID = "browser-webai";
export const BROWSER_AI_PROVIDER_NAME = "浏览器本地模式";

export type BrowserAiModel = {
  id: string;
  type: "text" | "image";
  ownedBy: string;
};

type FlowStatusPayload = {
  ok: boolean;
  error?: string;
  runtime?: {
    status: string;
    message: string;
  };
  models?: Array<{
    id: string;
    type?: string;
    owned_by?: string;
  }>;
};

type BrowserGeneratePayload = {
  ok: boolean;
  error?: string;
  result?: {
    text?: string;
    image?: string;
  };
};

const defaultModels: BrowserAiModel[] = [
  { id: "gpt-instant", type: "text", ownedBy: "chatgpt_text" },
  { id: "gpt-thinking", type: "text", ownedBy: "chatgpt_text" },
  { id: "gpt-pro", type: "text", ownedBy: "chatgpt_text" },
  { id: "gpt-image-1.5", type: "image", ownedBy: "chatgpt" },
  { id: "doubao-web", type: "text", ownedBy: "doubao_web" },
  { id: "doubao-image-web", type: "image", ownedBy: "doubao_web" },
];

let serviceStartPromise: Promise<void> | null = null;
let doubaoServiceStartPromise: Promise<void> | null = null;

function browserAiBaseUrl() {
  return (process.env.BROWSER_AI_BASE_URL || "http://127.0.0.1:3101").replace(/\/+$/, "");
}

function browserAiProjectRoot() {
  return process.env.BROWSER_AI_PROJECT_ROOT || path.resolve(process.cwd(), "../../ai");
}

function doubaoWebBaseUrl() {
  return (process.env.DOUBAO_WEB_SERVICE_URL || "http://127.0.0.1:8010").replace(/\/+$/, "");
}

function imageWorkshopRoot() {
  return process.env.IMAGE_WORKSHOP_ROOT || path.resolve(process.cwd(), "../image-workshop");
}

function browserAiServiceLogFds() {
  const logDir = path.resolve(process.cwd(), "storage", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "browser-ai-service.log");
  const fd = fs.openSync(logPath, "a");
  return { stdout: fd, stderr: fd, path: logPath };
}

function doubaoServiceLogFds() {
  const logDir = path.resolve(process.cwd(), "storage", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "doubao-web-service.log");
  const fd = fs.openSync(logPath, "a");
  return { stdout: fd, stderr: fd, path: logPath };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(pathname: string, init?: RequestInit, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${browserAiBaseUrl()}${pathname}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json()) as T & { ok?: boolean; error?: string };
    if (!response.ok || payload.ok === false) {
      throw new Error(sanitizeBrowserAiError(payload.error || `浏览器模型服务请求失败：${response.status}`));
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeBrowserAiError(message: string) {
  return String(message || "")
    .replace(/cookie:\s*[^\n\r]+/gi, "cookie: [redacted]")
    .replace(/authorization:\s*[^\n\r]+/gi, "authorization: [redacted]")
    .replace(/__Secure-next-auth\.[^;\s]+/g, "[redacted-session-token]")
    .replace(/session-token[^;\s]*/gi, "session-token=[redacted]")
    .slice(0, 1200);
}

async function serviceIsReachable() {
  try {
    await fetchJson<FlowStatusPayload>("/api/status", undefined, 1200);
    return true;
  } catch {
    return false;
  }
}

async function doubaoServiceIsReachable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${doubaoWebBaseUrl()}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureDoubaoWebService() {
  if (await doubaoServiceIsReachable()) return;
  if (doubaoServiceStartPromise) return doubaoServiceStartPromise;

  doubaoServiceStartPromise = (async () => {
    const baseUrl = new URL(doubaoWebBaseUrl());
    const isLocalDefault =
      (baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost") &&
      baseUrl.port === "8010";
    if (!isLocalDefault) {
      throw new Error(`豆包网页桥接服务未连接：${doubaoWebBaseUrl()}`);
    }

    const projectRoot = imageWorkshopRoot();
    const appEntry = path.join(projectRoot, "backend", "app.py");
    if (!fs.existsSync(appEntry)) {
      throw new Error(`未找到豆包网页桥接模块：${appEntry}`);
    }

    const logs = doubaoServiceLogFds();
    const pythonBinary =
      process.env.IMAGE_WORKSHOP_PYTHON ||
      process.env.PYTHON_BINARY ||
      (process.platform === "win32" ? "python" : "python3");
    const child = spawn(
      pythonBinary,
      ["-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8010"],
      {
        cwd: projectRoot,
        detached: true,
        env: {
          ...process.env,
          CHROME_DEVTOOLS_BASE: process.env.CHROME_DEVTOOLS_BASE || "http://127.0.0.1:9222",
        },
        stdio: ["ignore", logs.stdout, logs.stderr],
      },
    );
    child.unref();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await doubaoServiceIsReachable()) return;
      await sleep(400);
    }
    throw new Error(`豆包网页桥接服务启动超时，请查看日志：${logs.path}`);
  })();

  try {
    await doubaoServiceStartPromise;
  } finally {
    doubaoServiceStartPromise = null;
  }
}

async function ensureBrowserAiService() {
  if (await serviceIsReachable()) return;
  if (serviceStartPromise) return serviceStartPromise;

  serviceStartPromise = (async () => {
    const baseUrl = new URL(browserAiBaseUrl());
    const isLocalDefault =
      (baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost") &&
      baseUrl.port === "3101";
    if (!isLocalDefault) {
      throw new Error(`无法连接浏览器模型服务：${browserAiBaseUrl()}`);
    }

    const projectRoot = browserAiProjectRoot();
    const serverEntry = path.resolve(process.cwd(), "scripts/browser-ai-service.mjs");
    if (!fs.existsSync(serverEntry)) {
      throw new Error(`未找到 3000 项目的浏览器模型运行服务：${serverEntry}`);
    }

    const logs = browserAiServiceLogFds();
    const child = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        BROWSER_AI_CORE_ROOT: projectRoot,
        BROWSER_AI_SERVICE_HOST: "127.0.0.1",
        BROWSER_AI_SERVICE_PORT: "3101",
        DOUBAO_WEB_SERVICE_URL: doubaoWebBaseUrl(),
      },
      stdio: ["ignore", logs.stdout, logs.stderr],
    });
    child.unref();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await serviceIsReachable()) return;
      await sleep(400);
    }
    throw new Error("浏览器模型服务启动超时，请检查 WebAI2API 依赖。");
  })();

  try {
    await serviceStartPromise;
  } finally {
    serviceStartPromise = null;
  }
}

function normalizeModels(models: FlowStatusPayload["models"]) {
  if (!models?.length) return defaultModels;

  const preferred = models.filter((model) => !model.id.includes("/"));
  const source = preferred.length ? preferred : models;
  const seen = new Set<string>();
  return source.flatMap<BrowserAiModel>((model) => {
    if (!model.id || seen.has(model.id)) return [];
    seen.add(model.id);
    return [{
      id: model.id,
      type: model.type === "image" ? "image" : "text",
      ownedBy: model.owned_by || "browser",
    }];
  });
}

export function isBrowserAiProvider(providerId?: string | null) {
  return providerId === BROWSER_AI_PROVIDER_ID;
}

export async function getBrowserAiModels() {
  let doubaoServiceReady = false;
  try {
    await ensureDoubaoWebService();
    doubaoServiceReady = await doubaoServiceIsReachable();
  } catch {
    doubaoServiceReady = false;
  }
  await ensureBrowserAiService();
  const status = await fetchJson<FlowStatusPayload>("/api/status");
  return {
    runtimeStatus: status.runtime?.status || "idle",
    runtimeMessage: status.runtime?.message || "浏览器核心尚未启动",
    doubaoServiceReady,
    models: normalizeModels(status.models),
  };
}

async function runBrowserModel(input: {
  model: string;
  prompt: string;
  images?: string[];
}) {
  if (input.model === "doubao-web" || input.model === "doubao-image-web") {
    await ensureDoubaoWebService();
  }
  await ensureBrowserAiService();
  const generated = await fetchJson<BrowserGeneratePayload>(
    "/api/generate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: input.model,
        prompt: input.prompt,
        images: input.images ?? [],
      }),
    },
    5 * 60_000,
  );
  return generated.result ?? {};
}

export async function generateBrowserText(input: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const result = await runBrowserModel({
    model: input.model,
    prompt: `${input.systemPrompt}\n\n${input.userPrompt}`,
  });
  if (!result.text?.trim()) {
    throw new Error("浏览器文本模型没有返回有效内容。");
  }
  return result.text.trim();
}

export async function generateBrowserImage(input: {
  model: string;
  prompt: string;
  aspectRatio: string;
  referenceImages: string[];
}) {
  const result = await runBrowserModel({
    model: input.model,
    prompt: `${input.prompt}\n\n画幅比例：${input.aspectRatio}`,
    images: input.referenceImages,
  });
  if (!result.image?.trim()) {
    throw new Error("浏览器图片模型没有返回有效图片。");
  }

  const image = result.image.trim();
  const commaIndex = image.indexOf(",");
  const dataUrlHeader = commaIndex >= 0 ? image.slice(0, commaIndex) : "";
  const dataUrlBase64 = commaIndex >= 0 ? image.slice(commaIndex + 1) : "";
  const dataUrlMimeType =
    dataUrlHeader.startsWith("data:") && dataUrlHeader.endsWith(";base64")
      ? dataUrlHeader.slice(5, -7)
      : "";
  if (dataUrlMimeType.startsWith("image/") && dataUrlBase64) {
    return {
      b64Json: dataUrlBase64
        .replaceAll("\n", "")
        .replaceAll("\r", "")
        .replaceAll("\t", "")
        .replaceAll(" ", ""),
      mimeType: dataUrlMimeType,
      url: null,
    };
  }
  if (/^https?:\/\//i.test(image)) {
    return {
      b64Json: null,
      mimeType: null,
      url: image,
    };
  }
  return {
    b64Json: image.replace(/\s/g, ""),
    mimeType: "image/png",
    url: null,
  };
}
