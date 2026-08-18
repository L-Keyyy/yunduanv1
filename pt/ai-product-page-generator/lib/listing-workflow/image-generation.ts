import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { nanoid } from "nanoid";

import {
  BROWSER_AI_PROVIDER_ID,
  BROWSER_AI_PROVIDER_NAME,
  generateBrowserImage,
  isBrowserAiProvider,
} from "@/lib/browser-ai/client";
import { extractFourPanelGrid } from "@/lib/listing-workflow/four-panel-grid";
import { publishWorkflowImage } from "@/lib/listing-workflow/public-image-host";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { env } from "@/lib/utils/env";
import { extFromMime, relativeStorageUrl, sanitizeFileName } from "@/lib/utils/files";

const execFileAsync = promisify(execFile);

export type ListingWorkflowImageInput = {
  providerId?: string;
  model: string;
  prompt: string;
  aspectRatio: "1:1" | "3:4" | "9:16";
  referenceImages?: string[];
  useReferenceImages?: boolean;
  splitGrid?: boolean;
};

export type ListingWorkflowGridImageResult = {
  index: number;
  label: string;
  fileName: string;
  filePath: string;
  imageUrl: string;
  mimeType: string;
  width: number;
  height: number;
};

export type ListingWorkflowImageResult = {
  fileName: string;
  filePath: string;
  imageUrl: string;
  mimeType: string;
  providerId: string;
  providerName: string;
  model: string;
  prompt: string;
  revisedPrompt: string | null;
  usedReferenceImageCount: number;
  warnings: string[];
  gridImages?: ListingWorkflowGridImageResult[];
  gridSource?: {
    fileName: string;
    filePath: string;
    width: number;
    height: number;
    detectionMode: "separator" | "geometric-fallback";
  } | null;
};

const FOUR_PANEL_PROMPT_SUFFIX = `

输出必须严格遵守以下版式：
1. 只生成一张 3:4 竖版图片，画面为严格 2×2 四宫格。
2. 四格等宽等高，上下两排的竖向分隔线完全对齐。
3. 中心保留清晰、连续的纯白十字分隔带，宽度一致，不得被图片、文字或装饰覆盖。
4. 每格都是可独立使用的 3:4 俄文商品图：左上为商品总览与核心卖点，右上为功能特写，左下为使用场景，右下为材质或细节特写。
5. 所有商品、俄文、图标和装饰必须完整留在各自格内，不得跨格，不得贴近分隔带。
6. 四格使用一致的视觉系统、圆角、安全边距和品牌配色，不出现中文、水印或额外边框。`;

function fourPanelPrompt(prompt: string) {
  return `${prompt.trim()}${FOUR_PANEL_PROMPT_SUFFIX}`;
}

function storageRoot() {
  return path.resolve(process.cwd(), env.STORAGE_ROOT);
}

function isDataUrl(value: string) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

function isDoubaoImageModel(model: string) {
  return /doubao|豆包|seedream/i.test(model);
}

function isImageQuotaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(额度|次数.*(?:用完|耗尽|上限)|今日.*上限|quota|insufficient.*credit|usage.*limit|rate.*limit)/i.test(
    message,
  );
}

function isTransientBrowserImageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(页面操作超时|页面可能未正常加载|secure connection failed|pr_end_of_file_error|ns_error_net_interrupt|network.*(?:error|interrupt)|connection.*(?:failed|reset))/i.test(
    message,
  );
}

async function generateBrowserImageWithRetry(
  input: Parameters<typeof generateBrowserImage>[0],
) {
  const maxAttempts = isDoubaoImageModel(input.model) ? 3 : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {
        result: await generateBrowserImage(input),
        retryCount: attempt - 1,
      };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isTransientBrowserImageError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

function pngDimensions(buffer: Buffer) {
  const pngSignature = "89504e470d0a1a0a";
  if (
    buffer.length < 24 ||
    buffer.subarray(0, 8).toString("hex") !== pngSignature
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function removeDoubaoVisibleMark(imagePath: string) {
  // 原图左上角通常是商品标题，固定坐标擦除会破坏主图内容。
  // 仅在明确启用且确认当前模型水印位置后执行。
  if (process.env.REMOVE_AI_WATERMARKS_ENABLED !== "1") {
    return { removed: false, warning: null };
  }
  const configuredTool = process.env.REMOVE_AI_WATERMARKS_BIN?.trim();
  const toolPath =
    configuredTool ||
    path.join(
      storageRoot(),
      "tools",
      "remove-ai-watermarks",
      "bin",
      "remove-ai-watermarks",
    );
  try {
    await fs.access(toolPath);
  } catch {
    return {
      removed: false,
      warning: "豆包图片已保存，但本地去水印工具尚未安装。",
    };
  }

  const bytes = await fs.readFile(imagePath);
  const dimensions = pngDimensions(bytes) ?? { width: 384, height: 384 };
  // 当前豆包网页图片的“AI生成”角标位于左上角。按比例扩一圈，避免残留描边。
  const region = [
    Math.max(1, Math.round(dimensions.width * 0.01)),
    Math.max(1, Math.round(dimensions.height * 0.01)),
    Math.max(24, Math.round(dimensions.width * 0.14)),
    Math.max(14, Math.round(dimensions.height * 0.06)),
  ].join(",");
  const extension = path.extname(imagePath) || ".png";
  const temporaryPath = `${imagePath}.watermark-clean${extension}`;
  try {
    await execFileAsync(
      toolPath,
      [
        "erase",
        imagePath,
        "-o",
        temporaryPath,
        "--region",
        region,
        "--backend",
        "cv2",
      ],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    await fs.rename(temporaryPath, imagePath);
    return { removed: true, warning: null };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    return {
      removed: false,
      warning:
        error instanceof Error
          ? `豆包角标处理失败：${error.message}`
          : "豆包角标处理失败。",
    };
  }
}

async function imageUrlToDataUrl(url: string, requestOrigin: string) {
  if (isDataUrl(url)) return url;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resolvedUrl = new URL(url, requestOrigin).toString();
    const response = await fetch(resolvedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`参考图下载失败：${response.status}`);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      throw new Error("参考图地址没有返回图片内容。");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function normalizeReferenceImages(
  referenceImages: string[],
  enabled: boolean,
  requestOrigin: string,
) {
  if (!enabled || referenceImages.length === 0) {
    return { images: [] as string[], warnings: [] as string[] };
  }

  const images: string[] = [];
  const warnings: string[] = [];
  for (const image of referenceImages.slice(0, 4)) {
    try {
      images.push(await imageUrlToDataUrl(image, requestOrigin));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "参考图下载失败。");
    }
  }

  return { images, warnings };
}

async function saveWorkflowImage(params: {
  model: string;
  prompt: string;
  source: { url?: string | null; b64Json?: string | null; mimeType?: string | null };
  publish?: boolean;
}) {
  const mimeType = params.source.mimeType ?? "image/png";
  const ext = extFromMime(mimeType);
  const fileName = `${Date.now()}-${nanoid(6)}-${sanitizeFileName(params.model)}.${ext}`;
  const relativePath = path.join("generated", "listing-workflow", fileName);
  const absolutePath = path.join(storageRoot(), relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  if (params.source.b64Json) {
    await fs.writeFile(absolutePath, Buffer.from(params.source.b64Json, "base64"));
  } else if (params.source.url) {
    const response = await fetch(params.source.url);
    if (!response.ok) {
      throw new Error(`生成图下载失败：${response.status}`);
    }
    await fs.writeFile(absolutePath, Buffer.from(await response.arrayBuffer()));
  } else {
    throw new Error("图片模型没有返回可用图片。");
  }

  const watermarkResult = isDoubaoImageModel(params.model)
    ? await removeDoubaoVisibleMark(absolutePath)
    : { removed: false, warning: null as string | null };
  const publicImage = params.publish === false
    ? { publicUrl: null, warning: null }
    : await publishWorkflowImage({ absolutePath, fileName });
  const metadataPath = `${relativePath}.json`;
  await fs.writeFile(
    path.join(storageRoot(), metadataPath),
    JSON.stringify(
      {
        model: params.model,
        prompt: params.prompt,
        mimeType,
        visibleWatermarkRemoved: watermarkResult.removed,
        publicImageUrl: publicImage.publicUrl,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fileName,
    filePath: relativePath.split(path.sep).join("/"),
    absolutePath,
    imageUrl: publicImage.publicUrl ?? relativeStorageUrl(relativePath),
    mimeType,
    warnings: [watermarkResult.warning, publicImage.warning].filter(
      (warning): warning is string => Boolean(warning),
    ),
  };
}

async function saveFourPanelImages(params: {
  sourcePath: string;
  sourceFileName: string;
  sourceFilePath: string;
  model: string;
  prompt: string;
}) {
  const extracted = await extractFourPanelGrid(params.sourcePath);
  const sourceAspectRatio = extracted.sourceWidth / Math.max(extracted.sourceHeight, 1);
  if (sourceAspectRatio < 0.62 || sourceAspectRatio > 0.88) {
    throw new Error(
      `生图结果不是要求的3:4四宫格（当前 ${extracted.sourceWidth}×${extracted.sourceHeight}），已丢弃并等待重试。`,
    );
  }
  const images: ListingWorkflowGridImageResult[] = [];
  const warnings = [...extracted.warnings];

  // GitHub Contents API 对同一分支并发提交可能冲突，四张图按顺序发布。
  for (const crop of extracted.crops) {
    const fileName = `${Date.now()}-${nanoid(6)}-${sanitizeFileName(params.model)}-grid-${crop.index + 1}.png`;
    const relativePath = path.join("generated", "listing-workflow", fileName);
    const absolutePath = path.join(storageRoot(), relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, crop.buffer);
    const publicImage = await publishWorkflowImage({ absolutePath, fileName });
    if (publicImage.warning) warnings.push(`四宫格${crop.label}：${publicImage.warning}`);
    await fs.writeFile(
      path.join(storageRoot(), `${relativePath}.json`),
      JSON.stringify(
        {
          model: params.model,
          prompt: params.prompt,
          mimeType: "image/png",
          sourceGridFileName: params.sourceFileName,
          sourceGridFilePath: params.sourceFilePath,
          gridIndex: crop.index,
          gridLabel: crop.label,
          crop: {
            left: crop.left,
            top: crop.top,
            width: crop.width,
            height: crop.height,
          },
          detectionMode: extracted.mode,
          publicImageUrl: publicImage.publicUrl,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    images.push({
      index: crop.index,
      label: crop.label,
      fileName,
      filePath: relativePath.split(path.sep).join("/"),
      imageUrl: publicImage.publicUrl ?? relativeStorageUrl(relativePath),
      mimeType: "image/png",
      width: crop.width,
      height: crop.height,
    });
  }

  return {
    images,
    warnings,
    sourceWidth: extracted.sourceWidth,
    sourceHeight: extracted.sourceHeight,
    detectionMode: extracted.mode,
  };
}

function assertImageModel(
  provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"],
  modelId: string,
) {
  const model = provider.models.find((item) => item.modelId === modelId);
  if (!model) {
    throw new Error("当前 Provider 中没有找到这个图片模型，请重新选择模型。");
  }

  const capabilities = model.capabilities as Record<string, unknown>;
  if (!capabilities.image_gen && !capabilities.image_edit) {
    throw new Error("当前选择的模型不是图片生成/改图模型。");
  }
}

export async function generateListingWorkflowImage(
  input: ListingWorkflowImageInput,
  requestOrigin: string,
): Promise<ListingWorkflowImageResult> {
  const splitGrid = input.splitGrid === true;
  const effectivePrompt = splitGrid
    ? fourPanelPrompt(input.prompt)
    : input.prompt;
  const effectiveAspectRatio = splitGrid ? "3:4" : input.aspectRatio;
  const references = await normalizeReferenceImages(
    input.referenceImages ?? [],
    input.useReferenceImages ?? true,
    requestOrigin,
  );
  let providerId: string;
  let providerName: string;
  let effectiveModel = input.model;
  const generationWarnings: string[] = [];
  let result: {
    url?: string | null;
    b64Json?: string | null;
    mimeType?: string | null;
    revisedPrompt?: string | null;
  };

  if (isBrowserAiProvider(input.providerId)) {
    providerId = BROWSER_AI_PROVIDER_ID;
    providerName = BROWSER_AI_PROVIDER_NAME;
    try {
      const generated = await generateBrowserImageWithRetry({
        model: input.model,
        prompt: effectivePrompt,
        aspectRatio: effectiveAspectRatio,
        referenceImages: references.images,
      });
      result = generated.result;
      if (generated.retryCount) {
        generationWarnings.push(
          `豆包页面临时加载失败，已自动重试 ${generated.retryCount} 次后成功。`,
        );
      }
    } catch (error) {
      const fallbackModel =
        process.env.LISTING_IMAGE_QUOTA_FALLBACK_MODEL?.trim()
        || "gpt-image-1.5";
      if (
        !isDoubaoImageModel(input.model)
        || !isImageQuotaError(error)
        || fallbackModel === input.model
      ) throw error;
      effectiveModel = fallbackModel;
      generationWarnings.push(
        `豆包生图额度已耗尽，本次已自动切换 ${fallbackModel}。`,
      );
      result = await generateBrowserImage({
        model: fallbackModel,
        prompt: effectivePrompt,
        aspectRatio: effectiveAspectRatio,
        referenceImages: references.images,
      });
    }
  } else {
    const { provider, adapter } = await getProviderAdapter(input.providerId);
    assertImageModel(provider, input.model);
    providerId = provider.id;
    providerName = provider.name;
    result = await adapter.generateImage({
      model: effectiveModel,
      prompt: effectivePrompt,
      aspectRatio: effectiveAspectRatio,
      referenceImages: references.images,
      monitor: { operation: "listing_workflow_image_generate" },
    });
  }

  const saved = await saveWorkflowImage({
    model: effectiveModel,
    prompt: effectivePrompt,
    publish: !splitGrid,
    source: {
      url: result.url,
      b64Json: result.b64Json,
      mimeType: result.mimeType,
    },
  });

  if (splitGrid) {
    const grid = await saveFourPanelImages({
      sourcePath: saved.absolutePath,
      sourceFileName: saved.fileName,
      sourceFilePath: saved.filePath,
      model: effectiveModel,
      prompt: effectivePrompt,
    });
    const primary = grid.images[0];
    if (!primary || grid.images.length !== 4) {
      throw new Error("四宫格切割未返回完整的4张图片");
    }
    return {
      fileName: primary.fileName,
      filePath: primary.filePath,
      imageUrl: primary.imageUrl,
      mimeType: primary.mimeType,
      providerId,
      providerName,
      model: effectiveModel,
      prompt: input.prompt,
      revisedPrompt: result.revisedPrompt ?? null,
      usedReferenceImageCount: references.images.length,
      warnings: [
        ...generationWarnings,
        ...references.warnings,
        ...saved.warnings,
        ...grid.warnings,
      ],
      gridImages: grid.images,
      gridSource: {
        fileName: saved.fileName,
        filePath: saved.filePath,
        width: grid.sourceWidth,
        height: grid.sourceHeight,
        detectionMode: grid.detectionMode,
      },
    };
  }

  const { absolutePath: _absolutePath, ...publicSaved } = saved;

  return {
    ...publicSaved,
    providerId,
    providerName,
    model: effectiveModel,
    prompt: input.prompt,
    revisedPrompt: result.revisedPrompt ?? null,
    usedReferenceImageCount: references.images.length,
    warnings: [...generationWarnings, ...references.warnings, ...saved.warnings],
  };
}
