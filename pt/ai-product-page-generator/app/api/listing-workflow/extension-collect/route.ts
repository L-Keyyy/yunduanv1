import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { sanitizeCollectedProductJson } from "@/lib/listing-workflow/ai-product-json";
import { resolveCollectedProductTitle } from "@/lib/listing-workflow/collected-product-title";
import { readListingWorkflowPreferences } from "@/lib/listing-workflow/preferences";
import {
  LISTING_QUICK_MODE_MODEL_ID,
  LISTING_QUICK_MODE_PROVIDER_ID,
  listingFeatureFillModeConfig,
  type ListingFeatureFillMode,
} from "@/lib/listing-workflow/quick-mode";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

const looseRecordSchema = z.record(z.string(), z.unknown());

type CategoryMatchResponse = {
  category: {
    id: string;
    label: string;
    path: string[];
  } | null;
  features: unknown[];
  variantFeatures?: unknown[];
  preparedProduct?: Record<string, unknown>;
  notes?: string[];
  aiResponse?: Record<string, unknown> | null;
  aiStatus: {
    ok: boolean;
    message: string;
  };
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error?: { message?: string } | null;
};

const categoryMatchJobs = new Map<string, Promise<void>>();

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
  packagingRows: z.array(looseRecordSchema).max(2000).optional(),
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
      packagingRows: z.array(looseRecordSchema).max(2000).optional(),
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

function scalarText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizedSpec(value: unknown) {
  return scalarText(value)
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[【】\[\]()（）]/g, "");
}

function packageInfoFromRow(row: Record<string, unknown>) {
  const depth = scalarText(
    row.lengthCm ?? row.depthCm ?? row.length ?? row.depth,
  );
  const width = scalarText(row.widthCm ?? row.width);
  const height = scalarText(row.heightCm ?? row.height);
  const volumeCm3 = scalarText(row.volumeCm3 ?? row.volume);
  const weightG = scalarText(row.weightG ?? row.weight);
  if (!depth && !width && !height && !weightG) return {};
  return {
    ...(depth ? { depth } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(volumeCm3 ? { volumeCm3 } : {}),
    ...(weightG ? { weightG } : {}),
    dimensionUnit: scalarText(row.dimensionUnit) || "cm",
    weightUnit: scalarText(row.weightUnit) || "g",
    source: scalarText(row.source) || "1688商品件重尺",
  };
}

function packagingRowForVariant(
  variant: Record<string, unknown>,
  rows: Record<string, unknown>[],
) {
  const skuId = scalarText(
    variant.skuId ?? variant.sku_id ?? variant.productId ?? variant.id,
  );
  const candidates = [
    variant.specText,
    variant.specAttrs,
    variant.name,
    variant.title,
    existingJsonObject(
      variant.specs as Prisma.JsonValue,
    ).规格,
  ]
    .map(normalizedSpec)
    .filter(Boolean);
  return (
    rows.find((row) => {
      const rowSkuId = scalarText(row.skuId ?? row.sku_id);
      return skuId && rowSkuId && skuId === rowSkuId;
    }) ??
    rows.find((row) => {
      const rowSpec = normalizedSpec(
        row.specText ?? row.spec ?? row.name ?? row.title,
      );
      return (
        rowSpec &&
        candidates.some(
          (candidate) =>
            candidate === rowSpec ||
            candidate.endsWith(rowSpec) ||
            rowSpec.endsWith(candidate),
        )
      );
    })
  );
}

function attachPackagingToVariants(
  variants: Record<string, unknown>[],
  rows: Record<string, unknown>[],
) {
  if (!rows.length) return variants;
  return variants.map((variant) => {
    const row = packagingRowForVariant(variant, rows);
    const packageInfo = row ? packageInfoFromRow(row) : {};
    return Object.keys(packageInfo).length
      ? { ...variant, packageInfo }
      : variant;
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []))
    : [];
}

function uniqueStrings(values: string[], limit = 500) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function categoryMatchNotes(value: unknown, message: string) {
  return uniqueStrings(
    [
      ...stringArray(value).filter((note) => !note.startsWith("类目匹配：")),
      `类目匹配：${message}`,
    ],
    100,
  );
}

function categoryMatchState(value: Prisma.JsonValue) {
  const aiResponse = existingJsonObject(value);
  return {
    aiResponse,
    categoryMatch:
      aiResponse.categoryMatch &&
      typeof aiResponse.categoryMatch === "object" &&
      !Array.isArray(aiResponse.categoryMatch)
        ? (aiResponse.categoryMatch as Record<string, unknown>)
        : {},
  };
}

async function readCategoryMatchResponse(response: Response) {
  const payload = (await response.json()) as ApiEnvelope<CategoryMatchResponse>;
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(
      payload.error?.message || `类目匹配接口返回 ${response.status}`,
    );
  }
  return payload.data;
}

async function updateCategoryMatchFailure(
  itemId: string,
  runId: string,
  providerId: string,
  model: string,
  message: string,
  featureFillMode?: ListingFeatureFillMode,
) {
  const current = await prisma.listingWorkflowItem.findUnique({
    where: { id: itemId },
  });
  if (!current || current.stage !== "COLLECTED") return;
  const { aiResponse, categoryMatch } = categoryMatchState(current.aiResponse);
  if (categoryMatch.runId !== runId) return;
  await prisma.listingWorkflowItem.update({
    where: { id: itemId },
    data: {
      status: "AI_FAILED",
      categoryId: null,
      categoryLabel: null,
      categoryPath: Prisma.JsonNull,
      aiResponse: {
        ...aiResponse,
        categoryMatch: {
          ...categoryMatch,
          providerId,
          model,
          runId,
          status: "failed",
          error: message,
          completedAt: new Date().toISOString(),
        },
        quickMode: {
          providerId,
          model,
          ...(featureFillMode
            ? {
                mode: featureFillMode,
                modeLabel:
                  listingFeatureFillModeConfig(featureFillMode).label,
              }
            : {}),
          runId,
          status: "failed",
          error: message,
          completedAt: new Date().toISOString(),
        },
      } as Prisma.InputJsonValue,
      notes: categoryMatchNotes(current.notes, message) as Prisma.InputJsonValue,
    },
  });
}

async function runExtensionCategoryMatch(options: {
  itemId: string;
  runId: string;
  quickMatchUrl: string;
  scrapedData: Record<string, unknown>;
  providerId: string;
  model: string;
  featureFillMode: ListingFeatureFillMode;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const result = await readCategoryMatchResponse(
      await fetch(options.quickMatchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scrapedData: options.scrapedData,
          providerId: options.providerId,
          model: options.model,
          featureFillMode: options.featureFillMode,
        }),
        cache: "no-store",
        signal: controller.signal,
      }),
    );
    const matchedCategory = result.category;
    if (!matchedCategory) {
      await updateCategoryMatchFailure(
        options.itemId,
        options.runId,
        options.providerId,
        options.model,
        result.aiStatus.message || "AI 没有返回匹配类目",
        options.featureFillMode,
      );
      return;
    }

    const current = await prisma.listingWorkflowItem.findUnique({
      where: { id: options.itemId },
    });
    if (!current || current.stage !== "COLLECTED") return;
    const { aiResponse, categoryMatch } = categoryMatchState(current.aiResponse);
    if (categoryMatch.runId !== options.runId) return;
    await prisma.listingWorkflowItem.update({
      where: { id: options.itemId },
      data: {
        status: result.aiStatus.ok ? "MATCHED" : "AI_FAILED",
        categoryId: matchedCategory.id,
        categoryLabel: matchedCategory.label,
        categoryPath: matchedCategory.path as Prisma.InputJsonValue,
        features: result.features as Prisma.InputJsonValue,
        workflowData: {
          ...existingJsonObject(current.workflowData),
          ...(Array.isArray(result.variantFeatures)
            ? {
                skuFeatureDrafts: result.variantFeatures,
                skuFeatureDraftsUpdatedAt: new Date().toISOString(),
              }
            : {}),
        } as Prisma.InputJsonValue,
        aiResponse: {
          ...aiResponse,
          ...existingJsonObject((result.aiResponse ?? {}) as Prisma.JsonValue),
          categoryMatch: {
            ...existingJsonObject(
              existingJsonObject((result.aiResponse ?? {}) as Prisma.JsonValue)
                .categoryMatch as Prisma.JsonValue,
            ),
            providerId: options.providerId,
            model: options.model,
            runId: options.runId,
            status: "matched",
            preparedProduct: result.preparedProduct ?? {},
            completedAt: new Date().toISOString(),
          },
          quickMode: {
            ...existingJsonObject(
              existingJsonObject((result.aiResponse ?? {}) as Prisma.JsonValue)
                .quickMode as Prisma.JsonValue,
            ),
            providerId: options.providerId,
            model: options.model,
            runId: options.runId,
            status: result.aiStatus.ok ? "done" : "failed",
            completedAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
        notes: uniqueStrings([
          ...stringArray(result.notes),
          `快速模式：已一次返回 ${matchedCategory.label} 的类目和特征`,
        ]) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    await updateCategoryMatchFailure(
      options.itemId,
      options.runId,
      options.providerId,
      options.model,
      error instanceof Error ? error.message : "AI 类目匹配请求异常",
      options.featureFillMode,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function queueExtensionCategoryMatch(
  options: Parameters<typeof runExtensionCategoryMatch>[0],
) {
  const job = Promise.resolve()
    .then(() => runExtensionCategoryMatch(options))
    .finally(() => {
      if (categoryMatchJobs.get(options.runId) === job) {
        categoryMatchJobs.delete(options.runId);
      }
    });
  categoryMatchJobs.set(options.runId, job);
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
    const existingScrapedData = sanitizeCollectedProductJson(
      existing ? existingJsonObject(existing.scrapedData) : {},
    );
    const detail = input.detail || {};
    const rawVariants = objectArray(detail.variants);
    const sourceVariants = rawVariants.length
      ? rawVariants
      : objectArray(existingScrapedData.variants);
    const title = resolveCollectedProductTitle({
      cardTitle: input.title,
      variants: sourceVariants,
      detailTitle: detail.title,
      sellerName: input.sellerName,
      existingTitle: existing?.title,
      fallback: `1688 商品 ${input.offerId}`,
    });
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
    const storedPackagingRows = objectArray(
      existingScrapedData.packagingRows ??
        existingJsonObject(existingScrapedData.detailCapture as Prisma.JsonValue)
          .packagingRows,
    );
    const capturedPackagingRows = objectArray(
      detail.packagingRows ?? input.packagingRows,
    );
    const packagingRows = capturedPackagingRows.length
      ? capturedPackagingRows
      : storedPackagingRows;
    const variants = attachPackagingToVariants(
      sourceVariants,
      packagingRows,
    );
    const skuGroups = objectArray(detail.skuGroups);
    const characteristics = objectArray(detail.characteristics);
    const videos = objectArray(detail.videos);
    const storedVideos = objectArray(existingGallery.videos);
    const priceTiers = objectArray(detail.priceTiers);
    const capturedDomesticFreight = existingJsonObject(
      detail.domesticFreight as Prisma.JsonValue,
    );
    const storedDomesticFreight = existingJsonObject(
      existingScrapedData.domesticFreight as Prisma.JsonValue,
    );
    const domesticFreight = Object.keys(capturedDomesticFreight).length
      ? capturedDomesticFreight
      : storedDomesticFreight;
    const existingDetailCapture = existingJsonObject(
      existingScrapedData.detailCapture as Prisma.JsonValue,
    );
    const scrapedData = sanitizeCollectedProductJson({
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
        domesticFreightCny: domesticFreight.unitCny ?? domesticFreight.totalCny ?? null,
        domesticFreightStatus: Object.keys(domesticFreight).length ? "captured" : "missing",
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
      packagingRows,
      skuGroups: skuGroups.length ? skuGroups : existingScrapedData.skuGroups || [],
      characteristics: characteristics.length
        ? characteristics
        : existingScrapedData.characteristics || [],
      priceTiers: priceTiers.length ? priceTiers : existingScrapedData.priceTiers || [],
      domesticFreight,
      description: detail.description || existingScrapedData.description || {},
      detailCapture: {
        ...existingDetailCapture,
        ...detail,
        title,
        variants,
        packagingRows,
      },
      extensionCard: {
        pageUrl: input.pageUrl || input.sourceUrl,
        visibleText: nonEmpty(
          input.sellerName
            ? input.cardText
                ?.split(input.sellerName)
                .join(" ")
                .replace(/\s+/g, " ")
            : input.cardText,
        ),
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
    });

    const shouldPrepareCollection = !existing || existing.stage === "COLLECTED";
    const preferences = shouldPrepareCollection
      ? await readListingWorkflowPreferences()
      : null;
    const featureFillMode = listingFeatureFillModeConfig(
      preferences?.featureFillMode,
    );
    const persistedScrapedData = preferences
      ? {
          ...scrapedData,
        }
      : scrapedData;
    const existingAiResponse = existing
      ? existingJsonObject(existing.aiResponse)
      : {};
    const { categoryMatch: _categoryMatch, ...aiResponseWithoutCategoryMatch } =
      existingAiResponse;
    const pendingAiResponse = shouldPrepareCollection
      ? {
          ...aiResponseWithoutCategoryMatch,
          quickMode: {
            mode: featureFillMode.id,
            modeLabel: featureFillMode.label,
            prompt: featureFillMode.prompt,
            status: "pending",
          },
        }
      : existingAiResponse;
    const collectionNotes = uniqueStrings([
      ...stringArray(existing?.notes),
      "商品已进入采集阶段；主图固定保留，请勾选要进入加工的附图和 SKU，开始加工后再发送 AI。",
    ]);

    const item = await prisma.listingWorkflowItem.upsert({
      where: { offerId: input.offerId },
      create: {
        stage: "COLLECTED",
        status: "PENDING_AI",
        sourceUrl: input.sourceUrl,
        sourcePlatform: "1688",
        title,
        offerId: input.offerId,
        imageUrl,
        costPrice,
        currency: "CNY",
        scrapedData: persistedScrapedData as Prisma.InputJsonValue,
        aiResponse: pendingAiResponse as Prisma.InputJsonValue,
        notes: uniqueStrings([
          "由 1688 商品卡扩展采集，详情页由扩展在后台静默读取。",
          ...collectionNotes,
        ]) as Prisma.InputJsonValue,
      },
      update: {
        sourceUrl: input.sourceUrl,
        sourcePlatform: "1688",
        title,
        imageUrl,
        costPrice,
        currency: "CNY",
        scrapedData: persistedScrapedData as Prisma.InputJsonValue,
        ...(shouldPrepareCollection
          ? {
              status: "PENDING_AI" as const,
              categoryId: null,
              categoryLabel: null,
              categoryPath: Prisma.JsonNull,
              features: [] as Prisma.InputJsonValue,
              aiResponse: pendingAiResponse as Prisma.InputJsonValue,
              notes: collectionNotes as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    return withCors(
      ok(
        {
          item,
          created: !existing,
          categoryMatch: {
            queued: false,
            status: shouldPrepareCollection ? "deferred" : "skipped",
            providerId: null,
            model: null,
          },
          quickMode: {
            queued: false,
            status: shouldPrepareCollection ? "deferred" : "skipped",
            mode: featureFillMode.id,
            modeLabel: featureFillMode.label,
          },
          workflowUrl: "/listing/collection",
        },
        { status: existing ? 200 : 201 },
      ),
    );
  } catch (error) {
    return withCors(handleRouteError(error));
  }
}
