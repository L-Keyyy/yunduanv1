import fs from "fs/promises";
import path from "path";

import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  BROWSER_AI_PROVIDER_ID,
  BROWSER_AI_PROVIDER_NAME,
  generateBrowserImage,
  isBrowserAiProvider,
} from "@/lib/browser-ai/client";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { env } from "@/lib/utils/env";
import { extFromMime, relativeStorageUrl, sanitizeFileName } from "@/lib/utils/files";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1),
  prompt: z.string().trim().min(4).max(5000),
  aspectRatio: z.enum(["1:1", "3:4", "9:16"]).default("1:1"),
  referenceImages: z.array(z.string().min(1)).max(4).optional().default([]),
  useReferenceImages: z.boolean().default(true),
});

function storageRoot() {
  return path.resolve(process.cwd(), env.STORAGE_ROOT);
}

function isDataUrl(value: string) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

async function imageUrlToDataUrl(url: string, requestOrigin: string) {
  if (isDataUrl(url)) return url;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
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

  const metadataPath = `${relativePath}.json`;
  await fs.writeFile(
    path.join(storageRoot(), metadataPath),
    JSON.stringify(
      {
        model: params.model,
        prompt: params.prompt,
        mimeType,
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
    imageUrl: relativeStorageUrl(relativePath),
    mimeType,
  };
}

function assertImageModel(provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"], modelId: string) {
  const model = provider.models.find((item) => item.modelId === modelId);
  if (!model) {
    throw new Error("当前 Provider 中没有找到这个图片模型，请重新选择模型。");
  }

  const capabilities = model.capabilities as Record<string, unknown>;
  if (!capabilities.image_gen && !capabilities.image_edit) {
    throw new Error("当前选择的模型不是图片生成/改图模型。");
  }

  return model;
}

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    const references = await normalizeReferenceImages(
      input.referenceImages,
      input.useReferenceImages,
      request.nextUrl.origin,
    );
    let providerId: string;
    let providerName: string;
    let result: {
      url?: string | null;
      b64Json?: string | null;
      mimeType?: string | null;
      revisedPrompt?: string | null;
    };

    if (isBrowserAiProvider(input.providerId)) {
      providerId = BROWSER_AI_PROVIDER_ID;
      providerName = BROWSER_AI_PROVIDER_NAME;
      result = await generateBrowserImage({
        model: input.model,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        referenceImages: references.images,
      });
    } else {
      const { provider, adapter } = await getProviderAdapter(input.providerId);
      assertImageModel(provider, input.model);
      providerId = provider.id;
      providerName = provider.name;
      result = await adapter.generateImage({
        model: input.model,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        referenceImages: references.images,
        monitor: {
          operation: "listing_workflow_image_generate",
        },
      });
    }

    const saved = await saveWorkflowImage({
      model: input.model,
      prompt: input.prompt,
      source: {
        url: result.url,
        b64Json: result.b64Json,
        mimeType: result.mimeType,
      },
    });

    return ok({
      ...saved,
      providerId,
      providerName,
      model: input.model,
      prompt: input.prompt,
      revisedPrompt: result.revisedPrompt ?? null,
      usedReferenceImageCount: references.images.length,
      warnings: references.warnings,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
