import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest } from "next/server";
import { z } from "zod";

import {
  BROWSER_AI_PROVIDER_ID,
  BROWSER_AI_PROVIDER_NAME,
  generateBrowserText,
} from "@/lib/browser-ai/client";
import {
  LISTING_QUICK_MODE_MODEL_ID,
  LISTING_QUICK_MODE_PROVIDER_ID,
  listingFeatureFillModeConfig,
} from "@/lib/listing-workflow/quick-mode";
import { sanitizeProductJsonForAi } from "@/lib/listing-workflow/ai-product-json";
import { runProcessingFifo } from "@/lib/listing-workflow/processing-fifo";
import {
  persistWorkflowFeatureFailure,
  persistWorkflowFeatureResult,
  type ProcessingWorkflowContext,
} from "@/lib/listing-workflow/processing-state";
import { prisma } from "@/lib/db/prisma";
import {
  mapOzonAiResponse,
  type OzonAiMapping,
  type OzonMappedAttribute,
} from "@/lib/ozon/ai-response-mapper";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  scrapedData: z.record(z.string(), z.unknown()),
  providerId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  featureFillMode: z.enum(["normal", "max"]).optional(),
  precomputedAiText: z.string().trim().min(2).optional(),
  workflowItemId: z.string().trim().min(1).max(200).optional().nullable(),
  workflowRunId: z.string().trim().min(1).max(300).optional().nullable(),
});

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error?: { message?: string } | null;
};

type FeatureDraftResult = {
  category: {
    id: string;
    label: string;
    path: string[];
    descriptionCategoryId: number | null;
    typeId: number | null;
  } | null;
  features: Array<Record<string, unknown>>;
  variantFeatures?: Array<Record<string, unknown>>;
  preparedProduct?: Record<string, unknown>;
  promptAudit?: Record<string, unknown>;
  aiStatus: { ok: boolean; message: string };
  notes: string[];
  aiResponse?: Record<string, unknown> | null;
};

type OzonCategoryIds = {
  descriptionCategoryId: number;
  typeId: number;
};

const PET_TOY_DESCRIPTION_CATEGORY_ID = 17028968;

function petToyFallbackCategory(
  scrapedData: Record<string, unknown>,
): OzonCategoryIds | null {
  // This is a deterministic local fallback for the serial pet-toy batch. It
  // is only used when the Ozon Max Info response contains attributes but
  // omits the two category IDs; it does not trigger a second AI interaction.
  if (!Object.keys(recordValue(scrapedData.petToyBatch)).length) return null;
  const haystack = [
    scrapedData.title,
    scrapedData.productTitle,
    scrapedData.category,
    scrapedData.categoryName,
    scrapedData.description,
  ]
    .map(textValue)
    .join(" ")
    .toLowerCase();
  if (/(猫抓|抓板|抓柱|抓盆|磨爪|когтеточ)/i.test(haystack)) {
    return {
      descriptionCategoryId: PET_TOY_DESCRIPTION_CATEGORY_ID,
      typeId: 95240,
    };
  }
  if (/(隧道|通道|地龙|猫 тунн|тоннел)/i.test(haystack)) {
    return {
      descriptionCategoryId: PET_TOY_DESCRIPTION_CATEGORY_ID,
      typeId: 970944599,
    };
  }
  return {
    descriptionCategoryId: PET_TOY_DESCRIPTION_CATEGORY_ID,
    typeId: 95238,
  };
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function textValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  return "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function skuIdFromRecord(variant: Record<string, unknown>) {
  return textValue(
    variant.skuId ??
      variant.sku_id ??
      variant.sourceSkuId ??
      variant.source_sku_id ??
      variant.productId ??
      variant.product_id ??
      variant.id,
  );
}

function selectedProductDataForAi(
  scrapedData: Record<string, unknown>,
): Record<string, unknown> {
  const selection = recordValue(scrapedData.skuSelection);
  const selectedSkuIds = new Set(
    (Array.isArray(selection.selectedSkuIds)
      ? selection.selectedSkuIds
      : []
    )
      .map(textValue)
      .filter(Boolean),
  );
  if (!selectedSkuIds.size) return sanitizeProductJsonForAi(scrapedData);

  const filterVariants = (value: unknown) =>
    Array.isArray(value)
      ? value
          .map(recordValue)
          .filter((variant) => selectedSkuIds.has(skuIdFromRecord(variant)))
      : value;
  const detailCapture = recordValue(scrapedData.detailCapture);
  const selectedVariants = filterVariants(scrapedData.variants);

  return sanitizeProductJsonForAi({
    ...scrapedData,
    variants: selectedVariants,
    ...(Array.isArray(scrapedData.rawVariants)
      ? { rawVariants: filterVariants(scrapedData.rawVariants) }
      : {}),
    ...(Object.keys(detailCapture).length
      ? {
          detailCapture: {
            ...detailCapture,
            ...(Array.isArray(detailCapture.variants)
              ? { variants: filterVariants(detailCapture.variants) }
              : {}),
          },
        }
      : {}),
    selectedVariant:
      Array.isArray(selectedVariants) && selectedVariants.length === 1
        ? selectedVariants[0]
        : null,
  });
}

function sourceSkuIds(scrapedData: Record<string, unknown>) {
  const selectedSkuIds = new Set(
    (Array.isArray(recordValue(scrapedData.skuSelection).selectedSkuIds)
      ? (recordValue(scrapedData.skuSelection).selectedSkuIds as unknown[])
      : []
    ).map(textValue).filter(Boolean),
  );
  const variants = Array.isArray(scrapedData.variants)
    ? scrapedData.variants.map(recordValue)
    : [];
  const preferredVariants = selectedSkuIds.size
    ? variants.filter((variant) =>
        selectedSkuIds.has(
          textValue(
            variant.skuId ??
              variant.sku_id ??
              variant.sourceSkuId ??
              variant.source_sku_id ??
              variant.productId ??
              variant.product_id,
          ),
        ),
      )
    : variants;
  return Array.from(
    new Set(
      preferredVariants
        .map((variant) =>
          textValue(
            variant.skuId ??
              variant.sku_id ??
              variant.sourceSkuId ??
              variant.source_sku_id ??
              variant.productId ??
              variant.product_id,
          ),
        )
        .filter(Boolean),
    ),
  );
}

function assertResponseMatchesSourceProduct(
  scrapedData: Record<string, unknown>,
  mapping: OzonAiMapping,
) {
  const expectedSkuIds = sourceSkuIds(scrapedData);
  if (!expectedSkuIds.length) return;

  const returnedSkuIds = Array.from(
    new Set(mapping.variants.map((variant) => variant.skuKey.trim()).filter(Boolean)),
  );
  // 单 SKU 商品允许 AI 只返回公共属性。此时没有变体数组并不代表
  // 附件串单；公共属性仍会由 feature-draft 写入当前选中的唯一 SKU 商品。
  if (expectedSkuIds.length === 1 && returnedSkuIds.length === 0) return;
  const expected = new Set(expectedSkuIds);
  const returned = new Set(returnedSkuIds);
  const unknownSkuIds = returnedSkuIds.filter((skuId) => !expected.has(skuId));
  const missingSkuIds = expectedSkuIds.filter((skuId) => !returned.has(skuId));
  if (unknownSkuIds.length || missingSkuIds.length) {
    throw new Error(
      `快速模式返回的 SKU 与本次商品附件不一致（缺少 ${missingSkuIds.length} 个，出现 ${unknownSkuIds.length} 个未知 SKU），本次结果已拦截。`,
    );
  }
}

function safeFileSegment(value: unknown, fallback: string) {
  const normalized = textValue(value)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

async function cachedCompletionText(
  auditDirectory: string,
  productJsonSha256: string,
  featureFillMode: string,
  fallbackCategory: OzonCategoryIds | null,
  scrapedData: Record<string, unknown>,
) {
  try {
    const names = (await fs.readdir(auditDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    const recent = await Promise.all(
      names.map(async (name) => ({
        name,
        mtimeMs: (await fs.stat(path.join(auditDirectory, name))).mtimeMs,
      })),
    );
    recent.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const entry of recent.slice(0, 500)) {
      const audit = JSON.parse(
        await fs.readFile(path.join(auditDirectory, entry.name), "utf8"),
      ) as Record<string, unknown>;
      if (
        textValue(audit.productJsonSha256) !== productJsonSha256 ||
        textValue(audit.featureFillMode) !== featureFillMode
      ) {
        continue;
      }
      const completionText = textValue(audit.completionText);
      if (!completionText) continue;
      const mapping = mapOzonAiResponse(completionText);
      try {
        assertResponseMatchesSourceProduct(scrapedData, mapping);
      } catch {
        // Keep the audit for diagnosis, but never replay a response that was
        // already proven to contain another product's SKU identifiers.
        continue;
      }
      if (
        mapping.recognized &&
        ((mapping.category.descriptionCategoryId &&
          mapping.category.typeId) ||
          fallbackCategory)
      ) {
        return {
          completionText,
          requestId: textValue(audit.requestId),
        };
      }
    }
  } catch {
    // 缓存缺失或单个审计文件损坏时，继续走新的浏览器 AI 请求。
  }
  return null;
}

function canonicalUploadFeature(attribute: OzonMappedAttribute) {
  const values = attribute.values.flatMap((entry) =>
    entry.value?.trim() ? [entry.value.trim()] : [],
  );
  const value = values.length > 1 ? values : values[0] || attribute.value;
  const dictionaryValueId =
    attribute.values.length === 1
      ? positiveInteger(attribute.values[0]?.dictionary_value_id)
      : null;
  return {
    attributeId: attribute.attributeId,
    value,
    ...(dictionaryValueId
      ? { dictionary_value_id: dictionaryValueId }
      : {}),
  };
}

function canonicalFeatureResponse(mapping: OzonAiMapping) {
  const validAttributes = (attributes: OzonMappedAttribute[]) =>
    attributes.filter((attribute) => /^\d+$/.test(attribute.attributeId));
  const commonAttributes = validAttributes(mapping.attributes);
  const sharedAttributes =
    commonAttributes.length || mapping.variants.length !== 1
      ? commonAttributes
      : validAttributes(mapping.variants[0].attributes);
  const uploadFeatures = sharedAttributes.map(
    canonicalUploadFeature,
  );
  const displayFeatures = sharedAttributes.map(
    (attribute) => ({
      attributeId: attribute.attributeId,
      keyZh: attribute.label,
      valueZh: attribute.displayValue || attribute.value,
    }),
  );
  const variants = mapping.variants.map((variant) => {
    const attributes = validAttributes(variant.attributes);
    return {
      skuId: variant.skuKey,
      specLine:
        variant.specLine ||
        attributes
          .map((attribute) => `${attribute.label}=${attribute.value}`)
          .join("｜"),
      uploadFeatures: attributes.map(canonicalUploadFeature),
      displayFeatures: attributes.map((attribute) => ({
        attributeId: attribute.attributeId,
        keyZh: attribute.label,
        valueZh: attribute.displayValue || attribute.value,
      })),
    };
  });
  return JSON.stringify({
    variants,
    uploadFeatures,
    displayFeatures,
    notes: mapping.notes,
  });
}

function mergeBaseFields(
  features: Array<Record<string, unknown>>,
  mapping: OzonAiMapping,
  category: FeatureDraftResult["category"],
) {
  const baseById = new Map(
    mapping.baseFields.map((field) => [field.id, field]),
  );
  return features.map((feature) => {
    if (feature.group !== "base") return feature;
    const id = String(feature.attributeId || "").replace(/^base:/, "");
    const mapped = baseById.get(
      id as (typeof mapping.baseFields)[number]["id"],
    );
    const categoryValue =
      id === "category_type" && category
        ? `${category.label} / ${category.descriptionCategoryId ?? "-"} / ${category.typeId ?? "-"}`
        : "";
    const value = categoryValue || mapped?.value || "";
    if (!value) return feature;
    if (feature.source === "业务默认" && String(feature.value || "").trim()) {
      return feature;
    }
    return {
      ...feature,
      value,
      confidence: 0.94,
      status: "review",
      source: "China Product to Ozon 快速模式",
      reason: "由快速模式返回的严格 Ozon JSON 自动回填。",
    };
  });
}

async function readFeatureDraftResponse(response: Response) {
  const payload = (await response.json()) as ApiEnvelope<FeatureDraftResult>;
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(
      payload.error?.message || `特征草稿解析接口返回 ${response.status}`,
    );
  }
  return payload.data;
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

  return runProcessingFifo("feature", workflowContext, async () => {
    let temporaryDirectory = "";
    try {
    const providerId = LISTING_QUICK_MODE_PROVIDER_ID;
    const model = LISTING_QUICK_MODE_MODEL_ID;
    const featureFillMode = listingFeatureFillModeConfig(
      input.featureFillMode,
    );

    const requestId = crypto.randomUUID();
    const aiProductData = selectedProductDataForAi(input.scrapedData);
    const serializedProduct = JSON.stringify(aiProductData, null, 2);
    const productJsonSha256 = crypto
      .createHash("sha256")
      .update(serializedProduct)
      .digest("hex");
    const productOfferId = textValue(
      aiProductData.offerId ??
        aiProductData.offerId1688 ??
        aiProductData.productId,
    );
    const productTitle = textValue(aiProductData.title);
    const attachmentFileName = [
      "product",
      safeFileSegment(productOfferId, "unknown"),
      productJsonSha256.slice(0, 10),
      requestId.slice(0, 8),
    ].join("-") + ".json";

    temporaryDirectory = path.resolve(
      process.cwd(),
      "storage",
      "listing-quick-mode",
      requestId,
    );
    await fs.mkdir(temporaryDirectory, { recursive: true });
    const jsonFilePath = path.join(temporaryDirectory, attachmentFileName);
    await fs.writeFile(jsonFilePath, serializedProduct, "utf8");

    console.info("[listing-quick-mode] sending product attachment", {
      requestId,
      productOfferId,
      productTitle,
      attachmentFileName,
      productJsonChars: serializedProduct.length,
      productJsonSha256,
      sourceSkuCount: sourceSkuIds(aiProductData).length,
    });

    const auditDirectory = path.resolve(
      process.cwd(),
      "storage",
      "listing-quick-mode-audit",
    );
    await fs.mkdir(auditDirectory, { recursive: true });
    const cached = input.precomputedAiText
      ? null
      : await cachedCompletionText(
          auditDirectory,
          productJsonSha256,
          featureFillMode.id,
          petToyFallbackCategory(input.scrapedData),
          aiProductData,
        );
    const completionText = input.precomputedAiText ||
      cached?.completionText ||
      await generateBrowserText({
        model,
        systemPrompt: "",
        userPrompt: featureFillMode.prompt,
        files: [jsonFilePath],
        // 特征返回不设截止时间；页面导航、输入和附件上传仍各自保留操作超时。
        timeoutMs: null,
      });
    await fs.writeFile(
      path.join(auditDirectory, `${requestId}.json`),
      JSON.stringify(
        {
          requestId,
          generatedAt: new Date().toISOString(),
          productOfferId,
          productTitle,
          productJsonSha256,
          featureFillMode: featureFillMode.id,
          precomputed: Boolean(input.precomputedAiText),
          cachedFromRequestId: cached?.requestId || null,
          categoryFallback: petToyFallbackCategory(input.scrapedData),
          completionText,
        },
        null,
        2,
      ),
      "utf8",
    );
    const mapping = mapOzonAiResponse(completionText);
    assertResponseMatchesSourceProduct(aiProductData, mapping);
    const fallbackCategory = petToyFallbackCategory(input.scrapedData);
    const descriptionCategoryId =
      mapping.category.descriptionCategoryId ??
      fallbackCategory?.descriptionCategoryId ??
      null;
    const typeId =
      mapping.category.typeId ?? fallbackCategory?.typeId ?? null;
    if (descriptionCategoryId && typeId) {
      mapping.category = { descriptionCategoryId, typeId };
    }
    if (!mapping.recognized || !descriptionCategoryId || !typeId) {
      throw new Error(
        "快速模式返回的 JSON 缺少可识别的 description_category_id、type_id 或商品特征。",
      );
    }

    const categoryRecord = await prisma.ozonCategory.findFirst({
      where: {
        descriptionCategoryId,
        typeId,
        disabled: false,
      },
      orderBy: [{ isLeaf: "desc" }, { depth: "desc" }],
    });
    if (!categoryRecord) {
      throw new Error(
        `本地 Ozon 类目库未找到 ${descriptionCategoryId}/${typeId}。`,
      );
    }

    const featureResult = await readFeatureDraftResponse(
      await fetch(
        new URL("/api/listing-workflow/feature-draft", request.nextUrl.origin),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scrapedData: aiProductData,
            categoryId: categoryRecord.id,
            providerId,
            model,
            precomputedAiText: canonicalFeatureResponse(mapping),
          }),
          cache: "no-store",
        },
      ),
    );

    const generatedAt = new Date().toISOString();
    const category = featureResult.category;
    const features = mergeBaseFields(featureResult.features, mapping, category);
    const aiResponse = {
      text: completionText,
      providerId: BROWSER_AI_PROVIDER_ID,
      providerName: BROWSER_AI_PROVIDER_NAME,
      model,
      generatedAt,
      ozonMapping: mapping,
      categoryMatch: {
        providerId: BROWSER_AI_PROVIDER_ID,
        model,
        status: "matched",
        preparedProduct: featureResult.preparedProduct ?? {},
        confidence: 0.94,
        reason: "China Product to Ozon 快速模式一次返回类目和特征。",
        completedAt: generatedAt,
      },
      quickMode: {
        status: "done",
        mode: featureFillMode.id,
        modeLabel: featureFillMode.label,
        prompt: featureFillMode.prompt,
        requestId,
        attachedJsonFile: attachmentFileName,
        attachedDatabase: false,
        productJsonSha256,
        productTitle,
        productOfferId,
        sourceSkuCount: sourceSkuIds(aiProductData).length,
        completedAt: generatedAt,
      },
    };

    const result = {
      ...featureResult,
      category,
      features,
      aiStatus: {
        ok: featureResult.aiStatus.ok,
        message: featureResult.aiStatus.ok
          ? `快速模式已一次完成类目和特征处理：${category?.label || `${descriptionCategoryId}/${typeId}`}。`
          : featureResult.aiStatus.message,
      },
      notes: [
        ...(featureResult.notes ?? []),
        "已上传商品 JSON；dev.db 保留在本地，由 China Product to Ozon skill 读取。",
      ],
      aiResponse,
      quickMode: {
        mode: featureFillMode.id,
        modeLabel: featureFillMode.label,
        prompt: featureFillMode.prompt,
        requestId,
        productJsonChars: serializedProduct.length,
        productJsonSha256,
        productTitle,
        productOfferId,
        sourceSkuCount: sourceSkuIds(aiProductData).length,
        attachedFiles: [attachmentFileName],
      },
    };
    await persistWorkflowFeatureResult(workflowContext, result);
    return ok(result);
    } catch (error) {
      if (workflowContext) {
        const message = error instanceof Error ? error.message : "特征匹配请求异常";
        await persistWorkflowFeatureFailure(workflowContext, message).catch(
          () => undefined,
        );
      }
      return handleRouteError(error);
    } finally {
      if (temporaryDirectory) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }).catch(handleRouteError);
}
