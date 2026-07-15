"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Images,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useDismissOnOutside } from "@/components/shared/use-dismiss-on-outside";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  WorkflowImageDialog,
  WorkflowImageField,
  WORKFLOW_IMAGE_LIMIT,
  type ManagedWorkflowImage,
  type WorkflowImageDialogMode,
  workflowImagesToOzonPayload,
} from "@/components/projects/workflow-image-tools";
import type {
  ListingWorkflowFeature,
  ListingWorkflowItem,
  ListingWorkflowStage,
} from "@/lib/listing-workflow/items";
import {
  LISTING_FEATURE_MODEL_STORAGE_KEY,
  LISTING_IMAGE_MODEL_STORAGE_KEY,
  LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY,
  listingItemStatusLabel,
  parseListingModelSelection,
} from "@/lib/listing-workflow/items";
import {
  applySkuSelectionToJson,
  extractProductSkuOptions,
  readProductSkuSelection,
  type ProductSkuSelection,
} from "@/lib/listing-workflow/skus";
import {
  DEFAULT_LISTING_STAGE_AI_PROMPTS,
  LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
  buildDefaultListingImagePrompt,
  normalizeListingStageAiPrompts,
} from "@/lib/listing-workflow/text-prompts";
import { normalizeOzonAttributeMatchKey } from "@/lib/ozon/attribute-match";
import { findOzonColorValue, isOzonColorAttributeId } from "@/lib/ozon/color-match";
import type {
  OzonAttributeValueSnapshot,
  OzonFeatureSnapshot,
} from "@/lib/ozon/snapshot";
import type { ApiResponseShape } from "@/lib/utils/api";

type FeatureDraftResponse = {
  features: ListingWorkflowFeature[];
  aiStatus: { ok: boolean; message: string };
  notes: string[];
  aiResponse?: Record<string, unknown> | null;
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

type ListingImageTranslateResponse = {
  fileName: string;
  filePath: string;
  imageUrl: string;
  mimeType: string;
  engine: string;
  sourceText: string;
  translatedText: string;
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

type ImageWorkflowStatusValue =
  | "queued"
  | "running"
  | "done"
  | "partial"
  | "failed";

type ImageWorkflowSubStatusValue = ImageWorkflowStatusValue | "skipped";

async function readApi<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as ApiResponseShape<T>;
  if (!response.ok || !payload.success || payload.data === null) {
    throw new Error(
      !payload.success
        ? payload.error?.message || "请求失败"
        : `请求失败：${response.status}`,
    );
  }
  return payload.data as T;
}

function forgetActiveWorkflowItem(itemId: string) {
  try {
    if (
      window.localStorage.getItem(LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY) ===
      itemId
    ) {
      window.localStorage.removeItem(LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY);
    }
  } catch {
    // 本地存储不可用时忽略。
  }
}

function normalizeItem(raw: ListingWorkflowItem): ListingWorkflowItem {
  return {
    ...raw,
    categoryPath: Array.isArray(raw.categoryPath) ? raw.categoryPath : null,
    scrapedData:
      raw.scrapedData && typeof raw.scrapedData === "object"
        ? raw.scrapedData
        : {},
    features: Array.isArray(raw.features) ? raw.features : null,
    notes: Array.isArray(raw.notes) ? raw.notes : null,
  };
}

function simpleStableHash(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function readImageModelSelection() {
  const selected = parseListingModelSelection(
    window.localStorage.getItem(LISTING_IMAGE_MODEL_STORAGE_KEY),
  );
  return (
    selected ?? {
      providerId: "browser-webai",
      modelId: "gpt-image-1.5",
    }
  );
}

function managedImageName(url: string, index: number) {
  const extension =
    url.match(/\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i)?.[1] || "jpg";
  return `crawler-${String(index + 1).padStart(2, "0")}.${extension.replace(
    "jpeg",
    "jpg",
  )}`;
}

function buildManagedImagesFromItem(item: ListingWorkflowItem) {
  const existingWorkflowImages = asRecord(item.scrapedData.workflowImages);
  const storedImages = Array.isArray(existingWorkflowImages?.items)
    ? existingWorkflowImages.items
    : [];
  const stored = storedImages
    .map((entry, index): ManagedWorkflowImage | null => {
      const record = asRecord(entry);
      const url = typeof record?.url === "string" ? record.url.trim() : "";
      if (!url) return null;
      const id =
        typeof record?.id === "string" && record.id.trim()
          ? record.id
          : `image:${simpleStableHash(url)}`;
      const source = record?.source;
      return {
        id,
        name:
          typeof record?.name === "string" && record.name.trim()
            ? record.name
            : managedImageName(url, index),
        url,
        label:
          typeof record?.label === "string" && record.label.trim()
            ? record.label
            : index === 0
              ? "主图"
              : "采集图",
        source:
          source === "upload" || source === "generated" || source === "edited"
            ? source
            : "crawler",
      };
    })
    .filter(Boolean) as ManagedWorkflowImage[];

  if (stored.length) return stored.slice(0, WORKFLOW_IMAGE_LIMIT);

  return itemImageUrls(item)
    .slice(0, WORKFLOW_IMAGE_LIMIT)
    .map((url, index) => ({
      id: `image:${simpleStableHash(url)}`,
      name: managedImageName(url, index),
      url,
      label: index === 0 ? "主图" : "采集图",
      source: "crawler" as const,
    }));
}

function selectedImageIdsFromItem(item: ListingWorkflowItem) {
  const workflowImages = asRecord(item.scrapedData.workflowImages);
  const ids = Array.isArray(workflowImages?.selectedImageIds)
    ? workflowImages.selectedImageIds
    : [];
  return ids.filter((id): id is string => typeof id === "string" && Boolean(id));
}

function isOcrTranslatedWorkflowImage(image: ManagedWorkflowImage) {
  return image.id.startsWith("translated:") || image.label === "OCR 已翻译";
}

function syncImageFeature(
  features: ListingWorkflowFeature[] | null,
  images: ManagedWorkflowImage[],
) {
  if (!features) return features;
  const imagePayload = workflowImagesToOzonPayload(images);
  const value = imagePayload.primary_image ? JSON.stringify(imagePayload) : "";
  return features.map((feature) =>
    baseFeatureId(feature) === "images"
      ? {
          ...feature,
          value,
          status: value
            ? ("auto" as const)
            : feature.required
              ? ("missing" as const)
              : ("review" as const),
          source: value ? "图片排序" : feature.source,
          reason: value
            ? "按当前图片顺序回填，第一张作为 Ozon 主图，其余图片按顺序上传。"
            : feature.reason,
        }
      : feature,
  );
}

function applyManagedImagesToItem(
  item: ListingWorkflowItem,
  images: ManagedWorkflowImage[],
  extraWorkflow?: Record<string, unknown>,
  selectedImageIds?: string[],
): ListingWorkflowItem {
  const availableIds = new Set(images.map((image) => image.id));
  const validSelectedImageIds = (
    selectedImageIds ?? selectedImageIdsFromItem(item)
  ).filter((id) => availableIds.has(id));
  const selectedIds = new Set(validSelectedImageIds);
  const selectedImages = images.filter((image) => selectedIds.has(image.id));
  const urls = images.map((image) => image.url).filter(Boolean);
  const selectedImageUrls = selectedImages
    .map((image) => image.url)
    .filter(Boolean);
  const previousWorkflow = asRecord(item.scrapedData.imageWorkflow) ?? {};
  return {
    ...item,
    imageUrl: urls[0] ?? null,
    scrapedData: {
      ...item.scrapedData,
      gallery: urls,
      images: urls,
      imageUrls: urls,
      workflowImages: {
        items: images,
        selectedImageIds: validSelectedImageIds,
        selectedImageUrls,
        primaryImageUrl: urls[0] ?? "",
        updatedAt: new Date().toISOString(),
      },
      imageWorkflow: {
        ...previousWorkflow,
        ...extraWorkflow,
        updatedAt: new Date().toISOString(),
      },
    },
    features: syncImageFeature(item.features, images),
  };
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function generateWorkflowImage(
  image: ManagedWorkflowImage,
  title: string,
) {
  const model = readImageModelSelection();
  const prompts = readStageAiPrompts(title);
  const useReferenceImage = prompts.imageGeneration.useReference && Boolean(image.url);
  const result = await readApi<ListingImageGenerateResponse>(
    await fetch("/api/listing-workflow/image-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: model.providerId,
        model: model.modelId,
        prompt: prompts.imageGeneration.prompt || buildDefaultListingImagePrompt(title),
        aspectRatio: prompts.imageGeneration.aspectRatio,
        useReferenceImages: useReferenceImage,
        referenceImages: useReferenceImage ? [image.url] : [],
      }),
    }),
  );

  return {
    id: `generated:${result.filePath}`,
    name: result.fileName,
    url: result.imageUrl,
    label: "AI 主图",
    source: "generated" as const,
  };
}

async function translateWorkflowImage(
  image: ManagedWorkflowImage,
  targetLanguage = "ru",
) {
  const result = await readApi<ListingImageTranslateResponse>(
    await fetch("/api/listing-workflow/image-translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageUrl: image.url,
        targetLanguage,
        ocrEngine: "web",
      }),
    }),
  );

  return {
    ...image,
    id: `translated:${result.filePath}`,
    name: result.fileName,
    url: result.imageUrl,
    label: "OCR 已翻译",
    source: "edited" as const,
  };
}

async function translateWorkflowImageAtlas(
  images: ManagedWorkflowImage[],
  targetLanguage = "ru",
) {
  const translated: Array<{
    sourceId: string;
    image: ManagedWorkflowImage;
  }> = [];
  for (let offset = 0; offset < images.length; offset += 20) {
    const batch = images.slice(offset, offset + 20);
    const result = await readApi<ListingAtlasTranslateResponse>(
      await fetch("/api/listing-workflow/image-translate-atlas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: batch.map((image) => ({
            id: image.id,
            name: image.name,
            url: image.url,
          })),
          targetLanguage,
        }),
      }),
    );
    const sourceById = new Map(batch.map((image) => [image.id, image]));
    for (const output of result.images) {
      const source = sourceById.get(output.id);
      if (!source) continue;
      translated.push({
        sourceId: source.id,
        image: {
          ...source,
          id: `translated:${output.filePath}`,
          name: output.fileName,
          url: output.imageUrl,
          label: "图集已翻译",
          source: "edited" as const,
        },
      });
    }
  }
  return translated;
}

function baseFeatureId(feature: ListingWorkflowFeature) {
  return feature.attributeId.replace(/^base:/, "");
}

function valueOptionMappings(values: OzonAttributeValueSnapshot[]) {
  return values.map((value) => {
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

function isColorNameWorkflowFeature(feature: ListingWorkflowFeature) {
  const text = `${feature.attributeId} ${feature.ozonCode ?? ""} ${feature.label} ${feature.displayLabel ?? ""}`.toLowerCase();
  return text.includes("10097") || text.includes("название цвета") || text.includes("颜色名称");
}

function workflowColorLookupValues(
  feature: ListingWorkflowFeature,
  features: ListingWorkflowFeature[],
) {
  const values: unknown[] = [
    ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
    feature.aiJsonValue,
    feature.value,
  ];
  if (isOzonColorAttributeId(feature.ozonCode || feature.attributeId)) {
    const colorName = features.find(isColorNameWorkflowFeature);
    if (colorName) {
      values.unshift(
        ...(colorName.ozonAttributeValues?.map((value) => value.value) ?? []),
        colorName.aiJsonValue,
        colorName.value,
      );
    }
  }
  return values;
}

function findMatchedAttributeValue(
  values: OzonAttributeValueSnapshot[],
  feature: ListingWorkflowFeature,
  features: ListingWorkflowFeature[],
) {
  if (isOzonColorAttributeId(feature.ozonCode || feature.attributeId)) {
    const matchedColor = findOzonColorValue(
      values,
      workflowColorLookupValues(feature, features),
    );
    if (matchedColor) {
      return values.find(
        (value) => Number(value.ozonValueId) === matchedColor.dictionary_value_id,
      ) ?? null;
    }
  }
  return values.find(
    (candidate) =>
      normalizeOzonAttributeMatchKey(candidate.value) ===
        normalizeOzonAttributeMatchKey(feature.value) ||
      normalizeOzonAttributeMatchKey(candidate.valueZh || "") ===
        normalizeOzonAttributeMatchKey(feature.value) ||
      feature.ozonAttributeValues?.some(
        (selected) =>
          Number(selected.dictionary_value_id) ===
          Number(candidate.ozonValueId),
      ),
  ) ?? null;
}

function syncBaseFeatures(
  features: ListingWorkflowFeature[] | null,
  draft: ListingWorkflowItem,
): ListingWorkflowFeature[] | null {
  if (!features) return null;
  const baseValues: Record<string, string> = {
    name: draft.title,
    offer_id: draft.offerId,
    price: draft.currentPrice ?? "",
    old_price: draft.oldPrice ?? "",
    min_price: draft.minPrice ?? "",
    cost_price: draft.costPrice ?? "",
    currency_code: draft.currency,
  };
  return features.map((feature) => {
    if (feature.group !== "base") return feature;
    const value = baseValues[baseFeatureId(feature)];
    return value === undefined
      ? feature
      : {
          ...feature,
          value,
          source: "人工修改",
          status: value
            ? ("review" as const)
            : feature.required
              ? ("missing" as const)
              : ("review" as const),
        };
  });
}

async function resolveOzonAttributeValues(
  features: ListingWorkflowFeature[] | null,
  categoryId: string | null,
) {
  if (!features || !categoryId) return features;
  const snapshot = await readApi<OzonFeatureSnapshot>(
    await fetch(`/api/ozon/features?categoryId=${categoryId}`, {
      cache: "no-store",
    }),
  );
  const attributeById = new Map(
    (snapshot.selectedCategory?.attributes ?? []).map((attribute) => [
      attribute.ozonAttributeId,
      attribute,
    ]),
  );
  return features.map((feature) => {
    if (feature.group !== "category" || !feature.value.trim()) return feature;
    const attribute = attributeById.get(
      feature.ozonCode || feature.attributeId,
    );
    if (!attribute) return feature;
    if (!attribute.dictionaryId) {
      return {
        ...feature,
        ozonAttributeValues: [{ value: feature.value.trim() }],
      };
    }
    const matchedValue = findMatchedAttributeValue(
      attribute.values,
      feature,
      features,
    );
    const dictionaryValueId = Number(matchedValue?.ozonValueId);
    return Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
      ? {
          ...feature,
          ozonAttributeValues: [
            {
              dictionary_value_id: dictionaryValueId,
              value: matchedValue?.value || feature.value.trim(),
            },
          ],
        }
      : {
          ...feature,
          ozonAttributeValues: undefined,
          status: "review",
          reason:
            "人工修改的值没有匹配到当前 Ozon 字典，需要在主工作台继续核对。",
        };
  });
}

function statusVariant(item: ListingWorkflowItem) {
  if (item.status === "MATCHED") return "success" as const;
  if (item.status === "AI_FAILED") return "destructive" as const;
  if (item.status === "AI_RUNNING") return "warning" as const;
  return "outline" as const;
}

function imageWorkflowState(item: ListingWorkflowItem) {
  return asRecord(item.scrapedData.imageWorkflow) ?? {};
}

function imageWorkflowText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function imageWorkflowNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function imageWorkflowStatusValue(
  item: ListingWorkflowItem,
): ImageWorkflowStatusValue | "" {
  const status = imageWorkflowText(imageWorkflowState(item).status);
  return status === "queued" ||
    status === "running" ||
    status === "done" ||
    status === "partial" ||
    status === "failed"
    ? status
    : "";
}

function imageWorkflowSubStatusValue(
  value: unknown,
): ImageWorkflowSubStatusValue | "" {
  const status = imageWorkflowText(value);
  return status === "queued" ||
    status === "running" ||
    status === "done" ||
    status === "partial" ||
    status === "failed" ||
    status === "skipped"
    ? status
    : "";
}

function imageWorkflowIsRunning(item: ListingWorkflowItem) {
  const status = imageWorkflowStatusValue(item);
  return status === "queued" || status === "running";
}

function imageWorkflowSignature(images: ManagedWorkflowImage[]) {
  return images
    .map((image) => `${image.id}:${image.url}`)
    .join("|");
}

function imageWorkflowBadgeVariant(status: ImageWorkflowStatusValue | "") {
  if (status === "done") return "success" as const;
  if (status === "partial" || status === "running" || status === "queued") {
    return "warning" as const;
  }
  if (status === "failed") return "destructive" as const;
  return "outline" as const;
}

function ImageWorkflowStatus({ item }: { item: ListingWorkflowItem }) {
  const workflow = imageWorkflowState(item);
  const status = imageWorkflowStatusValue(item);
  const phase = imageWorkflowText(workflow.phase);
  const translationStatus = imageWorkflowSubStatusValue(
    workflow.translationStatus,
  );
  const generationStatus = imageWorkflowSubStatusValue(
    workflow.generationStatus,
  );
  const featureStatus = imageWorkflowSubStatusValue(workflow.featureStatus);
  const totalImages = imageWorkflowNumber(workflow.totalImages);
  const translationTotalImages =
    imageWorkflowNumber(workflow.translationTotalImages) ?? totalImages;
  const translatedCount = imageWorkflowNumber(workflow.translatedCount);
  const explicitTranslatedSuccessCount = imageWorkflowNumber(
    workflow.translatedSuccessCount,
  );
  const inferredTranslatedSuccessCount = buildManagedImagesFromItem(item).filter(
    isOcrTranslatedWorkflowImage,
  ).length;
  const translatedSuccessCount =
    explicitTranslatedSuccessCount ?? inferredTranslatedSuccessCount;
  const notes = Array.isArray(workflow.autoImageWorkflowNotes)
    ? workflow.autoImageWorkflowNotes.length
    : 0;

  if (!status) {
    return (
      <div className="space-y-1">
        <Badge variant="outline">三线加工待启动</Badge>
        <p className="text-xs text-slate-400">点击加入加工阶段后自动启动</p>
      </div>
    );
  }

  let label = "三线加工中";
  if (status === "done") {
    label = featureStatus ? "三线加工已完成" : "图片流程已完成";
  } else if (status === "partial") {
    label = featureStatus ? "三线加工部分完成" : "图片流程部分完成";
  } else if (status === "failed") {
    label = featureStatus ? "三线加工失败" : "图片流程失败";
  } else if (
    translationStatus === "running" &&
    generationStatus === "running" &&
    featureStatus === "running"
  ) {
    label = "三线并行处理中";
  } else if (phase === "generating" || generationStatus === "running") {
    label = "主图生成中";
  } else if (featureStatus === "running") {
    label = "特征匹配中";
  } else if (phase === "translating" || translationStatus === "running") {
    label = "图集翻译中";
  }
  const progress =
    translatedCount !== null &&
    translationTotalImages !== null &&
    translationTotalImages > 0
      ? `${translatedCount}/${translationTotalImages}`
      : "";
  const translatedSuccess =
    translatedSuccessCount !== null &&
    translationTotalImages !== null &&
    translationTotalImages > 0
      ? `翻译成功 ${translatedSuccessCount}/${translationTotalImages}`
      : "";
  const generationText =
    generationStatus === "done"
      ? "主图已生成"
      : generationStatus === "failed"
        ? "主图失败"
        : generationStatus === "running"
          ? "主图生成中"
          : generationStatus === "skipped"
            ? "主图跳过"
            : "";
  const featureText =
    featureStatus === "done"
      ? "特征已匹配"
      : featureStatus === "failed"
        ? "特征匹配失败"
        : featureStatus === "running"
          ? "特征匹配中"
          : featureStatus === "queued"
            ? "特征等待中"
            : "";
  const detail = [
    progress ? `图集进度 ${progress}` : "",
    translatedSuccess,
    generationText,
    featureText,
    notes ? `${notes} 条提醒` : "",
  ].filter(Boolean).join("，");
  const isActive = status === "queued" || status === "running";

  return (
    <div className="space-y-1">
      <Badge
        variant={imageWorkflowBadgeVariant(status)}
        className="inline-flex items-center gap-1"
      >
        {isActive ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : status === "failed" ? (
          <X className="h-3 w-3" />
        ) : (
          <CheckCircle2 className="h-3 w-3" />
        )}
        {label}
      </Badge>
      <p className="text-xs text-slate-500">
        {status === "failed"
          ? imageWorkflowText(workflow.error) || "可重新执行三线加工"
          : detail || "主图、特征、选中图片正在并行处理"}
      </p>
    </div>
  );
}

function imageProxyUrl(rawUrl: string | null) {
  if (!rawUrl) return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("blob:")
  ) {
    return normalized;
  }
  return `/api/image-proxy?url=${encodeURIComponent(normalized)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeImageCandidate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (
    !normalized.startsWith("http://") &&
    !normalized.startsWith("https://") &&
    !normalized.startsWith("/")
  ) {
    return null;
  }
  if (
    !/\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(normalized) &&
    !/alicdn\.com\/img\//i.test(normalized)
  ) {
    return null;
  }
  return normalized.replace(
    /\.(?:search|summ|\d+x\d+)(?=\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$)/i,
    "",
  );
}

function appendImageValues(
  value: unknown,
  output: string[],
  depth = 0,
) {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const normalized = normalizeImageCandidate(value);
    if (normalized) output.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => appendImageValues(entry, output, depth + 1));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  [
    "src",
    "url",
    "image",
    "imageUrl",
    "coverImage",
    "primary_image",
    "primaryImage",
    "images",
    "imageUrls",
    "pictures",
  ].forEach((key) => appendImageValues(record[key], output, depth + 1));
}

function itemImageUrls(item: ListingWorkflowItem) {
  const candidates: string[] = [];
  appendImageValues(item.imageUrl, candidates);

  const scraped = item.scrapedData;
  appendImageValues(scraped.gallery, candidates);
  appendImageValues(asRecord(scraped.description)?.images, candidates);
  appendImageValues(scraped.images, candidates);
  appendImageValues(scraped.imageUrls, candidates);

  const imageFeature = item.features?.find(
    (feature) =>
      feature.attributeId === "base:images" ||
      feature.ozonCode === "primary_image/images",
  );
  if (imageFeature?.value.trim()) {
    try {
      appendImageValues(JSON.parse(imageFeature.value), candidates);
    } catch {
      appendImageValues(imageFeature.value, candidates);
    }
  }

  return [...new Set(candidates)];
}

function RemoteProductImage({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  className: string;
}) {
  const source = imageProxyUrl(url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  return source && !failed ? (
    <img
      src={source}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  ) : (
    <div
      className={`flex items-center justify-center bg-slate-50 text-slate-300 dark:bg-black/30 ${className}`}
    >
      <Box className="h-7 w-7" />
    </div>
  );
}

function ProductImage({
  item,
  onClick,
}: {
  item: ListingWorkflowItem;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 transition hover:border-sky-300 hover:ring-2 hover:ring-sky-100 dark:border-white/10 dark:bg-black/30 dark:hover:border-sky-500/50 dark:hover:ring-sky-500/15"
      onClick={onClick}
      title="点击管理商品图片"
      aria-label={`管理 ${item.title} 的商品图片`}
    >
      {item.imageUrl ? (
        <RemoteProductImage
          url={item.imageUrl}
          alt={item.title}
          className="h-full w-full object-cover"
        />
      ) : (
        <Box className="h-7 w-7 text-slate-300" />
      )}
    </button>
  );
}

function EmbeddedProductGallery({
  item,
  onChange,
}: {
  item: ListingWorkflowItem;
  onChange?: (item: ListingWorkflowItem) => void;
}) {
  const images = useMemo(() => buildManagedImagesFromItem(item), [
    item.imageUrl,
    item.scrapedData,
    item.features,
  ]);
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dialogMode, setDialogMode] =
    useState<WorkflowImageDialogMode | null>(null);
  const [dialogInitialImageId, setDialogInitialImageId] = useState("");
  const [generatingImageId, setGeneratingImageId] = useState<string | null>(
    null,
  );
  const [translatingImageId, setTranslatingImageId] = useState<string | null>(
    null,
  );
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>(() =>
    selectedImageIdsFromItem(item),
  );
  const selectedImage = images[selectedIndex] ?? images[0] ?? null;
  const imageModel = useMemo(() => {
    if (typeof window === "undefined") return "浏览器本地模式 / GPT Image 1.5";
    const selected = readImageModelSelection();
    return `浏览器本地模式 / ${selected.modelId}`;
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
    setExpanded(false);
    setSelectedImageIds(selectedImageIdsFromItem(item));
  }, [item.id]);

  useEffect(() => {
    if (selectedIndex >= images.length) {
      setSelectedIndex(Math.max(images.length - 1, 0));
    }
  }, [images.length, selectedIndex]);

  function updateImages(
    nextImages: ManagedWorkflowImage[],
    extraWorkflow?: Record<string, unknown>,
    nextSelectedImageIds = selectedImageIds,
  ) {
    const normalizedImages = nextImages
      .slice(0, WORKFLOW_IMAGE_LIMIT)
      .map((image, index) => ({
        ...image,
        label: index === 0 ? "主图" : image.label || "商品图",
      }));
    const validSelectedIds = nextSelectedImageIds.filter((id) =>
      normalizedImages.some((image) => image.id === id),
    );
    setSelectedImageIds(validSelectedIds);
    onChange?.(
      applyManagedImagesToItem(
        item,
        normalizedImages,
        extraWorkflow,
        validSelectedIds,
      ),
    );
  }

  async function handleAddFiles(files: File[]) {
    const remaining = WORKFLOW_IMAGE_LIMIT - images.length;
    if (remaining <= 0) {
      toast.warning(`最多只能保留 ${WORKFLOW_IMAGE_LIMIT} 张图片`);
      return;
    }
    try {
      const appended = await Promise.all(
        files.slice(0, remaining).map(async (file) => ({
          id: `upload:${crypto.randomUUID()}`,
          name: file.name || `upload-${Date.now()}.png`,
          url: await fileToDataUrl(file),
          label: "手动上传",
          source: "upload" as const,
        })),
      );
      updateImages([...images, ...appended], {
        manualUploadAt: new Date().toISOString(),
      });
      toast.success(`已添加 ${appended.length} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片添加失败");
    }
  }

  function handleDelete(imageId: string) {
    const nextImages = images.filter((image) => image.id !== imageId);
    updateImages(
      nextImages,
      { imageDeletedAt: new Date().toISOString() },
      selectedImageIds.filter((id) => id !== imageId),
    );
    toast.success("图片已删除");
  }

  function handleDeleteSelected() {
    const selectedIds = new Set(selectedImageIds);
    if (!selectedIds.size) return;
    const nextImages = images.filter((image) => !selectedIds.has(image.id));
    updateImages(nextImages, { selectedImagesDeletedAt: new Date().toISOString() }, []);
    toast.success(`已删除 ${images.length - nextImages.length} 张选中图片`);
  }

  function handleReorder(nextImages: ManagedWorkflowImage[]) {
    updateImages(
      nextImages,
      { imageReorderedAt: new Date().toISOString() },
      selectedImageIds,
    );
    setSelectedIndex(0);
    toast.success("图片顺序已更新，第一张已作为主图");
  }

  function handleSetPrimary(imageId: string) {
    const selected = images.find((image) => image.id === imageId);
    if (!selected) return;
    const nextImages = [
      selected,
      ...images.filter((image) => image.id !== imageId),
    ];
    handleReorder(nextImages);
  }

  async function handleGenerate(imageId: string) {
    const image = images.find((entry) => entry.id === imageId);
    if (!image) return;
    setGeneratingImageId(imageId);
    try {
      const generated = await generateWorkflowImage(image, item.title);
      const nextSelectedIds = selectedImageIds.length
        ? [generated.id, ...selectedImageIds]
        : selectedImageIds;
      updateImages(
        [generated, ...images],
        {
          manualGeneratedMainImageAt: new Date().toISOString(),
          generatedFromImageId: image.id,
        },
        nextSelectedIds,
      );
      setSelectedIndex(0);
      toast.success("AI 主图已生成，并自动放到第一张");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片生成失败");
    } finally {
      setGeneratingImageId(null);
    }
  }

  async function handleTranslate(imageId: string) {
    const image = images.find((entry) => entry.id === imageId);
    if (!image) return;
    setTranslatingImageId(imageId);
    try {
      const translated = await translateWorkflowImage(image, "ru");
      const nextSelectedIds = selectedImageIds.map((id) =>
        id === imageId ? translated.id : id,
      );
      updateImages(
        images.map((entry) => (entry.id === imageId ? translated : entry)),
        {
          manualTranslatedImageAt: new Date().toISOString(),
          translatedImageId: image.id,
        },
        nextSelectedIds,
      );
      toast.success("图片文字已翻译并回填");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片翻译失败");
    } finally {
      setTranslatingImageId(null);
    }
  }

  function openDialog(mode: WorkflowImageDialogMode, imageId?: string) {
    setDialogInitialImageId(imageId || images[0]?.id || "");
    setDialogMode(mode);
  }

  function handleApplyEditedImage(
    imageId: string,
    dataUrl: string,
    name: string,
  ) {
    const editedId = `edited:${crypto.randomUUID()}`;
    updateImages(
      images.map((image) =>
        image.id === imageId
          ? {
              ...image,
              id: editedId,
              name,
              url: dataUrl,
              label: "手动编辑",
              source: "edited" as const,
            }
          : image,
      ),
      { manualEditedImageAt: new Date().toISOString() },
      selectedImageIds.map((id) => (id === imageId ? editedId : id)),
    );
  }

  function handleToggleSelect(imageId: string) {
    const nextSelectedIds = selectedImageIds.includes(imageId)
      ? selectedImageIds.filter((id) => id !== imageId)
      : [...selectedImageIds, imageId];
    updateImages(
      images,
      { selectedImagesChangedAt: new Date().toISOString() },
      nextSelectedIds,
    );
  }

  return (
    <section
      data-testid="product-image-gallery"
      className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-black/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Images className="h-5 w-5 text-slate-700 dark:text-slate-200" />
          <h3 className="text-base font-semibold text-slate-950 dark:text-white">
            商品图片
          </h3>
          <Badge variant="outline">{images.length} 张</Badge>
          {translatingImageId ? (
            <Badge variant="warning" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              翻译中
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {images[0] ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={Boolean(generatingImageId)}
              onClick={() => void handleGenerate(images[0].id)}
            >
              {generatingImageId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              生成主图
            </Button>
          ) : null}
          {images.length > 1 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? (
                <ChevronUp className="mr-1.5 h-4 w-4" />
              ) : (
                <ChevronDown className="mr-1.5 h-4 w-4" />
              )}
              {expanded ? "收起全部图片" : `查看全部 ${images.length} 张`}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {selectedImage ? (
          <button
            type="button"
            className="group relative block h-64 w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 text-left dark:border-white/10 dark:bg-black/30 sm:h-72"
            aria-label={
              expanded
                ? "收起全部商品图片"
                : `查看全部 ${images.length} 张商品图片`
            }
            onClick={() =>
              openDialog("manage", selectedImage.id)
            }
          >
            <RemoteProductImage
              url={selectedImage.url}
              alt={`${item.title} 商品图 ${selectedIndex + 1}`}
              className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
            />
            {images.length > 1 ? (
              <span className="absolute bottom-3 right-3 rounded-full bg-slate-950/80 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                {expanded ? "点击收起" : `点击查看全部 · ${images.length} 张`}
              </span>
            ) : null}
          </button>
        ) : (
          <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 text-sm text-slate-400 dark:border-white/10 sm:h-72">
            暂无商品图片
          </div>
        )}

        {expanded ? (
          <WorkflowImageField
            images={images}
            generating={Boolean(generatingImageId)}
            ocrReady
            selectedImageIds={selectedImageIds}
            onOpen={(mode) => openDialog(mode)}
            onDelete={handleDelete}
            onDeleteSelected={handleDeleteSelected}
            onGenerate={(imageId) => void handleGenerate(imageId)}
            onReorder={handleReorder}
            onToggleSelect={handleToggleSelect}
            onTranslate={(imageId) => void handleTranslate(imageId)}
          />
        ) : (
          <button
            type="button"
            className="flex min-h-40 min-w-0 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 px-6 text-center transition hover:border-slate-400 hover:bg-slate-50 dark:border-white/10 dark:hover:border-white/20 dark:hover:bg-white/[0.03]"
            onClick={() => images.length > 1 && setExpanded(true)}
            disabled={images.length < 2}
          >
            <Images className="h-8 w-8 text-slate-300" />
            <span className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              {images.length > 1
                ? `已采集 ${images.length} 张商品图片`
                : "当前只有 1 张商品图片"}
            </span>
            {images.length > 1 ? (
              <span className="mt-1 text-xs text-slate-400">
                点击这里或左侧主图展开全部照片
              </span>
            ) : null}
          </button>
        )}
      </div>
      <WorkflowImageDialog
        mode={dialogMode}
        images={images}
        initialImageId={dialogInitialImageId}
        imageModelLabel={imageModel}
        generating={Boolean(generatingImageId)}
        ocrReady
        ocrEndpoint="http://127.0.0.1:8010"
        onClose={() => setDialogMode(null)}
        onAddFiles={(files) => void handleAddFiles(files)}
        onDelete={handleDelete}
        onReorder={handleReorder}
        onSetPrimary={handleSetPrimary}
        onGenerate={(imageId) => void handleGenerate(imageId)}
        onApplyEditedImage={handleApplyEditedImage}
      />
    </section>
  );
}

type EditablePriceField = "currentPrice" | "oldPrice" | "minPrice";

const editablePriceLabels: Record<EditablePriceField, string> = {
  currentPrice: "当前价格",
  oldPrice: "折扣前价格",
  minPrice: "最低价格",
};

function defaultStageAiPromptsForTitle(title = "") {
  return normalizeListingStageAiPrompts({
    ...DEFAULT_LISTING_STAGE_AI_PROMPTS,
    imageGeneration: {
      ...DEFAULT_LISTING_STAGE_AI_PROMPTS.imageGeneration,
      prompt: buildDefaultListingImagePrompt(title),
    },
  });
}

function readStageAiPrompts(title = "") {
  try {
    const stored = window.localStorage.getItem(
      LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
    );
    return stored
      ? normalizeListingStageAiPrompts(JSON.parse(stored))
      : defaultStageAiPromptsForTitle(title);
  } catch {
    return defaultStageAiPromptsForTitle(title);
  }
}

function CollectionSkuSelector({
  item,
  selection,
  onChange,
}: {
  item: ListingWorkflowItem;
  selection: ProductSkuSelection;
  onChange: (selection: ProductSkuSelection) => void;
}) {
  const options = useMemo(
    () => extractProductSkuOptions(item.scrapedData),
    [item.scrapedData],
  );
  const [multiOpen, setMultiOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  useDismissOnOutside(selectorRef, multiOpen, () => setMultiOpen(false));

  useEffect(() => {
    if (selection.mode !== "multiple") setMultiOpen(false);
  }, [selection.mode]);

  if (!options.length) {
    return <span className="text-xs text-slate-400">整件商品（无独立 SKU）</span>;
  }

  return (
    <div ref={selectorRef} className="min-w-72 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{options.length} 个 SKU</Badge>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "single" ? "default" : "outline"}
          className="h-7 px-2.5 text-xs"
          onClick={() => {
            setMultiOpen(false);
            onChange({
              mode: "single",
              selectedSkuId: selection.selectedSkuId || options[0]?.id || "",
              selectedSkuIds: [selection.selectedSkuId || options[0]?.id || ""].filter(Boolean),
            });
          }}
        >
          选择单个
        </Button>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "multiple" ? "default" : "outline"}
          className="h-7 px-2.5 text-xs"
          onClick={() => {
            if (selection.mode === "multiple") {
              setMultiOpen((open) => !open);
              return;
            }
            const fallbackId = selection.selectedSkuId || options[0]?.id || "";
            setMultiOpen(true);
            onChange({
              mode: "multiple",
              selectedSkuId: fallbackId,
              selectedSkuIds: selection.selectedSkuIds.length
                ? selection.selectedSkuIds
                : fallbackId
                  ? [fallbackId]
                  : [],
            });
          }}
        >
          选择多个
        </Button>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "all" ? "default" : "outline"}
          className="h-7 px-2.5 text-xs"
          onClick={() => {
            setMultiOpen(false);
            onChange({
              mode: "all",
              selectedSkuId: selection.selectedSkuId || options[0]?.id || "",
              selectedSkuIds: options.map((option) => option.id),
            });
          }}
        >
          上传全部
        </Button>
      </div>
      {selection.mode === "single" ? (
        <select
          aria-label={`${item.offerId} 选择 SKU`}
          value={selection.selectedSkuId}
          onChange={(event) =>
            onChange({
              mode: "single",
              selectedSkuId: event.target.value,
              selectedSkuIds: [event.target.value],
            })
          }
          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-800 outline-none focus:border-slate-400 dark:border-white/10 dark:bg-slate-950 dark:text-white"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.specText} / ¥{option.price || "-"} / 库存{" "}
              {option.stock ?? "-"}
            </option>
          ))}
        </select>
      ) : selection.mode === "multiple" && multiOpen ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-950">
          <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-500 dark:border-white/10">
            <span>已选择 {selection.selectedSkuIds.length} / {options.length}</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="font-medium text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white"
                onClick={() =>
                  onChange({
                    ...selection,
                    mode: "multiple",
                    selectedSkuIds: options.map((option) => option.id),
                  })
                }
              >
                全选
              </button>
              <button
                type="button"
                className="font-medium text-slate-500 hover:text-slate-950 dark:hover:text-white"
                onClick={() =>
                  onChange({
                    ...selection,
                    mode: "multiple",
                    selectedSkuIds: [],
                  })
                }
              >
                清空
              </button>
            </div>
          </div>
          <div className="max-h-44 space-y-0.5 overflow-y-auto p-1.5">
            {options.map((option) => {
              const checked = selection.selectedSkuIds.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition ${
                    checked
                      ? "bg-slate-100 text-slate-950 dark:bg-white/10 dark:text-white"
                      : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const nextIds = checked
                        ? selection.selectedSkuIds.filter((id) => id !== option.id)
                        : [...selection.selectedSkuIds, option.id];
                      onChange({
                        mode: "multiple",
                        selectedSkuId: nextIds[0] || selection.selectedSkuId,
                        selectedSkuIds: nextIds,
                      });
                    }}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
                  />
                  <span className="min-w-0 leading-4">
                    {option.specText} / ¥{option.price || "-"} / 库存 {option.stock ?? "-"}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : selection.mode === "multiple" ? (
        <button
          type="button"
          className="w-full rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-2 text-left text-xs text-slate-500 transition hover:border-slate-300 hover:text-slate-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400 dark:hover:border-white/20 dark:hover:text-slate-200"
          onClick={() => setMultiOpen(true)}
        >
          已选择 {selection.selectedSkuIds.length} 个 SKU，点击继续修改
        </button>
      ) : (
        <p className="text-xs text-slate-500">
          将上传全部 {options.length} 个 SKU，共用商品描述和公共特征。
        </p>
      )}
    </div>
  );
}

function isDescriptionFeature(feature: ListingWorkflowFeature) {
  return (
    feature.valueType?.toLowerCase().includes("rich") ||
    feature.valueType?.toLowerCase().includes("multiline") ||
    /描述|说明|简介|description|описан/i.test(
      `${feature.displayLabel ?? ""} ${feature.label} ${feature.ozonCode ?? ""}`,
    )
  );
}

function isTagFeature(feature: ListingWorkflowFeature) {
  return /标签|关键词|tags?|keywords?|хештег/i.test(
    `${feature.displayLabel ?? ""} ${feature.label} ${feature.ozonCode ?? ""}`,
  );
}

function featureDisplayLabel(feature: ListingWorkflowFeature) {
  return feature.displayLabel?.trim() || feature.label;
}

function OzonUploadValuePreview({
  feature,
}: {
  feature: ListingWorkflowFeature;
}) {
  const uploadValue = (feature.ozonAttributeValues ?? [])
    .map((value) => value.value?.trim())
    .filter(Boolean)
    .join(", ");
  if (!uploadValue || uploadValue === feature.value.trim()) return null;
  return (
    <details className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] dark:border-white/10 dark:bg-black/20">
      <summary className="cursor-pointer font-medium text-sky-700 dark:text-sky-300">
        查看 Ozon 俄文上传值
      </summary>
      <p className="mt-2 whitespace-pre-wrap break-words leading-5 text-slate-600 dark:text-slate-300">
        {uploadValue}
      </p>
    </details>
  );
}

function InlinePriceInput({
  item,
  field,
  onSaved,
}: {
  item: ListingWorkflowItem;
  field: EditablePriceField;
  onSaved: (item: ListingWorkflowItem) => void;
}) {
  const savedValue = item[field] ?? "";
  const [value, setValue] = useState(savedValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(savedValue);
  }, [item.id, savedValue]);

  async function save() {
    const nextValue = value.trim();
    if (nextValue === savedValue) return;
    setSaving(true);
    try {
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              [field]: nextValue || null,
            }),
          }),
        ),
      );
      onSaved(saved);
      toast.success(`${editablePriceLabels[field]}已保存`);
    } catch (error) {
      setValue(savedValue);
      toast.error(error instanceof Error ? error.message : "价格保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative min-w-24">
      <Input
        value={value}
        inputMode="decimal"
        aria-label={`${item.offerId} ${editablePriceLabels[field]}`}
        placeholder="填写"
        className="h-10 bg-white pr-8 text-sm dark:bg-black/20"
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setValue(savedValue);
            event.currentTarget.blur();
          }
        }}
      />
      {saving ? (
        <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
      ) : null}
    </div>
  );
}

function FullscreenItemEditor({
  item,
  onClose,
  onSaved,
}: {
  item: ListingWorkflowItem;
  onClose: () => void;
  onSaved: (item: ListingWorkflowItem) => void;
}) {
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const features = draft.features ?? [];
  const categoryFeatures = features.filter(
    (feature) => feature.group !== "base",
  );
  const descriptionFeature = features.find(
    (feature) =>
      feature.group === "base" &&
      (feature.attributeId === "base:short_description" ||
        feature.ozonCode === "description"),
  );

  useEffect(() => {
    setPortalReady(true);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    if (!item.categoryId) return;
    let cancelled = false;

    async function loadChineseAttributeLabels() {
      try {
        const readSnapshot = async () =>
          readApi<OzonFeatureSnapshot>(
            await fetch(
              `/api/ozon/features?categoryId=${item.categoryId}`,
              { cache: "no-store" },
            ),
          );
        let snapshot = await readSnapshot();
        const initialAttributes =
          snapshot.selectedCategory?.attributes ?? [];
        if (
          initialAttributes.length &&
          initialAttributes.some(
            (attribute) =>
              !attribute.nameZh ||
              (attribute.dictionaryValueCount > 0 &&
                attribute.values.some((value) => !value.valueZh)),
          )
        ) {
          await readApi(
            await fetch("/api/ozon/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "category_attributes",
                categoryRecordId: item.categoryId,
                includeValues: true,
                language: "ZH_HANS",
                maxValuesPerAttribute: 1000,
              }),
            }),
          );
          snapshot = await readSnapshot();
        }
        if (cancelled) return;
        const attributeById = new Map(
          (snapshot.selectedCategory?.attributes ?? []).map((attribute) => [
            attribute.ozonAttributeId,
            attribute,
          ]),
        );
        setDraft((current) => ({
          ...current,
          features:
            current.features?.map((feature) => {
              if (feature.group !== "category") return feature;
              const attribute = attributeById.get(
                feature.ozonCode || feature.attributeId,
              );
              if (!attribute) return feature;
              const optionMappings = valueOptionMappings(attribute.values);
              const selectedValue = findMatchedAttributeValue(
                attribute.values,
                feature,
                current.features ?? [],
              );
              return attribute
                ? {
                    ...feature,
                    displayLabel: attribute.nameZh || attribute.name,
                    value: selectedValue?.valueZh || feature.value,
                    options: optionMappings.map((option) => option.label),
                    optionMappings,
                  }
                : feature;
            }) ?? null,
        }));
      } catch {
        // 中文元数据加载失败时继续使用 Ozon 原始字段名，不影响编辑和上传。
      }
    }

    void loadChineseAttributeLabels();
    return () => {
      cancelled = true;
    };
  }, [item.categoryId]);

  function updateFeature(attributeId: string, value: string) {
    setDraft((current) => ({
      ...current,
      features:
        current.features?.map((feature) =>
          feature.attributeId === attributeId
            ? {
                ...feature,
                value,
                source: "人工修改",
                status: value
                  ? "review"
                  : feature.required
                    ? "missing"
                    : "review",
                ozonAttributeValues: undefined,
              }
            : feature,
        ) ?? null,
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const imageSyncedDraft = applyManagedImagesToItem(
        draft,
        buildManagedImagesFromItem(draft),
      );
      const baseSyncedFeatures = syncBaseFeatures(
        imageSyncedDraft.features,
        imageSyncedDraft,
      );
      const syncedFeatures = await resolveOzonAttributeValues(
        baseSyncedFeatures,
        imageSyncedDraft.categoryId,
      );
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${draft.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: imageSyncedDraft.title,
              offerId: imageSyncedDraft.offerId,
              imageUrl: imageSyncedDraft.imageUrl,
              currentPrice: imageSyncedDraft.currentPrice,
              oldPrice: imageSyncedDraft.oldPrice,
              minPrice: imageSyncedDraft.minPrice,
              costPrice: imageSyncedDraft.costPrice,
              currency: imageSyncedDraft.currency,
              scrapedData: imageSyncedDraft.scrapedData,
              features: syncedFeatures,
            }),
          }),
        ),
      );
      toast.success("商品字段已保存");
      onSaved(saved);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "商品保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!portalReady) return null;

  return createPortal(
    <div className="fixed inset-0 z-[110] h-[100dvh] w-screen overflow-y-auto bg-slate-100 dark:bg-[#09090a]">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#111214]/95">
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {draft.stage === "PROCESSING" ? "加工阶段" : "采集阶段"}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-white">
              编辑商品卡
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              保存修改
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="关闭全屏编辑"
              onClick={onClose}
              disabled={saving}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto min-h-[calc(100dvh-81px)] w-full max-w-[1280px] space-y-4 p-3 sm:p-4 lg:p-5">
          <EmbeddedProductGallery item={draft} onChange={setDraft} />

          <section className="overflow-hidden rounded-[20px] border border-slate-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-black/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-slate-950 dark:text-white">
                商品卡信息
              </h3>
              <Badge variant={statusVariant(draft)}>
                {listingItemStatusLabel(draft.status)}
              </Badge>
            </div>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["title", "商品名称"],
                ["offerId", "货号"],
                ["currentPrice", "当前价格"],
                ["oldPrice", "折扣前价格"],
                ["minPrice", "最低价格"],
                ["costPrice", "成本"],
                ["currency", "币种"],
                ["imageUrl", "商品图片 URL"],
              ].map(([key, label]) => (
                <label key={key} className="min-w-0 space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">
                    {label}
                  </span>
                  <Input
                    className="h-8 min-w-0 px-3 text-xs"
                    value={String(
                      draft[key as keyof ListingWorkflowItem] ?? "",
                    )}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              <label className="min-w-0 space-y-1.5">
                <span className="text-xs font-medium text-slate-500">
                  Ozon 类目
                </span>
                <Input
                  className="h-8 min-w-0 bg-slate-50 px-3 text-xs dark:bg-white/[0.03]"
                  value={draft.categoryLabel ?? ""}
                  readOnly
                  placeholder="等待 AI 匹配"
                />
              </label>
              <label className="min-w-0 space-y-1.5 sm:col-span-2 xl:col-span-3">
                <span className="text-xs font-medium text-slate-500">
                  类目路径
                </span>
                <Input
                  className="h-8 min-w-0 bg-slate-50 px-3 text-xs dark:bg-white/[0.03]"
                  value={(draft.categoryPath ?? []).join(" / ")}
                  readOnly
                  placeholder="等待 AI 匹配"
                />
              </label>
            </div>
            {descriptionFeature ? (
              <label className="mt-4 block min-w-0 space-y-1.5">
                <span className="text-xs font-medium text-slate-500">
                  商品描述
                </span>
                <Textarea
                  value={descriptionFeature.value}
                  className="min-h-24 resize-y text-sm leading-6"
                  onChange={(event) =>
                    updateFeature(
                      descriptionFeature.attributeId,
                      event.target.value,
                    )
                  }
                />
              </label>
            ) : null}
          </section>

          {draft.stage === "PROCESSING" ? (
            <section className="overflow-hidden rounded-[20px] border border-slate-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-black/20">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-950 dark:text-white">
                    AI 类目特征
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    AI 匹配类目后字段会自动出现在这里，修改 value
                    会保存到后续 Ozon 上架草稿。
                  </p>
                </div>
                <Badge variant="outline">
                  {categoryFeatures.length} 个字段
                </Badge>
              </div>

              {categoryFeatures.length ? (
                <div className="mt-3 grid min-w-0 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                  {categoryFeatures.map((feature) => (
                    <label
                      key={feature.attributeId}
                      className={`min-w-0 rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-white/10 dark:bg-white/[0.03] ${
                        isDescriptionFeature(feature)
                          ? "sm:col-span-2 xl:col-span-4"
                          : isTagFeature(feature)
                            ? "sm:col-span-2 xl:col-span-2"
                            : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="min-w-0">
                          <p className="line-clamp-2 break-words text-xs font-medium leading-5 text-slate-700 dark:text-slate-200">
                            {featureDisplayLabel(feature)}
                            {feature.required ? (
                              <span className="ml-1 text-rose-500">*</span>
                            ) : null}
                          </p>
                          <p className="mt-0.5 truncate text-[10px] text-slate-400">
                            {feature.ozonCode || feature.attributeId}
                            {feature.source ? ` · ${feature.source}` : ""}
                          </p>
                        </div>
                        {isDescriptionFeature(feature) ? (
                          <Textarea
                            value={feature.value}
                            className="mt-2 min-h-24 min-w-0 resize-y text-sm leading-6"
                            onChange={(event) =>
                              updateFeature(
                                feature.attributeId,
                                event.target.value,
                              )
                            }
                          />
                        ) : (
                          <Input
                            value={feature.value}
                            className="mt-1.5 h-8 min-w-0 px-3 text-xs"
                            list={
                              feature.options.length
                                ? `stage-options-${feature.attributeId}`
                                : undefined
                            }
                            onChange={(event) =>
                              updateFeature(
                                feature.attributeId,
                                event.target.value,
                              )
                            }
                          />
                        )}
                        {feature.options.length ? (
                          <datalist id={`stage-options-${feature.attributeId}`}>
                            {feature.options.map((option) => (
                              <option key={option} value={option} />
                            ))}
                          </datalist>
                        ) : null}
                        <OzonUploadValuePreview feature={feature} />
                      </div>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-dashed border-slate-300 px-5 py-12 text-center text-sm text-slate-500 dark:border-white/10">
                  尚未完成 AI 类目匹配。可回到主页面执行匹配。
                </div>
              )}
            </section>
          ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function ListingStageWorkspace({
  stage,
}: {
  stage: ListingWorkflowStage;
}) {
  const [items, setItems] = useState<ListingWorkflowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editingItem, setEditingItem] =
    useState<ListingWorkflowItem | null>(null);
  const [deletingItem, setDeletingItem] =
    useState<ListingWorkflowItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [imageBusyIds, setImageBusyIds] = useState<Set<string>>(new Set());
  const [skuSelections, setSkuSelections] = useState<
    Record<string, ProductSkuSelection>
  >({});

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      [item.title, item.offerId, item.categoryLabel ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(keyword),
    );
  }, [items, query]);

  async function loadItems(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    try {
      const result = await readApi<ListingWorkflowItem[]>(
        await fetch(`/api/listing-workflow/items?stage=${stage}`, {
          cache: "no-store",
        }),
      );
      const normalizedItems = result.map(normalizeItem);
      setItems(normalizedItems);
      const fetchedSelections = Object.fromEntries(
        normalizedItems.map((item) => [
          item.id,
          readProductSkuSelection(item.scrapedData),
        ]),
      );
      setSkuSelections((current) =>
        options.silent ? { ...fetchedSelections, ...current } : fetchedSelections,
      );
    } catch (error) {
      if (!options.silent) {
        toast.error(error instanceof Error ? error.message : "商品列表读取失败");
      }
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadItems();
    const interval = window.setInterval(() => {
      void loadItems({ silent: true });
    }, 4000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void loadItems({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [stage]);

  function markImageBusy(itemId: string, busy: boolean) {
    setImageBusyIds((current) => {
      const next = new Set(current);
      if (busy) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  }

  function applySavedItem(saved: ListingWorkflowItem) {
    const normalized = normalizeItem(saved);
    setItems((current) =>
      current.map((entry) => (entry.id === normalized.id ? normalized : entry)),
    );
    setEditingItem((current) =>
      current?.id === normalized.id ? normalized : current,
    );
    return normalized;
  }

  async function fetchWorkflowItem(itemId: string) {
    return normalizeItem(
      await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${itemId}`, {
          cache: "no-store",
        }),
      ),
    );
  }

  async function patchWorkflowItem(
    itemId: string,
    body: Partial<ListingWorkflowItem>,
  ) {
    return applySavedItem(
      await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  }

  async function patchImageWorkflowState(
    itemId: string,
    workflowPatch: Record<string, unknown>,
  ) {
    const latest = await fetchWorkflowItem(itemId);
    const previousWorkflow = imageWorkflowState(latest);
    return patchWorkflowItem(itemId, {
      scrapedData: {
        ...latest.scrapedData,
        imageWorkflow: {
          ...previousWorkflow,
          ...workflowPatch,
          updatedAt: new Date().toISOString(),
        },
      },
    });
  }

  async function startProcessingWorkflowForItem(
    item: ListingWorkflowItem,
    options?: { silent?: boolean },
  ) {
    const allImages = buildManagedImagesFromItem(item).slice(
      0,
      WORKFLOW_IMAGE_LIMIT,
    );
    const mainImage = allImages[0] ?? null;
    const selectedIds = new Set(selectedImageIdsFromItem(item));
    const translationImages = allImages.filter(
      (image, index) => index > 0 && selectedIds.has(image.id),
    );
    const categoryMatch =
      asRecord(asRecord(item.aiResponse)?.categoryMatch) ?? {};
    const storedFeatureModel = parseListingModelSelection(
      window.localStorage.getItem(LISTING_FEATURE_MODEL_STORAGE_KEY),
    );
    const storedProviderId = imageWorkflowText(categoryMatch.providerId);
    const storedModelId = imageWorkflowText(categoryMatch.model);
    const featureModel =
      storedFeatureModel ??
      (storedProviderId && storedModelId
        ? { providerId: storedProviderId, modelId: storedModelId }
        : null);
    const prompts = readStageAiPrompts(item.title);
    const runId = `processing-run:${Date.now()}:${simpleStableHash(item.id)}`;
    const startedAt = new Date().toISOString();
    const notes: string[] = [];
    let workflowPatchQueue: Promise<unknown> = Promise.resolve();

    const queueWorkflowPatch = (workflowPatch: Record<string, unknown>) => {
      workflowPatchQueue = workflowPatchQueue
        .catch(() => undefined)
        .then(() => patchImageWorkflowState(item.id, workflowPatch));
      return workflowPatchQueue;
    };
    const noteSnapshot = () => [...notes];

    const runTranslationTask = async () => {
      if (!translationImages.length) {
        await queueWorkflowPatch({
          runId,
          translationStatus: "skipped",
          translationTotalImages: 0,
          translatedCount: 0,
          translatedSuccessCount: 0,
          translationFailedCount: 0,
          translationSkippedCount: 0,
        });
        return {
          status: "skipped" as ImageWorkflowSubStatusValue,
          outputs: [] as Awaited<ReturnType<typeof translateWorkflowImageAtlas>>,
          failedCount: 0,
        };
      }

      try {
        const outputs = await translateWorkflowImageAtlas(
          translationImages,
          "ru",
        );
        const failedCount = Math.max(
          translationImages.length - outputs.length,
          0,
        );
        const status: ImageWorkflowSubStatusValue =
          outputs.length === translationImages.length
            ? "done"
            : outputs.length
              ? "partial"
              : "failed";
        if (failedCount) {
          notes.push(`图集翻译有 ${failedCount} 张缺少裁剪结果。`);
        }
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          translationStatus: status,
          translationTotalImages: translationImages.length,
          translatedCount: outputs.length,
          translatedSuccessCount: outputs.length,
          translationFailedCount: failedCount,
          translationSkippedCount: 0,
          atlasTranslation: true,
          autoTranslatedAt: new Date().toISOString(),
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return { status, outputs, failedCount };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "图集翻译失败";
        notes.push(`选中图片图集翻译失败：${message}`);
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          translationStatus: "failed",
          translationTotalImages: translationImages.length,
          translatedCount: 0,
          translatedSuccessCount: 0,
          translationFailedCount: translationImages.length,
          translationSkippedCount: 0,
          atlasTranslation: true,
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "failed" as ImageWorkflowSubStatusValue,
          outputs: [] as Awaited<ReturnType<typeof translateWorkflowImageAtlas>>,
          failedCount: translationImages.length,
        };
      }
    };

    const runGenerationTask = async () => {
      if (!mainImage) {
        await queueWorkflowPatch({ runId, generationStatus: "skipped" });
        return {
          status: "skipped" as ImageWorkflowSubStatusValue,
          image: null as ManagedWorkflowImage | null,
        };
      }
      try {
        const generated = await generateWorkflowImage(mainImage, item.title);
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          generationStatus: "done",
          generatedImageId: generated.id,
          generatedImageUrl: generated.url,
          autoGeneratedMainImageAt: new Date().toISOString(),
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "done" as ImageWorkflowSubStatusValue,
          image: generated,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "主图生成失败";
        notes.push(`主图自动生图失败：${message}`);
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          generationStatus: "failed",
          generatedImageId: null,
          generatedImageUrl: null,
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "failed" as ImageWorkflowSubStatusValue,
          image: null as ManagedWorkflowImage | null,
        };
      }
    };

    const runFeatureTask = async () => {
      if (!item.categoryId) {
        const message = "采集阶段没有得到 Ozon 类目结果";
        notes.push(`特征匹配失败：${message}`);
        await queueWorkflowPatch({
          runId,
          featureStatus: "failed",
          featureError: message,
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "failed" as ImageWorkflowSubStatusValue,
          features: item.features,
          aiResponse: item.aiResponse,
          featureNotes: [message],
        };
      }
      if (!featureModel) {
        const message = "特征填写 AI 模型配置为空";
        notes.push(`特征匹配失败：${message}`);
        await queueWorkflowPatch({
          runId,
          featureStatus: "failed",
          featureError: message,
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "failed" as ImageWorkflowSubStatusValue,
          features: item.features,
          aiResponse: item.aiResponse,
          featureNotes: [message],
        };
      }

      try {
        await ensureCategoryAttributes(item.categoryId);
        const preparedProduct = asRecord(categoryMatch.preparedProduct);
        const featureResult = await readApi<FeatureDraftResponse>(
          await fetch("/api/listing-workflow/feature-draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scrapedData: item.scrapedData,
              preparedProduct,
              categoryId: item.categoryId,
              providerId: featureModel.providerId,
              model: featureModel.modelId,
              customPrompt: prompts.featureFill.taskPrompt,
              systemPrompt: prompts.featureFill.systemPrompt,
            }),
          }),
        );
        const features =
          syncBaseFeatures(featureResult.features, item) ??
          featureResult.features;
        const status: ImageWorkflowSubStatusValue = featureResult.aiStatus.ok
          ? "done"
          : "failed";
        if (!featureResult.aiStatus.ok) {
          notes.push(`特征匹配提醒：${featureResult.aiStatus.message}`);
        }
        const aiResponse = {
          ...(featureResult.aiResponse ?? {}),
          categoryMatch,
        };
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          featureStatus: status,
          featureError: featureResult.aiStatus.ok
            ? null
            : featureResult.aiStatus.message,
          autoFeatureMatchedAt: new Date().toISOString(),
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status,
          features,
          aiResponse,
          featureNotes: featureResult.notes ?? [],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "特征匹配失败";
        notes.push(`特征匹配失败：${message}`);
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          featureStatus: "failed",
          featureError: message,
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "failed" as ImageWorkflowSubStatusValue,
          features: item.features,
          aiResponse: item.aiResponse,
          featureNotes: [message],
        };
      }
    };

    markImageBusy(item.id, true);
    try {
      await patchWorkflowItem(item.id, {
        status: "AI_RUNNING",
        scrapedData: {
          ...item.scrapedData,
          imageWorkflow: {
            ...imageWorkflowState(item),
            runId,
            status: "running",
            phase: "parallel",
            totalImages: allImages.length,
            translationTotalImages: translationImages.length,
            translatedCount: 0,
            translatedSuccessCount: 0,
            translationFailedCount: 0,
            translationSkippedCount: 0,
            translationStatus: translationImages.length
              ? "running"
              : "skipped",
            generationStatus: mainImage ? "running" : "skipped",
            featureStatus: "running",
            sourceImageSignature: imageWorkflowSignature(allImages),
            selectedTranslationImageIds: translationImages.map(
              (image) => image.id,
            ),
            generatedImageId: null,
            generatedImageUrl: null,
            error: null,
            featureError: null,
            autoImageWorkflowNotes: [],
            startedAt,
            finishedAt: null,
            updatedAt: new Date().toISOString(),
          },
        },
      });

      if (!options?.silent) {
        toast("三线加工已开始：主图生图、特征匹配、选中图片图集翻译并行运行。");
      }

      const [translationResult, generationResult, featureResult] =
        await Promise.all([
          runTranslationTask(),
          runGenerationTask(),
          runFeatureTask(),
        ]);
      await workflowPatchQueue;

      const latest = await fetchWorkflowItem(item.id);
      if (imageWorkflowText(imageWorkflowState(latest).runId) !== runId) {
        return;
      }

      const translatedBySourceId = new Map(
        translationResult.outputs.map((output) => [
          output.sourceId,
          output.image,
        ]),
      );
      const processedImages = allImages.map((image, index) => {
        if (index === 0) return generationResult.image ?? image;
        return translatedBySourceId.get(image.id) ?? image;
      });
      const nextSelectedImageIds = translationImages
        .map(
          (image) => translatedBySourceId.get(image.id)?.id ?? image.id,
        )
        .filter((id) => processedImages.some((image) => image.id === id));
      const translationOk =
        translationResult.status === "done" ||
        translationResult.status === "skipped";
      const generationOk =
        generationResult.status === "done" ||
        generationResult.status === "skipped";
      const featureOk = featureResult.status === "done";
      const finalStatus: ImageWorkflowStatusValue =
        translationOk && generationOk && featureOk && notes.length === 0
          ? "done"
          : featureOk ||
              generationResult.status === "done" ||
              translationResult.outputs.length > 0
            ? "partial"
            : "failed";
      const completedFeatures = syncImageFeature(
        featureResult.features ?? latest.features,
        processedImages,
      );
      const finishedAt = new Date().toISOString();
      const nextItem = applyManagedImagesToItem(
        { ...latest, features: completedFeatures },
        processedImages,
        {
          runId,
          status: finalStatus,
          phase: "done",
          totalImages: allImages.length,
          translationTotalImages: translationImages.length,
          translatedCount: translationResult.outputs.length,
          translatedSuccessCount: translationResult.outputs.length,
          translationFailedCount: translationResult.failedCount,
          translationSkippedCount: 0,
          translationStatus: translationResult.status,
          generationStatus: generationResult.status,
          featureStatus: featureResult.status,
          autoTranslatedAt: translationImages.length ? finishedAt : null,
          autoGeneratedMainImageAt: generationResult.image
            ? finishedAt
            : null,
          autoFeatureMatchedAt: featureOk ? finishedAt : null,
          generatedImageId: generationResult.image?.id ?? null,
          generatedImageUrl: generationResult.image?.url ?? null,
          autoImageWorkflowNotes: noteSnapshot(),
          error: finalStatus === "failed" ? notes[0] ?? "加工失败" : null,
          startedAt,
          finishedAt,
        },
        nextSelectedImageIds,
      );
      await patchWorkflowItem(item.id, {
        status: featureOk ? "MATCHED" : "AI_FAILED",
        scrapedData: nextItem.scrapedData,
        imageUrl: nextItem.imageUrl,
        features: nextItem.features,
        aiResponse: featureResult.aiResponse,
        notes: featureResult.featureNotes,
      });

      if (!options?.silent) {
        if (finalStatus === "done") {
          toast.success("三线加工已完成");
        } else {
          toast.warning(`三线加工结束，共有 ${notes.length} 条提醒`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "三线加工失败";
      try {
        await patchWorkflowItem(item.id, { status: "AI_FAILED" });
        await patchImageWorkflowState(item.id, {
          runId,
          status: "failed",
          phase: "failed",
          error: message,
          autoImageWorkflowNotes: [...notes, message],
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      } catch {
        // 商品记录已变化时交给列表轮询恢复最新状态。
      }
      if (!options?.silent) toast.error(message);
    } finally {
      markImageBusy(item.id, false);
    }
  }

  async function persistSkuSelection(
    item: ListingWorkflowItem,
    selection: ProductSkuSelection,
  ) {
    const options = extractProductSkuOptions(item.scrapedData);
    if (!options.length) return;
    const scrapedData = applySkuSelectionToJson(
      item.scrapedData,
      selection.mode,
      selection.selectedSkuId,
      selection.selectedSkuIds,
    );
    try {
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scrapedData }),
          }),
        ),
      );
      setItems((current) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry)),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "SKU 选择保存失败",
      );
    }
  }

  async function moveToProcessing(item: ListingWorkflowItem) {
    setBusyId(item.id);
    try {
      const options = extractProductSkuOptions(item.scrapedData);
      const selection =
        skuSelections[item.id] ?? readProductSkuSelection(item.scrapedData);
      if (
        options.length &&
        ((selection.mode === "single" && !selection.selectedSkuId) ||
          (selection.mode === "multiple" && !selection.selectedSkuIds.length))
      ) {
        throw new Error("请至少选择一个 SKU，或选择上传全部 SKU");
      }
      const selectedData = options.length
        ? applySkuSelectionToJson(
            item.scrapedData,
            selection.mode,
            selection.selectedSkuId,
            selection.selectedSkuIds,
          )
        : item.scrapedData;
      const selectedSku =
        selection.mode === "single"
          ? options.find((option) => option.id === selection.selectedSkuId)
          : null;
      const preparedItem: ListingWorkflowItem = {
        ...item,
        scrapedData: selectedData,
        ...(selectedSku?.price ? { costPrice: selectedSku.price } : {}),
      };
      const sourceImages = buildManagedImagesFromItem(preparedItem).slice(
        0,
        WORKFLOW_IMAGE_LIMIT,
      );
      const selectedIds = new Set(selectedImageIdsFromItem(preparedItem));
      const translationImageCount = sourceImages.filter(
        (image, index) => index > 0 && selectedIds.has(image.id),
      ).length;
      const imageSyncedItem = sourceImages.length
        ? applyManagedImagesToItem(preparedItem, sourceImages, {
            status: "queued",
            phase: "queued",
            translationStatus: translationImageCount ? "queued" : "skipped",
            generationStatus: "queued",
            featureStatus: "queued",
            totalImages: sourceImages.length,
            translationTotalImages: translationImageCount,
            translatedCount: 0,
            translatedSuccessCount: 0,
            translationFailedCount: 0,
            translationSkippedCount: 0,
            sourceImageSignature: imageWorkflowSignature(sourceImages),
            autoImageWorkflowNotes: [],
            queuedAt: new Date().toISOString(),
          })
        : preparedItem;
      toast(
        `商品进入加工阶段后启动三线并行：主图生图、特征匹配、${translationImageCount} 张选中图片图集翻译。`,
      );
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: "PROCESSING",
            status: "PENDING_AI",
            scrapedData: imageSyncedItem.scrapedData,
            imageUrl: imageSyncedItem.imageUrl,
            costPrice: imageSyncedItem.costPrice,
            features: imageSyncedItem.features,
          }),
        }),
        ),
      );
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      toast.success(
        options.length
          ? selection.mode === "all"
            ? `全部 ${options.length} 个 SKU 已加入加工阶段`
            : selection.mode === "multiple"
              ? `已选择 ${selection.selectedSkuIds.length} 个 SKU 并加入加工阶段`
              : `已选择 SKU“${selectedSku?.specText || selection.selectedSkuId}”并加入加工阶段`
          : "商品已加入加工阶段",
      );
      void startProcessingWorkflowForItem(saved, { silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加入加工阶段失败");
    } finally {
      setBusyId(null);
    }
  }

  async function ensureCategoryAttributes(categoryId: string) {
    let snapshot = await readApi<OzonFeatureSnapshot>(
      await fetch(`/api/ozon/features?categoryId=${categoryId}`, {
        cache: "no-store",
      }),
    );
    const attributes = snapshot.selectedCategory?.attributes ?? [];
    const needsAttributeSync =
      attributes.length === 0 ||
      attributes.some(
        (attribute) =>
          attribute.dictionaryId && attribute.dictionaryValueCount === 0,
      );
    try {
      if (snapshot.connection.ready && needsAttributeSync) {
        await readApi(
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
        snapshot = await readApi<OzonFeatureSnapshot>(
          await fetch(`/api/ozon/features?categoryId=${categoryId}`, {
            cache: "no-store",
          }),
        );
      }
      const translatedAttributes =
        snapshot.selectedCategory?.attributes ?? [];
      const needsChineseSync = translatedAttributes.some(
        (attribute) =>
          !attribute.nameZh ||
          (attribute.dictionaryValueCount > 0 &&
            attribute.values.some((value) => !value.valueZh)),
      );
      if (snapshot.connection.ready && needsChineseSync) {
        await readApi(
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
      }
    } catch (error) {
      toast.warning(
        error instanceof Error
          ? `${error.message}；将继续使用本地类目特征`
          : "类目特征同步失败，将继续使用本地缓存",
      );
    }
  }

  async function matchItem(item: ListingWorkflowItem) {
    const categoryMatch =
      asRecord(asRecord(item.aiResponse)?.categoryMatch) ?? {};
    const localModel = parseListingModelSelection(
      window.localStorage.getItem(LISTING_FEATURE_MODEL_STORAGE_KEY),
    );
    const savedProviderId = imageWorkflowText(categoryMatch.providerId);
    const savedModelId = imageWorkflowText(categoryMatch.model);
    const model =
      localModel ??
      (savedProviderId && savedModelId
        ? { providerId: savedProviderId, modelId: savedModelId }
        : null);
    if (!model) {
      toast.error("请先在主页选择一次“特征填写 AI”模型");
      return;
    }
    if (!item.categoryId) {
      toast.error("该商品缺少采集阶段的类目匹配结果");
      return;
    }
    const prompts = readStageAiPrompts();
    setBusyId(item.id);
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id
          ? { ...entry, status: "AI_RUNNING" as const }
          : entry,
      ),
    );
    try {
      await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "AI_RUNNING" }),
        }),
      );
      await ensureCategoryAttributes(item.categoryId);
      const featureResult = await readApi<FeatureDraftResponse>(
        await fetch("/api/listing-workflow/feature-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scrapedData: item.scrapedData,
            preparedProduct: asRecord(categoryMatch.preparedProduct),
            categoryId: item.categoryId,
            providerId: model.providerId,
            model: model.modelId,
            customPrompt: prompts.featureFill.taskPrompt,
            systemPrompt: prompts.featureFill.systemPrompt,
          }),
        }),
      );
      const nextItemForBase = {
        ...item,
      };
      const nextFeatures =
        syncBaseFeatures(featureResult.features, nextItemForBase) ??
        featureResult.features;
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: featureResult.aiStatus.ok ? "MATCHED" : "AI_FAILED",
              features: nextFeatures,
              aiResponse: {
                ...(featureResult.aiResponse ?? {}),
                categoryMatch,
              },
              notes: featureResult.notes ?? [],
            }),
          }),
        ),
      );
      setItems((current) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry)),
      );
      if (featureResult.aiStatus.ok) {
        toast.success(
          `特征匹配完成：${item.categoryLabel || item.categoryId}，已回填 ${nextFeatures.filter((feature) => feature.group === "category" && feature.value.trim()).length} 个类目字段`,
        );
      } else {
        toast.warning(featureResult.aiStatus.message);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "特征匹配失败";
      try {
        const failed = normalizeItem(
          await readApi<ListingWorkflowItem>(
            await fetch(`/api/listing-workflow/items/${item.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "AI_FAILED" }),
            }),
          ),
        );
        setItems((current) =>
          current.map((entry) =>
            entry.id === failed.id ? failed : entry,
          ),
        );
      } catch {
        setItems((current) =>
          current.map((entry) =>
            entry.id === item.id
              ? { ...entry, status: "AI_FAILED" as const }
              : entry,
          ),
        );
      }
      toast.error(message);
    } finally {
      setBusyId(null);
    }
  }

  async function removeItem() {
    if (!deletingItem) return;
    setBusyId(deletingItem.id);
    try {
      await readApi<ListingWorkflowItem>(
        await fetch(`/api/listing-workflow/items/${deletingItem.id}`, {
          method: "DELETE",
        }),
      );
      setItems((current) =>
        current.filter((entry) => entry.id !== deletingItem.id),
      );
      forgetActiveWorkflowItem(deletingItem.id);
      toast.success("商品记录已删除");
      setDeletingItem(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索商品名称、货号或类目"
              className="pl-9"
            />
          </div>
          <Button variant="outline" onClick={() => void loadItems()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-black/20">
          {loading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取商品队列
            </div>
          ) : filteredItems.length ? (
            <div className="max-h-[calc(100dvh-20rem)] min-h-72 overflow-auto [scrollbar-gutter:stable]">
              <table
                className={`table-fixed text-left ${
                  stage === "COLLECTED"
                    ? "min-w-[1580px]"
                    : "min-w-[1220px]"
                }`}
              >
                <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-semibold text-slate-500 shadow-[0_1px_0_0_rgb(226_232_240)] dark:bg-slate-900 dark:shadow-[0_1px_0_0_rgba(255,255,255,0.1)]">
                  <tr>
                    <th className="w-28 px-4 py-4">商品图片</th>
                    <th className="w-64 px-4 py-4">商品名称</th>
                    <th className="w-52 px-4 py-4">货号</th>
                    <th className="w-28 px-4 py-4">当前价格</th>
                    <th className="w-28 px-4 py-4">折扣前价格</th>
                    <th className="w-28 px-4 py-4">最低价格</th>
                    <th className="w-28 px-4 py-4">成本</th>
                    {stage === "COLLECTED" ? (
                      <th className="w-96 px-4 py-4">SKU 上传范围</th>
                    ) : null}
	                    <th
	                      className={
	                        stage === "PROCESSING"
	                          ? "w-72 px-4 py-4"
	                          : "w-[420px] px-4 py-4"
	                      }
	                    >
	                      {stage === "PROCESSING" ? "三线加工状态" : "操作"}
	                    </th>
	                    {stage === "PROCESSING" ? (
	                      <th className="w-80 px-4 py-4">操作</th>
	                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-slate-200 align-middle dark:border-white/10"
                    >
	                      <td className="px-4 py-4">
	                        <ProductImage
	                          item={item}
	                          onClick={() => setEditingItem(item)}
	                        />
	                      </td>
                      <td className="px-4 py-4">
                        <p className="line-clamp-2 text-sm font-medium text-slate-950 dark:text-white">
                          {item.title}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.sourcePlatform || "未知来源"}
                        </p>
                        {item.categoryLabel ? (
                          <p className="mt-1 line-clamp-2 text-xs text-sky-700 dark:text-sky-300">
                            类目：{item.categoryLabel}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-700 dark:text-slate-200">
                        <span className="break-all">{item.offerId}</span>
                      </td>
                      <td className="px-3 py-4 text-sm">
                        <InlinePriceInput
                          item={item}
                          field="currentPrice"
                          onSaved={(saved) =>
                            setItems((current) =>
                              current.map((entry) =>
                                entry.id === saved.id ? saved : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-4 text-sm">
                        <InlinePriceInput
                          item={item}
                          field="oldPrice"
                          onSaved={(saved) =>
                            setItems((current) =>
                              current.map((entry) =>
                                entry.id === saved.id ? saved : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-4 text-sm">
                        <InlinePriceInput
                          item={item}
                          field="minPrice"
                          onSaved={(saved) =>
                            setItems((current) =>
                              current.map((entry) =>
                                entry.id === saved.id ? saved : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-4 py-4 text-sm font-medium text-amber-700 dark:text-amber-300">
                        {item.costPrice || "-"}
                      </td>
                      {stage === "COLLECTED" ? (
                        <td className="px-4 py-4">
                          <CollectionSkuSelector
                            item={item}
                            selection={
                              skuSelections[item.id] ??
                              readProductSkuSelection(item.scrapedData)
                            }
                            onChange={(selection) => {
                              setSkuSelections((current) => ({
                                ...current,
                                [item.id]: selection,
                              }));
                              void persistSkuSelection(item, selection);
                            }}
                          />
                        </td>
                      ) : null}
	                      <td className="px-4 py-4">
	                        {stage === "PROCESSING" ? (
	                          <div className="space-y-3">
	                            <div className="space-y-1">
	                              <Badge variant={statusVariant(item)}>
	                                {listingItemStatusLabel(item.status)}
	                              </Badge>
	                              <p className="line-clamp-2 text-xs text-slate-500">
	                                {item.categoryLabel || "等待类目匹配"}
	                              </p>
	                            </div>
	                            <ImageWorkflowStatus item={item} />
	                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Badge variant={statusVariant(item)}>
                              {listingItemStatusLabel(item.status)}
                            </Badge>
                            <Button
                              size="sm"
                              onClick={() => void moveToProcessing(item)}
	                              disabled={
	                                busyId === item.id ||
	                                imageBusyIds.has(item.id) ||
	                                imageWorkflowIsRunning(item)
	                              }
                            >
                              {busyId === item.id ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <ArrowRight className="mr-1.5 h-4 w-4" />
                              )}
                              开始三线加工
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingItem(item)}
                            >
                              <Pencil className="mr-1.5 h-4 w-4" />
                              编辑商品卡
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingItem(item)}
                            >
                              <Trash2 className="mr-1.5 h-4 w-4" />
                              删除
                            </Button>
                          </div>
                        )}
                      </td>
                      {stage === "PROCESSING" ? (
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => void matchItem(item)}
                              disabled={busyId === item.id}
                            >
                              {busyId === item.id ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <Sparkles className="mr-1.5 h-4 w-4" />
	                              )}
	                              {busyId === item.id
	                                ? "特征匹配中"
	                                : item.status === "MATCHED"
	                                  ? "重新特征匹配"
	                                  : "开始特征匹配"}
	                            </Button>
	                            <Button
	                              size="sm"
	                              variant="outline"
	                              onClick={() =>
	                                void startProcessingWorkflowForItem(item)
	                              }
	                              disabled={
	                                imageBusyIds.has(item.id) ||
	                                imageWorkflowIsRunning(item)
	                              }
	                            >
	                              {imageBusyIds.has(item.id) ||
	                              imageWorkflowIsRunning(item) ? (
	                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
	                              ) : (
	                                <Images className="mr-1.5 h-4 w-4" />
	                              )}
	                              {imageBusyIds.has(item.id) ||
	                              imageWorkflowIsRunning(item)
	                                ? "三线加工中"
	                                : "重跑三线加工"}
	                            </Button>
	                            <Button
	                              size="sm"
	                              variant="outline"
                              onClick={() => setEditingItem(item)}
                            >
                              <Pencil className="mr-1.5 h-4 w-4" />
                              编辑商品卡
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeletingItem(item)}
                            >
                              <Trash2 className="mr-1.5 h-4 w-4" />
                              删除
                            </Button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <Box className="h-10 w-10 text-slate-300" />
              <p className="mt-4 text-sm font-medium text-slate-800 dark:text-slate-100">
                {stage === "COLLECTED"
                  ? "还没有采集商品"
                  : "还没有进入加工阶段的商品"}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {stage === "COLLECTED"
                  ? "回到主页面输入 1688 链接并启动采集。"
                  : "在采集阶段点击“加入加工阶段”。"}
              </p>
            </div>
          )}
        </div>
      </div>

      {editingItem ? (
        <FullscreenItemEditor
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={(saved) =>
            setItems((current) =>
              current.map((entry) => (entry.id === saved.id ? saved : entry)),
            )
          }
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deletingItem)}
        title="删除商品记录？"
        description="这会同时删除该商品保存的采集 JSON 和 AI 特征草稿，操作不可恢复。"
        confirmText="删除"
        destructive
        loading={Boolean(deletingItem && busyId === deletingItem.id)}
        onConfirm={() => void removeItem()}
        onCancel={() => setDeletingItem(null)}
        icon={<Trash2 className="h-5 w-5" />}
      />
    </>
  );
}
