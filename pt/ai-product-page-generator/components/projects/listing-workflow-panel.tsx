"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Eye,
  ExternalLink,
  History,
  KeyRound,
  Languages,
  Loader2,
  MoreVertical,
  PackageCheck,
  PauseCircle,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Video,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useDismissOnOutside } from "@/components/shared/use-dismiss-on-outside";
import { OzonApiConfigPanel } from "@/components/ozon/ozon-api-config-panel";
import { ModelChoiceSelect } from "@/components/projects/model-choice-select";
import {
  TextPromptResponseDialog,
  type TextPromptResponse,
} from "@/components/projects/text-prompt-response-dialog";
import { StageAiPromptDialog } from "@/components/projects/stage-ai-prompt-dialog";
import { TextSystemPromptDialog } from "@/components/projects/text-system-prompt-dialog";
import {
  WorkflowImageDialog,
  WorkflowImageField,
  WORKFLOW_IMAGE_LIMIT,
  type ManagedWorkflowImage,
  type WorkflowImageDialogMode,
  workflowImagesToOzonPayload,
} from "@/components/projects/workflow-image-tools";
import type { CrawlerLaunchResult, CrawlerScanResult } from "@/lib/crawlers/registry";
import type { ProductCollectResult } from "@/lib/crawlers/collect";
import type { ListingWorkflowCapabilities, WorkflowCapability } from "@/lib/listing-workflow/capabilities";
import {
  LISTING_FEATURE_MODEL_STORAGE_KEY,
  LISTING_IMAGE_MODEL_STORAGE_KEY,
  LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY,
  parseListingModelSelection,
  type ListingWorkflowItem,
  type ListingWorkflowStage,
} from "@/lib/listing-workflow/items";
import {
  applySkuSelectionToJson,
  extractProductSkuOptions,
  type ProductSkuOption,
} from "@/lib/listing-workflow/skus";
import {
  DEFAULT_LISTING_STAGE_AI_PROMPTS,
  DEFAULT_LISTING_TEXT_SYSTEM_PROMPT,
  LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
  buildDefaultListingImagePrompt,
  normalizeListingStageAiPrompts,
  type ListingImageAspectRatio,
  type ListingStageAiPromptConfig,
} from "@/lib/listing-workflow/text-prompts";
import {
  mapOzonAiResponse,
  type OzonAiMapping,
  type OzonAiVariantMapping,
  type OzonBaseFieldId,
  type OzonMappedAttribute,
  type OzonMappedAttributeValue,
} from "@/lib/ozon/ai-response-mapper";
import {
  findOzonCategoryAttribute,
  normalizeOzonAttributeMatchKey,
} from "@/lib/ozon/attribute-match";
import { ozonListingBaseFields, type OzonAttributeNode } from "@/lib/ozon/feature-tree";
import type {
  OzonAttributeValueSnapshot,
  OzonFeatureSnapshot,
} from "@/lib/ozon/snapshot";
import type { ApiResponseShape } from "@/lib/utils/api";

type CrawlerAction = "launch_marketspider_ui" | "launch_taobao_spider" | "launch_jd_spider" | "launch_1688_spider";
export type WorkflowImageBucketKey = "MAIN" | "ANGLE" | "DETAIL" | "REFERENCE";
export type WorkflowImageItem = {
  name: string;
  url: string;
};
export type WorkflowImageBuckets = Record<WorkflowImageBucketKey, WorkflowImageItem[]>;

type ProductDetailMediaItem = {
  type: "image" | "video";
  url: string;
};

type ProductDetailContent = {
  text: string;
  media: ProductDetailMediaItem[];
  imageCount: number;
  videoCount: number;
};

function productDetailMediaKey(item: ProductDetailMediaItem) {
  return `${item.type}:${item.url}`;
}

type ProviderModelOption = {
  modelId: string;
  label: string;
  capabilities: Record<string, unknown>;
  isAvailable: boolean;
  isDefaultAnalysis?: boolean;
  isDefaultHeroImage?: boolean;
  isDefaultDetailImage?: boolean;
  isDefaultImageEdit?: boolean;
};

type ProviderOption = {
  id: string;
  name: string;
  baseUrl?: string;
  isActive: boolean;
  source?: "api" | "browser";
  models: ProviderModelOption[];
};

type ProviderModelChoice = ProviderModelOption & {
  providerId: string;
  providerName: string;
  providerIsActive: boolean;
  source: "api" | "browser";
};

type ListingFeatureDraft = {
  attributeId: string;
  label: string;
  displayLabel?: string;
  value: string;
  confidence: number;
  required: boolean;
  group: "base" | "category" | "source";
  ozonCode: string | null;
  valueType: string | null;
  status: "auto" | "review" | "missing";
  source: string;
  reason: string;
  dictionaryValueCount: number;
  options: string[];
  optionMappings?: Array<{
    label: string;
    value: string;
    dictionaryValueId?: number;
  }>;
  ozonComplexId?: number;
  ozonAttributeValues?: OzonMappedAttributeValue[];
  aiJsonKey?: string;
  aiJsonPath?: string;
  aiJsonValue?: string;
};

type FeatureDraftResponse = {
  category: {
    id: string;
    label: string;
    path: string[];
    descriptionCategoryId: number | null;
    typeId: number | null;
  } | null;
  features: ListingFeatureDraft[];
  aiStatus: {
    ok: boolean;
    message: string;
  };
  notes: string[];
  aiResponse?: TextPromptResponse | null;
  preparedProduct?: Record<string, unknown>;
  promptAudit?: {
    rawBytes: number;
    preparedBytes: number;
    removedUrlCount: number;
    removedImageReferenceCount: number;
    factCount: number;
    variantCount: number;
    jsonRepaired?: boolean;
    returnedAttributeCount?: number;
    attributeCount?: number;
    requiredFilled?: number;
    requiredCount?: number;
  };
};

type CategoryMatchResponse = {
  category: {
    id: string;
    label: string;
    path: string[];
    descriptionCategoryId: number | null;
    typeId: number | null;
    score: number;
  } | null;
  candidates: Array<{
    id: string;
    label: string;
    path: string[];
    descriptionCategoryId: number | null;
    typeId: number | null;
    score: number;
  }>;
  aiStatus: {
    ok: boolean;
    message: string;
  };
  confidence: number;
  reason: string;
  preparedProduct: Record<string, unknown>;
  aiDecision?: Record<string, unknown>;
  categoryCorrection?: Record<string, unknown> | null;
  promptAudit: {
    rawBytes: number;
    preparedBytes: number;
    removedUrlCount: number;
    removedImageReferenceCount: number;
    factCount: number;
    variantCount: number;
    jsonRepaired?: boolean;
  };
};

type ApiUsagePreviewEntry = {
  id: string;
  timestamp: string;
  category: string;
  success: boolean;
  statusCode: number;
  durationMs: number;
  model: string | null;
  operation: string | null;
  totalTokens: number | null;
  actualCostUsd: number | null;
  quotaState: string;
  errorMessage: string | null;
};

type ApiUsagePreviewResponse = {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  imageRequests: number;
  recentEntries: ApiUsagePreviewEntry[];
};

type ListingImageGenerateResponse = {
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
};

type ListingAtlasTranslateResponse = {
  engine: string;
  atlasCount: number;
  imageCount: number;
  images: Array<{
    id: string;
    name: string;
    fileName: string;
    filePath: string;
    imageUrl: string;
    mimeType: string;
    atlasIndex: number;
  }>;
  sourceText: string;
  translatedText: string;
};

const crawlerActions: Record<string, CrawlerAction> = {
  taobao: "launch_taobao_spider",
  jd: "launch_jd_spider",
  "1688": "launch_1688_spider",
};

async function readApi<T>(response: Response) {
  const payload = (await response.json()) as ApiResponseShape<T>;
  if (!payload.success || !payload.data) {
    throw new Error(payload.error?.message ?? "请求失败");
  }
  return payload.data;
}

function detectPlatform(url: string) {
  const normalized = url.trim().toLowerCase();
  if (!normalized) return { key: "unknown", label: "待输入", action: "launch_marketspider_ui" as CrawlerAction };
  if (normalized.includes("taobao.com") || normalized.includes("tmall.com")) return { key: "taobao", label: "淘宝 / 天猫", action: crawlerActions.taobao };
  if (normalized.includes("jd.com") || normalized.includes("360buy.com")) return { key: "jd", label: "京东", action: crawlerActions.jd };
  if (normalized.includes("1688.com")) return { key: "1688", label: "1688", action: crawlerActions["1688"] };
  return { key: "unknown", label: "未识别平台", action: "launch_marketspider_ui" as CrawlerAction };
}

function safeParseJson(text: string) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCrawlerImageUrl(url: string) {
  return url.replace(/\.(?:search|summ|310x310|220x220|100x100|64x64)(?=\.(?:jpg|jpeg|png|webp)(?:$|\?))/gi, "");
}

function imageValue(value: unknown) {
  if (typeof value === "string") return normalizeCrawlerImageUrl(value.trim());
  const record = asRecord(value);
  const url = textValue(record.src) || textValue(record.url) || textValue(record.imageUrl) || textValue(record.imgUrl);
  return url ? normalizeCrawlerImageUrl(url) : "";
}

function uniqueImageCount(values: unknown[]) {
  const urls = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = imageValue(item);
        if (url) urls.add(url);
      }
      continue;
    }

    const url = imageValue(value);
    if (url) urls.add(url);
  }
  return urls.size;
}

function uniqueImages(values: unknown[]) {
  const urls = new Set<string>();
  const images: WorkflowImageItem[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const url = imageValue(candidate);
      if (!url || urls.has(url)) continue;
      urls.add(url);
      images.push({
        url,
        name: `crawler-${String(images.length + 1).padStart(2, "0")}.jpg`,
      });
    }
  }
  return images;
}

function splitAttachmentImages(images: WorkflowImageItem[]) {
  const result: Pick<WorkflowImageBuckets, "ANGLE" | "DETAIL" | "REFERENCE"> = {
    ANGLE: [],
    DETAIL: [],
    REFERENCE: [],
  };
  const keys = ["ANGLE", "DETAIL", "REFERENCE"] as const;
  let cursor = 0;
  for (const image of images) {
    result[keys[cursor % keys.length]].push(image);
    cursor += 1;
  }
  return result;
}

function buildWorkflowImageBuckets(data: Record<string, unknown>): WorkflowImageBuckets {
  const gallery = asRecord(data.gallery);
  const productImages = uniqueImages([
    gallery.coverImage,
    gallery.images,
    data.primary_image,
    data.main_image,
    data.mainImage,
    data.pic_url,
    data.image,
    data.item_image,
    data.images,
    data.item_images,
    data.pictures,
  ]);

  const attachments = splitAttachmentImages(productImages.slice(1));
  return {
    MAIN: productImages.slice(0, 1),
    ...attachments,
  };
}

function detailMediaUrl(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.startsWith("//")) return `https:${normalized}`;
    return normalized;
  }
  const record = asRecord(value);
  const nested =
    record.src ??
      record.url ??
      record.videoUrl ??
      record.videoURL ??
      record.playUrl ??
      record.imageUrl;
  return nested === undefined ? "" : detailMediaUrl(nested);
}

function buildProductDetailContent(data: Record<string, unknown> | null): ProductDetailContent {
  if (!data) return { text: "", media: [], imageCount: 0, videoCount: 0 };
  const description = asRecord(data.description);
  const media: ProductDetailMediaItem[] = [];
  const seen = new Set<string>();

  function add(type: ProductDetailMediaItem["type"], value: unknown) {
    const url = detailMediaUrl(value);
    if (!url || seen.has(`${type}:${url}`)) return;
    seen.add(`${type}:${url}`);
    media.push({ type, url });
  }

  for (const item of asArray(description.media)) {
    const record = asRecord(item);
    const type = textValue(record.type).toLowerCase() === "video" ? "video" : "image";
    add(type, record);
  }
  for (const item of [
    ...asArray(description.images),
    ...asArray(data.detailImages),
    ...asArray(data.detail_images),
  ]) {
    add("image", item);
  }
  for (const item of [
    ...asArray(description.videos),
    ...asArray(data.detailVideos),
    ...asArray(data.detail_videos),
    data.videoUrl,
    data.video,
  ]) {
    add("video", item);
  }

  return {
    text: textValue(description.text) || textValue(data.descriptionText),
    media,
    imageCount: media.filter((item) => item.type === "image").length,
    videoCount: media.filter((item) => item.type === "video").length,
  };
}

function firstText(data: Record<string, unknown> | null, keys: string[]) {
  if (!data) return "";
  for (const key of keys) {
    const value = textValue(data[key]);
    if (value) return value;
  }
  return "";
}

function collectImageCount(data: Record<string, unknown> | null) {
  if (!data) return 0;
  const gallery = asRecord(data.gallery);
  return uniqueImageCount([
    data.primary_image,
    data.main_image,
    data.mainImage,
    data.pic_url,
    data.image,
    data.item_image,
    gallery.coverImage,
    data.images,
    data.item_images,
    gallery.images,
    data.pictures,
  ]);
}

function extractAiSkuOptions(
  variants: OzonAiVariantMapping[],
): ProductSkuOption[] {
  const valuesByAttribute = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const attribute of variant.attributes) {
      const key = attribute.jsonKey || attribute.label || attribute.attributeId;
      if (!key || !attribute.value) continue;
      const values = valuesByAttribute.get(key) ?? new Set<string>();
      values.add(attribute.value);
      valuesByAttribute.set(key, values);
    }
  }

  const preferredSpecPattern =
    /(颜色|色号|尺寸|尺码|规格|型号|款式|容量|数量|color|size|spec|model|style|capacity)/i;

  return variants.map((variant, index) => {
    const varyingAttributes = variant.attributes.filter((attribute) => {
      const key = attribute.jsonKey || attribute.label || attribute.attributeId;
      return (valuesByAttribute.get(key)?.size ?? 0) > 1;
    });
    const preferredAttributes = variant.attributes.filter((attribute) =>
      preferredSpecPattern.test(
        `${attribute.jsonKey || ""} ${attribute.label || ""}`,
      ),
    );
    const specAttributes = [...varyingAttributes, ...preferredAttributes]
      .filter(
        (attribute, attributeIndex, attributes) =>
          attributes.findIndex(
            (candidate) =>
              (candidate.jsonKey || candidate.label || candidate.attributeId) ===
              (attribute.jsonKey || attribute.label || attribute.attributeId),
          ) === attributeIndex,
      )
      .slice(0, 8);
    const specs = Object.fromEntries(
      specAttributes.map((attribute) => [
        attribute.jsonKey || attribute.label || attribute.attributeId,
        attribute.value,
      ]),
    );
    const id =
      variant.skuKey ||
      variant.offerId ||
      `ai-sku-${variant.index || index + 1}`;
    const specText =
      Object.entries(specs)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" / ") ||
      variant.name ||
      `AI SKU ${index + 1}`;
    const raw =
      variant.importItem ??
      ({
        offer_id: variant.offerId || id,
        name: variant.name,
        price: variant.price,
        attributes: variant.attributes,
        primary_image: variant.images.primaryImage,
        images: variant.images.images,
      } satisfies Record<string, unknown>);

    return {
      id,
      title: variant.name || specText,
      price: variant.price,
      stock: null,
      specText,
      specs,
      images: [
        variant.images.primaryImage,
        ...variant.images.images,
      ].filter(Boolean),
      raw,
      source: "ai",
    };
  });
}

function findAiVariantForSku(
  option: ProductSkuOption,
  aiVariants: OzonAiVariantMapping[],
  fallbackIndex: number,
) {
  const direct = aiVariants.find(
    (variant) =>
      variant.skuKey === option.id || variant.offerId === option.id,
  );
  if (direct) return direct;

  const specValues = Object.values(option.specs)
    .map(normalizeOzonAttributeMatchKey)
    .filter(Boolean);
  const ranked = aiVariants
    .map((variant) => {
      const haystack = normalizeOzonAttributeMatchKey(
        `${variant.name} ${variant.offerId} ${variant.skuKey}`,
      );
      return {
        variant,
        score: specValues.filter((value) => haystack.includes(value)).length,
      };
    })
    .sort((left, right) => right.score - left.score);
  if (
    ranked[0]?.score &&
    (!ranked[1] || ranked[0].score > ranked[1].score)
  ) {
    return ranked[0].variant;
  }
  return aiVariants[fallbackIndex];
}

function capabilityById(capabilities: ListingWorkflowCapabilities | null, id: WorkflowCapability["id"]) {
  return capabilities?.capabilities.find((capability) => capability.id === id) ?? null;
}

function isImageModel(model: ProviderModelOption) {
  return Boolean(model.capabilities.image_gen || model.capabilities.image_edit);
}

function isFeatureModel(model: ProviderModelOption) {
  return model.isAvailable !== false && Boolean(model.capabilities.text || model.capabilities.structured_output || model.capabilities.vision) && !isImageModel(model);
}

function isImageGenerationModel(model: ProviderModelOption) {
  return model.isAvailable !== false && Boolean(model.capabilities.image_gen || model.capabilities.image_edit);
}

function modelCapabilityText(model: ProviderModelOption | null) {
  if (!model) return "未选择模型";
  const labels = [
    model.capabilities.text ? "文本" : null,
    model.capabilities.structured_output ? "结构化" : null,
    model.capabilities.vision ? "视觉" : null,
    model.capabilities.image_gen ? "生图" : null,
    model.capabilities.image_edit ? "改图" : null,
  ].filter(Boolean);
  return labels.length ? labels.join(" / ") : "能力未知";
}

const modelChoiceDivider = "\u001F";
const textPromptStorageKey = "banana-mall:listing-workflow:text-prompt";
const textSystemPromptStorageKey = "banana-mall:listing-workflow:text-system-prompt";
const textPromptResponseStorageKey =
  "banana-mall:listing-workflow:text-prompt-response";

function readActiveWorkflowItemId() {
  try {
    return window.localStorage.getItem(LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function rememberActiveWorkflowItem(itemId: string) {
  if (!itemId) return;
  try {
    window.localStorage.setItem(LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY, itemId);
  } catch {
    // 本地存储不可用时，URL 中的 item 参数仍可恢复当前商品。
  }
}

function forgetActiveWorkflowItem(itemId?: string) {
  try {
    const current = window.localStorage.getItem(LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY);
    if (!itemId || current === itemId) {
      window.localStorage.removeItem(LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY);
    }
  } catch {
    // 本地存储不可用时忽略。
  }
}

function modelChoiceValue(providerId: string, modelId: string) {
  return `${providerId}${modelChoiceDivider}${modelId}`;
}

function modelChoiceLabel(choice: ProviderModelChoice) {
  return `${choice.providerName}${choice.providerIsActive ? " / 默认" : ""} / ${choice.label || choice.modelId}`;
}

function collectModelChoices(providers: ProviderOption[], predicate: (model: ProviderModelOption) => boolean) {
  return providers.flatMap((provider) =>
    provider.models.filter(predicate).map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.name,
      providerIsActive: provider.isActive,
      source: provider.source ?? "api",
    })),
  );
}

function confidenceText(value: number) {
  return `${Math.round(value * 100)}%`;
}

function featureStatusLabel(status: ListingFeatureDraft["status"]) {
  if (status === "auto") return "自动填写";
  if (status === "missing") return "缺失必填";
  return "待复核";
}

function featureStatusVariant(status: ListingFeatureDraft["status"]) {
  if (status === "auto") return "success" as const;
  if (status === "missing") return "destructive" as const;
  return "warning" as const;
}

function featureGroupMeta(group: ListingFeatureDraft["group"]) {
  if (group === "base") {
    return {
      label: "基础上架表",
      description: "所有商品都会先填写这些通用字段，后续上架接口会直接消费。",
      variant: "success" as const,
    };
  }
  if (group === "category") {
    return {
      label: "类目特殊特征",
      description: "匹配到具体 Ozon 类目后展示该类目的必填、字典和条件属性。",
      variant: "warning" as const,
    };
  }
  return {
    label: "补充特征",
    description: "类目字段不足时，保留商品源信息中的可用字段，方便人工编辑和后续映射。",
    variant: "outline" as const,
  };
}

function usageCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    models: "模型列表",
    chat: "文本",
    structured: "结构化",
    image_generation: "生图",
    image_edit: "改图",
    google_generate_content: "Gemini",
    unknown: "其他",
  };
  return labels[category] ?? category;
}

function usageTimeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function buildDefaultListingTextPrompt() {
  return [
    "只依据采集到的商品事实和 Ozon 字段要求生成内容，不要编造品牌、材质、规格或认证信息。",
    "优先输出准确、简洁、可直接人工复核的中文字段；不确定的信息请降低置信度并说明原因。",
  ].join("\n");
}

function canEditFeatureName(feature: ListingFeatureDraft) {
  return feature.group === "source" || feature.attributeId.startsWith("custom-");
}

function baseFeatureId(feature: ListingFeatureDraft) {
  return feature.attributeId.replace(/^base:/, "");
}

function baseFeatureValue(
  features: ListingFeatureDraft[],
  id: OzonBaseFieldId | "cost_price",
) {
  return (
    features.find(
      (feature) =>
        feature.group === "base" && baseFeatureId(feature) === id,
    )?.value ?? ""
  );
}

function firstWorkflowImage(data: Record<string, unknown>) {
  const buckets = buildWorkflowImageBuckets(data);
  return (
    buckets.MAIN[0]?.url ||
    buckets.ANGLE[0]?.url ||
    buckets.DETAIL[0]?.url ||
    buckets.REFERENCE[0]?.url ||
    ""
  );
}

function firstProductPrice(data: Record<string, unknown>) {
  const direct = firstText(data, [
    "price",
    "salePrice",
    "sale_price",
    "currentPrice",
    "current_price",
    "discountPrice",
    "discount_price",
    "minPrice",
    "min_price",
  ]);
  if (direct) return direct;

  const priceData = asRecord(data.price_data ?? data.priceData);
  const nested = textValue(
    priceData.purchase_price_cny ??
      priceData.purchasePriceCny ??
      priceData.price ??
      priceData.sale_price ??
      priceData.salePrice ??
      priceData.current_price ??
      priceData.currentPrice,
  );
  if (nested) return nested;

  return extractProductSkuOptions(data)[0]?.price ?? "";
}

const baseFeatureSectionOrder = [
  {
    title: "商品信息",
    ids: ["name", "category_type", "offer_id", "barcode", "brand", "tags", "short_description", "images"],
  },
  {
    title: "价格",
    ids: ["old_price", "price", "min_price", "cost_price", "currency_code"],
  },
  {
    title: "尺寸和重量",
    ids: ["depth", "width", "height", "dimension_unit", "weight", "weight_unit"],
  },
];

function buildBaseFeatureSections(features: ListingFeatureDraft[]) {
  const byId = new Map(features.map((feature) => [baseFeatureId(feature), feature]));
  const used = new Set<string>();
  const sections = baseFeatureSectionOrder
    .map((section) => {
      const items = section.ids
        .map((id) => {
          const feature = byId.get(id);
          if (feature) used.add(id);
          return feature;
        })
        .filter((feature): feature is ListingFeatureDraft => Boolean(feature));
      return { ...section, items };
    })
    .filter((section) => section.items.length > 0);

  const rest = features.filter((feature) => !used.has(baseFeatureId(feature)));
  if (rest.length > 0) {
    sections.push({ title: "其他", ids: [], items: rest });
  }

  return sections;
}

function isLongBaseField(feature: ListingFeatureDraft) {
  const id = baseFeatureId(feature);
  return feature.valueType === "rich_text" || id === "short_description" || id === "tags";
}

const imageBucketMeta: Record<WorkflowImageBucketKey, { label: string }> = {
  MAIN: { label: "主图" },
  ANGLE: { label: "角度图" },
  DETAIL: { label: "细节图" },
  REFERENCE: { label: "参考图" },
};

function proxiedImageSrc(url: string) {
  if (/^https?:\/\//i.test(url)) {
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function workflowImageGridItems(
  buckets: WorkflowImageBuckets | null | undefined,
  generatedImage: ListingImageGenerateResponse | null | undefined,
) {
  const items: Array<{ id: string; url: string; label: string; name: string }> = [];

  if (generatedImage) {
    items.push({
      id: `generated:${generatedImage.filePath}`,
      url: generatedImage.imageUrl,
      label: "AI 主图",
      name: generatedImage.fileName,
    });
  }

  if (buckets) {
    (["MAIN", "ANGLE", "DETAIL", "REFERENCE"] as const).forEach((bucketKey) => {
      buckets[bucketKey].forEach((image, index) => {
        items.push({
          id: `${bucketKey}:${image.url}:${index}`,
          url: image.url,
          label: imageBucketMeta[bucketKey].label,
          name: image.name,
        });
      });
    });
  }

  return items;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function flattenBaseFields(nodes: OzonAttributeNode[]): OzonAttributeNode[] {
  return nodes.flatMap((node) => {
    const children = flattenBaseFields(node.children ?? []);
    return node.ozonCode || children.length === 0 ? [node, ...children] : children;
  });
}

function baseDefaultValue(field: OzonAttributeNode) {
  if (field.id === "currency_code") return "CNY";
  if (field.id === "weight_unit") return "g";
  if (field.id === "dimension_unit") return "mm";
  if (field.id === "images") return "等待图片处理模块回填";
  return "";
}

function applyWorkflowImageOrder(
  features: ListingFeatureDraft[],
  images: ManagedWorkflowImage[],
) {
  const imagePayload = workflowImagesToOzonPayload(images);
  const value = imagePayload.primary_image
    ? JSON.stringify(imagePayload)
    : "";

  return features.map((feature) =>
    baseFeatureId(feature) === "images"
      ? {
          ...feature,
          value,
          status: imagePayload.primary_image ? "auto" as const : "missing" as const,
          source: imagePayload.primary_image ? "图片排序" : feature.source,
          reason: imagePayload.primary_image
            ? "按当前图片顺序回填，第一张作为 Ozon 主图，其余图片按顺序上传。"
            : feature.reason,
        }
      : feature,
  );
}

function createBaseFeatureDraft(): ListingFeatureDraft[] {
  return flattenBaseFields(ozonListingBaseFields).map((field) => {
    const value = baseDefaultValue(field);
    const required = field.requirement === "required";
    return {
      attributeId: `base:${field.id}`,
      label: field.label,
      value,
      confidence: value ? 0.5 : required ? 0.22 : 0.45,
      required,
      group: "base",
      ozonCode: field.ozonCode ?? null,
      valueType: field.valueType,
      status: value ? "review" : required ? "missing" : "review",
      source: value ? "系统默认" : "基础字段表",
      reason: field.aiHint,
      dictionaryValueCount: 0,
      options: [],
    };
  });
}

function buildCollectedManagedImages(
  scrapedData: Record<string, unknown>,
): ManagedWorkflowImage[] {
  return workflowImageGridItems(buildWorkflowImageBuckets(scrapedData), null).map(
    (image) => ({
      ...image,
      source: "crawler" as const,
    }),
  );
}

function buildFallbackCollectedFeatures(
  scrapedData: Record<string, unknown>,
): ListingFeatureDraft[] {
  const title =
    firstText(scrapedData, [
      "title",
      "name",
      "item_name",
      "productName",
      "goods_name",
      "subject",
    ]) || "未命名商品";
  const price = firstProductPrice(scrapedData);
  const offerId = `OZ-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  const features = createBaseFeatureDraft().map((feature) => {
    const id = baseFeatureId(feature);
    if (id === "name") {
      return {
        ...feature,
        value: title,
        confidence: 0.72,
        status: "review" as const,
        source: "采集 JSON",
        reason: "基础信息回填失败时，先用来源标题生成可进入采集阶段的商品卡。",
      };
    }
    if (id === "offer_id") {
      return {
        ...feature,
        value: offerId,
        confidence: 0.9,
        status: "auto" as const,
        source: "系统随机生成",
        reason: "基础信息回填失败时仍生成独立卖家货号，避免商品卡无法保存。",
      };
    }
    if (id === "cost_price" && price) {
      return {
        ...feature,
        value: price,
        confidence: 0.82,
        status: "review" as const,
        source: "采集 JSON",
        reason: "来源价格先写入成本字段，后续可在采集阶段直接修改售价、折扣价和最低价。",
      };
    }
    if (id === "currency_code") {
      return {
        ...feature,
        value: "CNY",
        confidence: 0.72,
        status: "review" as const,
        source: "系统默认",
        reason: "默认使用 CNY，可按店铺策略修改。",
      };
    }
    return feature;
  });

  return applyWorkflowImageOrder(features, buildCollectedManagedImages(scrapedData));
}

function ozonValueOptionMappings(
  values: OzonAttributeValueSnapshot[],
) {
  return (values ?? []).map((value) => {
    const dictionaryValueId = Number(value.ozonValueId);
    return {
      label: value.valueZh || value.value,
      value: value.value,
      ...(Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
        ? { dictionaryValueId }
        : {}),
    };
  });
}

function mergeOzonAiMappingIntoDraft(
  current: ListingFeatureDraft[],
  mapping: OzonAiMapping,
  snapshot: OzonFeatureSnapshot | null,
) {
  const baseById = new Map(mapping.baseFields.map((field) => [field.id, field]));
  const selectedCategory = snapshot?.selectedCategory ?? null;
  const categoryAttributes = selectedCategory?.attributes ?? [];
  const categoryAttributeById = new Map(
    categoryAttributes.map((attribute) => [
      attribute.ozonAttributeId,
      attribute,
    ]),
  );
  const merged = current.map((feature) => {
    const mapped =
      feature.group === "base"
        ? baseById.get(baseFeatureId(feature) as OzonBaseFieldId)
        : null;
    if (!mapped || (feature.source === "人工修改" && feature.value.trim())) return feature;
    const value =
      mapped.id === "category_type" && selectedCategory
        ? `${selectedCategory.label} / ${selectedCategory.descriptionCategoryId ?? "-"} / ${selectedCategory.typeId ?? "-"}`
        : mapped.value;
    return {
      ...feature,
      value,
      confidence: 0.92,
      status: value ? "review" as const : feature.status,
      source: mapped.source,
      reason: "由文本模型返回的 Ozon JSON 按标准字段名自动匹配。",
    };
  });
  const indexById = new Map<string, number>();
  merged.forEach((feature, index) => {
    indexById.set(feature.attributeId, index);
    if (feature.ozonCode) indexById.set(feature.ozonCode, index);
  });

  for (const mapped of mapping.attributes) {
    const localAttribute =
      categoryAttributeById.get(mapped.attributeId) ??
      findOzonCategoryAttribute(mapped, categoryAttributes);
    const resolvedAttributeId = localAttribute?.ozonAttributeId ?? mapped.attributeId;
    const existingIndex = indexById.get(resolvedAttributeId);
    const resolvedValues = mapped.values.map((value) => {
      if (value.dictionary_value_id || !value.value || !localAttribute) return value;
      const dictionaryValue = localAttribute.values.find(
        (candidate) =>
          normalizeOzonAttributeMatchKey(candidate.value) ===
          normalizeOzonAttributeMatchKey(value.value ?? ""),
      ) ?? (() => {
        const sourceValue = normalizeOzonAttributeMatchKey(value.value ?? "");
        if (sourceValue.length < 3) return undefined;
        const partialMatches = localAttribute.values.filter((candidate) => {
          const candidateValue = normalizeOzonAttributeMatchKey(candidate.value);
          return (
            candidateValue.length >= 3 &&
            (candidateValue.includes(sourceValue) ||
              sourceValue.includes(candidateValue))
          );
        });
        return partialMatches.length === 1 ? partialMatches[0] : undefined;
      })();
      const dictionaryValueId = Number(dictionaryValue?.ozonValueId);
      return Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
        ? { dictionary_value_id: dictionaryValueId, value: value.value }
        : value;
    });
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      if (
        (existing.source === "人工修改" ||
          existing.source === "业务默认") &&
        existing.value.trim()
      ) {
        continue;
      }
      const mappedHasDictionaryId = resolvedValues.some((value) =>
        Number.isSafeInteger(Number(value.dictionary_value_id)),
      );
      const existingHasDictionaryId = existing.ozonAttributeValues?.some(
        (value) =>
          Number.isSafeInteger(Number(value.dictionary_value_id)),
      );
      const uploadValues =
        !mappedHasDictionaryId && existingHasDictionaryId
          ? existing.ozonAttributeValues
          : resolvedValues;
      merged[existingIndex] = {
        ...existing,
        label: localAttribute?.name || mapped.label || existing.label,
        displayLabel:
          existing.displayLabel ||
          localAttribute?.nameZh ||
          localAttribute?.name ||
          mapped.label,
        value: existing.value.trim() || mapped.value,
        confidence: 0.9,
        status: "review",
        source: "AI Ozon JSON",
        reason: localAttribute
          ? "AI 返回的属性 ID 已与当前 Ozon 类目属性表精确匹配。"
          : "AI 返回了可上传的 Ozon 属性 ID，已保留原始 values 结构。",
        ozonCode: localAttribute?.ozonAttributeId || existing.ozonCode || mapped.attributeId,
        valueType: localAttribute?.type || existing.valueType,
        dictionaryValueCount:
          localAttribute?.dictionaryValueCount ?? existing.dictionaryValueCount,
        options: localAttribute
          ? ozonValueOptionMappings(localAttribute.values).map(
              (option) => option.label,
            )
          : existing.options,
        optionMappings: localAttribute
          ? ozonValueOptionMappings(localAttribute.values)
          : existing.optionMappings,
        ozonComplexId: mapped.complexId,
        ozonAttributeValues: uploadValues,
        aiJsonKey: mapped.jsonKey || mapped.label,
        aiJsonPath: mapped.jsonPath || mapped.attributeId,
        aiJsonValue: mapped.value,
      };
      continue;
    }

    const hasCategorySchema = categoryAttributes.length > 0;
    const isNumericAttribute = /^\d+$/.test(resolvedAttributeId);
    const isOzonAttribute =
      isNumericAttribute && (!hasCategorySchema || Boolean(localAttribute));
    const feature: ListingFeatureDraft = {
      attributeId: resolvedAttributeId,
      label: localAttribute?.name || mapped.label,
      value: mapped.value,
      confidence: isOzonAttribute ? 0.9 : 0.72,
      required: localAttribute?.isRequired ?? false,
      group: isOzonAttribute ? "category" : "source",
      ozonCode: isOzonAttribute ? resolvedAttributeId : null,
      valueType: localAttribute?.type || "string",
      status: "review",
      source: "AI Ozon JSON",
      reason: localAttribute
        ? "根据 Ozon 属性 ID 自动创建并匹配到当前类目特征。"
        : isOzonAttribute
          ? "AI 返回了新的 Ozon 属性 ID，已自动创建为可编辑特征。"
          : isNumericAttribute && hasCategorySchema
            ? "AI 返回的属性 ID 不属于当前 Ozon 类目，前端保留但上传时会跳过。"
          : "AI 返回了新的可读特征；因缺少 Ozon 属性 ID，前端保留但上传时会跳过。",
      dictionaryValueCount: localAttribute?.dictionaryValueCount ?? 0,
      options: localAttribute
        ? ozonValueOptionMappings(localAttribute.values).map(
            (option) => option.label,
          )
        : [],
      optionMappings: localAttribute
        ? ozonValueOptionMappings(localAttribute.values)
        : [],
      ozonComplexId: mapped.complexId,
      ozonAttributeValues: resolvedValues,
      aiJsonKey: mapped.jsonKey || mapped.label,
      aiJsonPath: mapped.jsonPath || mapped.attributeId,
      aiJsonValue: mapped.value,
    };
    indexById.set(feature.attributeId, merged.length);
    merged.push(feature);
  }

  return merged;
}

function mergeStageTwoFeatureDraft(
  current: ListingFeatureDraft[],
  generated: ListingFeatureDraft[],
) {
  const currentBase = new Map(
    current
      .filter((feature) => feature.group === "base")
      .map((feature) => [baseFeatureId(feature), feature]),
  );
  return generated.map((feature) => {
    if (feature.group !== "base") return feature;
    const id = baseFeatureId(feature);
    const existing = currentBase.get(id);
    if (!existing) return feature;
    if (id === "category_type") {
      return {
        ...existing,
        value: feature.value,
        confidence: feature.confidence,
        status: feature.status,
        source: feature.source,
        reason: feature.reason,
      };
    }
    return existing;
  });
}

function findDraftForAiAttribute(
  attribute: OzonMappedAttribute,
  draft: ListingFeatureDraft[],
) {
  const jsonKey = normalizeOzonAttributeMatchKey(
    attribute.jsonKey || attribute.label,
  );
  return (
    draft.find(
      (feature) =>
        Boolean(attribute.jsonPath) &&
        feature.aiJsonPath === attribute.jsonPath,
    ) ??
    draft.find(
      (feature) =>
        feature.ozonCode === attribute.attributeId ||
        feature.attributeId === attribute.attributeId,
    ) ??
    draft.find(
      (feature) =>
        Boolean(jsonKey) &&
        normalizeOzonAttributeMatchKey(
          feature.aiJsonKey || feature.label,
        ) === jsonKey,
    ) ??
    null
  );
}

function aiAttributeDetailDraft(
  attribute: OzonMappedAttribute,
  matchedFeature: ListingFeatureDraft | null,
  skuLabel?: string,
): ListingFeatureDraft {
  if (matchedFeature) return matchedFeature;
  return {
    attributeId: attribute.attributeId,
    label: attribute.label || attribute.jsonKey || attribute.attributeId,
    value: attribute.value,
    confidence: 0.72,
    required: false,
    group: "source",
    ozonCode: null,
    valueType: "string",
    status: "review",
    source: skuLabel ? `AI Ozon JSON / ${skuLabel}` : "AI Ozon JSON",
    reason: skuLabel
      ? "这是 AI 为具体 SKU 返回的独立特征，前端完整保留。"
      : "AI 已返回该特征，但还没有匹配到正式 Ozon 属性 ID。",
    dictionaryValueCount: 0,
    options: [],
    ozonComplexId: attribute.complexId,
    ozonAttributeValues: attribute.values,
    aiJsonKey: attribute.jsonKey || attribute.label,
    aiJsonPath: attribute.jsonPath || attribute.attributeId,
    aiJsonValue: attribute.value,
  };
}

function AiReturnedFeaturesPanel({
  response,
  loading,
  error,
  draft,
  onShowDetail,
}: {
  response: TextPromptResponse | null;
  loading: boolean;
  error: string | null;
  draft: ListingFeatureDraft[];
  onShowDetail: (feature: ListingFeatureDraft) => void;
}) {
  const [open, setOpen] = useState(true);
  const mapping = response?.ozonMapping ?? null;
  const featureRows = mapping
    ? [
        ...mapping.attributes.map((attribute) => ({
          attribute,
          skuLabel: "",
        })),
        ...mapping.variants.flatMap((variant, index) =>
          variant.attributes.map((attribute) => ({
            attribute,
            skuLabel:
              variant.name ||
              variant.offerId ||
              variant.skuKey ||
              `SKU ${index + 1}`,
          })),
        ),
      ]
    : [];

  return (
    <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-500/20 dark:bg-violet-500/[0.06]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-950 dark:text-white">
              AI 返回特征
            </p>
            {loading ? (
              <Badge variant="warning">AI 正在处理</Badge>
            ) : error ? (
              <Badge variant="destructive">返回失败</Badge>
            ) : mapping ? (
              <>
                <Badge variant="success">AI 已返回</Badge>
                <Badge variant="outline">基础信息 {mapping.baseFields.length}</Badge>
                <Badge variant="outline">
                  特征 {mapping.attributes.length}
                </Badge>
                <Badge variant="outline">
                  SKU {mapping.variants.length}
                </Badge>
              </>
            ) : response ? (
              <Badge variant="success">AI 已返回</Badge>
            ) : (
              <Badge variant="outline">等待 AI 返回</Badge>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            以用户可读的字段和值展示 AI 返回内容，原始 JSON 仅用于查看详情。
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          {loading ? (
            <div className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white/70 text-sm text-violet-700 dark:border-violet-500/20 dark:bg-black/10 dark:text-violet-200">
              <Loader2 className="h-4 w-4 animate-spin" />
              AI 正在生成并解析回复…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
              {error}
            </div>
          ) : !response ? (
            <div className="rounded-xl border border-dashed border-violet-200 bg-white/70 p-6 text-center text-sm leading-6 text-slate-500 dark:border-violet-500/20 dark:bg-black/10 dark:text-slate-400">
              商品 JSON 发送给模型后，基础信息、公共特征和每个 SKU
              的独立特征都会在这里显示。
            </div>
          ) : (
            <>
              {!mapping ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                  AI 回复已经收到，但暂时无法转换成表单字段。你仍可在下方查看完整原文。
                </div>
              ) : (
                <>
                  <div>
                <p className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                  基础信息
                </p>
                {mapping.baseFields.length ? (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {mapping.baseFields.map((field) => {
                      const baseFeature = draft.find(
                        (feature) =>
                          feature.group === "base" &&
                          baseFeatureId(feature) === field.id,
                      );
                      return (
                        <div
                          key={field.id}
                          className="min-w-0 rounded-xl border border-violet-100 bg-white p-3 dark:border-violet-500/10 dark:bg-black/20"
                        >
                          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            {baseFeature?.label || field.id}
                          </p>
                          <p className="mt-2 break-words text-xs leading-5 text-slate-700 dark:text-slate-200">
                            {field.value}
                          </p>
                          <code className="mt-2 block break-all text-[10px] text-slate-400">
                            {field.id}
                          </code>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-violet-200 p-4 text-xs text-slate-500 dark:border-violet-500/20 dark:text-slate-400">
                    本次 AI 回答没有识别到基础信息。
                  </p>
                )}
              </div>

                  <div>
                <p className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                  商品特征
                </p>
                {featureRows.length ? (
                  <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                    {featureRows.map(({ attribute, skuLabel }, index) => {
                      const matchedFeature = findDraftForAiAttribute(
                        attribute,
                        draft,
                      );
                      return (
                        <div
                          key={`${skuLabel}:${attribute.attributeId}:${attribute.jsonPath}:${index}`}
                          className="grid min-w-0 gap-3 rounded-xl border border-violet-100 bg-white p-3 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)_auto] md:items-center dark:border-violet-500/10 dark:bg-black/20"
                        >
                          <div className="min-w-0">
                            {skuLabel ? (
                              <p className="mb-1 truncate text-[11px] font-medium text-sky-700 dark:text-sky-300">
                                {skuLabel}
                              </p>
                            ) : null}
                            <p className="break-words text-xs font-medium text-slate-600 dark:text-slate-300">
                              {attribute.label ||
                                attribute.jsonKey ||
                                attribute.attributeId}
                            </p>
                            {attribute.jsonKey &&
                            attribute.jsonKey !== attribute.label ? (
                              <code className="mt-1 block break-all text-[10px] text-slate-400">
                                {attribute.jsonKey}
                              </code>
                            ) : null}
                          </div>
                          <p className="min-w-0 break-words text-xs leading-5 text-slate-700 dark:text-slate-200">
                            {attribute.value}
                          </p>
                          <div className="flex items-center gap-2 md:justify-end">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                onShowDetail(
                                  aiAttributeDetailDraft(
                                    attribute,
                                    matchedFeature,
                                    skuLabel,
                                  ),
                                )
                              }
                            >
                              详情
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-violet-200 p-4 text-xs text-slate-500 dark:border-violet-500/20 dark:text-slate-400">
                    本次 AI 回答没有识别到可展示的特征。
                  </p>
                )}
                  </div>
                </>
              )}

              <details className="rounded-xl border border-violet-100 bg-white p-4 dark:border-violet-500/10 dark:bg-black/20">
                <summary className="cursor-pointer text-xs font-semibold text-slate-700 dark:text-slate-200">
                  查看 AI 原始回复
                </summary>
                <p className="mt-2 text-[11px] text-slate-400">
                  {response.providerName} / {response.model} /{" "}
                  {new Date(response.generatedAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </p>
                <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-sans text-xs leading-6 text-slate-700 dark:bg-white/[0.04] dark:text-slate-200">
                  {response.text}
                </pre>
              </details>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SkuSelectionPanel({
  options,
  mode,
  selectedSkuId,
  aiVariants,
  processing,
  applied,
  canMatchWithoutSku,
  onModeChange,
  onSelectedSkuChange,
  onApply,
}: {
  options: ProductSkuOption[];
  mode: "single" | "all";
  selectedSkuId: string;
  aiVariants: OzonAiVariantMapping[];
  processing: boolean;
  applied: boolean;
  canMatchWithoutSku: boolean;
  onModeChange: (mode: "single" | "all") => void;
  onSelectedSkuChange: (skuId: string) => void;
  onApply: () => void;
}) {
  const [open, setOpen] = useState(true);
  const source = options[0]?.source ?? null;
  const visibleOptions =
    mode === "all"
      ? options
      : options.filter((option) => option.id === selectedSkuId).slice(0, 1);

  return (
    <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-500/20 dark:bg-sky-500/[0.06]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-950 dark:text-white">
              多 SKU 选择
            </p>
            <Badge variant="outline">{options.length} 个</Badge>
            {source ? (
              <Badge variant={source === "1688" ? "success" : "warning"}>
                {source === "1688" ? "1688 抓取" : "AI 返回"}
              </Badge>
            ) : null}
            {aiVariants.length ? (
              <Badge variant="success">AI 返回 {aiVariants.length} 个名称</Badge>
            ) : null}
            <Badge variant={applied ? "success" : "warning"}>
              {applied
                ? source === "1688" || (!source && canMatchWithoutSku)
                  ? "已匹配"
                  : "已应用"
                : "等待确认"}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            商品描述和公共特征复用；名称、价格、图片及规格按 SKU 分开。
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          {!options.length ? (
            <div className="rounded-xl border border-dashed border-sky-200 bg-white/70 p-6 text-center text-sm leading-6 text-slate-500 dark:border-sky-500/20 dark:bg-black/10 dark:text-slate-400">
              <p>
                {canMatchWithoutSku
                  ? "当前商品没有识别到独立 SKU，可直接匹配整个商品。"
                  : "采集到 1688 规格或 AI 返回多个商品后，这里会列出每个具体 SKU，并支持选择单个或全部。"}
              </p>
              {canMatchWithoutSku ? (
                <Button
                  type="button"
                  onClick={onApply}
                  disabled={processing}
                  className="mt-3 gap-2"
                >
                  {processing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {processing ? "AI 正在匹配" : "匹配"}
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "single" ? "default" : "outline"}
                  onClick={() => onModeChange("single")}
                >
                  选择单个 SKU
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "all" ? "default" : "outline"}
                  onClick={() => onModeChange("all")}
                >
                  选择全部 SKU
                </Button>
              </div>

              {mode === "single" ? (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    当前 SKU
                  </span>
                  <select
                    value={selectedSkuId}
                    onChange={(event) =>
                      onSelectedSkuChange(event.target.value)
                    }
                    className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-400 dark:border-white/10 dark:bg-slate-950 dark:text-white"
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.specText} / ¥{option.price || "-"} / 库存{" "}
                        {option.stock ?? "-"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {visibleOptions.slice(0, 12).map((option, index) => {
                  const aiVariant = findAiVariantForSku(
                    option,
                    aiVariants,
                    index,
                  );
                  return (
                    <div
                      key={option.id}
                      className="min-w-0 rounded-xl border border-sky-100 bg-white p-3 dark:border-sky-500/10 dark:bg-black/20"
                    >
                      <p className="break-words text-xs font-semibold leading-5 text-slate-900 dark:text-white">
                        {option.specText}
                      </p>
                      <p className="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
                        SKU {option.id} / ¥{option.price || "-"} / 库存{" "}
                        {option.stock ?? "-"}
                      </p>
                      {Object.keys(option.specs).length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {Object.entries(option.specs).map(([key, value]) => (
                            <span
                              key={`${option.id}:${key}`}
                              className="rounded-full border border-sky-100 bg-sky-50 px-2 py-1 text-[11px] text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200"
                            >
                              {key}: {value}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {aiVariant?.name ? (
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
                          AI 名称：{aiVariant.name}
                        </p>
                      ) : null}
                      {aiVariant?.attributes.length ? (
                        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-[11px] leading-4 text-slate-500 dark:border-white/10 dark:text-slate-400">
                          {aiVariant.attributes
                            .slice(0, 4)
                            .map((attribute) => (
                              <p
                                key={`${aiVariant.skuKey}:${attribute.attributeId}`}
                                className="truncate"
                              >
                                {attribute.jsonKey || attribute.label}:{" "}
                                {attribute.value}
                              </p>
                            ))}
                          {aiVariant.attributes.length > 4 ? (
                            <details className="pt-1">
                              <summary className="cursor-pointer font-medium text-sky-700 dark:text-sky-300">
                                查看全部 {aiVariant.attributes.length} 个字段
                              </summary>
                              <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2 dark:bg-white/[0.04]">
                                {aiVariant.attributes.map((attribute) => (
                                  <p
                                    key={`${aiVariant.skuKey}:all:${attribute.attributeId}`}
                                    className="break-words"
                                  >
                                    {attribute.jsonKey || attribute.label}:{" "}
                                    {attribute.value}
                                  </p>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {visibleOptions.length > 12 ? (
                <p className="text-xs text-slate-500">
                  其余 {visibleOptions.length - 12} 个 SKU 将一并处理。
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={onApply}
                  disabled={
                    processing || (mode === "single" && !selectedSkuId)
                  }
                  className="gap-2"
                >
                  {processing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : source === "1688" ? (
                    <Sparkles className="h-4 w-4" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {processing
                    ? "AI 正在匹配"
                    : source === "1688"
                      ? "匹配"
                      : "应用 SKU 选择"}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProductDetailMediaActionMenu(props: {
  media: ProductDetailMediaItem;
  index: number;
  generating: boolean;
  ocrReady: boolean;
  onGenerateImage: (item: ProductDetailMediaItem, index: number) => void;
  onTranslateImage: (item: ProductDetailMediaItem, index: number) => void;
  onDeleteMedia: (item: ProductDetailMediaItem, index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(menuRef, open, () => setOpen(false));

  if (props.media.type === "video") {
    return (
      <button
        type="button"
        className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full bg-white/95 text-rose-600 shadow-lg transition hover:bg-rose-50 dark:bg-slate-950/90 dark:text-rose-300 dark:hover:bg-rose-500/10"
        title="删除视频"
        aria-label={`删除详情视频 ${props.index + 1}`}
        onClick={() => props.onDeleteMedia(props.media, props.index)}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div ref={menuRef} className="absolute right-3 top-3 z-10">
      <button
        type="button"
        className="grid h-9 w-9 place-items-center rounded-full bg-white/95 text-slate-700 shadow-lg transition hover:bg-white hover:text-slate-950 dark:bg-slate-950/90 dark:text-slate-200"
        aria-haspopup="menu"
        aria-expanded={open}
        title="详情图操作"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 top-11 w-36 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-xs shadow-xl dark:border-white/10 dark:bg-slate-950">
          <button
            type="button"
            disabled={props.generating}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-white/[0.06]"
            onClick={() => {
              setOpen(false);
              props.onGenerateImage(props.media, props.index);
            }}
          >
            {props.generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            生图
          </button>
          <button
            type="button"
            disabled={!props.ocrReady}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-white/[0.06]"
            onClick={() => {
              setOpen(false);
              props.onTranslateImage(props.media, props.index);
            }}
          >
            <Languages className="h-3.5 w-3.5" />
            翻译
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
            onClick={() => {
              setOpen(false);
              props.onDeleteMedia(props.media, props.index);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProductDetailRichText({
  content,
  generating,
  ocrReady,
  onDeleteMedia,
  onGenerateImage,
  onTranslateImage,
}: {
  content: ProductDetailContent;
  generating: boolean;
  ocrReady: boolean;
  onDeleteMedia: (item: ProductDetailMediaItem, index: number) => void;
  onGenerateImage: (item: ProductDetailMediaItem, index: number) => void;
  onTranslateImage: (item: ProductDetailMediaItem, index: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasContent = Boolean(content.text || content.media.length);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-white">商品详情富文本</p>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            按商品详情页顺序展示采集到的视频、详情图片和说明文字。
          </p>
        </div>
        <span className="flex items-center gap-2">
          <Badge variant={hasContent ? "success" : "outline"}>
            {content.videoCount} 个视频 / {content.imageCount} 张图片
          </Badge>
          <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open ? (
        <div className="mt-4">
          {hasContent ? (
            <div className="mx-auto max-w-4xl space-y-4">
              {content.text ? (
                <div className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200">
                  {content.text}
                </div>
              ) : null}
              {content.media.map((item, index) =>
                item.type === "video" ? (
                  <div
                    key={`video:${item.url}:${index}`}
                  >
                    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-black dark:border-white/10">
                      <video
                        src={item.url}
                        controls
                        playsInline
                        preload="metadata"
                        className="aspect-video w-full object-contain"
                      >
                        当前浏览器无法播放该详情视频。
                      </video>
                      <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-slate-950/75 px-2.5 py-1 text-[11px] font-medium text-white">
                        <Video className="h-3.5 w-3.5" />
                        详情视频 {index + 1}
                      </span>
                      <ProductDetailMediaActionMenu
                        media={item}
                        index={index}
                        generating={generating}
                        ocrReady={ocrReady}
                        onDeleteMedia={onDeleteMedia}
                        onGenerateImage={onGenerateImage}
                        onTranslateImage={onTranslateImage}
                      />
                    </div>
                  </div>
                ) : (
                  <div
                    key={`image:${item.url}:${index}`}
                    className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]"
                  >
                    <img
                      src={proxiedImageSrc(item.url)}
                      alt={`商品详情图 ${index + 1}`}
                      loading="lazy"
                      className="h-auto w-full object-contain"
                    />
                    <ProductDetailMediaActionMenu
                      media={item}
                      index={index}
                      generating={generating}
                      ocrReady={ocrReady}
                      onDeleteMedia={onDeleteMedia}
                      onGenerateImage={onGenerateImage}
                      onTranslateImage={onTranslateImage}
                    />
                  </div>
                ),
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
              爬虫采集完成后，会在这里展示商品详情中的视频和图片。
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AiFeatureDetailDialog({
  feature,
  onClose,
}: {
  feature: ListingFeatureDraft | null;
  onClose: () => void;
}) {
  if (!feature) return null;

  const originalKey = feature.aiJsonKey || feature.label;
  const originalValue = feature.aiJsonValue ?? feature.value;
  const jsonPath = feature.aiJsonPath || feature.attributeId;
  const valueChanged = originalValue !== feature.value;

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="AI 特征详情"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <div>
            <h2 className="text-lg font-semibold text-slate-950 dark:text-white">
              特征详情
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              按 GPT 返回的原始 key 和冒号后的 value 展示。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭特征详情"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              原始 key
            </p>
            <code className="block break-all rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-semibold text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
              {originalKey}
            </code>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              原始 value
            </p>
            <pre className="whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-sans text-sm leading-6 text-slate-800 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100">
              {originalValue}
            </pre>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              JSON 路径
            </p>
            <code className="block break-all rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-300">
              {jsonPath}
            </code>
          </div>
          {valueChanged ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                面板当前值
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 font-sans text-sm leading-6 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                {feature.value}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <Button type="button" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}

function BaseFeatureForm(props: {
  features: ListingFeatureDraft[];
  images: ManagedWorkflowImage[];
  selectedImageIds: string[];
  imageGenerating: boolean;
  ocrReady: boolean;
  onOpenImageDialog: (mode: WorkflowImageDialogMode) => void;
  onDeleteImage: (imageId: string) => void;
  onGenerateImage: (imageId: string) => void | Promise<void>;
  onReorderImages: (images: ManagedWorkflowImage[]) => void;
  onToggleImageSelect: (imageId: string) => void;
  onTranslateImage: (imageId: string) => void;
  onChange: (attributeId: string, patch: Partial<ListingFeatureDraft>) => void;
}) {
  const sections = buildBaseFeatureSections(props.features);
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
      >
        <h3 className="text-base font-semibold text-slate-950 dark:text-white">商品基础信息</h3>
        <span className="flex items-center gap-2">
          <Badge variant="success">{props.features.length} 项</Badge>
          <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open ? <div className="mt-4 space-y-5">
        {sections.map((section) => (
          <div key={section.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-slate-950 dark:text-white">{section.title}</p>
              <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {section.items.map((feature) => {
                if (baseFeatureId(feature) === "images") {
                  return (
                    <div key={feature.attributeId} className="min-w-0 space-y-2 md:col-span-2 xl:col-span-3">
                      <span className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                        <span>{feature.label}</span>
                        {feature.required ? <span className="text-rose-500">*</span> : null}
                        <span className="text-slate-300 dark:text-slate-600">/</span>
                        <span>{props.images.length} 张</span>
                      </span>
                      <WorkflowImageField
                        images={props.images}
                        selectedImageIds={props.selectedImageIds}
                        generating={props.imageGenerating}
                        ocrReady={props.ocrReady}
                        onOpen={props.onOpenImageDialog}
                        onDelete={props.onDeleteImage}
                        onGenerate={props.onGenerateImage}
                        onReorder={props.onReorderImages}
                        onToggleSelect={props.onToggleImageSelect}
                        onTranslate={props.onTranslateImage}
                      />
                      {feature.status === "missing" && props.images.length === 0 ? (
                        <span className="block text-[11px] leading-4 text-rose-500">缺少商品图片</span>
                      ) : null}
                    </div>
                  );
                }

                const longField = isLongBaseField(feature);
                return (
                  <label
                    key={feature.attributeId}
                    className={`group min-w-0 space-y-1.5 ${longField ? "md:col-span-2 xl:col-span-3" : ""}`}
                  >
                    <span className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <span className="truncate">{feature.label}</span>
                      {feature.required ? <span className="text-rose-500">*</span> : null}
                    </span>
                    {longField ? (
                      <Textarea
                        value={feature.value}
                        onChange={(event) => props.onChange(feature.attributeId, { value: event.target.value })}
                        placeholder={feature.required ? "必填" : "选填"}
                        className="min-h-[76px] resize-y rounded-xl border-slate-200 bg-white text-sm dark:border-white/10 dark:bg-black/20"
                      />
                    ) : (
                      <Input
                        value={feature.value}
                        onChange={(event) => props.onChange(feature.attributeId, { value: event.target.value })}
                        placeholder={feature.required ? "必填" : "选填"}
                        className="h-10 rounded-xl border-slate-200 bg-white text-sm dark:border-white/10 dark:bg-black/20"
                      />
                    )}
                    {feature.status === "missing" && !feature.value.trim() ? (
                      <span className="block text-[11px] leading-4 text-rose-500">缺少必填内容</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div> : null}
    </div>
  );
}

function UsageRecordPanel(props: {
  usageSummary: ApiUsagePreviewResponse | null;
  usageLoading: boolean;
  onRefresh: () => void;
  onClose?: () => void;
}) {
  const { usageSummary, usageLoading, onRefresh, onClose } = props;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_24px_60px_-34px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-[#101012]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-white">最近使用记录</p>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">展示最近 7 天的模型调用。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{usageSummary ? `${usageSummary.totalRequests} 次` : "待加载"}</Badge>
          {usageSummary?.failedRequests ? <Badge variant="warning">{usageSummary.failedRequests} 次失败</Badge> : null}
          <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={usageLoading} className="gap-2">
            {usageLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.open("/monitor/usage", "_blank", "noopener,noreferrer")} className="gap-2">
            <ExternalLink className="h-3.5 w-3.5" />
            完整记录
          </Button>
          {onClose ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="px-2">
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 dark:border-white/10 dark:bg-white/[0.04]">
          <p className="text-xs text-slate-400">成功调用</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{usageSummary?.successRequests ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 dark:border-white/10 dark:bg-white/[0.04]">
          <p className="text-xs text-slate-400">图片调用</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{usageSummary?.imageRequests ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 dark:border-white/10 dark:bg-white/[0.04]">
          <p className="text-xs text-slate-400">失败调用</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{usageSummary?.failedRequests ?? 0}</p>
        </div>
      </div>

      <div className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {usageSummary?.recentEntries.length ? (
          usageSummary.recentEntries.map((entry) => (
            <div key={entry.id} className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm dark:border-white/10 dark:bg-black/20 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={entry.success ? "success" : "destructive"}>{entry.success ? "成功" : "失败"}</Badge>
                  <Badge variant="outline">{usageCategoryLabel(entry.category)}</Badge>
                  {entry.quotaState !== "ok" ? <Badge variant="warning">{entry.quotaState}</Badge> : null}
                  <span className="text-xs text-slate-400">{usageTimeLabel(entry.timestamp)}</span>
                </div>
                <p className="mt-2 truncate font-medium text-slate-900 dark:text-white">{entry.operation || "未标记操作"}</p>
                <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{entry.model || "未知模型"}</p>
                {!entry.success && entry.errorMessage ? <p className="mt-1 line-clamp-2 text-xs text-rose-600 dark:text-rose-300">{entry.errorMessage}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400 md:justify-end">
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="h-3.5 w-3.5" />
                  {entry.durationMs} ms
                </span>
                <span>{entry.totalTokens !== null ? `${entry.totalTokens} tokens` : "无 tokens"}</span>
                {entry.actualCostUsd !== null ? <span>${entry.actualCostUsd.toFixed(6)}</span> : null}
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
            暂无可展示的调用记录。
          </div>
        )}
      </div>
    </div>
  );
}

export function ListingWorkflowPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedWorkflowItemId = searchParams.get("item") ?? "";
  const [sourceUrl, setSourceUrl] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [jsonFileName, setJsonFileName] = useState("");
  const [workflowItemId, setWorkflowItemId] = useState("");
  const [workflowItemStage, setWorkflowItemStage] =
    useState<ListingWorkflowStage | null>(null);
  const [capabilities, setCapabilities] = useState<ListingWorkflowCapabilities | null>(null);
  const [crawlerScan, setCrawlerScan] = useState<CrawlerScanResult | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [ozonSnapshot, setOzonSnapshot] = useState<OzonFeatureSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<(CrawlerLaunchResult & { time: string }) | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [featureProviderId, setFeatureProviderId] = useState("");
  const [featureModelId, setFeatureModelId] = useState("");
  const [imageProviderId, setImageProviderId] = useState("");
  const [imageModelId, setImageModelId] = useState("");
  const [featureDraft, setFeatureDraft] = useState<ListingFeatureDraft[]>(() => createBaseFeatureDraft());
  const [featureNotes, setFeatureNotes] = useState<string[]>([]);
  const [featureStatusMessage, setFeatureStatusMessage] = useState<string | null>(null);
  const [featureStatusOk, setFeatureStatusOk] = useState(false);
  const [categoryMatchMessage, setCategoryMatchMessage] = useState<string | null>(null);
  const [categoryMatchOk, setCategoryMatchOk] = useState(false);
  const [categoryMatchReason, setCategoryMatchReason] = useState("");
  const [categoryMatchConfidence, setCategoryMatchConfidence] = useState(0);
  const [usageSummary, setUsageSummary] = useState<ApiUsagePreviewResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usagePanelOpen, setUsagePanelOpen] = useState(false);
  const [ozonApiPanelOpen, setOzonApiPanelOpen] = useState(false);
  const [imagePrompt, setImagePrompt] = useState(() => buildDefaultListingImagePrompt(""));
  const [imagePromptTouched, setImagePromptTouched] = useState(false);
  const [imagePromptOpen, setImagePromptOpen] = useState(true);
  const [textPrompt, setTextPrompt] = useState(() => buildDefaultListingTextPrompt());
  const [textPromptOpen, setTextPromptOpen] = useState(true);
  const [savedTextPrompt, setSavedTextPrompt] = useState(() => buildDefaultListingTextPrompt());
  const [textSystemPrompt, setTextSystemPrompt] = useState(DEFAULT_LISTING_TEXT_SYSTEM_PROMPT);
  const [textSystemPromptOpen, setTextSystemPromptOpen] = useState(false);
  const [stagePromptDialogOpen, setStagePromptDialogOpen] = useState(false);
  const [stageAiPrompts, setStageAiPrompts] =
    useState<ListingStageAiPromptConfig>(() => DEFAULT_LISTING_STAGE_AI_PROMPTS);
  const [textPromptResponse, setTextPromptResponse] = useState<TextPromptResponse | null>(null);
  const [textPromptResponseError, setTextPromptResponseError] = useState<string | null>(null);
  const [textPromptResponseLoading, setTextPromptResponseLoading] = useState(false);
  const [textPromptResponseOpen, setTextPromptResponseOpen] = useState(false);
  const [featureDetail, setFeatureDetail] = useState<ListingFeatureDraft | null>(null);
  const [skuMode, setSkuMode] = useState<"single" | "all">("single");
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [skuSelectionApplied, setSkuSelectionApplied] = useState(false);
  const [aiSkuVariants, setAiSkuVariants] = useState<OzonAiVariantMapping[]>([]);
  const [imageAspectRatio, setImageAspectRatio] = useState<ListingImageAspectRatio>("1:1");
  const [imageUseReference, setImageUseReference] = useState(true);
  const [generatedListingImage, setGeneratedListingImage] = useState<ListingImageGenerateResponse | null>(null);
  const [imageGenerationMessage, setImageGenerationMessage] = useState<string | null>(null);
  const [managedImages, setManagedImages] = useState<ManagedWorkflowImage[]>([]);
  const [selectedWorkflowImageIds, setSelectedWorkflowImageIds] = useState<string[]>([]);
  const [primaryImageId, setPrimaryImageId] = useState("");
  const [imageDialogMode, setImageDialogMode] = useState<WorkflowImageDialogMode | null>(null);
  const [imageDialogInitialImageId, setImageDialogInitialImageId] = useState("");
  const [deletedDetailMediaKeys, setDeletedDetailMediaKeys] = useState<string[]>([]);
  const collectAbortRef = useRef<AbortController | null>(null);
  const textPromptRunRef = useRef(0);
  const loadedWorkflowItemRef = useRef("");

  const platform = useMemo(() => detectPlatform(sourceUrl), [sourceUrl]);
  const parsedJson = useMemo(() => safeParseJson(jsonText), [jsonText]);
  const jsonValid = jsonText.trim().length > 0 && parsedJson !== null;
  const featureModelChoices = useMemo(() => collectModelChoices(providers, isFeatureModel), [providers]);
  const imageModelChoices = useMemo(() => collectModelChoices(providers, isImageGenerationModel), [providers]);
  const selectedFeatureModel = useMemo(
    () => featureModelChoices.find((model) => model.providerId === featureProviderId && model.modelId === featureModelId) ?? null,
    [featureModelId, featureModelChoices, featureProviderId],
  );
  const selectedImageModel = useMemo(
    () => imageModelChoices.find((model) => model.providerId === imageProviderId && model.modelId === imageModelId) ?? null,
    [imageModelId, imageModelChoices, imageProviderId],
  );
  const featureModelValue = selectedFeatureModel ? modelChoiceValue(selectedFeatureModel.providerId, selectedFeatureModel.modelId) : "";
  const imageModelValue = selectedImageModel ? modelChoiceValue(selectedImageModel.providerId, selectedImageModel.modelId) : "";
  const imageDialogImages = useMemo(() => {
    if (imageDialogMode === "main") return managedImages.slice(0, 1);
    if (imageDialogMode === "other") {
      const selectedIds = new Set(selectedWorkflowImageIds);
      return managedImages.filter((image, index) => index > 0 && selectedIds.has(image.id));
    }
    return managedImages;
  }, [imageDialogMode, managedImages, selectedWorkflowImageIds]);
  const crawler = useMemo(() => crawlerScan?.modules.find((module) => module.id === "marketspider-main") ?? null, [crawlerScan]);
  const imageOcr = useMemo(() => capabilityById(capabilities, "ocr"), [capabilities]);
  const ozon = useMemo(() => capabilityById(capabilities, "ozon"), [capabilities]);
  const ai = useMemo(() => capabilityById(capabilities, "ai"), [capabilities]);
  const title = firstText(parsedJson, ["title", "name", "item_name", "productName", "goods_name", "subject"]);
  const defaultStageAiPrompts = useMemo(
    () =>
      normalizeListingStageAiPrompts({
        ...DEFAULT_LISTING_STAGE_AI_PROMPTS,
        imageGeneration: {
          ...DEFAULT_LISTING_STAGE_AI_PROMPTS.imageGeneration,
          prompt: buildDefaultListingImagePrompt(title),
        },
      }),
    [title],
  );
  const stageAiPromptsCustomized = useMemo(
    () =>
      JSON.stringify(normalizeListingStageAiPrompts(stageAiPrompts)) !==
      JSON.stringify(defaultStageAiPrompts),
    [defaultStageAiPrompts, stageAiPrompts],
  );
  const stageAiPromptDialogValue = useMemo(
    () =>
      normalizeListingStageAiPrompts({
        ...stageAiPrompts,
        imageGeneration: {
          prompt: imagePrompt,
          aspectRatio: imageAspectRatio,
          useReference: imageUseReference,
        },
      }),
    [imageAspectRatio, imagePrompt, imageUseReference, stageAiPrompts],
  );
  const workflowImageBuckets = useMemo(() => (parsedJson ? buildWorkflowImageBuckets(parsedJson) : null), [parsedJson]);
  const rawProductDetailContent = useMemo(() => buildProductDetailContent(parsedJson), [parsedJson]);
  const productDetailContent = useMemo<ProductDetailContent>(() => {
    if (!deletedDetailMediaKeys.length) return rawProductDetailContent;
    const deleted = new Set(deletedDetailMediaKeys);
    const media = rawProductDetailContent.media.filter((item) => !deleted.has(productDetailMediaKey(item)));
    return {
      ...rawProductDetailContent,
      media,
      imageCount: media.filter((item) => item.type === "image").length,
      videoCount: media.filter((item) => item.type === "video").length,
    };
  }, [deletedDetailMediaKeys, rawProductDetailContent]);
  const skuOptions = useMemo(
    () => extractProductSkuOptions(parsedJson),
    [parsedJson],
  );
  const aiSkuOptions = useMemo(
    () => extractAiSkuOptions(aiSkuVariants),
    [aiSkuVariants],
  );
  const displayedSkuOptions =
    skuOptions.length > 0 ? skuOptions : aiSkuOptions;
  const collectedManagedImages = useMemo<ManagedWorkflowImage[]>(
    () =>
      workflowImageGridItems(workflowImageBuckets, null).map((image) => ({
        ...image,
        source: "crawler" as const,
      })),
    [workflowImageBuckets],
  );
  const selectedCategory = ozonSnapshot?.selectedCategory ?? null;
  const baseFeatures = featureDraft.filter((feature) => feature.group === "base");
  const featureHasGenerated = featureStatusMessage !== null;
  const featureGroups = (["base", "category", "source"] as const)
    .map((group) => ({
      group,
      items: featureDraft.filter((feature) => feature.group === group),
      meta: featureGroupMeta(group),
    }))
    .filter((group) => group.group !== "base")
    .filter((group) => group.items.length > 0);
  const consoleAction: CrawlerAction = "launch_marketspider_ui";
  const consoleReady = Boolean(crawler?.actions.find((item) => item.id === consoleAction)?.enabled);
  const directCollectReady = platform.key === "1688";

  useEffect(() => {
    setManagedImages((current) => {
      const retained = current.filter((image) => image.source !== "crawler");
      const collectedUrls = new Set(collectedManagedImages.map((image) => image.url));
      return [
        ...collectedManagedImages,
        ...retained.filter((image) => !collectedUrls.has(image.url)),
      ].slice(0, WORKFLOW_IMAGE_LIMIT);
    });
  }, [collectedManagedImages]);

  useEffect(() => {
    setDeletedDetailMediaKeys([]);
  }, [jsonText, workflowItemId]);

  useEffect(() => {
    const firstImageId = managedImages[0]?.id || "";
    if (primaryImageId !== firstImageId) {
      setPrimaryImageId(firstImageId);
    }
  }, [managedImages, primaryImageId]);

  useEffect(() => {
    const availableIds = new Set(managedImages.map((image) => image.id));
    setSelectedWorkflowImageIds((current) =>
      current.filter((imageId) => availableIds.has(imageId)),
    );
  }, [managedImages]);

  useEffect(() => {
    setFeatureDraft((current) => applyWorkflowImageOrder(current, managedImages));
  }, [managedImages]);

  useEffect(() => {
    setSkuSelectionApplied(false);
    setAiSkuVariants([]);
  }, [skuOptions.map((option) => option.id).join("|")]);

  useEffect(() => {
    const firstSkuId = displayedSkuOptions[0]?.id ?? "";
    setSelectedSkuId((current) =>
      current &&
      displayedSkuOptions.some((option) => option.id === current)
        ? current
        : firstSkuId,
    );
    setSkuSelectionApplied(false);
  }, [displayedSkuOptions.map((option) => option.id).join("|")]);

  useEffect(() => {
    if (!textPromptResponse?.text || textPromptResponse.ozonMapping) return;
    const recoveredMapping = mapOzonAiResponse(textPromptResponse.text);
    if (!recoveredMapping.recognized) return;

    const recoveredResponse: TextPromptResponse = {
      ...textPromptResponse,
      ozonMapping: recoveredMapping,
    };
    setTextPromptResponse(recoveredResponse);
    setAiSkuVariants(recoveredMapping.variants);
    setFeatureDraft((current) =>
      mergeOzonAiMappingIntoDraft(current, recoveredMapping, null),
    );
    try {
      window.localStorage.setItem(
        textPromptResponseStorageKey,
        JSON.stringify(recoveredResponse),
      );
    } catch {
      // 本地存储不可用时，当前页面仍然可以展示恢复后的表单。
    }
  }, [textPromptResponse?.text, textPromptResponse?.ozonMapping]);

  function clearMatchedCategory() {
    setSelectedCategoryId("");
    setOzonSnapshot((current) => (current ? { ...current, selectedCategory: null } : current));
    setCategoryMatchMessage(null);
    setCategoryMatchOk(false);
    setCategoryMatchReason("");
    setCategoryMatchConfidence(0);
  }

  function resetFeatureWorkflow(options: { clearCategory?: boolean } = {}) {
    setFeatureDraft(createBaseFeatureDraft());
    setFeatureNotes([]);
    setFeatureStatusMessage(null);
    setFeatureStatusOk(false);
    if (options.clearCategory ?? true) {
      clearMatchedCategory();
    }
  }

  function handleOzonConnectionChange(connection: OzonFeatureSnapshot["connection"]) {
    setOzonSnapshot((current) => (current ? { ...current, connection } : current));
  }

  async function addWorkflowImages(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) {
      toast.error("请选择 JPG、PNG 或 WEBP 图片");
      return;
    }
    const availableSlots = Math.max(WORKFLOW_IMAGE_LIMIT - managedImages.length, 0);
    if (!availableSlots) {
      toast.error(`商品图片最多添加 ${WORKFLOW_IMAGE_LIMIT} 张`);
      return;
    }
    const acceptedFiles = imageFiles.slice(0, availableSlots);

    try {
      const additions = await Promise.all(
        acceptedFiles.map(async (file) => ({
          id: `upload:${crypto.randomUUID()}`,
          name: file.name,
          url: await fileToDataUrl(file),
          label: "手动上传",
          source: "upload" as const,
        })),
      );
      setManagedImages((current) => [...current, ...additions]);
      if (acceptedFiles.length < imageFiles.length) {
        toast.warning(`已添加 ${additions.length} 张，商品图片最多 ${WORKFLOW_IMAGE_LIMIT} 张`);
      } else {
        toast.success(`已添加 ${additions.length} 张图片`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片添加失败");
    }
  }

  function deleteWorkflowImage(imageId: string) {
    const next = managedImages.filter((image) => image.id !== imageId);
    setManagedImages(next);
    setSelectedWorkflowImageIds((current) =>
      current.filter((selectedId) => selectedId !== imageId),
    );
    if (primaryImageId === imageId) {
      setPrimaryImageId(next[0]?.id || "");
    }
    toast.success("图片已删除");
  }

  function openWorkflowImageTranslate(imageId: string) {
    if (managedImages[0]?.id === imageId) {
      setImageDialogInitialImageId(imageId);
      setImageDialogMode("main");
      toast.info("主图已切换到生图处理");
      return;
    }
    if (!imageOcr?.ready) {
      toast.warning("图片翻译服务未连接，请先启动 8010 服务");
    }
    setSelectedWorkflowImageIds((current) =>
      current.includes(imageId) ? current : [...current, imageId],
    );
    setImageDialogInitialImageId(imageId);
    setImageDialogMode("other");
  }

  function toggleWorkflowImageSelection(imageId: string) {
    setSelectedWorkflowImageIds((current) =>
      current.includes(imageId)
        ? current.filter((selectedId) => selectedId !== imageId)
        : [...current, imageId],
    );
  }

  function ensureWorkflowImageFromUrl(url: string, name: string, label: string) {
    const existing = managedImages.find((image) => image.url === url);
    const imageId = existing?.id || `detail:${url}`;
    if (!existing) {
      const nextImage: ManagedWorkflowImage = {
        id: imageId,
        name,
        url,
        label,
        source: "crawler",
      };
      setManagedImages((current) =>
        current.some((image) => image.url === url)
          ? current
          : [...current, nextImage].slice(0, WORKFLOW_IMAGE_LIMIT),
      );
    }
    return imageId;
  }

  function translateProductDetailImage(item: ProductDetailMediaItem, index: number) {
    if (item.type !== "image") return;
    const imageId = ensureWorkflowImageFromUrl(
      item.url,
      `detail-${String(index + 1).padStart(2, "0")}.jpg`,
      "详情图",
    );
    openWorkflowImageTranslate(imageId);
  }

  function deleteProductDetailMedia(item: ProductDetailMediaItem) {
    setDeletedDetailMediaKeys((current) => {
      const key = productDetailMediaKey(item);
      return current.includes(key) ? current : [...current, key];
    });
    toast.success(item.type === "video" ? "详情视频已删除" : "详情图已删除");
  }

  function setWorkflowPrimaryImage(imageId: string) {
    const image = managedImages.find((item) => item.id === imageId);
    if (!image) return;
    setManagedImages((current) => [
      image,
      ...current.filter((item) => item.id !== imageId),
    ]);
    setPrimaryImageId(imageId);
    toast.success("已设为主图");
  }

  function reorderWorkflowImages(images: ManagedWorkflowImage[]) {
    setManagedImages(images);
    setPrimaryImageId(images[0]?.id || "");
  }

  function openWorkflowImageDialog(mode: WorkflowImageDialogMode) {
    if (mode === "other") {
      const selectedOtherImages = managedImages.filter(
        (image, index) => index > 0 && selectedWorkflowImageIds.includes(image.id),
      );
      if (!selectedOtherImages.length) {
        toast.info("请先选中需要翻译的其他图片");
        return;
      }
      setImageDialogInitialImageId(selectedOtherImages[0].id);
    } else if (mode === "main") {
      setImageDialogInitialImageId(managedImages[0]?.id || "");
    } else {
      setImageDialogInitialImageId("");
    }
    setImageDialogMode(mode);
  }

  function applyEditedWorkflowImage(imageId: string, dataUrl: string, name: string) {
    setManagedImages((current) =>
      current.map((image) =>
        image.id === imageId
          ? {
              ...image,
              name,
              url: dataUrl,
              label: "OCR 已修改",
              source: "edited",
            }
          : image,
      ),
    );
    toast.success("图片修改已回填");
  }

  async function batchTranslateWorkflowImages(
    images: ManagedWorkflowImage[],
    targetLanguage: string,
  ) {
    try {
      const result = await readApi<ListingAtlasTranslateResponse>(
        await fetch("/api/listing-workflow/image-translate-atlas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            images: images.map((image) => ({
              id: image.id,
              name: image.name,
              url: image.url,
            })),
            targetLanguage,
          }),
        }),
      );
      const translatedById = new Map(result.images.map((image) => [image.id, image]));
      setManagedImages((current) =>
        current.map((image) => {
          const translated = translatedById.get(image.id);
          return translated
            ? {
                ...image,
                name: translated.name,
                url: translated.imageUrl,
                label: "Google 图集翻译",
                source: "edited" as const,
              }
            : image;
        }),
      );
      toast.success(
        `已用 ${result.atlasCount} 张图集翻译并回填 ${result.imageCount} 张图片`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图集批量翻译失败");
      throw error;
    }
  }

  async function refreshUsageHistory() {
    setUsageLoading(true);
    try {
      const nextUsage = await readApi<ApiUsagePreviewResponse>(
        await fetch("/api/monitor/usage?hours=168&limit=6", { cache: "no-store" }),
      );
      setUsageSummary(nextUsage);
    } catch {
      setUsageSummary(null);
    } finally {
      setUsageLoading(false);
    }
  }

  async function refresh(categoryIdOverride = selectedCategoryId) {
    setLoading(true);
    try {
      const [nextCapabilities, nextCrawlerScan, nextProviders, nextOzonSnapshot, browserProvider] = await Promise.all([
        readApi<ListingWorkflowCapabilities>(await fetch("/api/listing-workflow/capabilities")),
        readApi<CrawlerScanResult>(await fetch("/api/crawlers")),
        readApi<ProviderOption[]>(await fetch("/api/providers")),
        readApi<OzonFeatureSnapshot>(await fetch(`/api/ozon/features${categoryIdOverride ? `?categoryId=${categoryIdOverride}` : ""}`)),
        readApi<ProviderOption>(await fetch("/api/browser-ai/models", { cache: "no-store" })).catch(() => null),
      ]);
      setCapabilities(nextCapabilities);
      setCrawlerScan(nextCrawlerScan);
      setProviders(browserProvider ? [...nextProviders, browserProvider] : nextProviders);
      setOzonSnapshot(nextOzonSnapshot);
      setSelectedCategoryId(nextOzonSnapshot.selectedCategory?.id ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "扫描工作流模块失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadOzonSnapshot(
    categoryId: string,
    options: { preserveFeatureDraft?: boolean; matchSource?: "manual" | "ai" } = {},
  ) {
    if (!categoryId) {
      clearMatchedCategory();
      resetFeatureWorkflow({ clearCategory: false });
      return null;
    }
    setSelectedCategoryId(categoryId);
    try {
      const params = new URLSearchParams();
      if (categoryId) params.set("categoryId", categoryId);
      const nextSnapshot = await readApi<OzonFeatureSnapshot>(await fetch(`/api/ozon/features?${params.toString()}`));
      setOzonSnapshot(nextSnapshot);
      setSelectedCategoryId(nextSnapshot.selectedCategory?.id ?? categoryId);
      if (!options.preserveFeatureDraft) {
        resetFeatureWorkflow({ clearCategory: false });
      }
      if (categoryId && nextSnapshot.selectedCategory) {
        setCategoryMatchOk(true);
        setCategoryMatchMessage(
          options.matchSource === "ai"
            ? "AI 返回的类目 ID 已匹配到本地 Ozon 类目，现有基础信息已保留。"
            : "已手动选择 Ozon 类目，可以继续拉取/填写该类目的特殊字段。",
        );
        setCategoryMatchReason("");
        setCategoryMatchConfidence(1);
      }
      return nextSnapshot;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取 Ozon 类目失败");
      return null;
    }
  }

  async function patchWorkflowItem(
    itemId: string,
    patch: Record<string, unknown>,
  ) {
    return await readApi<ListingWorkflowItem>(
      await fetch(`/api/listing-workflow/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  }

  function workflowItemPayload(
    scrapedData: Record<string, unknown>,
    features: ListingFeatureDraft[],
    overrides: Record<string, unknown> = {},
  ) {
    const offerId =
      baseFeatureValue(features, "offer_id") ||
      `OZ-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      stage: "COLLECTED",
      status: "READY",
      sourceUrl: sourceUrl || null,
      sourcePlatform:
        firstText(scrapedData, ["platform", "source", "site"]) ||
        platform.label,
      title:
        baseFeatureValue(features, "name") ||
        firstText(scrapedData, [
          "title",
          "name",
          "item_name",
          "productName",
          "goods_name",
          "subject",
        ]) ||
        "未命名商品",
      offerId,
      imageUrl:
        managedImages[0]?.url || firstWorkflowImage(scrapedData) || null,
      currentPrice: baseFeatureValue(features, "price") || null,
      oldPrice: baseFeatureValue(features, "old_price") || null,
      minPrice: baseFeatureValue(features, "min_price") || null,
      costPrice: baseFeatureValue(features, "cost_price") || null,
      currency: baseFeatureValue(features, "currency_code") || "CNY",
      scrapedData,
      features,
      ...overrides,
    };
  }

  async function createWorkflowItem(
    scrapedData: Record<string, unknown>,
    features: ListingFeatureDraft[],
    overrides: Record<string, unknown> = {},
  ) {
    return await readApi<ListingWorkflowItem>(
      await fetch("/api/listing-workflow/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          workflowItemPayload(scrapedData, features, overrides),
        ),
      }),
    );
  }

  async function loadWorkflowItem(itemId: string) {
    try {
      const item = await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${itemId}`, {
          cache: "no-store",
        }),
      );
      loadedWorkflowItemRef.current = item.id;
      setWorkflowItemId(item.id);
      setWorkflowItemStage(item.stage);
      rememberActiveWorkflowItem(item.id);
      setSourceUrl(item.sourceUrl ?? "");
      setJsonText(JSON.stringify(item.scrapedData ?? {}, null, 2));
      setJsonFileName(`${item.offerId}.json`);
      const storedFeatures = Array.isArray(item.features)
        ? (item.features as unknown as ListingFeatureDraft[])
        : [];
      setFeatureDraft(
        storedFeatures.length ? storedFeatures : createBaseFeatureDraft(),
      );
      setFeatureNotes(Array.isArray(item.notes) ? item.notes : []);
      setFeatureStatusOk(item.status === "MATCHED");
      setFeatureStatusMessage(
        item.status === "MATCHED"
          ? "已从加工阶段恢复 AI 类目特征，可以继续修改或上传。"
          : item.stage === "PROCESSING"
            ? "商品已进入加工阶段，主图、特征和选中图片会并行处理。"
            : null,
      );
      if (item.aiResponse && typeof item.aiResponse === "object") {
        const restoredResponse =
          item.aiResponse as unknown as TextPromptResponse;
        setTextPromptResponse(restoredResponse);
        setAiSkuVariants(restoredResponse.ozonMapping?.variants ?? []);
      } else {
        setTextPromptResponse(null);
        setAiSkuVariants([]);
      }
      if (item.categoryId) {
        await loadOzonSnapshot(item.categoryId, {
          preserveFeatureDraft: true,
          matchSource: "ai",
        });
      } else {
        clearMatchedCategory();
      }
      setLaunchResult({
        url: null,
        action: "workflow_item_loaded",
        message: `已载入${item.stage === "PROCESSING" ? "加工" : "采集"}阶段商品：${item.title}`,
        time: new Date().toLocaleTimeString(),
      });
    } catch (error) {
      forgetActiveWorkflowItem(itemId);
      loadedWorkflowItemRef.current = "";
      setWorkflowItemStage(null);
      toast.error(error instanceof Error ? error.message : "商品记录载入失败");
    }
  }

  function saveTextPrompt() {
    const prompt = textPrompt.trim();
    if (!prompt) {
      toast.error("请先填写文本提示词");
      return;
    }
    try {
      window.localStorage.setItem(textPromptStorageKey, prompt);
      setTextPrompt(prompt);
      setSavedTextPrompt(prompt);
      toast.success("文本提示词已保存");
    } catch {
      toast.error("文本提示词保存失败");
    }
  }

  function saveTextSystemPrompt(nextPrompt: string) {
    const prompt = nextPrompt.trim();
    if (!prompt) {
      toast.error("系统提示词不能为空");
      return;
    }
    try {
      window.localStorage.setItem(textSystemPromptStorageKey, prompt);
      setTextSystemPrompt(prompt);
      setTextSystemPromptOpen(false);
      toast.success("系统提示词已保存");
    } catch {
      toast.error("系统提示词保存失败");
    }
  }

  function saveStageAiPrompts(nextPrompts: ListingStageAiPromptConfig) {
    const prompts = normalizeListingStageAiPrompts(nextPrompts);
    try {
      window.localStorage.setItem(
        LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
        JSON.stringify(prompts),
      );
      setStageAiPrompts(prompts);
      setImagePrompt(prompts.imageGeneration.prompt);
      setImageAspectRatio(prompts.imageGeneration.aspectRatio);
      setImageUseReference(prompts.imageGeneration.useReference);
      setImagePromptTouched(true);
      setStagePromptDialogOpen(false);
      toast.success("AI 提示词已保存");
    } catch {
      toast.error("AI 提示词保存失败");
    }
  }

  async function hydrateBaseFeaturesFromJson(
    scrapedData: Record<string, unknown>,
    options: { preserveExisting?: boolean } = {},
  ) {
    try {
      const result = await readApi<FeatureDraftResponse>(
        await fetch("/api/listing-workflow/feature-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scrapedData }),
        }),
      );
      const hydratedBase = result.features.filter((feature) => feature.group === "base");
      if (!hydratedBase.length) return result.features;
      setFeatureDraft((current) => {
        const currentBase = new Map(
          current
            .filter((feature) => feature.group === "base")
            .map((feature) => [baseFeatureId(feature), feature]),
        );
        const nextBase = hydratedBase.map((feature) => {
          if (!options.preserveExisting) return feature;
          const existing = currentBase.get(baseFeatureId(feature));
          if (!existing) return feature;
          if (
            existing.source === "人工修改" ||
            baseFeatureId(feature) === "offer_id" ||
            baseFeatureId(feature) === "images"
          ) {
            return existing;
          }
          return feature;
        });
        return [
          ...nextBase,
          ...current.filter((feature) => feature.group !== "base"),
        ];
      });
      return result.features;
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : "包装和商品基础信息自动回填失败");
      return [];
    }
  }

  async function runTwoStageAiWorkflow(
    scrapedData: Record<string, unknown>,
  ) {
    if (!selectedFeatureModel) {
      toast.error("请先选择用于两阶段匹配的文本模型");
      return false;
    }
    const promptConfig = normalizeListingStageAiPrompts(stageAiPrompts);

    const runId = textPromptRunRef.current + 1;
    textPromptRunRef.current = runId;
    setSkuSelectionApplied(false);
    setTextPromptResponse(null);
    setTextPromptResponseError(null);
    setTextPromptResponseLoading(true);
    setCategoryMatchMessage(null);
    setFeatureStatusMessage(null);
    try {
      window.localStorage.removeItem(textPromptResponseStorageKey);
    } catch {
      // 本地存储不可用时不影响两阶段匹配。
    }

    try {
      const recordStage = workflowItemStage ?? "PROCESSING";
      if (workflowItemId) {
        await patchWorkflowItem(workflowItemId, {
          status: "AI_RUNNING",
        });
      }
      setBusyAction("category-match");
      const categoryResult = await readApi<CategoryMatchResponse>(
        await fetch("/api/listing-workflow/category-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scrapedData,
            providerId: selectedFeatureModel.providerId,
            model: selectedFeatureModel.modelId,
            customPrompt: promptConfig.categoryMatch.taskPrompt,
            systemPrompt: promptConfig.categoryMatch.systemPrompt,
          }),
        }),
      );
      if (textPromptRunRef.current !== runId) return false;

      setCategoryMatchOk(categoryResult.aiStatus.ok);
      setCategoryMatchMessage(categoryResult.aiStatus.message);
      setCategoryMatchReason(categoryResult.reason);
      setCategoryMatchConfidence(categoryResult.confidence);
      if (!categoryResult.category) {
        setTextPromptResponseError(categoryResult.aiStatus.message);
        if (workflowItemId) {
          void patchWorkflowItem(workflowItemId, {
            status: "AI_FAILED",
          }).catch(() => undefined);
        }
        toast.warning(categoryResult.aiStatus.message);
        return false;
      }

      const categorySnapshot = await loadOzonSnapshot(
        categoryResult.category.id,
        { preserveFeatureDraft: true, matchSource: "ai" },
      );
      const syncedSnapshot = await syncSelectedCategoryAttributes(
        categoryResult.category.id,
        categorySnapshot,
        true,
      );
      const attributeCount =
        syncedSnapshot?.selectedCategory?.attributes?.length ?? 0;
      if (!attributeCount) {
        const message =
          "类目已经匹配，但没有读取到该类目的 Ozon 特征，第二阶段已停止。";
        setTextPromptResponseError(message);
        if (workflowItemId) {
          void patchWorkflowItem(workflowItemId, {
            status: "AI_FAILED",
            categoryId: categoryResult.category.id,
            categoryLabel: categoryResult.category.label,
            categoryPath: categoryResult.category.path,
          }).catch(() => undefined);
        }
        toast.error(message);
        return false;
      }

      setCategoryMatchMessage(
        `${categoryResult.aiStatus.message} 第一阶段已把 ${categoryResult.promptAudit.rawBytes} 字节原始 JSON 清洗为 ${categoryResult.promptAudit.preparedBytes} 字节商品事实，移除 ${categoryResult.promptAudit.removedImageReferenceCount} 个图片引用和 ${categoryResult.promptAudit.removedUrlCount} 个链接；已读取 ${attributeCount} 个类目特征，开始第二阶段填写。`,
      );
      setBusyAction("features");
      const featureResult = await readApi<FeatureDraftResponse>(
        await fetch("/api/listing-workflow/feature-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scrapedData,
            preparedProduct: categoryResult.preparedProduct,
            categoryId: categoryResult.category.id,
            providerId: selectedFeatureModel.providerId,
            model: selectedFeatureModel.modelId,
            customPrompt: promptConfig.featureFill.taskPrompt,
            systemPrompt: promptConfig.featureFill.systemPrompt,
          }),
        }),
      );
      if (textPromptRunRef.current !== runId) return false;

      const mergedDraft = mergeStageTwoFeatureDraft(
        featureDraft,
        featureResult.features,
      );
      const uploadReadyDraft = featureResult.aiResponse?.ozonMapping
        ? mergeOzonAiMappingIntoDraft(
            mergedDraft,
            featureResult.aiResponse.ozonMapping,
            syncedSnapshot ?? categorySnapshot,
          )
        : mergedDraft;
      const completedDraft = applyWorkflowImageOrder(
        uploadReadyDraft,
        managedImages,
      );
      setFeatureDraft(completedDraft);
      setFeatureNotes(featureResult.notes ?? []);
      setFeatureStatusOk(featureResult.aiStatus.ok);
      setFeatureStatusMessage(featureResult.aiStatus.message);

      if (featureResult.aiResponse) {
        setTextPromptResponse(featureResult.aiResponse);
        setAiSkuVariants(
          featureResult.aiResponse.ozonMapping?.variants ?? [],
        );
        try {
          window.localStorage.setItem(
            textPromptResponseStorageKey,
            JSON.stringify(featureResult.aiResponse),
          );
        } catch {
          // 回复过长或本地存储不可用时，当前页面仍正常展示。
        }
      }

      const recordPatch = {
        ...workflowItemPayload(scrapedData, completedDraft, {
          stage: recordStage,
          status: featureResult.aiStatus.ok ? "MATCHED" : "AI_FAILED",
          categoryId: categoryResult.category.id,
          categoryLabel: categoryResult.category.label,
          categoryPath: categoryResult.category.path,
          aiResponse: {
            ...(featureResult.aiResponse ?? {}),
            categoryMatch: {
              aiDecision: categoryResult.aiDecision ?? null,
              categoryCorrection:
                categoryResult.categoryCorrection ?? null,
              confidence: categoryResult.confidence,
              reason: categoryResult.reason,
            },
          },
          notes: featureResult.notes ?? [],
        }),
      };
      if (workflowItemId) {
        const savedItem = await patchWorkflowItem(workflowItemId, recordPatch);
        setWorkflowItemStage(savedItem.stage);
      } else {
        const createdItem = await createWorkflowItem(
          scrapedData,
          completedDraft,
          recordPatch,
        );
        setWorkflowItemId(createdItem.id);
        setWorkflowItemStage(createdItem.stage);
        loadedWorkflowItemRef.current = createdItem.id;
        rememberActiveWorkflowItem(createdItem.id);
        router.replace(`/projects/new?item=${createdItem.id}`);
      }

      if (featureResult.aiStatus.ok) {
        toast.success(
          `两阶段匹配完成：类目 1 次请求，${attributeCount} 个特征 1 次请求`,
        );
        return true;
      }
      toast.warning(featureResult.aiStatus.message);
      return false;
    } catch (error) {
      if (textPromptRunRef.current !== runId) return false;
      const message =
        error instanceof Error ? error.message : "两阶段 AI 匹配失败";
      setTextPromptResponseError(message);
      if (workflowItemId) {
        void patchWorkflowItem(workflowItemId, {
          status: "AI_FAILED",
        }).catch(() => undefined);
      }
      toast.error(message);
      return false;
    } finally {
      if (textPromptRunRef.current === runId) {
        setTextPromptResponseLoading(false);
        setBusyAction(null);
      }
      void refreshUsageHistory();
    }
  }

  async function applySelectedSkusAndRunAi() {
    if (!skuOptions.length && aiSkuVariants.length) {
      const fallbackSkuId =
        selectedSkuId || displayedSkuOptions[0]?.id || "";
      if (skuMode === "single" && !fallbackSkuId) {
        toast.error("请选择一个 SKU");
        return;
      }
      setSkuSelectionApplied(true);
      toast.success(
        skuMode === "all"
          ? `已选择全部 ${displayedSkuOptions.length} 个 AI SKU`
          : `已选择 SKU：${fallbackSkuId}`,
      );
      return;
    }
    if (!parsedJson) {
      toast.error("请先采集或粘贴商品 JSON");
      return;
    }
    let selectedData = parsedJson;
    if (skuOptions.length) {
      const fallbackSkuId = selectedSkuId || skuOptions[0]?.id || "";
      if (skuMode === "single" && !fallbackSkuId) {
        toast.error("请选择一个 SKU");
        return;
      }
      selectedData = applySkuSelectionToJson(
        parsedJson,
        skuMode,
        fallbackSkuId,
      );
    }
    setSkuSelectionApplied(false);
    await hydrateBaseFeaturesFromJson(selectedData, {
      preserveExisting: true,
    });
    const success = await runTwoStageAiWorkflow(selectedData);
    if (success) {
      setSkuSelectionApplied(true);
    }
  }

  async function collectProduct() {
    if (!selectedFeatureModel) {
      toast.error("请先选择“特征填写 AI”模型，采集完成后会立即匹配类目");
      return;
    }
    const featureModel = selectedFeatureModel;
    const controller = new AbortController();
    collectAbortRef.current = controller;
    setBusyAction("collect");
    try {
      const result = await readApi<ProductCollectResult>(
        await fetch("/api/crawlers/collect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: sourceUrl }),
          signal: controller.signal,
        }),
      );
      setJsonText(JSON.stringify(result.scrapedData, null, 2));
      setJsonFileName(result.fileName);
      resetFeatureWorkflow();
      textPromptRunRef.current += 1;
      setTextPromptResponse(null);
      setTextPromptResponseError(null);
      setTextPromptResponseLoading(false);
      try {
        window.localStorage.removeItem(textPromptResponseStorageKey);
      } catch {
        // 本地存储不可用时不影响采集和后续匹配。
      }
      setLaunchResult({
        url: null,
        action: "collect",
        message: `${result.platform} 商品已采集成 JSON，已进入后续 Ozon 特征匹配流程。`,
        time: new Date().toLocaleTimeString(),
      });
      toast.success("采集完成，JSON 已填入");
      const promptConfig = normalizeListingStageAiPrompts(stageAiPrompts);
      const categoryMatchPromise = fetch("/api/listing-workflow/category-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scrapedData: result.scrapedData,
            providerId: featureModel.providerId,
            model: featureModel.modelId,
            customPrompt: promptConfig.categoryMatch.taskPrompt,
            systemPrompt: promptConfig.categoryMatch.systemPrompt,
          }),
          signal: controller.signal,
        }).then((response) => readApi<CategoryMatchResponse>(response));
      toast("商品采集完成，AI 类目匹配已发送");
      const [hydratedFeatures, categoryOutcome] = await Promise.all([
        hydrateBaseFeaturesFromJson(result.scrapedData),
        categoryMatchPromise.then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        ),
        refresh(""),
      ]).then(([features, category]) => [features, category] as const);
      if (controller.signal.aborted) {
        throw new DOMException("采集已暂停", "AbortError");
      }
      const collectedImages = buildCollectedManagedImages(result.scrapedData);
      const collectedScrapedData = {
        ...result.scrapedData,
        workflowImages: {
          items: collectedImages,
          selectedImageIds: [],
          selectedImageUrls: [],
          primaryImageUrl: collectedImages[0]?.url || "",
          updatedAt: new Date().toISOString(),
        },
      };
      const collectedFeatures = applyWorkflowImageOrder(
        hydratedFeatures.length
          ? hydratedFeatures
          : buildFallbackCollectedFeatures(result.scrapedData),
        collectedImages,
      );
      setFeatureDraft(collectedFeatures);
      const categoryResult = categoryOutcome.value;
      const matchedCategory = categoryResult?.category ?? null;
      const categoryErrorMessage = categoryOutcome.error
        ? categoryOutcome.error instanceof Error
          ? categoryOutcome.error.message
          : "AI 类目匹配失败"
        : categoryResult?.aiStatus.message || "AI 没有返回类目结果";
      if (categoryResult) {
        setCategoryMatchOk(Boolean(matchedCategory));
        setCategoryMatchMessage(categoryResult.aiStatus.message);
        setCategoryMatchReason(categoryResult.reason);
        setCategoryMatchConfidence(categoryResult.confidence);
      }
      const collectedItem = await createWorkflowItem(
        collectedScrapedData,
        collectedFeatures,
        {
          stage: "COLLECTED",
          status: matchedCategory ? "PENDING_AI" : "AI_FAILED",
          imageUrl: firstWorkflowImage(result.scrapedData) || null,
          categoryId: matchedCategory?.id ?? null,
          categoryLabel: matchedCategory?.label ?? null,
          categoryPath: matchedCategory?.path ?? null,
          aiResponse: matchedCategory
            ? {
                categoryMatch: {
                  providerId: featureModel.providerId,
                  model: featureModel.modelId,
                  preparedProduct: categoryResult?.preparedProduct ?? {},
                  aiDecision: categoryResult?.aiDecision ?? null,
                  categoryCorrection:
                    categoryResult?.categoryCorrection ?? null,
                  confidence: categoryResult?.confidence ?? 0,
                  reason: categoryResult?.reason ?? "",
                },
              }
            : {
                categoryMatch: {
                  providerId: featureModel.providerId,
                  model: featureModel.modelId,
                  error: categoryErrorMessage,
                },
              },
          notes: matchedCategory ? [] : [categoryErrorMessage],
        },
      );
      setWorkflowItemId(collectedItem.id);
      setWorkflowItemStage(collectedItem.stage);
      loadedWorkflowItemRef.current = collectedItem.id;
      rememberActiveWorkflowItem(collectedItem.id);
      if (matchedCategory) {
        toast.success(`商品卡已保存，类目已匹配：${matchedCategory.label}`);
      } else {
        toast.warning(`商品卡已保存，类目匹配提醒：${categoryErrorMessage}`);
      }
      const collectedSkus = extractProductSkuOptions(result.scrapedData);
      setSkuMode("single");
      setSelectedSkuId(collectedSkus[0]?.id ?? "");
      setSkuSelectionApplied(false);
      setAiSkuVariants([]);
      if (collectedSkus.length > 1) {
        toast.info(
          `检测到 ${collectedSkus.length} 个 SKU，请选择加工范围和待翻译图片`,
        );
      } else if (collectedSkus.length === 1) {
        toast.info("已识别 1 个 SKU，请确认图片后加入加工阶段");
      } else {
        toast.info("商品可直接确认图片并加入加工阶段");
      }
      router.push("/listing/collection");
    } catch (error) {
      const message = error instanceof Error ? error.message : "采集失败";
      if (controller.signal.aborted || message.includes("暂停") || message.toLowerCase().includes("abort")) {
        setLaunchResult({
          url: null,
          action: "collect_paused",
          message: "采集已暂停，当前页面不会继续写入新的 JSON。",
          time: new Date().toLocaleTimeString(),
        });
        toast.warning("采集已暂停");
      } else {
        toast.error(message);
      }
    } finally {
      if (collectAbortRef.current === controller) {
        collectAbortRef.current = null;
      }
      setBusyAction(null);
    }
  }

  function pauseCollect() {
    collectAbortRef.current?.abort();
  }

  async function openCrawlerConsole() {
    setBusyAction("console");
    try {
      const result = await readApi<CrawlerLaunchResult>(
        await fetch("/api/crawlers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: consoleAction }),
        }),
      );
      setLaunchResult({ ...result, time: new Date().toLocaleTimeString() });
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      toast.success(result.message);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开采集控制台失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function syncSelectedCategoryAttributes(
    categoryId: string,
    snapshot: OzonFeatureSnapshot | null,
    preserveFeatureDraft = false,
  ) {
    let currentSnapshot = snapshot;
    const category = currentSnapshot?.selectedCategory;
    const categoryAttributes = category?.attributes ?? [];
    const needsAttributeSync =
      categoryAttributes.length === 0 ||
      categoryAttributes.some(
        (attribute) => attribute.dictionaryId && attribute.dictionaryValueCount === 0,
      );
    if (!category || !currentSnapshot?.connection.ready) {
      return currentSnapshot;
    }

    try {
      if (needsAttributeSync) {
        await readApi<Record<string, unknown>>(
          await fetch("/api/ozon/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "category_attributes",
              categoryRecordId: categoryId,
              includeValues: true,
              language: "DEFAULT",
              maxValuesPerAttribute: 1000,
            }),
          }),
        );
        currentSnapshot = await loadOzonSnapshot(categoryId, {
          preserveFeatureDraft,
          matchSource: preserveFeatureDraft ? "ai" : "manual",
        });
      }

      const translatedAttributes =
        currentSnapshot?.selectedCategory?.attributes ?? [];
      const needsChineseSync = translatedAttributes.some(
        (attribute) =>
          !attribute.nameZh ||
          (attribute.dictionaryValueCount > 0 &&
            attribute.values.some((value) => !value.valueZh)),
      );
      if (needsChineseSync) {
        await readApi<Record<string, unknown>>(
          await fetch("/api/ozon/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "category_attributes",
              categoryRecordId: categoryId,
              includeValues: true,
              language: "ZH_HANS",
              maxValuesPerAttribute: 1000,
            }),
          }),
        );
        currentSnapshot = await loadOzonSnapshot(categoryId, {
          preserveFeatureDraft,
          matchSource: preserveFeatureDraft ? "ai" : "manual",
        });
      }
      return currentSnapshot;
    } catch (error) {
      toast.warning(
        error instanceof Error
          ? error.message
          : "类目特殊字段或中文值同步失败，可到特征表页检查 Ozon 配置。",
      );
      return currentSnapshot;
    }
  }

  async function generateListingImage(referenceImageId?: string, referenceImageUrl?: string) {
    if (!selectedImageModel) {
      toast.error("请先选择图片生成 / 改图 AI 模型");
      return;
    }
    if (!imagePrompt.trim()) {
      toast.error("请先填写生图提示词");
      return;
    }

    setBusyAction("image-generate");
    setImageGenerationMessage(null);
    try {
      const selectedReference =
        referenceImageUrl ||
        managedImages.find((image) => image.id === referenceImageId)?.url ||
        managedImages[0]?.url ||
        "";
      const referenceImages = selectedReference ? [selectedReference] : [];
      const result = await readApi<ListingImageGenerateResponse>(
        await fetch("/api/listing-workflow/image-generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: selectedImageModel.providerId,
            model: selectedImageModel.modelId,
            prompt: imagePrompt,
            aspectRatio: imageAspectRatio,
            useReferenceImages: referenceImages.length > 0,
            referenceImages,
          }),
        }),
      );
      setGeneratedListingImage(result);
      const generatedImage: ManagedWorkflowImage = {
        id: `generated:${result.filePath}`,
        name: result.fileName,
        url: result.imageUrl,
        label: "AI 主图",
        source: "generated",
      };
      setManagedImages((current) => [
        generatedImage,
        ...current.filter((image) => image.id !== generatedImage.id),
      ].slice(0, WORKFLOW_IMAGE_LIMIT));
      setPrimaryImageId(generatedImage.id);
      setImageGenerationMessage(
        result.warnings.length
          ? `已生成图片，但有 ${result.warnings.length} 个参考图未能使用。`
          : referenceImages.length
            ? `已生成图片，使用 ${result.usedReferenceImageCount} 张参考图。`
            : "已生成图片，但当前没有可传入 GPT 的主图/参考图。",
      );
      if (result.warnings.length) {
        toast.warning("图片已生成，部分参考图未能使用");
      } else {
        toast.success("主图已生成");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主图生成失败");
    } finally {
      void refreshUsageHistory();
      setBusyAction(null);
    }
  }

  function generateProductDetailImage(item: ProductDetailMediaItem, index: number) {
    if (item.type !== "image") return;
    const imageId = ensureWorkflowImageFromUrl(
      item.url,
      `detail-${String(index + 1).padStart(2, "0")}.jpg`,
      "详情图",
    );
    void generateListingImage(imageId, item.url);
  }

  function updateFeatureDraft(attributeId: string, patch: Partial<ListingFeatureDraft>) {
    setFeatureDraft((current) =>
      current.map((feature) => {
        if (feature.attributeId !== attributeId) return feature;
        const nextValue = patch.value?.trim();
        const localAttribute = ozonSnapshot?.selectedCategory?.attributes?.find(
          (attribute) =>
            attribute.ozonAttributeId ===
            (feature.ozonCode || feature.attributeId),
        );
        const dictionaryValue =
          nextValue && localAttribute?.dictionaryId
            ? localAttribute.values.find(
                (candidate) =>
                  normalizeOzonAttributeMatchKey(candidate.value) ===
                    normalizeOzonAttributeMatchKey(nextValue) ||
                  normalizeOzonAttributeMatchKey(candidate.valueZh || "") ===
                    normalizeOzonAttributeMatchKey(nextValue),
              )
            : undefined;
        const dictionaryValueId = Number(dictionaryValue?.ozonValueId);
        const manualAttributeValues =
          patch.value === undefined || feature.group !== "category"
            ? feature.ozonAttributeValues
            : Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
              ? [
                  {
                    dictionary_value_id: dictionaryValueId,
                    value: dictionaryValue?.value || nextValue,
                  },
                ]
              : nextValue && !localAttribute?.dictionaryId
                ? [{ value: nextValue }]
                : undefined;
        return {
          ...feature,
          ...patch,
          ...(patch.value !== undefined
            ? {
                source: "人工修改",
                reason: "用户在前端手动修改，后续 AI 自动匹配不会覆盖。",
                ozonAttributeValues: manualAttributeValues,
              }
            : {}),
          status: patch.value?.trim()
            ? feature.required
              ? "review"
              : feature.status === "missing"
                ? "review"
                : feature.status
            : feature.status,
        };
      }),
    );
  }

  function addCustomFeature() {
    const now = Date.now();
    setFeatureDraft((current) => [
      ...current,
      {
        attributeId: `custom-${now}`,
        label: "自定义特征",
        value: "",
        confidence: 0.5,
        required: false,
        group: selectedCategoryId ? "category" : "source",
        ozonCode: null,
        valueType: "string",
        status: "review",
        source: "人工",
        reason: "人工新增字段，上传前可继续修改。",
        dictionaryValueCount: 0,
        options: [],
      },
    ]);
  }

  function removeFeature(attributeId: string) {
    setFeatureDraft((current) => current.filter((feature) => feature.attributeId !== attributeId));
  }

  useEffect(() => {
    refresh();
    void refreshUsageHistory();
  }, []);

  useEffect(() => {
    if (
      loading ||
      !requestedWorkflowItemId ||
      loadedWorkflowItemRef.current === requestedWorkflowItemId
    ) {
      return;
    }
    void loadWorkflowItem(requestedWorkflowItemId);
  }, [loading, requestedWorkflowItemId]);

  useEffect(() => {
    if (
      loading ||
      requestedWorkflowItemId ||
      loadedWorkflowItemRef.current
    ) {
      return;
    }
    const rememberedItemId = readActiveWorkflowItemId();
    if (!rememberedItemId) return;
    loadedWorkflowItemRef.current = rememberedItemId;
    void loadWorkflowItem(rememberedItemId);
  }, [loading, requestedWorkflowItemId]);

  useEffect(() => {
    try {
      const storedPrompt = window.localStorage.getItem(textPromptStorageKey)?.trim();
      if (storedPrompt) {
        setTextPrompt(storedPrompt);
        setSavedTextPrompt(storedPrompt);
      }
      const storedSystemPrompt = window.localStorage.getItem(textSystemPromptStorageKey)?.trim();
      if (storedSystemPrompt) {
        setTextSystemPrompt(storedSystemPrompt);
      }
      const storedStagePrompts = window.localStorage.getItem(
        LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
      );
      if (storedStagePrompts) {
        const restoredPrompts = normalizeListingStageAiPrompts(
          JSON.parse(storedStagePrompts),
        );
        setStageAiPrompts(restoredPrompts);
        setImagePrompt(restoredPrompts.imageGeneration.prompt);
        setImageAspectRatio(restoredPrompts.imageGeneration.aspectRatio);
        setImageUseReference(restoredPrompts.imageGeneration.useReference);
        setImagePromptTouched(true);
      }
      const storedFeatureModel = parseListingModelSelection(
        window.localStorage.getItem(LISTING_FEATURE_MODEL_STORAGE_KEY),
      );
      if (storedFeatureModel) {
        setFeatureProviderId(storedFeatureModel.providerId);
        setFeatureModelId(storedFeatureModel.modelId);
      }
      const storedImageModel = parseListingModelSelection(
        window.localStorage.getItem(LISTING_IMAGE_MODEL_STORAGE_KEY),
      );
      if (storedImageModel) {
        setImageProviderId(storedImageModel.providerId);
        setImageModelId(storedImageModel.modelId);
      }
      const storedResponse = window.localStorage.getItem(
        textPromptResponseStorageKey,
      );
      if (storedResponse) {
        const parsedResponse = JSON.parse(
          storedResponse,
        ) as Partial<TextPromptResponse>;
        if (
          typeof parsedResponse.text === "string" &&
          typeof parsedResponse.providerId === "string" &&
          typeof parsedResponse.providerName === "string" &&
          typeof parsedResponse.model === "string" &&
          typeof parsedResponse.generatedAt === "string"
        ) {
          const restoredResponse = parsedResponse as TextPromptResponse;
          setTextPromptResponse(restoredResponse);
          setAiSkuVariants(restoredResponse.ozonMapping?.variants ?? []);
        }
      }
    } catch {
      // 浏览器禁用本地存储时继续使用默认提示词。
    }
  }, []);

  useEffect(() => {
    if (!imagePromptTouched) {
      setImagePrompt(buildDefaultListingImagePrompt(title));
    }
  }, [imagePromptTouched, title]);

  useEffect(() => {
    if (!selectedFeatureModel) return;
    try {
      window.localStorage.setItem(
        LISTING_FEATURE_MODEL_STORAGE_KEY,
        JSON.stringify({
          providerId: selectedFeatureModel.providerId,
          modelId: selectedFeatureModel.modelId,
        }),
      );
    } catch {
      // 本地存储不可用时仅影响下次恢复，不影响当前模型调用。
    }
  }, [selectedFeatureModel]);

  useEffect(() => {
    if (!selectedImageModel) return;
    try {
      window.localStorage.setItem(
        LISTING_IMAGE_MODEL_STORAGE_KEY,
        JSON.stringify({
          providerId: selectedImageModel.providerId,
          modelId: selectedImageModel.modelId,
        }),
      );
    } catch {
      // 本地存储不可用时仅影响下次恢复，不影响当前图片生成。
    }
  }, [selectedImageModel]);

  useEffect(() => {
    const hasSelectedFeatureModel = featureModelChoices.some(
      (model) => model.providerId === featureProviderId && model.modelId === featureModelId,
    );
    if ((!featureModelId || !hasSelectedFeatureModel) && featureModelChoices.length) {
      const nextFeatureModel =
        featureModelChoices.find((model) => model.providerIsActive && model.isDefaultAnalysis) ??
        featureModelChoices.find((model) => model.isDefaultAnalysis) ??
        featureModelChoices.find((model) => model.providerIsActive && model.capabilities.structured_output) ??
        featureModelChoices.find((model) => model.capabilities.structured_output) ??
        featureModelChoices.find((model) => model.providerIsActive) ??
        featureModelChoices[0];
      setFeatureProviderId(nextFeatureModel.providerId);
      setFeatureModelId(nextFeatureModel.modelId);
    }

    const hasSelectedImageModel = imageModelChoices.some(
      (model) => model.providerId === imageProviderId && model.modelId === imageModelId,
    );
    const browserImageModel =
      imageModelChoices.find((model) => model.source === "browser" && model.modelId === "gpt-image-1.5") ??
      imageModelChoices.find((model) => model.source === "browser" && model.capabilities.image_gen);
    const shouldPreferBrowserImageModel =
      browserImageModel &&
      (!hasSelectedImageModel ||
        !imageModelId ||
        imageModelChoices.find(
          (model) => model.providerId === imageProviderId && model.modelId === imageModelId,
        )?.source !== "browser");
    if (shouldPreferBrowserImageModel) {
      setImageProviderId(browserImageModel.providerId);
      setImageModelId(browserImageModel.modelId);
    } else if ((!imageModelId || !hasSelectedImageModel) && imageModelChoices.length) {
      const nextImageModel =
        imageModelChoices.find((model) => model.providerIsActive && (model.isDefaultHeroImage || model.isDefaultDetailImage || model.isDefaultImageEdit)) ??
        imageModelChoices.find((model) => model.isDefaultHeroImage || model.isDefaultDetailImage || model.isDefaultImageEdit) ??
        imageModelChoices.find((model) => model.providerIsActive) ??
        imageModelChoices[0];
      setImageProviderId(nextImageModel.providerId);
      setImageModelId(nextImageModel.modelId);
    }
  }, [featureModelChoices, featureModelId, featureProviderId, imageModelChoices, imageModelId, imageProviderId]);

  return (
    <>
    <section className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-slate-900 dark:text-white">Ozon 自动上架工作流</p>
            <Badge variant={jsonValid ? "success" : directCollectReady ? "warning" : "outline"}>
              {jsonValid ? "JSON 就绪" : directCollectReady ? "可采集" : "等待链接"}
            </Badge>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            链接采集、AI 匹配 Ozon 类目、读取类目字段、AI 填写特征值、图片处理、Ozon 上传。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-label="AI 提示词"
            data-testid="listing-stage-ai-prompts-button"
            onClick={() => setStagePromptDialogOpen(true)}
            className="gap-2"
          >
            <Bot className="h-4 w-4" />
            AI 提示词
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-white/10 dark:text-slate-300">
              {stageAiPromptsCustomized ? "自定义" : "默认"}
            </span>
          </Button>
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              onClick={() => setUsagePanelOpen((open) => !open)}
              className="gap-2"
            >
              <History className="h-4 w-4" />
              记录
              {usageSummary ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-white/10 dark:text-slate-300">{usageSummary.totalRequests}</span> : null}
            </Button>
            {usagePanelOpen ? (
              <div className="fixed left-4 right-4 top-20 z-50 md:left-auto md:right-8 md:w-[720px] xl:right-[calc((100vw-1600px)/2+2rem)]">
                <UsageRecordPanel
                  usageSummary={usageSummary}
                  usageLoading={usageLoading}
                  onRefresh={refreshUsageHistory}
                  onClose={() => setUsagePanelOpen(false)}
                />
              </div>
            ) : null}
          </div>
          <Button type="button" variant="outline" onClick={() => refresh()} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            扫描模块
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <div className="space-y-4">
          <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_auto]">
            <div className="space-y-2">
              <label className="whitespace-nowrap text-sm font-medium text-slate-900 dark:text-white">商品链接</label>
              <Input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="粘贴淘宝 / 京东 / 1688 商品链接" />
              {platform.key === "1688" ? (
                <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                  点击采集会自动连接持久化浏览器、读取 1688 Cookie 并抓取商品；首次出现登录或安全验证时，只需在自动打开的页面完成一次。
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button type="button" onClick={collectProduct} disabled={!sourceUrl.trim() || !selectedFeatureModel || busyAction !== null} className="gap-2">
                {busyAction === "collect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                {busyAction === "collect" ? "采集并匹配类目" : "启动采集"}
              </Button>
              <Button type="button" variant="outline" onClick={pauseCollect} disabled={busyAction !== "collect"} className="gap-2">
                <PauseCircle className="h-4 w-4" />
                暂停
              </Button>
              <Button type="button" variant="outline" onClick={openCrawlerConsole} disabled={!consoleReady || busyAction !== null} className="gap-2">
                {busyAction === "console" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                打开控制台
              </Button>
              <Button type="button" variant="outline" onClick={() => window.open("/ozon/features", "_blank", "noopener,noreferrer")} className="gap-2">
                <ExternalLink className="h-4 w-4" />
                特征表
              </Button>
            </div>
          </div>

          {launchResult ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
              <div className="min-w-0">
                <p className="font-semibold">{launchResult.action === "collect" ? "采集已完成" : "采集入口已响应"}</p>
                <p className="mt-1 leading-5 opacity-80">{launchResult.message}</p>
                {launchResult.url ? <p className="mt-1 truncate text-xs opacity-70">{launchResult.url}</p> : null}
              </div>
              {launchResult.url ? (
                <Button type="button" variant="outline" onClick={() => window.open(launchResult.url!, "_blank", "noopener,noreferrer")} className="gap-2 bg-white/80">
                  <ExternalLink className="h-4 w-4" />
                  打开控制台
                </Button>
              ) : (
                <span className="rounded-full bg-white/70 px-3 py-2 text-xs font-semibold dark:bg-black/20">{launchResult.time}</span>
              )}
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">特征填写 AI</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">只用于 Ozon 属性理解和字段填写，DeepSeek 这类文本模型放这里。</p>
                </div>
                <Badge variant={selectedFeatureModel ? "success" : "warning"}>{selectedFeatureModel ? "可用" : "未选择"}</Badge>
              </div>
              <ModelChoiceSelect
                value={featureModelValue}
                onValueChange={(value) => {
                  const [providerId, modelId] = value.split(modelChoiceDivider);
                  setFeatureProviderId(providerId ?? "");
                  setFeatureModelId(modelId ?? "");
                }}
                options={featureModelChoices.map((model) => ({
                  value: modelChoiceValue(model.providerId, model.modelId),
                  label: modelChoiceLabel(model),
                  isBrowser: model.source === "browser",
                }))}
                placeholder="未选择"
                ariaLabel="特征填写 AI 模型"
                emptyLabel="暂无文本 / 结构化模型"
                className="mt-3"
              />
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {selectedFeatureModel
                  ? `${selectedFeatureModel.providerName} / ${modelCapabilityText(selectedFeatureModel)}${selectedFeatureModel.source === "browser" ? " / 本机浏览器运行" : ""}`
                  : "还没有配置可用的文本 / 结构化模型"}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">图片生成 / 改图 AI</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">只用于主图改造、补角度图和详情图生成，和特征填写模型分开。</p>
                </div>
                <Badge variant={selectedImageModel ? "success" : "warning"}>{selectedImageModel ? "可用" : "未选择"}</Badge>
              </div>
              <ModelChoiceSelect
                value={imageModelValue}
                onValueChange={(value) => {
                  const [providerId, modelId] = value.split(modelChoiceDivider);
                  setImageProviderId(providerId ?? "");
                  setImageModelId(modelId ?? "");
                }}
                options={imageModelChoices.map((model) => ({
                  value: modelChoiceValue(model.providerId, model.modelId),
                  label: modelChoiceLabel(model),
                  isBrowser: model.source === "browser",
                }))}
                placeholder="未选择"
                ariaLabel="图片生成 AI 模型"
                emptyLabel="暂无图片生成 / 改图模型"
                className="mt-3"
              />
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {selectedImageModel
                  ? `${selectedImageModel.providerName} / ${modelCapabilityText(selectedImageModel)}${selectedImageModel.source === "browser" ? " / 本机浏览器运行" : ""}`
                  : "还没有配置可用的图片生成 / 改图模型"}
              </p>
            </div>
          </div>

	          <SkuSelectionPanel
            options={displayedSkuOptions}
            mode={skuMode}
            selectedSkuId={selectedSkuId}
            aiVariants={aiSkuVariants}
            processing={textPromptResponseLoading}
            applied={skuSelectionApplied}
            canMatchWithoutSku={jsonValid && displayedSkuOptions.length === 0}
            onModeChange={(mode) => {
              setSkuMode(mode);
              setSkuSelectionApplied(false);
            }}
            onSelectedSkuChange={(skuId) => {
              setSelectedSkuId(skuId);
              setSkuSelectionApplied(false);
            }}
            onApply={() => void applySelectedSkusAndRunAi()}
          />

          <ProductDetailRichText
            content={productDetailContent}
            generating={busyAction === "image-generate"}
            ocrReady={Boolean(imageOcr?.ready)}
            onDeleteMedia={deleteProductDetailMedia}
            onGenerateImage={generateProductDetailImage}
            onTranslateImage={translateProductDetailImage}
          />

          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOzonApiPanelOpen((open) => !open)}
                  disabled={!ozonSnapshot}
                  className="gap-2"
                >
                  <KeyRound className="h-4 w-4" />
                  Ozon API 配置
                </Button>
                {ozonSnapshot ? (
                  <Badge variant={ozonSnapshot.connection.ready ? "success" : "warning"}>
                    {ozonSnapshot.connection.ready ? "已配置" : "待配置"}
                  </Badge>
                ) : null}
              </div>
              {ozonSnapshot?.connection.ready ? (
                <div className="text-right text-xs leading-5 text-slate-500 dark:text-slate-400">
                  <p>{ozonSnapshot.connection.name}</p>
                  <p>Client-Id：{ozonSnapshot.connection.maskedClientId || "-"}</p>
                </div>
              ) : null}
            </div>

            {ozonApiPanelOpen && ozonSnapshot ? (
              <div className="mt-3">
                <OzonApiConfigPanel
                  connection={ozonSnapshot.connection}
                  onConnectionChange={handleOzonConnectionChange}
                  onSynced={() => refresh(selectedCategoryId)}
                />
              </div>
            ) : null}

            <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-900 dark:text-white">Ozon 类目</label>
                <select
                  value={selectedCategoryId}
                  onChange={(event) => loadOzonSnapshot(event.target.value)}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none dark:border-white/10 dark:bg-black/20 dark:text-white"
                >
                  <option value="">{ozonSnapshot?.categories.length ? "等待 AI 匹配或手动选择类目" : "暂无同步类目"}</option>
                  {ozonSnapshot?.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label} / {category.descriptionCategoryId ?? "-"} / {category.typeId ?? "-"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  type="button"
                  onClick={() => void applySelectedSkusAndRunAi()}
                  disabled={!jsonValid || !selectedFeatureModel || busyAction !== null}
                  className="gap-2"
                >
                  {busyAction === "category-match" || busyAction === "features" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Bot className="h-4 w-4" />
                  )}
                  重新执行两阶段匹配
                </Button>
                <Button type="button" variant="outline" onClick={addCustomFeature} className="gap-2">
                  <Plus className="h-4 w-4" />
                  新增字段
                </Button>
              </div>
            </div>

            {selectedCategory ? (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{selectedCategory.label}</span>
                <span> / 属性 {selectedCategory.attributeCount ?? selectedCategory.attributes?.length ?? 0}</span>
                <span> / 必填 {selectedCategory.requiredAttributeCount ?? 0}</span>
                <span> / {selectedCategory.path.join(" / ")}</span>
              </div>
            ) : null}

            {categoryMatchMessage ? (
              <div
                className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-sm leading-6 ${
                  categoryMatchOk
                    ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200"
                }`}
              >
                {categoryMatchOk ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                <div>
                  <p>{categoryMatchMessage}</p>
                  {categoryMatchReason ? (
                    <p className="mt-1 text-xs opacity-80">
                      类目匹配依据：{categoryMatchReason} / 置信度 {confidenceText(categoryMatchConfidence)}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {featureStatusMessage ? (
              <div
                className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-sm leading-6 ${
                  featureStatusOk
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200"
                }`}
              >
                {featureStatusOk ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                <span>{featureStatusMessage}</span>
              </div>
            ) : null}

            {featureNotes.length ? (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
                {featureNotes.slice(0, 4).map((note) => (
                  <p key={note}>- {note}</p>
                ))}
              </div>
            ) : null}

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-white/[0.04]">
	                <p className="text-xs text-slate-400">特征填写模型</p>
	                <p className="mt-1 truncate text-sm font-semibold text-slate-900 dark:text-white">
	                  {selectedFeatureModel ? `${selectedFeatureModel.providerName} / ${selectedFeatureModel.label || selectedFeatureModel.modelId}` : "未选择"}
	                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-white/[0.04]">
                <p className="text-xs text-slate-400">第一次 AI：类目</p>
                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                  {selectedCategory ? "已匹配/已选择" : "等待匹配"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-white/[0.04]">
                <p className="text-xs text-slate-400">第二次 AI：特征值</p>
                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                  {featureHasGenerated ? "已填写，可复核" : selectedCategory ? "等待填写" : "等待类目"}
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <BaseFeatureForm
                features={baseFeatures}
                images={managedImages}
                selectedImageIds={selectedWorkflowImageIds}
                imageGenerating={busyAction === "image-generate"}
                ocrReady={Boolean(imageOcr?.ready)}
                onOpenImageDialog={openWorkflowImageDialog}
                onDeleteImage={deleteWorkflowImage}
                onGenerateImage={generateListingImage}
                onReorderImages={reorderWorkflowImages}
                onToggleImageSelect={toggleWorkflowImageSelection}
                onTranslateImage={openWorkflowImageTranslate}
                onChange={updateFeatureDraft}
              />

              {featureGroups.map(({ group, items, meta }) => (
                <div key={group} className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-black/20">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">{meta.label}</p>
                        <Badge variant={meta.variant}>{items.length} 项</Badge>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{meta.description}</p>
                    </div>
                  </div>

                  <div className="mt-3 space-y-3">
                    {items.map((feature) => (
                      <div key={feature.attributeId} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.04]">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={featureStatusVariant(feature.status)}>{featureStatusLabel(feature.status)}</Badge>
                              {feature.required ? <Badge variant="destructive">必填</Badge> : <Badge variant="outline">选填</Badge>}
                              {feature.dictionaryValueCount ? <Badge variant="warning">字典 {feature.dictionaryValueCount}</Badge> : null}
                              {feature.valueType ? <Badge variant="outline">{feature.valueType}</Badge> : null}
                              <Badge variant="outline">置信度 {confidenceText(feature.confidence)}</Badge>
                            </div>
                            <p className="mt-2 truncate text-xs text-slate-400">
                              {feature.ozonCode ? `Ozon code：${feature.ozonCode}` : `attribute id：${feature.attributeId}`}
                            </p>
                          </div>
                          {feature.group === "base" ? (
                            <Badge variant="outline">基础字段</Badge>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setFeatureDetail(feature)}
                                className="gap-2"
                              >
                                <Eye className="h-4 w-4" />
                                详情
                              </Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => removeFeature(feature.attributeId)} className="gap-2">
                                <Trash2 className="h-4 w-4" />
                                删除
                              </Button>
                            </div>
                          )}
                        </div>

                        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(190px,0.68fr)_minmax(0,1.32fr)]">
                          <div className="space-y-2">
                            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">字段名称</label>
                            {canEditFeatureName(feature) ? (
                              <Input value={feature.label} onChange={(event) => updateFeatureDraft(feature.attributeId, { label: event.target.value })} />
	                            ) : (
	                              <div className="min-h-[56px] rounded-xl border border-slate-200 bg-white px-3 py-3 dark:border-white/10 dark:bg-black/20">
	                                <p className="break-words text-sm font-semibold leading-6 text-slate-900 dark:text-white">{feature.displayLabel || feature.label}</p>
	                              </div>
	                            )}
	                          </div>
	                          <div className="space-y-2">
	                            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">填写内容</label>
	                            {feature.options.length ? (
	                              <>
	                                <Input
	                                  value={feature.value}
	                                  list={`workflow-options-${feature.attributeId}`}
	                                  onChange={(event) => updateFeatureDraft(feature.attributeId, { value: event.target.value })}
	                                  placeholder={feature.required ? "必填，请选择或输入" : "可选，请选择或输入"}
	                                />
	                                <datalist id={`workflow-options-${feature.attributeId}`}>
	                                  {feature.options.map((option) => (
	                                    <option key={option} value={option} />
	                                  ))}
	                                </datalist>
	                              </>
	                            ) : (
	                              <Textarea
	                                value={feature.value}
	                                onChange={(event) => updateFeatureDraft(feature.attributeId, { value: event.target.value })}
	                                className="min-h-[76px]"
	                                placeholder={feature.required ? "必填，等待填写或手动输入" : "可选，支持手动修改"}
	                              />
	                            )}
	                          </div>
	                        </div>
	                        {feature.options.length ? (
	                          <p className="mt-2 truncate text-xs leading-5 text-slate-400">字典示例：{feature.options.slice(0, 8).join(" / ")}</p>
	                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <AiReturnedFeaturesPanel
            response={textPromptResponse}
            loading={textPromptResponseLoading}
            error={textPromptResponseError}
            draft={featureDraft}
            onShowDetail={setFeatureDetail}
          />
        </div>

      </div>
    </section>
    <TextPromptResponseDialog
      open={textPromptResponseOpen}
      loading={textPromptResponseLoading}
      response={textPromptResponse}
      error={textPromptResponseError}
      onClose={() => setTextPromptResponseOpen(false)}
    />
    <StageAiPromptDialog
      open={stagePromptDialogOpen}
      value={stageAiPromptDialogValue}
      defaultValue={defaultStageAiPrompts}
      onSave={saveStageAiPrompts}
      onClose={() => setStagePromptDialogOpen(false)}
    />
    <TextSystemPromptDialog
      open={textSystemPromptOpen}
      value={textSystemPrompt}
      defaultValue={DEFAULT_LISTING_TEXT_SYSTEM_PROMPT}
      onSave={saveTextSystemPrompt}
      onClose={() => setTextSystemPromptOpen(false)}
    />
    <AiFeatureDetailDialog
      feature={featureDetail}
      onClose={() => setFeatureDetail(null)}
    />
    <WorkflowImageDialog
      mode={imageDialogMode}
      images={imageDialogImages}
      initialImageId={imageDialogInitialImageId}
      imageModelLabel={
        selectedImageModel
          ? `${selectedImageModel.providerName} / ${selectedImageModel.label || selectedImageModel.modelId}`
          : ""
      }
      generating={busyAction === "image-generate"}
      ocrReady={Boolean(imageOcr?.ready)}
      ocrEndpoint={imageOcr?.endpoint || "http://127.0.0.1:8010"}
      onClose={() => {
        setImageDialogMode(null);
        setImageDialogInitialImageId("");
      }}
      onAddFiles={addWorkflowImages}
      onDelete={deleteWorkflowImage}
      onReorder={reorderWorkflowImages}
      onSetPrimary={setWorkflowPrimaryImage}
      onGenerate={generateListingImage}
      onBatchTranslate={batchTranslateWorkflowImages}
      onApplyEditedImage={applyEditedWorkflowImage}
    />
    </>
  );
}
