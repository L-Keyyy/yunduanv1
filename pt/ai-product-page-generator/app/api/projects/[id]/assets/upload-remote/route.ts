import { NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { saveUploadAsset } from "@/lib/storage/asset-manager";
import { handleRouteError, ok } from "@/lib/utils/route";

const remoteUploadSchema = z.object({
  type: z.enum(["MAIN", "ANGLE", "DETAIL", "REFERENCE"]),
  url: z.string().url(),
  fileName: z.string().optional(),
});

function extensionFromMime(mimeType: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "jpg";
}

function fileNameFromUrl(url: string, mimeType: string) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    if (name && /\.[a-z0-9]{2,5}/i.test(name)) return name.replace(/[?#].*$/, "");
  } catch {
    // Fall through to generated name.
  }
  return `crawler-image.${extensionFromMime(mimeType)}`;
}

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    const input = remoteUploadSchema.parse(await request.json());
    const response = await fetch(input.url, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`远程图片下载失败：${response.status}`);
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!mimeType.startsWith("image/")) {
      throw new Error("远程地址不是图片资源。");
    }

    const existingCount = await prisma.productAsset.count({
      where: { projectId: context.params.id },
    });
    const asset = await saveUploadAsset({
      projectId: context.params.id,
      type: input.type,
      fileName: input.fileName?.trim() || fileNameFromUrl(input.url, mimeType),
      mimeType,
      fileBuffer: Buffer.from(await response.arrayBuffer()),
      sortOrder: existingCount,
      isMain: input.type === "MAIN",
    });

    return ok(asset, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
