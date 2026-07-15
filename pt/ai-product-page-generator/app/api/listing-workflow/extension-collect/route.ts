import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

const looseRecordSchema = z.record(z.string(), z.unknown());

const requestSchema = z.object({
  offerId: z.string().trim().regex(/^\d{5,30}$/),
  sourceUrl: z.string().trim().url().max(3000),
  pageUrl: z.string().trim().url().max(3000).optional(),
  title: z.string().trim().max(500).optional(),
  imageUrl: z.string().trim().max(3000).optional(),
  currentPrice: z.string().trim().max(100).optional(),
  sellerName: z.string().trim().max(300).optional(),
  minOrder: z.string().trim().max(300).optional(),
  salesText: z.string().trim().max(300).optional(),
  cardText: z.string().trim().max(8000).optional(),
  categoryLabel: z.string().trim().max(500).optional(),
  categoryPath: z.array(z.string().trim().max(300)).max(20).optional(),
  collectedAt: z.string().datetime().optional(),
  detail: z
    .object({
      title: z.string().trim().max(500).optional(),
      imageUrl: z.string().trim().max(3000).optional(),
      price: z.string().trim().max(100).optional(),
      fetched: z.boolean().optional(),
      captureMode: z.string().trim().max(100).optional(),
      galleryImages: z.array(z.string().trim().max(3000)).max(500).optional(),
      images: z.array(z.string().trim().max(3000)).max(500).optional(),
      detailImages: z.array(z.string().trim().max(3000)).max(500).optional(),
      videos: z.array(looseRecordSchema).max(100).optional(),
      skuGroups: z.array(looseRecordSchema).max(100).optional(),
      variants: z.array(looseRecordSchema).max(2000).optional(),
      characteristics: z.array(looseRecordSchema).max(1000).optional(),
      priceTiers: z.array(looseRecordSchema).max(500).optional(),
      description: looseRecordSchema.optional(),
    })
    .passthrough()
    .optional(),
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

function is1688Url(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "1688.com" || hostname.endsWith(".1688.com");
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined) {
  const text = value?.trim();
  return text || null;
}

function existingJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []))
    : [];
}

function uniqueStrings(values: string[], limit = 500) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    if (!is1688Url(input.sourceUrl) || (input.pageUrl && !is1688Url(input.pageUrl))) {
      return withCors(fail("INVALID_SOURCE", "只接受 1688 商品卡数据", null, 400));
    }

    const existing = await prisma.listingWorkflowItem.findUnique({
      where: { offerId: input.offerId },
    });
    const title =
      nonEmpty(input.detail?.title) ||
      nonEmpty(input.title) ||
      existing?.title ||
      `1688 商品 ${input.offerId}`;
    const imageUrl =
      nonEmpty(input.detail?.imageUrl) ||
      nonEmpty(input.imageUrl) ||
      existing?.imageUrl ||
      null;
    const costPrice =
      nonEmpty(input.detail?.price) ||
      nonEmpty(input.currentPrice) ||
      existing?.costPrice ||
      null;
    const collectedAt = input.collectedAt || new Date().toISOString();
    const existingScrapedData = existing
      ? existingJsonObject(existing.scrapedData)
      : {};
    const detail = input.detail || {};
    const existingGallery = existingScrapedData.gallery &&
      typeof existingScrapedData.gallery === "object" &&
      !Array.isArray(existingScrapedData.gallery)
      ? (existingScrapedData.gallery as Record<string, unknown>)
      : {};
    const existingGalleryImages = objectArray(existingGallery.images).flatMap((entry) =>
      typeof entry.src === "string" ? [entry.src] : [],
    );
    const capturedGalleryImages = stringArray(detail.galleryImages);
    const capturedDetailImages = stringArray(detail.detailImages);
    const hasFreshProductImages = capturedGalleryImages.length > 0 || capturedDetailImages.length > 0;
    const fullImages = uniqueStrings([
      imageUrl || "",
      ...(capturedGalleryImages.length ? capturedGalleryImages : stringArray(detail.images)),
      ...capturedDetailImages,
      ...(hasFreshProductImages ? [] : stringArray(existingScrapedData.images)),
      ...(hasFreshProductImages ? [] : existingGalleryImages),
    ]);
    const rawVariants = objectArray(detail.variants);
    const variants = rawVariants;
    const skuGroups = objectArray(detail.skuGroups);
    const characteristics = objectArray(detail.characteristics);
    const videos = objectArray(detail.videos);
    const storedVideos = objectArray(existingGallery.videos);
    const priceTiers = objectArray(detail.priceTiers);
    const scrapedData = {
      ...existingScrapedData,
      source: "1688_extension_card",
      platform: "1688",
      productId: `1688-${input.offerId}`,
      offerId1688: input.offerId,
      sourceUrl: input.sourceUrl,
      title,
      price: costPrice,
      pricing: {
        purchasePriceCny: costPrice,
        currency: "CNY",
      },
      gallery: {
        coverImage: imageUrl || "",
        images: fullImages.map((src) => ({ src })),
        videos: videos.length ? videos : storedVideos,
      },
      images: fullImages,
      variants: variants.length ? variants : existingScrapedData.variants || [],
      rawVariants: rawVariants.length ? rawVariants : existingScrapedData.rawVariants || [],
      skuGroups: skuGroups.length ? skuGroups : existingScrapedData.skuGroups || [],
      characteristics: characteristics.length
        ? characteristics
        : existingScrapedData.characteristics || [],
      priceTiers: priceTiers.length ? priceTiers : existingScrapedData.priceTiers || [],
      description: detail.description || existingScrapedData.description || {},
      detailCapture: detail,
      extensionCard: {
        pageUrl: input.pageUrl || input.sourceUrl,
        visibleText: nonEmpty(input.cardText),
        sellerName: nonEmpty(input.sellerName),
        minimumOrder: nonEmpty(input.minOrder),
        salesText: nonEmpty(input.salesText),
        categoryLabel: nonEmpty(input.categoryLabel),
        categoryPath: input.categoryPath || [],
        detailFetch: detail.fetched === false
          ? { fetched: false }
          : {
              fetched: Boolean(detail.fetched),
              captureMode: detail.captureMode || "background_inactive_tab",
              imageCount: fullImages.length,
              skuCount: variants.length,
              sourceSkuCount: rawVariants.length,
              characteristicCount: characteristics.length,
            },
        collectedAt,
        captureMode: detail.captureMode || "card_without_opening_detail",
      },
    };

    const item = await prisma.listingWorkflowItem.upsert({
      where: { offerId: input.offerId },
      create: {
        stage: "COLLECTED",
        status: "READY",
        sourceUrl: input.sourceUrl,
        sourcePlatform: "1688",
        title,
        offerId: input.offerId,
        imageUrl,
        costPrice,
        currency: "CNY",
        categoryLabel: nonEmpty(input.categoryLabel),
        categoryPath: input.categoryPath
          ? (input.categoryPath as Prisma.InputJsonValue)
          : undefined,
        scrapedData: scrapedData as Prisma.InputJsonValue,
        notes: ["由 1688 商品卡扩展采集，详情页由扩展在后台静默读取。"],
      },
      update: {
        sourceUrl: input.sourceUrl,
        sourcePlatform: "1688",
        title,
        imageUrl,
        costPrice,
        currency: "CNY",
        categoryLabel: nonEmpty(input.categoryLabel) || existing?.categoryLabel,
        categoryPath: input.categoryPath
          ? (input.categoryPath as Prisma.InputJsonValue)
          : undefined,
        scrapedData: scrapedData as Prisma.InputJsonValue,
      },
    });

    return withCors(
      ok(
        {
          item,
          created: !existing,
          workflowUrl: "/listing/collection",
        },
        { status: existing ? 200 : 201 },
      ),
    );
  } catch (error) {
    return withCors(handleRouteError(error));
  }
}
