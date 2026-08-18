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
  Store,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { OzonStoreManager } from "@/components/ozon/ozon-store-manager";
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
  LISTING_IMAGE_MODEL_STORAGE_KEY,
  LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY,
  listingItemStatusLabel,
  parseListingModelSelection,
} from "@/lib/listing-workflow/items";
import {
  applyOzonPackageMetricsToSelectedSkus,
  applySkuSelectionToJson,
  deriveOzonPackageMetrics,
  extractProductSkuOptions,
  readProductSkuSelection,
  type OzonPackageMetrics,
  type ProductSkuSelection,
} from "@/lib/listing-workflow/skus";
import {
  DEFAULT_LISTING_FEATURE_FILL_MODE,
  LISTING_FEATURE_FILL_MODES,
  LISTING_QUICK_MODE_MODEL_ID,
  LISTING_QUICK_MODE_PROVIDER_ID,
  listingFeatureFillModeConfig,
  normalizeListingFeatureFillMode,
  type ListingFeatureFillMode,
} from "@/lib/listing-workflow/quick-mode";
import {
  DEFAULT_LISTING_STAGE_AI_PROMPTS,
  LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
  buildDefaultListingImagePrompt,
  normalizeListingStageAiPrompts,
  type ListingStageAiPromptConfig,
} from "@/lib/listing-workflow/text-prompts";
import {
  DEFAULT_LISTING_PRODUCT_QUANTITY,
  normalizeListingProductQuantity,
  normalizeListingWarehouseRules,
  type ListingWarehouseRule,
} from "@/lib/listing-workflow/warehouse-settings";
import { normalizeOzonAttributeMatchKey } from "@/lib/ozon/attribute-match";
import { findOzonColorValue, isOzonColorAttributeId } from "@/lib/ozon/color-match";
import type {
  OzonAttributeValueSnapshot,
  OzonFeatureSnapshot,
} from "@/lib/ozon/snapshot";
import type { OzonConnectionState } from "@/lib/ozon/client";
import type { ApiResponseShape } from "@/lib/utils/api";

type FeatureDraftResponse = {
  category?: {
    id: string;
    label: string;
    path: string[];
  } | null;
  features: ListingWorkflowFeature[];
  preparedProduct?: Record<string, unknown>;
  variantFeatures?: ListingSkuFeatureDraft[];
  aiStatus: { ok: boolean; message: string };
  notes: string[];
  aiResponse?: Record<string, unknown> | null;
};

type ListingSkuFeatureDraft = {
  skuId: string;
  title: string;
  specText: string;
  specLine: string;
  price: string;
  stock: string;
  package?: Array<{ key: string; value: string }>;
  features: ListingWorkflowFeature[];
  status: "matched" | "review" | "missing";
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
  gridImages?: Array<{
    index: number;
    label: string;
    fileName: string;
    filePath: string;
    imageUrl: string;
    mimeType: string;
    width: number;
    height: number;
  }>;
  gridSource?: {
    fileName: string;
    filePath: string;
    width: number;
    height: number;
    detectionMode: "separator" | "geometric-fallback";
  } | null;
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

type OzonImportSubmitResponse = {
  taskId: number;
  submittedAt: string;
  warnings: string[];
};

const OZON_TARGET_STORE_IDS_STORAGE_KEY =
  "banana-mall:listing-workflow:ozon-target-store-ids";

type OzonImportStatusResponse = {
  taskId: number;
  terminal: boolean;
  imported: number;
  failed: number;
  pending: number;
  items: Array<{
    offer_id?: string;
    status?: string;
    errors?: unknown[];
    product_id?: number;
  }>;
};

type OzonErrorRepairResponse = {
  totalUploaded: number;
  detected: number;
  running: boolean;
  state: {
    status: "idle" | "running" | "completed" | "failed";
    totalUploaded: number;
    detected: number;
    processed: number;
    repaired: number;
    stockUpdated: number;
    stockPending: number;
    failed: number;
    currentOfferId: string | null;
    errors: string[];
    startedAt: string | null;
    completedAt: string | null;
  };
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
    workflowData:
      raw.workflowData && typeof raw.workflowData === "object"
        ? raw.workflowData
        : null,
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
      modelId: "doubao-image-web",
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
  const existingWorkflowImages =
    asRecord(item.workflowData?.workflowImages) ??
    asRecord(item.scrapedData.workflowImages);
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
  const workflowImages =
    asRecord(item.workflowData?.workflowImages) ??
    asRecord(item.scrapedData.workflowImages);
  const ids = Array.isArray(workflowImages?.selectedImageIds)
    ? workflowImages.selectedImageIds
    : [];
  return ids.filter((id): id is string => typeof id === "string" && Boolean(id));
}

function readItemSkuSelection(item: ListingWorkflowItem) {
  const workflowSelection = item.workflowData?.skuSelection;
  return readProductSkuSelection({
    ...item.scrapedData,
    ...(workflowSelection ? { skuSelection: workflowSelection } : {}),
  });
}

function processingImagesFromCollection(
  images: ManagedWorkflowImage[],
  selectedImageIds: string[],
) {
  const selected = new Set(selectedImageIds);
  const processingImages = images.filter(
    (image, index) => index === 0 || selected.has(image.id),
  );
  return {
    processingImages,
    selectedAdditionalImageIds: processingImages
      .slice(1)
      .map((image) => image.id),
  };
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
  const previousWorkflow =
    asRecord(item.workflowData?.imageWorkflow) ??
    asRecord(item.scrapedData.imageWorkflow) ??
    {};
  return {
    ...item,
    imageUrl: urls[0] ?? null,
    workflowData: {
      ...(item.workflowData ?? {}),
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

function currentFeatureInputData(item: ListingWorkflowItem) {
  const selection = readItemSkuSelection(item);
  const selectedSource = applySkuSelectionToJson(
    item.scrapedData,
    selection.mode,
    selection.selectedSkuId,
    selection.selectedSkuIds,
  );
  return {
    ...selectedSource,
    title: item.title,
    offerId: item.offerId,
    price:
      item.costPrice ||
      item.currentPrice ||
      item.minPrice ||
      imageWorkflowText(item.scrapedData.price),
    currency: item.currency,
    imageUrl: item.imageUrl || imageWorkflowText(item.scrapedData.imageUrl),
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
  workflowContext?: { itemId: string; runId: string },
  promptConfig?: ListingStageAiPromptConfig,
) {
  const model = readImageModelSelection();
  const prompts = promptConfig ?? readStageAiPrompts(title);
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
        splitGrid: Boolean(workflowContext),
        ...(workflowContext
          ? {
              workflowItemId: workflowContext.itemId,
              workflowRunId: workflowContext.runId,
            }
          : {}),
      }),
    }),
  );

  const outputs =
    result.gridImages?.length === 4
      ? [...result.gridImages].sort((left, right) => left.index - right.index)
      : [
          {
            index: 0,
            label: "左上",
            fileName: result.fileName,
            filePath: result.filePath,
            imageUrl: result.imageUrl,
          },
        ];

  return outputs.map((output, index) => ({
    id: `generated:${output.filePath}`,
    name: output.fileName,
    url: output.imageUrl,
    label: index === 0 ? "AI 主图" : `AI 详情图 ${index}`,
    source: "generated" as const,
  }));
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
  workflowContext?: { itemId: string; runId: string },
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
          ...(workflowContext
            ? {
                workflowItemId: workflowContext.itemId,
                workflowRunId: workflowContext.runId,
                workflowTranslationTotal: images.length,
              }
            : {}),
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
    const selectedDictionaryIds = new Set(
      (feature.ozonAttributeValues ?? [])
        .map((value) => Number(value.dictionary_value_id))
        .filter(
          (value) => Number.isSafeInteger(value) && value > 0,
        ),
    );
    if (selectedDictionaryIds.size > 1) {
      const matchedValues = attribute.values.filter((candidate) =>
        selectedDictionaryIds.has(Number(candidate.ozonValueId)),
      );
      if (matchedValues.length === selectedDictionaryIds.size) {
        return {
          ...feature,
          ozonAttributeValues: matchedValues.map((matchedValue) => ({
            dictionary_value_id: Number(matchedValue.ozonValueId),
            value: matchedValue.value,
          })),
        };
      }
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
  return (
    asRecord(item.workflowData?.imageWorkflow) ??
    asRecord(item.scrapedData.imageWorkflow) ??
    {}
  );
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
        <Badge variant="outline">加工待启动</Badge>
        <p className="text-xs text-slate-400">点击加入加工阶段后自动启动</p>
      </div>
    );
  }

  let label = "加工中";
  if (status === "done") {
    label = featureStatus ? "加工已完成" : "图片流程已完成";
  } else if (status === "partial") {
    label = featureStatus ? "加工部分完成" : "图片流程部分完成";
  } else if (status === "failed") {
    label = featureStatus ? "加工失败" : "图片流程失败";
  } else if (
    translationStatus === "running" &&
    generationStatus === "running" &&
    featureStatus === "running"
  ) {
    label = "加工中";
  } else if (phase === "generating" || generationStatus === "running") {
    label = "主图生成中";
  } else if (featureStatus === "running") {
    label = "属性同步中";
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
      ? "采集属性已沿用"
      : featureStatus === "failed"
        ? "属性同步失败"
        : featureStatus === "running"
          ? "属性同步中"
          : featureStatus === "queued"
            ? "属性等待同步"
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
          ? imageWorkflowText(workflow.error) || "可重新执行加工"
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

function categoryMatchNotes(notes: string[] | null, message: string) {
  return [
    ...(notes ?? []).filter((note) => !note.startsWith("类目匹配：")),
    `类目匹配：${message}`,
  ];
}

function categoryMatchHint(item: ListingWorkflowItem) {
  if (item.status === "AI_RUNNING") {
    return "AI 正在读取选中 SKU 并填写 Ozon 类目与属性。";
  }
  if (item.categoryId && item.categoryLabel) {
    return `类目已就绪：${item.categoryLabel}`;
  }
  const categoryMatch =
    asRecord(asRecord(item.aiResponse)?.categoryMatch) ?? {};
  const error = imageWorkflowText(categoryMatch.error);
  return error
    ? `${error}；可编辑商品后重新匹配。`
    : "请确认主图、勾选要保留的附图和 SKU；点击开始加工后发送给 AI。";
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
    item.workflowData,
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
  const [itemStageAiPrompts, setItemStageAiPrompts] =
    useState<ListingStageAiPromptConfig>(() => readStageAiPrompts(item.title));
  const imagePrompt = itemStageAiPrompts.imageGeneration.prompt;
  const imageModel = useMemo(() => {
    if (typeof window === "undefined") return "浏览器本地模式 / GPT Image 1.5";
    const selected = readImageModelSelection();
    return `浏览器本地模式 / ${selected.modelId}`;
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
    setExpanded(false);
    setSelectedImageIds(selectedImageIdsFromItem(item));
    let active = true;
    void resolveStageAiPrompts(item.title, item).then((prompts) => {
      if (active) setItemStageAiPrompts(prompts);
    });
    return () => {
      active = false;
    };
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
    const primaryImageId = normalizedImages[0]?.id;
    const validSelectedIds = nextSelectedImageIds.filter(
      (id) =>
        id !== primaryImageId &&
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
    const selectedIds = new Set(
      selectedImageIds.filter((id) => id !== images[0]?.id),
    );
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
    if (imagePrompt.trim().length < 4) {
      toast.error("主图生成提示词至少填写 4 个字符");
      return;
    }
    setGeneratingImageId(imageId);
    try {
      const generatedImages = await generateWorkflowImage(
        image,
        item.title,
        undefined,
        normalizeListingStageAiPrompts({
          ...itemStageAiPrompts,
          imageGeneration: {
            ...itemStageAiPrompts.imageGeneration,
            prompt: imagePrompt,
          },
        }),
      );
      updateImages(
        [...generatedImages, ...images],
        {
          manualGeneratedMainImageAt: new Date().toISOString(),
          generatedFromImageId: image.id,
        },
        selectedImageIds,
      );
      setSelectedIndex(0);
      toast.success(
        generatedImages.length === 4
          ? "AI 四宫格已生成并裁成 4 张图片"
          : "AI 主图已生成，并自动放到第一张",
      );
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
    if (imageId === images[0]?.id) {
      toast("主图固定进入加工阶段，无需额外勾选");
      return;
    }
    const nextSelectedIds = selectedImageIds.includes(imageId)
      ? selectedImageIds.filter((id) => id !== imageId)
      : [...selectedImageIds, imageId];
    updateImages(
      images,
      { selectedImagesChangedAt: new Date().toISOString() },
      nextSelectedIds,
    );
  }

  function updateImageGeneration(
    patch: Partial<ListingStageAiPromptConfig["imageGeneration"]>,
  ) {
    setItemStageAiPrompts((current) =>
      normalizeListingStageAiPrompts({
        ...current,
        imageGeneration: {
          ...current.imageGeneration,
          ...patch,
        },
      }),
    );
  }

  async function overwriteRootImagePrompt(
    imageGeneration = itemStageAiPrompts.imageGeneration,
  ) {
    const prompts = normalizeListingStageAiPrompts({
      ...itemStageAiPrompts,
      imageGeneration,
    });
    try {
      await readApi<{ stageAiPrompts: ListingStageAiPromptConfig }>(
        await fetch("/api/listing-workflow/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stageAiPrompts: prompts }),
        }),
      );
      window.localStorage.setItem(
        LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
        JSON.stringify(prompts),
      );
      toast.success("已覆盖全局根提示词");
    } catch {
      toast.error("根提示词保存失败");
    }
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

      {onChange ? (
        <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-400/20 dark:bg-violet-500/[0.08]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <label
                htmlFor={`listing-image-prompt-${item.id}`}
                className="text-sm font-semibold text-slate-900 dark:text-white"
              >
                主图生成提示词（可自由修改）
              </label>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                始终读取最新全局根提示词；修改后离开输入框即覆盖根提示词。
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const imageGeneration = {
                  ...itemStageAiPrompts.imageGeneration,
                  prompt: buildDefaultListingImagePrompt(item.title),
                };
                updateImageGeneration(imageGeneration);
                void overwriteRootImagePrompt(imageGeneration);
              }}
            >
              恢复默认
            </Button>
          </div>
          <Textarea
            id={`listing-image-prompt-${item.id}`}
            aria-label="主图生成提示词"
            value={imagePrompt}
            maxLength={5000}
            onChange={(event) =>
              updateImageGeneration({ prompt: event.target.value })
            }
            onBlur={() => void overwriteRootImagePrompt()}
            className="mt-3 min-h-32 resize-y bg-white text-sm leading-6 dark:bg-black/30"
            placeholder="输入当前商品的主图生成提示词"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <span>画幅</span>
                <select
                  aria-label="主图生成画幅"
                  value={itemStageAiPrompts.imageGeneration.aspectRatio}
                  onChange={(event) =>
                    updateImageGeneration({
                      aspectRatio: event.target
                        .value as ListingStageAiPromptConfig["imageGeneration"]["aspectRatio"],
                    })
                  }
                  className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none dark:border-white/10 dark:bg-black/30 dark:text-white"
                >
                  <option value="1:1">1:1 主图</option>
                  <option value="3:4">3:4 竖图</option>
                  <option value="9:16">9:16 长图</option>
                </select>
              </label>
              <label className="flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-black/30 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={itemStageAiPrompts.imageGeneration.useReference}
                  onChange={(event) =>
                    updateImageGeneration({
                      useReference: event.target.checked,
                    })
                  }
                  className="h-4 w-4"
                />
                使用当前主图作为参考
              </label>
            </div>
            <span
              className={`text-xs ${
                imagePrompt.trim().length < 4
                  ? "text-rose-500"
                  : "text-slate-400"
              }`}
            >
              {imagePrompt.length} / 5000
            </span>
          </div>
        </div>
      ) : null}

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
        selectedImageIds={selectedImageIds}
        initialImageId={dialogInitialImageId}
        imageModelLabel={imageModel}
        generating={Boolean(generatingImageId)}
        ocrReady
        ocrEndpoint="http://127.0.0.1:8010"
        onClose={() => setDialogMode(null)}
        onAddFiles={(files) => void handleAddFiles(files)}
        onDelete={handleDelete}
        onSelectionChange={(nextSelectedImageIds) =>
          updateImages(
            images,
            { selectedImagesChangedAt: new Date().toISOString() },
            nextSelectedImageIds,
          )
        }
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

async function resolveStageAiPrompts(
  title = "",
  _item?: ListingWorkflowItem,
) {
  // 服务端偏好是全局唯一来源。商品中保存的 stageAiPrompts 只是历史快照，
  // 新一轮类目/特征/生图始终读取主页刚保存的最新全局提示词。
  try {
    const preferences = await readApi<{
      stageAiPrompts: ListingStageAiPromptConfig;
    }>(
      await fetch("/api/listing-workflow/preferences", {
        cache: "no-store",
      }),
    );
    const prompts = normalizeListingStageAiPrompts(
      preferences.stageAiPrompts,
    );
    window.localStorage.setItem(
      LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
      JSON.stringify(prompts),
    );
    return prompts;
  } catch {
    try {
      const stored = window.localStorage.getItem(
        LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
      );
      if (stored) {
        return normalizeListingStageAiPrompts(JSON.parse(stored));
      }
    } catch {
      // 继续使用内置默认值。
    }
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

  if (!options.length) {
    return <span className="text-xs text-slate-400">整件商品（无独立 SKU）</span>;
  }

  const validIds = new Set(options.map((option) => option.id));
  const selectedIds =
    selection.mode === "all"
      ? options.map((option) => option.id)
      : selection.selectedSkuIds.filter((id) => validIds.has(id));
  const allSelected = selectedIds.length === options.length;

  function toggleSelectAll() {
    const nextIds = allSelected
      ? []
      : options.map((option) => option.id);
    onChange({
      mode: "multiple",
      selectedSkuId: nextIds[0] || "",
      selectedSkuIds: nextIds,
    });
  }

  return (
    <div className="min-w-72">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-950">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2 dark:border-white/10">
          <span className="text-xs text-slate-500">
            已选 {selectedIds.length}/{options.length}
          </span>
          <button
            type="button"
            onClick={toggleSelectAll}
            className="rounded-md bg-slate-950 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
        </div>
        <div className="max-h-52 space-y-0.5 overflow-y-auto p-1.5">
          {options.map((option) => {
            const checked = selectedIds.includes(option.id);
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
                      ? selectedIds.filter((id) => id !== option.id)
                      : [...selectedIds, option.id];
                    onChange({
                      mode: "multiple",
                      selectedSkuId: nextIds[0] || "",
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
    </div>
  );
}

function skuFeatureDraftsFromItem(item: ListingWorkflowItem) {
  const storedDrafts =
    item.workflowData?.skuFeatureDrafts ?? item.scrapedData.skuFeatureDrafts;
  if (!Array.isArray(storedDrafts)) return [];
  return storedDrafts.flatMap((entry) => {
    const record = asRecord(entry);
    const skuId = imageWorkflowText(record?.skuId);
    if (!record || !skuId) return [];
    return [
      {
        skuId,
        title: imageWorkflowText(record.title),
        specText: imageWorkflowText(record.specText),
        specLine: imageWorkflowText(record.specLine),
        price: imageWorkflowText(record.price),
        stock: imageWorkflowText(record.stock),
        package: Array.isArray(record.package)
          ? (record.package as Array<{ key: string; value: string }>)
          : [],
        features: Array.isArray(record.features)
          ? (record.features as ListingWorkflowFeature[])
          : [],
        status:
          record.status === "matched" ||
          record.status === "review" ||
          record.status === "missing"
            ? record.status
            : "missing",
      } satisfies ListingSkuFeatureDraft,
    ];
  });
}

function selectedSkuOptionsFromItem(item: ListingWorkflowItem) {
  const options = extractProductSkuOptions(item.scrapedData);
  const selection = readItemSkuSelection(item);
  const selectedIds = new Set(selection.selectedSkuIds);
  return options.filter((option) => selectedIds.has(option.id));
}

function skuOfferId(
  item: ListingWorkflowItem,
  skuId: string,
  draft?: ListingSkuFeatureDraft,
) {
  const sellerCode = draft?.features.find(
    (feature) =>
      String(feature.ozonCode || feature.attributeId).replace(/^base:/, "") ===
      "9024",
  )?.value;
  return (
    sellerCode?.trim() ||
    `1688-${item.offerId}-${skuId}`
  ).slice(0, 50);
}

function containsHanText(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

function ozonUploadFeatureText(
  features: ListingWorkflowFeature[] | null | undefined,
  attributeId: string,
) {
  const feature = features?.find(
    (entry) => String(entry.ozonCode || entry.attributeId) === attributeId,
  );
  if (!feature) return "";
  const candidates = [
    ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
    feature.aiJsonValue,
  ];
  return (
    candidates
      .map((value) => String(value ?? "").trim())
      .find((value) => value && !containsHanText(value)) ?? ""
  );
}

function enforceUploadBusinessDefaults(features: ListingWorkflowFeature[]) {
  return features.map((feature) => {
    const hasReturnedValue = [
      ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
      feature.aiJsonValue,
      feature.value,
    ].some((value) => String(value ?? "").trim());
    if (
      hasReturnedValue &&
      (Boolean(feature.aiJsonPath) || /AI|快速模式/i.test(feature.source))
    ) {
      return feature;
    }
    const attributeId = String(feature.ozonCode || feature.attributeId).replace(
      /^base:/,
      "",
    );
    if (attributeId === "23249") {
      const hasValue = [
        ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
        feature.aiJsonValue,
        feature.value,
      ].some((value) => String(value ?? "").trim());
      if (hasValue) return feature;
      return {
        ...feature,
        value: "1",
        aiJsonValue: "1",
        ozonAttributeValues: [{ value: "1" }],
        confidence: Math.max(feature.confidence, 0.94),
        status: "auto" as const,
        source: "业务默认",
        reason: "AI 和来源数据未返回数量时，默认填写 1。",
      };
    }
    if (attributeId !== "23487") return feature;
    return {
      ...feature,
      value: "China",
      aiJsonValue: "China",
      ozonAttributeValues: [{ value: "China" }],
      confidence: Math.max(feature.confidence, 0.94),
      status: "auto" as const,
      source: "业务默认",
      reason: "制造商固定填写 China，并覆盖 AI 返回值。",
    };
  });
}

function buildOzonImportRequest(item: ListingWorkflowItem) {
  const images = workflowImagesToOzonPayload(buildManagedImagesFromItem(item));
  const baseSyncedFeatures = syncBaseFeatures(item.features, item) ?? [];
  const uploadName =
    ozonUploadFeatureText(baseSyncedFeatures, "4180") ||
    ozonUploadFeatureText(baseSyncedFeatures, "9048") ||
    (!containsHanText(item.categoryLabel ?? "")
      ? item.categoryLabel?.trim() ?? ""
      : "") ||
    `Товар ${item.offerId}`;
  const syncedFeatures = enforceUploadBusinessDefaults(baseSyncedFeatures.map((feature) => {
    const id = String(feature.ozonCode || feature.attributeId).replace(
      /^base:/,
      "",
    );
    if (feature.group === "base" && id === "name") {
      return {
        ...feature,
        value: uploadName,
        status: "auto" as const,
        source: "Ozon 俄文名称",
      };
    }
    if (feature.group !== "base" && id === "4180") {
      return {
        ...feature,
        ozonAttributeValues: [{ value: uploadName }],
        aiJsonValue: uploadName,
      };
    }
    return feature;
  }));
  const drafts = skuFeatureDraftsFromItem(item);
  const draftBySkuId = new Map(drafts.map((draft) => [draft.skuId, draft]));
  const selectedSkus = selectedSkuOptionsFromItem(item);
  const variants = selectedSkus.map((sku) => {
    const draft = draftBySkuId.get(sku.id);
    const variantUploadName =
      ozonUploadFeatureText(draft?.features, "4180") ||
      uploadName;
    const variantFeatures = enforceUploadBusinessDefaults(draft?.features ?? []);
    const packageMetrics = deriveOzonPackageMetrics(
      sku.raw,
      variantFeatures,
      item.scrapedData,
    );
    return {
      skuId: sku.id,
      offerId: skuOfferId(item, sku.id, draft),
      ...(variantUploadName ? { name: variantUploadName } : {}),
      images,
      features: variantFeatures,
      ...(packageMetrics ?? {}),
    };
  });
  return {
    features: syncedFeatures,
    images,
    ...(variants.length ? { variants } : {}),
  };
}

const PACKAGE_EDITOR_FIELDS = [
  { id: "depth", label: "包装长度，毫米" },
  { id: "width", label: "包装宽度，毫米" },
  { id: "height", label: "包装高度，毫米" },
  { id: "weight", label: "含包装重量，克" },
] as const;

type PackageEditorFieldId = (typeof PACKAGE_EDITOR_FIELDS)[number]["id"];

function baseFeature(
  features: ListingWorkflowFeature[] | null,
  id: string,
) {
  return features?.find(
    (feature) => feature.group === "base" && baseFeatureId(feature) === id,
  );
}

function upsertBasePackageFeature(
  features: ListingWorkflowFeature[] | null,
  id: PackageEditorFieldId | "dimension_unit" | "weight_unit",
  value: string,
) {
  const existing = baseFeature(features, id);
  const nextFeature: ListingWorkflowFeature = existing
    ? {
        ...existing,
        value,
        source: "人工修改",
        status: value ? "review" : existing.required ? "missing" : "review",
        ozonAttributeValues: undefined,
      }
    : {
        attributeId: `base:${id}`,
        label:
          PACKAGE_EDITOR_FIELDS.find((field) => field.id === id)?.label ??
          (id === "dimension_unit" ? "尺寸单位" : "重量单位"),
        value,
        confidence: 1,
        required: true,
        group: "base",
        ozonCode: id,
        valueType: id.endsWith("_unit") ? "enum" : "number",
        status: value ? "review" : "missing",
        source: "人工修改",
        reason: "在编辑商品卡中填写。",
        dictionaryValueCount: 0,
        options: [],
      };
  return existing
    ? (features ?? []).map((feature) =>
        feature.attributeId === existing.attributeId ? nextFeature : feature,
      )
    : [...(features ?? []), nextFeature];
}

function metricsFromBaseFeatures(
  features: ListingWorkflowFeature[] | null,
) {
  const packageInfo = Object.fromEntries(
    ["depth", "width", "height", "weight", "dimension_unit", "weight_unit"].map(
      (id) => [id, baseFeature(features, id)?.value ?? ""],
    ),
  );
  if (["depth", "width", "height", "weight"].some((id) => !packageInfo[id])) {
    return null;
  }
  return deriveOzonPackageMetrics(
    {
      packageInfo: {
        depth: packageInfo.depth,
        width: packageInfo.width,
        height: packageInfo.height,
        weight: packageInfo.weight,
        dimensionUnit: packageInfo.dimension_unit,
        weightUnit: packageInfo.weight_unit,
      },
    },
  );
}

function editablePackageMetrics(item: ListingWorkflowItem) {
  const baseMetrics = metricsFromBaseFeatures(item.features);
  if (baseMetrics) return baseMetrics;
  const drafts = skuFeatureDraftsFromItem(item);
  const draftBySkuId = new Map(drafts.map((draft) => [draft.skuId, draft]));
  const metrics = selectedSkuOptionsFromItem(item).map((sku) =>
    deriveOzonPackageMetrics(
      sku.raw,
      draftBySkuId.get(sku.id)?.features,
      item.scrapedData,
    ),
  );
  const first = metrics[0];
  if (!first || metrics.some((entry) => JSON.stringify(entry) !== JSON.stringify(first))) {
    return null;
  }
  return first;
}

function withEditablePackageMetrics(item: ListingWorkflowItem) {
  const metrics = editablePackageMetrics(item);
  let features = item.features
    ? enforceUploadBusinessDefaults(item.features)
    : null;
  if (!metrics) return { ...item, features };
  for (const field of PACKAGE_EDITOR_FIELDS) {
    features = upsertBasePackageFeature(
      features,
      field.id,
      String(metrics[field.id]),
    );
  }
  features = upsertBasePackageFeature(features, "dimension_unit", "mm");
  features = upsertBasePackageFeature(features, "weight_unit", "g");
  return { ...item, features };
}

function packageMetricsForSave(
  features: ListingWorkflowFeature[] | null,
): OzonPackageMetrics | null {
  const values = Object.fromEntries(
    PACKAGE_EDITOR_FIELDS.map(({ id }) => [
      id,
      Number(baseFeature(features, id)?.value),
    ]),
  ) as Record<PackageEditorFieldId, number>;
  if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return null;
  }
  return {
    depth: values.depth,
    width: values.width,
    height: values.height,
    weight: values.weight,
    dimensionUnit: "mm",
    weightUnit: "g",
  };
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function ProcessingSkuSummary({ item }: { item: ListingWorkflowItem }) {
  const [open, setOpen] = useState(false);
  const selectedSkus = useMemo(
    () => selectedSkuOptionsFromItem(item),
    [item.scrapedData],
  );
  const drafts = useMemo(
    () => skuFeatureDraftsFromItem(item),
    [item.scrapedData],
  );
  const draftBySkuId = useMemo(
    () => new Map(drafts.map((draft) => [draft.skuId, draft])),
    [drafts],
  );
  if (!selectedSkus.length) return null;

  const matchedCount = selectedSkus.filter(
    (sku) => draftBySkuId.get(sku.id)?.status === "matched",
  ).length;

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-2.5 dark:border-violet-400/20 dark:bg-violet-500/[0.08]">
      <button
        type="button"
        aria-label={`查看 ${selectedSkus.length} 个 SKU 规格`}
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <span className="block text-xs font-semibold text-violet-800 dark:text-violet-200">
            {selectedSkus.length} 个 SKU
          </span>
          <span className="mt-0.5 block text-[11px] text-violet-600/80 dark:text-violet-300/80">
            规格已匹配 {matchedCount}/{selectedSkus.length}
          </span>
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" />
        )}
      </button>
      {open ? (
        <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto border-t border-violet-200 pt-2 dark:border-violet-400/20">
          {selectedSkus.map((sku) => {
            const draft = draftBySkuId.get(sku.id);
            return (
              <div
                key={sku.id}
                className="rounded-lg bg-white/90 p-2 text-[11px] leading-4 dark:bg-black/20"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">
                    {draft?.specLine || sku.specText}
                  </p>
                  <Badge
                    variant={
                      draft?.status === "matched" ? "success" : "warning"
                    }
                    className="shrink-0"
                  >
                    {draft?.status === "matched" ? "已匹配" : "待确认"}
                  </Badge>
                </div>
                <p className="mt-1 text-slate-500">
                  SKU {sku.id} · ¥{draft?.price || sku.price || "-"} · 库存{" "}
                  {draft?.stock || sku.stock || "-"}
                </p>
                {draft?.features.length ? (
                  <div className="mt-2 space-y-1 border-t border-violet-100 pt-2 dark:border-violet-400/10">
                    <p className="font-medium text-violet-700 dark:text-violet-300">
                      {draft.features.length} 个差异属性
                    </p>
                    {draft.features.map((feature, featureIndex) => (
                      <div
                        key={`${draft.skuId}-${feature.attributeId || feature.ozonCode || featureIndex}`}
                        className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2 rounded-md bg-violet-50/80 px-2 py-1 dark:bg-violet-500/10"
                      >
                        <span className="break-words text-slate-500 dark:text-slate-400">
                          {featureDisplayLabel(feature)}
                        </span>
                        <span className="break-words font-medium text-slate-800 dark:text-slate-100">
                          {String(feature.value ?? "").trim() || "待填写"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function CollectedFeatureSummary({
  item,
  onOpen,
}: {
  item: ListingWorkflowItem;
  onOpen: () => void;
}) {
  const categoryFeatures = (item.features ?? []).filter(
    (feature) => feature.group !== "base",
  );
  const filledCount = categoryFeatures.filter((feature) =>
    String(feature.value ?? "").trim(),
  ).length;
  const skuDraftCount = skuFeatureDraftsFromItem(item).length;
  if (!categoryFeatures.length && !skuDraftCount) return null;

  return (
    <button
      type="button"
      className="w-full rounded-xl border border-violet-200 bg-violet-50/70 px-3 py-2 text-left transition hover:border-violet-300 hover:bg-violet-50 dark:border-violet-400/20 dark:bg-violet-500/[0.08] dark:hover:border-violet-400/40"
      onClick={onOpen}
    >
      <span className="block text-xs font-semibold text-violet-800 dark:text-violet-200">
        AI 属性已返回
      </span>
      <span className="mt-0.5 block text-[11px] leading-4 text-violet-600/90 dark:text-violet-300/90">
        公共属性 {categoryFeatures.length} 项，已填写 {filledCount} 项
        {skuDraftCount ? `；SKU 属性 ${skuDraftCount} 组` : ""}，点击查看
      </span>
    </button>
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
    const enteredValue = value.trim();
    const enteredPrice = Number(enteredValue.replace(",", "."));
    const nextValue = field === "currentPrice"
      && enteredValue
      && Number.isFinite(enteredPrice)
      && enteredPrice < 15
      ? "15"
      : enteredValue;
    if (nextValue !== enteredValue) {
      setValue(nextValue);
      toast.info("商品当前价格已按店铺下限调整为 15 元");
    }
    if (nextValue === savedValue) return;
    setSaving(true);
    try {
      const nextItem = {
        ...item,
        [field]: nextValue || null,
      } as ListingWorkflowItem;
      const syncedFeatures = syncBaseFeatures(item.features, nextItem);
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              [field]: nextValue || null,
              features: syncedFeatures,
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
        type="number"
        min={field === "currentPrice" ? 15 : 0}
        step="0.01"
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
  const [draft, setDraft] = useState(() => withEditablePackageMetrics(item));
  const [dirty, setDirty] = useState(false);
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
    if (!dirty) setDraft(withEditablePackageMetrics(item));
  }, [dirty, item]);

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
              const selectedIds = new Set(
                (feature.ozonAttributeValues ?? [])
                  .map((value) => Number(value.dictionary_value_id))
                  .filter((value) => Number.isSafeInteger(value) && value > 0),
              );
              const selectedValues = attribute.values.filter((value) =>
                selectedIds.has(Number(value.ozonValueId)),
              );
              const selectedValue = findMatchedAttributeValue(
                attribute.values,
                feature,
                current.features ?? [],
              );
              const displayValue =
                selectedValues.length > 1
                  ? selectedValues
                      .map((value) => value.valueZh || value.value)
                      .join("、")
                  : selectedValue?.valueZh || feature.value;
              return attribute
                ? {
                    ...feature,
                    displayLabel: attribute.nameZh || attribute.name,
                    value: displayValue,
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
    setDirty(true);
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

  function updatePackageField(id: PackageEditorFieldId, value: string) {
    setDirty(true);
    setDraft((current) => {
      let features = upsertBasePackageFeature(current.features, id, value);
      features = upsertBasePackageFeature(
        features,
        id === "weight" ? "weight_unit" : "dimension_unit",
        id === "weight" ? "g" : "mm",
      );
      return { ...current, features };
    });
  }

  async function save() {
    const editableImagePrompt =
      readStageAiPrompts(draft.title).imageGeneration.prompt;
    if (editableImagePrompt.trim().length < 4) {
      toast.error("主图生成提示词至少填写 4 个字符");
      return;
    }
    setSaving(true);
    try {
      const packageMetrics = packageMetricsForSave(draft.features);
      const packageSyncedDraft = packageMetrics
        ? {
            ...draft,
            scrapedData: applyOzonPackageMetricsToSelectedSkus(
              draft.scrapedData,
              packageMetrics,
              readItemSkuSelection(draft).selectedSkuIds,
            ),
          }
        : draft;
      const imageSyncedDraft = applyManagedImagesToItem(
        packageSyncedDraft,
        buildManagedImagesFromItem(packageSyncedDraft),
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
              workflowData: imageSyncedDraft.workflowData,
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
          <EmbeddedProductGallery
            item={draft}
            onChange={(nextDraft) => {
              setDirty(true);
              setDraft(nextDraft);
            }}
          />

          <ProcessingSkuSummary item={draft} />

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
                    onChange={(event) => {
                      setDirty(true);
                      setDraft((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }));
                    }}
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
              {PACKAGE_EDITOR_FIELDS.map((field) => (
                <label key={field.id} className="min-w-0 space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">
                    {field.label}
                  </span>
                  <Input
                    className="h-8 min-w-0 px-3 text-xs"
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={baseFeature(draft.features, field.id)?.value ?? ""}
                    placeholder="填写大于 0 的整数"
                    onChange={(event) =>
                      updatePackageField(field.id, event.target.value)
                    }
                  />
                </label>
              ))}
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

          <section className="overflow-hidden rounded-[20px] border border-slate-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-black/20">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-950 dark:text-white">
                    AI 返回属性
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    快速模式返回的公共属性会在采集阶段直接显示，修改后会保存到后续 Ozon 上架草稿。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {categoryFeatures.length} 个字段
                  </Badge>
                </div>
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
                  快速模式尚未返回可展示的类目属性。
                </div>
              )}
            </section>
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
  const [featureFillMode, setFeatureFillMode] =
    useState<ListingFeatureFillMode>(DEFAULT_LISTING_FEATURE_FILL_MODE);
  const [savingFeatureFillMode, setSavingFeatureFillMode] = useState(false);
  const [savedProductQuantity, setSavedProductQuantity] = useState(
    DEFAULT_LISTING_PRODUCT_QUANTITY,
  );
  const [warehouseRules, setWarehouseRules] = useState<ListingWarehouseRule[]>(
    () => normalizeListingWarehouseRules(null),
  );
  const [warehouseSettingsOpen, setWarehouseSettingsOpen] = useState(false);
  const [storeSettingsOpen, setStoreSettingsOpen] = useState(false);
  const [activeStoreName, setActiveStoreName] = useState("Ozon 店铺");
  const [ozonStores, setOzonStores] = useState<OzonConnectionState[]>([]);
  const [targetStoreIds, setTargetStoreIds] = useState<string[]>([]);
  const [warehouseQuantityDraft, setWarehouseQuantityDraft] = useState("100");
  const [warehouseRulesDraft, setWarehouseRulesDraft] = useState<
    ListingWarehouseRule[]
  >(() => normalizeListingWarehouseRules(null));
  const [savingWarehouseSettings, setSavingWarehouseSettings] = useState(false);
  const [resolvingWarehouseIds, setResolvingWarehouseIds] = useState(false);
  const [imageBusyIds, setImageBusyIds] = useState<Set<string>>(new Set());
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set());
  const [ozonRepair, setOzonRepair] = useState<OzonErrorRepairResponse | null>(
    null,
  );
  const repairToastStatusRef = useRef<string>("idle");
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
  const selectedFeatureFillMode = useMemo(
    () => listingFeatureFillModeConfig(featureFillMode),
    [featureFillMode],
  );

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
      setEditingItem((current) =>
        current
          ? normalizedItems.find((item) => item.id === current.id) ?? current
          : null,
      );
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

  useEffect(() => {
    if (stage !== "PROCESSING") return;
    let disposed = false;
    const loadRepairState = async () => {
      try {
        const result = await readApi<OzonErrorRepairResponse>(
          await fetch("/api/listing-workflow/ozon-error-repair", {
            cache: "no-store",
          }),
        );
        if (disposed) return;
        setOzonRepair(result);
        const previous = repairToastStatusRef.current;
        repairToastStatusRef.current = result.state.status;
        if (previous === "running" && result.state.status === "completed") {
          toast.success(
            `批量修复完成：修复 ${result.state.repaired} 个，库存更新 ${result.state.stockUpdated} 个`,
          );
          void loadItems({ silent: true });
        } else if (previous === "running" && result.state.status === "failed") {
          toast.error(
            `批量修复结束，成功 ${result.state.repaired} 个，失败 ${result.state.failed} 个`,
          );
          void loadItems({ silent: true });
        }
      } catch {
        // 页面主流程保持可用，下次轮询继续读取。
      }
    };
    void loadRepairState();
    const interval = window.setInterval(loadRepairState, 2500);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [stage]);

  async function startOzonErrorRepair() {
    try {
      const state = await readApi<OzonErrorRepairResponse["state"]>(
        await fetch("/api/listing-workflow/ozon-error-repair", {
          method: "POST",
        }),
      );
      repairToastStatusRef.current = state.status;
      setOzonRepair((current) => ({
        totalUploaded: state.totalUploaded,
        detected: state.detected,
        running: state.status === "running",
        state,
        ...(current && !state.totalUploaded
          ? {
              totalUploaded: current.totalUploaded,
              detected: current.detected,
            }
          : {}),
      }));
      toast.success("已开始扫描并修复 Ozon 中文错误商品");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量修复启动失败");
    }
  }

  useEffect(() => {
    void fetch("/api/ozon/configs", { cache: "no-store" })
      .then((response) =>
        readApi<{
          stores: OzonConnectionState[];
          activeStoreId: string | null;
          activeStoreName: string;
        }>(response),
      )
      .then((result) => {
        setOzonStores(result.stores);
        setActiveStoreName(result.activeStoreName || "Ozon 店铺");
        const validIds = new Set(
          result.stores.flatMap((store) => (store.id ? [store.id] : [])),
        );
        let storedIds: string[] = [];
        try {
          const parsed = JSON.parse(
            window.localStorage.getItem(OZON_TARGET_STORE_IDS_STORAGE_KEY) || "[]",
          );
          storedIds = Array.isArray(parsed)
            ? parsed.map(String).filter((id) => validIds.has(id))
            : [];
        } catch {
          storedIds = [];
        }
        const initialIds = storedIds.length
          ? storedIds
          : result.activeStoreId
            ? [result.activeStoreId]
            : [...validIds].slice(0, 1);
        setTargetStoreIds(initialIds);
      })
      .catch(() => null);
  }, []);

  function updateTargetStoreIds(ids: string[]) {
    const normalized = [...new Set(ids.map(String).filter(Boolean))];
    setTargetStoreIds(normalized);
    window.localStorage.setItem(
      OZON_TARGET_STORE_IDS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  }

  useEffect(() => {
    void fetch("/api/listing-workflow/preferences", { cache: "no-store" })
      .then((response) =>
        readApi<{
          featureFillMode?: ListingFeatureFillMode;
          productQuantity?: number;
          warehouseRules?: ListingWarehouseRule[];
          stageAiPrompts: ListingStageAiPromptConfig;
        }>(response),
      )
      .then((preferences) => {
        setFeatureFillMode(
          normalizeListingFeatureFillMode(preferences.featureFillMode),
        );
        const quantity = normalizeListingProductQuantity(
          preferences.productQuantity,
        );
        const rules = normalizeListingWarehouseRules(
          preferences.warehouseRules,
        );
        setSavedProductQuantity(quantity);
        setWarehouseQuantityDraft(String(quantity));
        setWarehouseRules(rules);
        setWarehouseRulesDraft(rules.map((rule) => ({ ...rule })));
        const prompts = normalizeListingStageAiPrompts(
          preferences.stageAiPrompts,
        );
        window.localStorage.setItem(
          LISTING_STAGE_AI_PROMPT_STORAGE_KEY,
          JSON.stringify(prompts),
        );
      })
      .catch(() => null);
  }, []);

  async function saveFeatureFillMode(nextMode: ListingFeatureFillMode) {
    const previousMode = featureFillMode;
    setFeatureFillMode(nextMode);
    setSavingFeatureFillMode(true);
    try {
      const saved = await readApi<{
        featureFillMode: ListingFeatureFillMode;
      }>(
        await fetch("/api/listing-workflow/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ featureFillMode: nextMode }),
        }),
      );
      const normalized = normalizeListingFeatureFillMode(
        saved.featureFillMode,
      );
      setFeatureFillMode(normalized);
      toast.success(
        `属性模式已切换为${listingFeatureFillModeConfig(normalized).label}`,
      );
    } catch (error) {
      setFeatureFillMode(previousMode);
      toast.error(
        error instanceof Error ? error.message : "属性模式保存失败",
      );
    } finally {
      setSavingFeatureFillMode(false);
    }
  }

  function openWarehouseSettings() {
    setWarehouseQuantityDraft(String(savedProductQuantity));
    setWarehouseRulesDraft(warehouseRules.map((rule) => ({ ...rule })));
    setWarehouseSettingsOpen(true);
  }

  function updateWarehouseRule(
    ruleId: string,
    patch: Partial<ListingWarehouseRule>,
  ) {
    setWarehouseRulesDraft((current) =>
      current.map((rule) =>
        rule.id === ruleId
          ? {
              ...rule,
              ...patch,
              ...(patch.warehouseName !== undefined
                ? { warehouseId: null }
                : {}),
            }
          : rule,
      ),
    );
  }

  async function resolveWarehouseIds() {
    setResolvingWarehouseIds(true);
    try {
      const result = await readApi<{
        warehouses: Array<{ id: string; name: string }>;
      }>(
        await fetch("/api/ozon/warehouses", { cache: "no-store" }),
      );
      const normalizedName = (value: string) =>
        value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      let matchedCount = 0;
      const nextRules = warehouseRulesDraft.map((rule) => {
        const matches = result.warehouses.filter(
          (warehouse) =>
            normalizedName(warehouse.name) ===
            normalizedName(rule.warehouseName),
        );
        if (matches.length !== 1) return { ...rule, warehouseId: null };
        matchedCount += 1;
        return { ...rule, warehouseId: matches[0].id };
      });
      setWarehouseRulesDraft(nextRules);
      if (matchedCount === nextRules.length) {
        toast.success("全部仓库名称已匹配到ID，保存后将永久记录");
      } else {
        toast.warning(
          `已匹配 ${matchedCount}/${nextRules.length} 个仓库；未匹配项请核对店铺中的完整仓库名称`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "仓库ID匹配失败",
      );
    } finally {
      setResolvingWarehouseIds(false);
    }
  }

  async function saveWarehouseSettings() {
    const quantity = Number(warehouseQuantityDraft);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      quantity > 999_999
    ) {
      toast.error("商品数量应填写 0 到 999999 之间的整数");
      return;
    }
    const invalidRule = warehouseRulesDraft.find(
      (rule) =>
        !rule.warehouseName.trim() ||
        rule.minWeightGrams > rule.maxWeightGrams ||
        rule.minPriceCny > rule.maxPriceCny,
    );
    if (invalidRule) {
      toast.error(`请检查“${invalidRule.logisticsGroup}”的仓库名称和区间`);
      return;
    }
    setSavingWarehouseSettings(true);
    try {
      const saved = await readApi<{
        productQuantity: number;
        warehouseRules: ListingWarehouseRule[];
      }>(
        await fetch("/api/listing-workflow/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productQuantity: quantity,
            warehouseRules: warehouseRulesDraft,
          }),
        }),
      );
      setSavedProductQuantity(saved.productQuantity);
      setWarehouseRules(
        normalizeListingWarehouseRules(saved.warehouseRules),
      );
      setWarehouseSettingsOpen(false);
      toast.success("仓库设置已永久保存");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "仓库设置保存失败",
      );
    } finally {
      setSavingWarehouseSettings(false);
    }
  }

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

  function markPublishing(itemId: string, busy: boolean) {
    setPublishingIds((current) => {
      const next = new Set(current);
      if (busy) next.add(itemId);
      else next.delete(itemId);
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
    const previousStatus = imageWorkflowText(previousWorkflow.status);
    const patchRunId = imageWorkflowText(workflowPatch.runId);
    const preserveTerminalState =
      ["done", "partial", "failed"].includes(previousStatus) &&
      (!patchRunId || patchRunId === imageWorkflowText(previousWorkflow.runId));
    const safeWorkflowPatch = preserveTerminalState
      ? {
          ...workflowPatch,
          status: previousWorkflow.status,
          phase: previousWorkflow.phase,
          error: previousWorkflow.error,
          finishedAt: previousWorkflow.finishedAt,
        }
      : workflowPatch;
    return patchWorkflowItem(itemId, {
      workflowData: {
        ...(latest.workflowData ?? {}),
        imageWorkflow: {
          ...previousWorkflow,
          ...safeWorkflowPatch,
          updatedAt: new Date().toISOString(),
        },
      },
    });
  }

  async function publishToOzon(item: ListingWorkflowItem) {
    markPublishing(item.id, true);
    try {
      // 点击按钮时价格输入框会先触发 blur 保存；稍候并重新读取服务端记录，
      // 避免使用点击前的旧价格快照进行预检。
      await delay(150);
      const latestItem = await fetchWorkflowItem(item.id);
      const requestBody = buildOzonImportRequest(latestItem);
      const preview = await readApi<{ errors: string[]; warnings: string[] }>(
        await fetch("/api/listing-workflow/ozon-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", ...requestBody }),
        }),
      );
      if (preview.errors.length) {
        throw new Error(`上架预检失败：${preview.errors.join("；")}`);
      }

      const storeIds = targetStoreIds.filter((id) =>
        ozonStores.some((store) => store.id === id),
      );
      if (!storeIds.length) {
        throw new Error("请先在店铺管理中勾选至少一个上架目标店铺。");
      }
      const storeById = new Map(
        ozonStores.flatMap((store) => (store.id ? [[store.id, store] as const] : [])),
      );
      const publishResults = await Promise.allSettled(
        storeIds.map(async (configId) => {
          const storeName = storeById.get(configId)?.name || configId;
          const submitted = await readApi<OzonImportSubmitResponse>(
            await fetch("/api/listing-workflow/ozon-import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "submit",
                confirmed: true,
                configId,
                ...requestBody,
              }),
            }),
          );
          let status: OzonImportStatusResponse | null = null;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await delay(attempt === 0 ? 2500 : 3000);
            status = await readApi<OzonImportStatusResponse>(
              await fetch("/api/listing-workflow/ozon-import-status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId: submitted.taskId, configId }),
              }),
            );
            if (status.terminal) break;
          }
          return {
            configId,
            storeName,
            taskId: submitted.taskId,
            submittedAt: submitted.submittedAt || new Date().toISOString(),
            status: status?.terminal
              ? status.failed > 0
                ? "failed"
                : "imported"
              : "processing",
            imported: status?.imported ?? 0,
            failed: status?.failed ?? 0,
            pending: status?.pending ?? 0,
            items: status?.items ?? [],
            warnings: submitted.warnings ?? preview.warnings,
          };
        }),
      );
      const completed = publishResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failedStores = publishResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [{
              configId: storeIds[index],
              storeName: storeById.get(storeIds[index])?.name || storeIds[index],
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            }]
          : [],
      );
      if (!completed.length) {
        throw new Error(
          `所有目标店铺提交失败：${failedStores
            .map((entry) => `${entry.storeName}：${entry.error}`)
            .join("；")}`,
        );
      }
      const latest = await fetchWorkflowItem(item.id);
      await patchWorkflowItem(item.id, {
        workflowData: {
          ...(latest.workflowData ?? {}),
          ozonPublish: {
            status: failedStores.length
              ? "partial"
              : completed.some((entry) => entry.status === "processing")
                ? "processing"
                : completed.some((entry) => entry.status === "failed")
                  ? "failed"
                  : "imported",
            storeIds,
            stores: [...completed, ...failedStores.map((entry) => ({
              ...entry,
              status: "submit_failed",
            }))],
            taskId: completed[0]?.taskId,
            submittedAt: completed[0]?.submittedAt,
            checkedAt: new Date().toISOString(),
            imported: completed.reduce((sum, entry) => sum + entry.imported, 0),
            failed: completed.reduce((sum, entry) => sum + entry.failed, 0),
            pending: completed.reduce((sum, entry) => sum + entry.pending, 0),
          },
        },
      });
      if (failedStores.length) {
        toast.error(
          `已提交 ${completed.length}/${storeIds.length} 个店铺；失败：${failedStores
            .map((entry) => entry.storeName)
            .join("、")}`,
        );
      } else {
        toast.success(
          `已并行提交到 ${completed.length} 个店铺，共导入 ${completed.reduce(
            (sum, entry) => sum + entry.imported,
            0,
          )} 个 SKU`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上架到店铺失败");
    } finally {
      markPublishing(item.id, false);
    }
  }

  async function startProcessingWorkflowForItem(
    item: ListingWorkflowItem,
    options?: { silent?: boolean },
  ) {
    const allImages = buildManagedImagesFromItem(item).slice(
      0,
      WORKFLOW_IMAGE_LIMIT,
    );
    // 重跑加工时第一张可能已经是上一轮 AI 主图；继续拿它做参考会反复改图。
    // 优先回到采集图/上传原图，仍把新结果写回列表第一张。
    const mainImage =
      allImages.find(
        (image) => image.source === "crawler" || image.source === "upload",
      ) ??
      allImages.find((image) => image.source !== "generated") ??
      allImages[0] ??
      null;
    const selectedIds = new Set(selectedImageIdsFromItem(item));
    const translationImages = allImages.filter(
      (image, index) => index > 0 && selectedIds.has(image.id),
    );
    const runId = `processing-run:${Date.now()}:${simpleStableHash(item.id)}`;
    const startedAt = new Date().toISOString();
    const queuedAt =
      imageWorkflowText(imageWorkflowState(item).status) === "queued"
        ? imageWorkflowText(imageWorkflowState(item).queuedAt) || startedAt
        : startedAt;
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
          { itemId: item.id, runId },
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
          images: [] as ManagedWorkflowImage[],
          image: null as ManagedWorkflowImage | null,
        };
      }
      try {
        const prompts = await resolveStageAiPrompts(item.title, item);
        const generatedImages = await generateWorkflowImage(
          mainImage,
          item.title,
          {
            itemId: item.id,
            runId,
          },
          prompts,
        );
        const generated = generatedImages[0];
        if (!generated) throw new Error("四宫格生图没有返回图片");
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          generationStatus: "done",
          generatedImageId: generated.id,
          generatedImageUrl: generated.url,
          generatedImageIds: generatedImages.map((image) => image.id),
          generatedImageUrls: generatedImages.map((image) => image.url),
          generatedGridCount: generatedImages.length,
          autoGeneratedMainImageAt: new Date().toISOString(),
          autoImageWorkflowNotes: noteSnapshot(),
        });
        return {
          status: "done" as ImageWorkflowSubStatusValue,
          images: generatedImages,
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
          images: [] as ManagedWorkflowImage[],
          image: null as ManagedWorkflowImage | null,
        };
      }
    };

    const runFeatureTask = async () => {
      const aiResponseRecord = asRecord(item.aiResponse) ?? {};

      try {
        const featureResult = await readApi<FeatureDraftResponse>(
          await fetch("/api/listing-workflow/quick-match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scrapedData: currentFeatureInputData(item),
              providerId: LISTING_QUICK_MODE_PROVIDER_ID,
              model: LISTING_QUICK_MODE_MODEL_ID,
              featureFillMode: selectedFeatureFillMode.id,
              workflowItemId: item.id,
              workflowRunId: runId,
            }),
          }),
        );
        const matchedCategory = featureResult.category ?? null;
        const features =
          syncBaseFeatures(featureResult.features, item) ??
          featureResult.features;
        const success = Boolean(matchedCategory && featureResult.aiStatus.ok);
        const status: ImageWorkflowSubStatusValue = success ? "done" : "failed";
        if (!success) {
          notes.push(`特征匹配提醒：${featureResult.aiStatus.message}`);
        }
        const aiResponse = {
          ...aiResponseRecord,
          ...(featureResult.aiResponse ?? {}),
        };
        await queueWorkflowPatch({
          runId,
          status: "running",
          phase: "parallel",
          featureStatus: status,
          featureError: success
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
          category: matchedCategory,
          variantFeatures: featureResult.variantFeatures ?? [],
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
          category: null,
          variantFeatures: [] as ListingSkuFeatureDraft[],
        };
      }
    };

    markImageBusy(item.id, true);
    try {
      await patchWorkflowItem(item.id, {
        status: "AI_RUNNING",
        workflowData: {
          ...(item.workflowData ?? {}),
          imageWorkflow: {
            ...imageWorkflowState(item),
            runId,
            queuedAt,
            status: "running",
            phase: "parallel",
            totalImages: allImages.length,
            translationTotalImages: translationImages.length,
            translatedCount: 0,
            translatedSuccessCount: 0,
            translationFailedCount: 0,
            translationSkippedCount: 0,
            translatedSourceImageIds: [],
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
        toast(
          `加工已开始：选中 SKU + “${selectedFeatureFillMode.label}”Skill、主图生图、选中图片翻译并行运行。`,
        );
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
      const generatedImages = generationResult.images;
      const processedImages = [
        ...(generatedImages.length ? generatedImages : allImages.slice(0, 1)),
        ...allImages
          .slice(1)
          .map((image) => translatedBySourceId.get(image.id) ?? image),
      ].slice(0, WORKFLOW_IMAGE_LIMIT);
      const nextSelectedImageIds = [
        ...new Set([
          ...generatedImages.map((image) => image.id),
          ...translationImages.map(
            (image) => translatedBySourceId.get(image.id)?.id ?? image.id,
          ),
        ]),
      ].filter((id) => processedImages.some((image) => image.id === id));
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
          totalImages: processedImages.length,
          translationTotalImages: translationImages.length,
          translatedCount: translationResult.outputs.length,
          translatedSuccessCount: translationResult.outputs.length,
          translationFailedCount: translationResult.failedCount,
          translationSkippedCount: 0,
          translationStatus: translationResult.status,
          generationStatus: generationResult.status,
          featureStatus: featureResult.status,
          autoTranslatedAt: translationImages.length ? finishedAt : null,
          autoGeneratedMainImageAt: generatedImages.length
            ? finishedAt
            : null,
          autoFeatureMatchedAt: featureOk ? finishedAt : null,
          generatedImageId: generationResult.image?.id ?? null,
          generatedImageUrl: generationResult.image?.url ?? null,
          generatedImageIds: generatedImages.map((image) => image.id),
          generatedImageUrls: generatedImages.map((image) => image.url),
          generatedGridCount: generatedImages.length,
          autoImageWorkflowNotes: noteSnapshot(),
          error: finalStatus === "failed" ? notes[0] ?? "加工失败" : null,
          startedAt,
          finishedAt,
        },
        nextSelectedImageIds,
      );
      const nextWorkflowData = featureResult.variantFeatures.length
        ? {
            ...(nextItem.workflowData ?? {}),
            skuFeatureDrafts: featureResult.variantFeatures,
            skuFeatureDraftsUpdatedAt: finishedAt,
          }
        : nextItem.workflowData;
      await patchWorkflowItem(item.id, {
        status: featureOk ? "MATCHED" : "AI_FAILED",
        categoryId: featureResult.category?.id ?? null,
        categoryLabel: featureResult.category?.label ?? null,
        categoryPath: featureResult.category?.path ?? null,
        workflowData: nextWorkflowData,
        imageUrl: nextItem.imageUrl,
        features: nextItem.features,
        aiResponse: featureResult.aiResponse,
        notes: featureResult.featureNotes,
      });

      if (!options?.silent) {
        if (finalStatus === "done") {
          toast.success("加工已完成");
        } else {
          toast.warning(`加工结束，共有 ${notes.length} 条提醒`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "加工失败";
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
    const selectedSkuIds =
      selection.mode === "all"
        ? options.map((option) => option.id)
        : selection.selectedSkuIds.filter((id) =>
            options.some((option) => option.id === id),
          );
    try {
      const saved = normalizeItem(
        await readApi<ListingWorkflowItem>(
          await fetch(`/api/listing-workflow/items/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workflowData: {
                ...(item.workflowData ?? {}),
                skuSelection: {
                  mode: selection.mode,
                  selectedSkuIds,
                  selectedCount: selectedSkuIds.length,
                  totalCount: options.length,
                },
              },
            }),
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

  async function runQuickModeForItem(
    item: ListingWorkflowItem,
    source: "collection" | "processing",
  ) {
    const currentAiResponse = asRecord(item.aiResponse) ?? {};
    const runId = `${source}-quick:${item.id}:${Date.now()}`;
    const completedAt = () => new Date().toISOString();
    setBusyId(item.id);
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id
          ? { ...entry, status: "AI_RUNNING" as const }
          : entry,
      ),
    );
    try {
      const matchingItem = await patchWorkflowItem(item.id, {
        status: "AI_RUNNING",
        aiResponse: {
          ...currentAiResponse,
          categoryMatch: {
            ...asRecord(currentAiResponse.categoryMatch),
            providerId: LISTING_QUICK_MODE_PROVIDER_ID,
            model: LISTING_QUICK_MODE_MODEL_ID,
            runId,
            status: "running",
            startedAt: completedAt(),
          },
          quickMode: {
            ...asRecord(currentAiResponse.quickMode),
            providerId: LISTING_QUICK_MODE_PROVIDER_ID,
            model: LISTING_QUICK_MODE_MODEL_ID,
            mode: selectedFeatureFillMode.id,
            modeLabel: selectedFeatureFillMode.label,
            prompt: selectedFeatureFillMode.prompt,
            runId,
            status: "running",
            startedAt: completedAt(),
          },
        },
        notes: categoryMatchNotes(
          item.notes,
          `正在上传商品 JSON 并运行${selectedFeatureFillMode.label}`,
        ),
      });
      const scrapedData = {
        ...currentFeatureInputData(matchingItem),
        title: matchingItem.title,
        price:
          matchingItem.costPrice ||
          matchingItem.currentPrice ||
          matchingItem.minPrice ||
          "",
        imageUrl: matchingItem.imageUrl || "",
      };
      const result = await readApi<FeatureDraftResponse>(
        await fetch("/api/listing-workflow/quick-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scrapedData,
            providerId: LISTING_QUICK_MODE_PROVIDER_ID,
            model: LISTING_QUICK_MODE_MODEL_ID,
            featureFillMode: selectedFeatureFillMode.id,
          }),
        }),
      );
      const matchedCategory = result.category ?? null;
      const resultAiResponse = asRecord(result.aiResponse) ?? {};
      const nextItemForBase = {
        ...matchingItem,
        categoryId: matchedCategory?.id ?? matchingItem.categoryId,
        categoryLabel: matchedCategory?.label ?? matchingItem.categoryLabel,
        categoryPath: matchedCategory?.path ?? matchingItem.categoryPath,
      };
      const nextFeatures = result.features?.length
        ? syncBaseFeatures(result.features, nextItemForBase) ?? result.features
        : matchingItem.features;
      const doneAt = completedAt();
      const success = Boolean(matchedCategory && result.aiStatus.ok);
      const saved = normalizeItem(
        await patchWorkflowItem(item.id, {
          status: success ? "MATCHED" : "AI_FAILED",
          categoryId: matchedCategory?.id ?? null,
          categoryLabel: matchedCategory?.label ?? null,
          categoryPath: matchedCategory?.path ?? null,
          features: nextFeatures,
          workflowData: {
            ...(matchingItem.workflowData ?? {}),
            ...(Array.isArray(result.variantFeatures)
              ? {
                skuFeatureDrafts: result.variantFeatures,
                skuFeatureDraftsUpdatedAt: doneAt,
                }
              : {}),
            imageWorkflow: {
              ...imageWorkflowState(matchingItem),
              featureStatus: success ? "done" : "failed",
              featureError: success ? null : result.aiStatus.message,
              autoFeatureMatchedAt: doneAt,
              updatedAt: doneAt,
            },
          },
          aiResponse: {
            ...currentAiResponse,
            ...resultAiResponse,
            categoryMatch: {
              ...asRecord(resultAiResponse.categoryMatch),
              providerId: LISTING_QUICK_MODE_PROVIDER_ID,
              model: LISTING_QUICK_MODE_MODEL_ID,
              runId,
              status: matchedCategory ? "matched" : "failed",
              preparedProduct: result.preparedProduct ?? {},
              completedAt: doneAt,
            },
            quickMode: {
              ...asRecord(resultAiResponse.quickMode),
              providerId: LISTING_QUICK_MODE_PROVIDER_ID,
              model: LISTING_QUICK_MODE_MODEL_ID,
              runId,
              status: success ? "done" : "failed",
              completedAt: doneAt,
            },
          },
          notes: categoryMatchNotes(
            result.notes,
            matchedCategory
              ? `快速模式已一次返回 ${matchedCategory.label} 的类目和特征`
              : result.aiStatus.message,
          ),
        }),
      );
      setItems((current) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry)),
      );
      if (success) {
        toast.success(
          `快速模式完成：${matchedCategory?.label}，类目和特征已同步`,
        );
      } else {
        toast.warning(result.aiStatus.message);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "快速模式请求异常";
      try {
        const latest = await fetchWorkflowItem(item.id);
        const aiResponse = asRecord(latest.aiResponse) ?? {};
        await patchWorkflowItem(item.id, {
          status: "AI_FAILED",
          workflowData: {
            ...(latest.workflowData ?? {}),
            imageWorkflow: {
              ...imageWorkflowState(latest),
              featureStatus: "failed",
              featureError: message,
              updatedAt: completedAt(),
            },
          },
          aiResponse: {
            ...aiResponse,
            categoryMatch: {
              ...asRecord(aiResponse.categoryMatch),
              providerId: LISTING_QUICK_MODE_PROVIDER_ID,
              model: LISTING_QUICK_MODE_MODEL_ID,
              runId,
              status: "failed",
              error: message,
              completedAt: completedAt(),
            },
            quickMode: {
              ...asRecord(aiResponse.quickMode),
              providerId: LISTING_QUICK_MODE_PROVIDER_ID,
              model: LISTING_QUICK_MODE_MODEL_ID,
              runId,
              status: "failed",
              error: message,
              completedAt: completedAt(),
            },
          },
          notes: categoryMatchNotes(latest.notes, message),
        });
      } catch {
        // 列表轮询会恢复服务端的最新商品状态。
      }
      toast.error(message);
    } finally {
      setBusyId(null);
    }
  }

  async function moveToProcessing(item: ListingWorkflowItem) {
    if (item.status === "AI_RUNNING") {
      toast.warning("当前商品正在加工，请稍候");
      return;
    }
    setBusyId(item.id);
    try {
      const options = extractProductSkuOptions(item.scrapedData);
      const selection =
        skuSelections[item.id] ?? readItemSkuSelection(item);
      const selectedSkuIds =
        selection.mode === "all"
          ? options.map((option) => option.id)
          : selection.selectedSkuIds.filter((skuId) =>
              options.some((option) => option.id === skuId),
            );
      if (options.length && !selectedSkuIds.length) {
        throw new Error("请至少勾选一个 SKU");
      }
      const selectedSku =
        selectedSkuIds.length === 1
          ? options.find((option) => option.id === selectedSkuIds[0])
          : null;
      const preparedItem: ListingWorkflowItem = {
        ...item,
        workflowData: {
          ...(item.workflowData ?? {}),
          skuSelection: {
            mode: "multiple",
            selectedSkuIds,
            selectedCount: selectedSkuIds.length,
            totalCount: options.length,
          },
        },
        ...(selectedSku?.price ? { costPrice: selectedSku.price } : {}),
      };
      const sourceImages = buildManagedImagesFromItem(preparedItem).slice(
        0,
        WORKFLOW_IMAGE_LIMIT,
      );
      const selectedIds = new Set(selectedImageIdsFromItem(preparedItem));
      const {
        processingImages,
        selectedAdditionalImageIds,
      } = processingImagesFromCollection(sourceImages, [...selectedIds]);
      const translationImageCount = selectedAdditionalImageIds.length;
      const imageSyncedItem = processingImages.length
        ? applyManagedImagesToItem(
            preparedItem,
            processingImages,
            {
              status: "queued",
              phase: "queued",
              translationStatus: translationImageCount
                ? "queued"
                : "skipped",
              generationStatus: "queued",
              featureStatus: "queued",
              totalImages: processingImages.length,
              translationTotalImages: translationImageCount,
              translatedCount: 0,
              translatedSuccessCount: 0,
              translationFailedCount: 0,
              translationSkippedCount: 0,
              sourceImageSignature: imageWorkflowSignature(processingImages),
              autoImageWorkflowNotes: [],
              queuedAt: new Date().toISOString(),
            },
            selectedAdditionalImageIds,
          )
        : preparedItem;
      toast(
        `即将发送 ${selectedSkuIds.length || 1} 个 SKU 和“${selectedFeatureFillMode.label}”Skill 描述，并启动主图生图与 ${translationImageCount} 张图片翻译。`,
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
            workflowData: imageSyncedItem.workflowData,
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
          ? selectedSkuIds.length === 1
            ? `已选择 SKU“${selectedSku?.specText || selectedSkuIds[0]}”并加入加工阶段`
            : `已选择 ${selectedSkuIds.length} 个 SKU 并加入加工阶段`
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
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-300">
              <span>属性 Skill</span>
              <select
                aria-label="属性填写模式"
                value={featureFillMode}
                disabled={savingFeatureFillMode || Boolean(busyId)}
                className="bg-transparent text-sm font-semibold text-slate-900 outline-none dark:text-white"
                onChange={(event) =>
                  void saveFeatureFillMode(
                    normalizeListingFeatureFillMode(event.target.value),
                  )
                }
              >
                {LISTING_FEATURE_FILL_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
              {savingFeatureFillMode ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
            </label>
            <Button variant="outline" onClick={() => setStoreSettingsOpen(true)}>
              <Store className="mr-2 h-4 w-4" />
              店铺管理：已选 {targetStoreIds.length}/{ozonStores.length}
            </Button>
            <Button variant="outline" onClick={openWarehouseSettings}>
              <Store className="mr-2 h-4 w-4" />
              仓库设置
            </Button>
            {stage === "PROCESSING" ? (
              <Button
                variant="outline"
                onClick={() => void startOzonErrorRepair()}
                disabled={ozonRepair?.state.status === "running"}
                title="扫描已上传商品，修复中文名称和属性，并按仓库设置更新库存"
              >
                {ozonRepair?.state.status === "running" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="mr-2 h-4 w-4" />
                )}
                {ozonRepair?.state.status === "running"
                  ? ozonRepair.state.processed >= ozonRepair.state.totalUploaded &&
                    ozonRepair.state.stockPending > 0
                    ? `等待审核 ${ozonRepair.state.stockUpdated}/${ozonRepair.state.totalUploaded}`
                    : `修复中 ${ozonRepair.state.processed}/${ozonRepair.state.totalUploaded}`
                  : `错误商品一键修复${ozonRepair?.detected ? ` (${ozonRepair.detected})` : ""}`}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void loadItems()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
          </div>
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
                      <th className="w-96 px-4 py-4">本次加工 SKU</th>
                    ) : null}
	                    <th
	                      className={
	                        stage === "PROCESSING"
	                          ? "w-72 px-4 py-4"
	                          : "w-[420px] px-4 py-4"
	                      }
	                    >
	                      {stage === "PROCESSING" ? "加工状态" : "操作"}
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
                              readItemSkuSelection(item)
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
	                            <ProcessingSkuSummary item={item} />
	                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <div className="w-full space-y-1.5">
                              <Badge variant={statusVariant(item)}>
                                {listingItemStatusLabel(item.status)}
                              </Badge>
                              <p className="line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                                {categoryMatchHint(item)}
                              </p>
                              <CollectedFeatureSummary
                                item={item}
                                onOpen={() => setEditingItem(item)}
                              />
                            </div>
                            <Button
                              size="sm"
                              onClick={() => void moveToProcessing(item)}
	                              disabled={
	                                item.status === "AI_RUNNING" ||
	                                busyId === item.id ||
	                                imageBusyIds.has(item.id) ||
	                                imageWorkflowIsRunning(item)
                              }
                              title={`进入加工阶段，发送选中 SKU 和“${selectedFeatureFillMode.label}”Skill 描述`}
                            >
                              {busyId === item.id ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <ArrowRight className="mr-1.5 h-4 w-4" />
                              )}
                              开始加工
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
	                              onClick={() => void publishToOzon(item)}
	                              disabled={
	                                publishingIds.has(item.id) ||
	                                imageBusyIds.has(item.id) ||
	                                imageWorkflowIsRunning(item)
	                              }
	                            >
	                              {publishingIds.has(item.id) ? (
	                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
	                              ) : (
	                                <Store className="mr-1.5 h-4 w-4" />
	                              )}
	                              {publishingIds.has(item.id)
	                                ? "正在上架"
	                                : `上架到 ${targetStoreIds.length || 0} 个店铺`}
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
	                                ? "加工中"
	                                : "重跑加工"}
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

      {storeSettingsOpen ? (
        <div className="fixed inset-0 z-[125] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="max-h-[92dvh] w-full max-w-6xl overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-white/10">
              <div>
                <h2 className="text-xl font-semibold text-slate-950 dark:text-white">
                  Ozon Seller 店铺管理
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  多个店铺同时保留，并可多选为上架目标；默认店铺只用于未指定店铺的旧功能。
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭店铺管理"
                onClick={() => setStoreSettingsOpen(false)}
                className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(92dvh-100px)] overflow-auto px-6 py-5">
              <OzonStoreManager
                onActiveStoreChange={(store) => setActiveStoreName(store.name)}
                selectedStoreIds={targetStoreIds}
                onSelectedStoreIdsChange={updateTargetStoreIds}
                onStoresChange={(stores) => {
                  setOzonStores(stores);
                  const validIds = new Set(
                    stores.flatMap((store) => (store.id ? [store.id] : [])),
                  );
                  setTargetStoreIds((current) => {
                    const normalized = current.filter((id) => validIds.has(id));
                    window.localStorage.setItem(
                      OZON_TARGET_STORE_IDS_STORAGE_KEY,
                      JSON.stringify(normalized),
                    );
                    return normalized;
                  });
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {warehouseSettingsOpen ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="max-h-[92dvh] w-full max-w-6xl overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-white/10">
              <div>
                <h2 className="text-xl font-semibold text-slate-950 dark:text-white">
                  仓库设置
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  按包装后重量与人民币售价匹配仓库；仓库ID匹配成功后永久保存。
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭仓库设置"
                onClick={() => setWarehouseSettingsOpen(false)}
                disabled={savingWarehouseSettings}
                className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[calc(92dvh-150px)] overflow-auto px-6 py-5">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-4 rounded-2xl bg-slate-50 p-4 dark:bg-white/[0.04]">
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium text-slate-500">
                    每个 SKU 的默认上货数量
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={999999}
                    step={1}
                    value={warehouseQuantityDraft}
                    onChange={(event) =>
                      setWarehouseQuantityDraft(event.target.value)
                    }
                    className="w-40"
                  />
                </label>
                <Button
                  variant="outline"
                  onClick={() => void resolveWarehouseIds()}
                  disabled={resolvingWarehouseIds || savingWarehouseSettings}
                >
                  {resolvingWarehouseIds ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  匹配仓库ID
                </Button>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-white/10">
                <table className="w-full min-w-[1080px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold text-slate-500 dark:bg-white/[0.04]">
                    <tr>
                      <th className="px-4 py-3">Ozon物流组</th>
                      <th className="px-3 py-3">最小重量(g)</th>
                      <th className="px-3 py-3">最大重量(g)</th>
                      <th className="px-3 py-3">最低售价(¥)</th>
                      <th className="px-3 py-3">最高售价(¥)</th>
                      <th className="px-3 py-3">仓库名称</th>
                      <th className="px-4 py-3">仓库ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {warehouseRulesDraft.map((rule) => (
                      <tr
                        key={rule.id}
                        className="border-t border-slate-200 dark:border-white/10"
                      >
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                          {rule.logisticsGroup}
                        </td>
                        {(
                          [
                            ["minWeightGrams", rule.minWeightGrams],
                            ["maxWeightGrams", rule.maxWeightGrams],
                            ["minPriceCny", rule.minPriceCny],
                            ["maxPriceCny", rule.maxPriceCny],
                          ] as const
                        ).map(([field, value]) => (
                          <td key={field} className="px-2 py-3">
                            <Input
                              type="number"
                              min={0}
                              step={field.includes("Price") ? 0.01 : 1}
                              value={value}
                              onChange={(event) =>
                                updateWarehouseRule(rule.id, {
                                  [field]: Number(event.target.value),
                                })
                              }
                              className="h-9 w-28"
                            />
                          </td>
                        ))}
                        <td className="px-2 py-3">
                          <Input
                            value={rule.warehouseName}
                            onChange={(event) =>
                              updateWarehouseRule(rule.id, {
                                warehouseName: event.target.value,
                              })
                            }
                            className="h-9 w-36"
                          />
                        </td>
                        <td className="px-4 py-3">
                          {rule.warehouseId ? (
                            <div>
                              <Badge variant="success">已匹配</Badge>
                              <p className="mt-1 break-all text-xs text-slate-500">
                                {rule.warehouseId}
                              </p>
                            </div>
                          ) : (
                            <Badge>未匹配</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                自动预填自 ozon.xlsx。修改仓库名称后需要重新匹配ID；名称必须与 Ozon 店铺仓库名称完全一致。
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4 dark:border-white/10">
              <Button
                variant="outline"
                onClick={() => setWarehouseSettingsOpen(false)}
                disabled={savingWarehouseSettings}
              >
                取消
              </Button>
              <Button
                onClick={() => void saveWarehouseSettings()}
                disabled={savingWarehouseSettings || resolvingWarehouseIds}
              >
                {savingWarehouseSettings ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                保存仓库设置
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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
