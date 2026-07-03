import { NextRequest } from "next/server";

import { fail, handleRouteError } from "@/lib/utils/route";

export const runtime = "nodejs";

function assertImageUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("只支持 http/https 图片地址。");
  }
  return url;
}

export async function GET(request: NextRequest) {
  try {
    const rawUrl = request.nextUrl.searchParams.get("url");
    if (!rawUrl) {
      return fail("VALIDATION_ERROR", "缺少图片地址。", null, 400);
    }

    const imageUrl = assertImageUrl(rawUrl);
    const response = await fetch(imageUrl, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        referer: "https://detail.1688.com/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      return fail("IMAGE_PROXY_ERROR", `图片代理下载失败：${response.status}`, null, response.status);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return fail("IMAGE_PROXY_ERROR", "远程地址不是图片资源。", { contentType }, 400);
    }

    return new Response(await response.arrayBuffer(), {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
