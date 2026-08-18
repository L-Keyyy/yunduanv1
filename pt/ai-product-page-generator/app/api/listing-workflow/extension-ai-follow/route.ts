import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { enqueueExtensionAiFollow } from "@/lib/listing-workflow/extension-ai-follow";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  imageModelProcess: z.literal(true),
  offerId: z.string().trim().min(1).max(200),
  sourceUrl: z.string().trim().url().max(3000),
  productId: z.union([z.string(), z.number()]).optional().nullable(),
  title: z.string().trim().max(500).optional().nullable(),
  scrapedJson: z.record(z.string(), z.unknown()),
  currentPrice: z.string().trim().max(100).optional().nullable(),
  oldPrice: z.string().trim().max(100).optional().nullable(),
  minPrice: z.string().trim().max(100).optional().nullable(),
  costPrice: z.string().trim().max(100).optional().nullable(),
  currency: z.string().trim().max(20).optional().nullable(),
  storeId: z.string().trim().max(200).optional().nullable(),
  mergeValue: z.string().trim().max(200).optional().nullable(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Private-Network": "true",
};

function withCors(response: NextResponse) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

function isOzonBuyerUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "ozon.ru" ||
      hostname === "www.ozon.ru" ||
      hostname.endsWith(".ozon.ru")
    );
  } catch {
    return false;
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    if (!isOzonBuyerUrl(input.sourceUrl)) {
      return withCors(
        fail("INVALID_SOURCE", "只接受 Ozon 买家端商品数据", null, 400),
      );
    }

    const result = await enqueueExtensionAiFollow(
      input,
      request.nextUrl.origin,
    );
    const workflowUrl = new URL(
      `/listing/processing?item=${encodeURIComponent(result.item.id)}`,
      request.nextUrl.origin,
    ).toString();

    return withCors(
      ok(
        {
          ...result,
          workflowUrl,
          imagePlan: {
            generatedMain: 1,
            generatedAdditional: 3,
            originalMainReplaced: true,
            originalAdditionalRetained: true,
          },
        },
        { status: result.reused ? 200 : 202 },
      ),
    );
  } catch (error) {
    return withCors(handleRouteError(error));
  }
}
