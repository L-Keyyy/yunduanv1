import fs from "fs/promises";
import path from "path";

import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { z } from "zod";

import { ensureDoubaoWebService } from "@/lib/browser-ai/client";
import {
  persistWorkflowTranslationFailure,
  persistWorkflowTranslationResult,
  type ProcessingWorkflowContext,
} from "@/lib/listing-workflow/processing-state";
import { runProcessingFifo } from "@/lib/listing-workflow/processing-fifo";
import { publishWorkflowImage } from "@/lib/listing-workflow/public-image-host";
import { env } from "@/lib/utils/env";
import { extFromMime, relativeStorageUrl, sanitizeFileName } from "@/lib/utils/files";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  images: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(240),
    url: z.string().min(1),
  })).min(1).max(20),
  targetLanguage: z.string().trim().min(2).max(12).default("ru"),
  workflowItemId: z.string().trim().min(1).max(200).optional().nullable(),
  workflowRunId: z.string().trim().min(1).max(300).optional().nullable(),
  workflowTranslationTotal: z.number().int().min(1).max(30).optional(),
});

function storageRoot() {
  return path.resolve(process.cwd(), env.STORAGE_ROOT);
}

function parseDataUrl(value: string) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) throw new Error("图片 dataURL 格式无效");
  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

async function imageUrlToBuffer(url: string, requestOrigin: string) {
  if (url.startsWith("data:image/")) return parseDataUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(new URL(url, requestOrigin), {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 Chrome/149 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    if (!mimeType.startsWith("image/")) throw new Error("图片地址没有返回图片内容");
    return { mimeType, bytes: Buffer.from(await response.arrayBuffer()) };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveTranslatedCrop(input: {
  imageId: string;
  sourceName: string;
  imageDataUrl: string;
  targetLanguage: string;
  atlasIndex: number;
}) {
  const parsed = parseDataUrl(input.imageDataUrl);
  const ext = extFromMime(parsed.mimeType);
  const stem = sanitizeFileName(path.parse(input.sourceName).name || "translated");
  const fileName = `${Date.now()}-${nanoid(6)}-${stem}-${input.targetLanguage}.${ext}`;
  const relativePath = path.join("generated", "listing-workflow", fileName);
  const absolutePath = path.join(storageRoot(), relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, parsed.bytes);
  const publicImage = await publishWorkflowImage({ absolutePath, fileName });
  await fs.writeFile(
    `${absolutePath}.json`,
    JSON.stringify({
      imageId: input.imageId,
      sourceName: input.sourceName,
      engine: "web-image-translation-atlas",
      targetLanguage: input.targetLanguage,
      atlasIndex: input.atlasIndex,
      publicImageUrl: publicImage.publicUrl,
      createdAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
  return {
    id: input.imageId,
    name: fileName,
    fileName,
    filePath: relativePath.split(path.sep).join("/"),
    imageUrl: publicImage.publicUrl ?? relativeStorageUrl(relativePath),
    mimeType: parsed.mimeType,
    atlasIndex: input.atlasIndex,
    warnings: publicImage.warning ? [publicImage.warning] : [],
  };
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch (error) {
    return handleRouteError(error);
  }
  const workflowContext: ProcessingWorkflowContext | null =
    input.workflowItemId && input.workflowRunId
      ? { itemId: input.workflowItemId, runId: input.workflowRunId }
      : null;
  const workflowTranslationTotal = workflowContext
    ? input.workflowTranslationTotal ?? input.images.length
    : 0;

  return runProcessingFifo("translation", workflowContext, async () => {
    try {
    const sources = await Promise.all(
      input.images.map(async (image) => ({
        ...image,
        source: await imageUrlToBuffer(image.url, request.nextUrl.origin),
      })),
    );

    const formData = new FormData();
    formData.set("target_language", input.targetLanguage);
    formData.set("image_ids", JSON.stringify(sources.map((image) => image.id)));
    for (const image of sources) {
      formData.append(
        "files",
        new Blob([image.source.bytes], { type: image.source.mimeType }),
        image.name,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
    let response: Response;
    try {
      await ensureDoubaoWebService();
      response = await fetch("http://127.0.0.1:8010/translate-atlas", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => null) as {
      detail?: string;
      engine?: string;
      atlasCount?: number;
      sourceText?: string;
      translatedText?: string;
      results?: Array<{
        imageId?: string;
        name?: string;
        image?: string;
        atlasIndex?: number;
      }>;
    } | null;
    if (!response.ok || !payload?.results?.length) {
      throw new Error(payload?.detail || `图集翻译失败：${response.status}`);
    }

    const sourceById = new Map(input.images.map((image) => [image.id, image]));
    const images = await Promise.all(payload.results.map((result) => {
      const imageId = String(result.imageId || "");
      const source = sourceById.get(imageId);
      if (!source || !result.image) throw new Error("图集裁剪结果与源图片映射不完整");
      return saveTranslatedCrop({
        imageId,
        sourceName: source.name,
        imageDataUrl: result.image,
        targetLanguage: input.targetLanguage,
        atlasIndex: Number(result.atlasIndex || 0),
      });
    }));

    const result = {
      engine: payload.engine || "web-image-translation-atlas",
      atlasCount: Number(payload.atlasCount || 1),
      imageCount: images.length,
      images,
      sourceText: payload.sourceText || "",
      translatedText: payload.translatedText || "",
    };
    await persistWorkflowTranslationResult(
      workflowContext,
      workflowTranslationTotal,
      images,
    );
    return ok(result);
    } catch (error) {
      if (workflowContext) {
        const message = error instanceof Error ? error.message : "图集翻译请求异常";
        await persistWorkflowTranslationFailure(
          workflowContext,
          workflowTranslationTotal,
          message,
        ).catch(() => undefined);
      }
      return handleRouteError(error);
    }
  }).catch(handleRouteError);
}
