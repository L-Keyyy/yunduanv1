import fs from "fs/promises";
import path from "path";

import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { z } from "zod";

import { ensureDoubaoWebService } from "@/lib/browser-ai/client";
import { publishWorkflowImage } from "@/lib/listing-workflow/public-image-host";
import { runProcessingFifo } from "@/lib/listing-workflow/processing-fifo";
import { env } from "@/lib/utils/env";
import { extFromMime, relativeStorageUrl, sanitizeFileName } from "@/lib/utils/files";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  imageUrl: z.string().min(1),
  targetLanguage: z.string().trim().min(2).max(12).default("ru"),
  ocrEngine: z.enum(["web", "doubao"]).default("doubao"),
  translationMode: z.string().trim().min(1).max(80).default("product_short"),
});

function storageRoot() {
  return path.resolve(process.cwd(), env.STORAGE_ROOT);
}

function isDataUrl(value: string) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

function parseDataUrl(value: string) {
  const commaIndex = value.indexOf(",");
  const header = commaIndex >= 0 ? value.slice(0, commaIndex) : "";
  const base64 = commaIndex >= 0 ? value.slice(commaIndex + 1) : "";
  const mimeType = header.startsWith("data:") && header.endsWith(";base64")
    ? header.slice(5, -7)
    : "";
  if (!mimeType.startsWith("image/") || !base64) {
    throw new Error("图片 dataURL 格式无效。");
  }
  return {
    mimeType,
    bytes: Buffer.from(
      base64
        .replaceAll("\n", "")
        .replaceAll("\r", "")
        .replaceAll("\t", "")
        .replaceAll(" ", ""),
      "base64",
    ),
  };
}

async function imageUrlToBuffer(url: string, requestOrigin: string) {
  if (isDataUrl(url)) return parseDataUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const normalized = url.startsWith("//") ? `https:${url}` : url;
    const resolvedUrl = new URL(normalized, requestOrigin).toString();
    const response = await fetch(resolvedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`图片下载失败：${response.status}`);
    }
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "image/jpeg";
    if (!mimeType.startsWith("image/")) {
      throw new Error("图片地址没有返回图片内容。");
    }
    return {
      mimeType,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveTranslatedImage(params: {
  imageDataUrl: string;
  sourceName: string;
  engine: string;
  targetLanguage: string;
}) {
  const parsed = parseDataUrl(params.imageDataUrl);
  const ext = extFromMime(parsed.mimeType);
  const fileName = `${Date.now()}-${nanoid(6)}-${sanitizeFileName(params.sourceName)}.${ext}`;
  const relativePath = path.join("generated", "listing-workflow", fileName);
  const absolutePath = path.join(storageRoot(), relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, parsed.bytes);
  const publicImage = await publishWorkflowImage({ absolutePath, fileName });
  await fs.writeFile(
    path.join(storageRoot(), `${relativePath}.json`),
    JSON.stringify(
      {
        sourceName: params.sourceName,
        engine: params.engine,
        targetLanguage: params.targetLanguage,
        mimeType: parsed.mimeType,
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
    imageUrl: publicImage.publicUrl ?? relativeStorageUrl(relativePath),
    mimeType: parsed.mimeType,
    warnings: publicImage.warning ? [publicImage.warning] : [],
  };
}

export async function POST(request: NextRequest) {
  return runProcessingFifo("translation", null, async () => {
    try {
    const input = requestSchema.parse(await request.json());
    const source = await imageUrlToBuffer(input.imageUrl, request.nextUrl.origin);

    const formData = new FormData();
    const ext = extFromMime(source.mimeType);
    const sourceName = `translated-source.${ext}`;
    formData.set("file", new Blob([source.bytes], { type: source.mimeType }), sourceName);
    formData.set("target_language", input.targetLanguage);
    formData.set("translation_mode", input.translationMode);
    formData.set("ocr_engine", input.ocrEngine);

    await ensureDoubaoWebService();
    const ocrResponse = await fetch("http://127.0.0.1:8010/translate", {
      method: "POST",
      body: formData,
    });
    const payload = (await ocrResponse.json().catch(() => null)) as {
      image?: string;
      engine?: string;
      warnings?: string[];
      sourceText?: string;
      translatedText?: string;
    } | null;

    if (!ocrResponse.ok || !payload?.image) {
      const detail =
        payload && "detail" in payload
          ? String((payload as { detail?: unknown }).detail)
          : "";
      throw new Error(detail || `图片翻译失败：${ocrResponse.status}`);
    }

    const saved = await saveTranslatedImage({
      imageDataUrl: payload.image,
      sourceName,
      engine: payload.engine || input.ocrEngine,
      targetLanguage: input.targetLanguage,
    });

    return ok({
      ...saved,
      engine: payload.engine || input.ocrEngine,
      sourceText: payload.sourceText || "",
      translatedText: payload.translatedText || "",
      warnings: [...(payload.warnings ?? []), ...saved.warnings],
    });
    } catch (error) {
      return handleRouteError(error);
    }
  }).catch(handleRouteError);
}
