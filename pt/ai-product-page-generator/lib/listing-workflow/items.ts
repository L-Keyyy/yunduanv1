export type ListingWorkflowStage = "COLLECTED" | "PROCESSING";
export type ListingWorkflowStatus =
  | "READY"
  | "PENDING_AI"
  | "AI_RUNNING"
  | "MATCHED"
  | "AI_FAILED";

export const LISTING_WORKFLOW_ACTIVE_ITEM_STORAGE_KEY =
  "banana-mall:listing-workflow:active-item-id";
export const LISTING_FEATURE_MODEL_STORAGE_KEY =
  "banana-mall:listing-workflow:feature-model";
export const LISTING_IMAGE_MODEL_STORAGE_KEY =
  "banana-mall:listing-workflow:image-model";

export type ListingModelSelection = {
  providerId: string;
  modelId: string;
};

export function parseListingModelSelection(
  value: string | null,
): ListingModelSelection | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ListingModelSelection>;
    return typeof parsed.providerId === "string" &&
      parsed.providerId.trim() &&
      typeof parsed.modelId === "string" &&
      parsed.modelId.trim()
      ? {
          providerId: parsed.providerId.trim(),
          modelId: parsed.modelId.trim(),
        }
      : null;
  } catch {
    return null;
  }
}

export type ListingWorkflowFeature = {
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
  ozonAttributeValues?: Array<{
    dictionary_value_id?: number;
    value?: string;
  }>;
  aiJsonKey?: string;
  aiJsonPath?: string;
  aiJsonValue?: string;
};

export type ListingWorkflowItem = {
  id: string;
  stage: ListingWorkflowStage;
  status: ListingWorkflowStatus;
  sourceUrl: string | null;
  sourcePlatform: string | null;
  title: string;
  offerId: string;
  imageUrl: string | null;
  currentPrice: string | null;
  oldPrice: string | null;
  minPrice: string | null;
  costPrice: string | null;
  currency: string;
  categoryId: string | null;
  categoryLabel: string | null;
  categoryPath: string[] | null;
  scrapedData: Record<string, unknown>;
  workflowData: Record<string, unknown> | null;
  features: ListingWorkflowFeature[] | null;
  aiResponse: Record<string, unknown> | null;
  notes: string[] | null;
  createdAt: string;
  updatedAt: string;
};

export function listingItemStatusLabel(status: ListingWorkflowStatus) {
  if (status === "MATCHED") return "AI 已匹配";
  if (status === "AI_RUNNING") return "AI 匹配中";
  if (status === "AI_FAILED") return "匹配失败";
  if (status === "PENDING_AI") return "待选择图片与 SKU";
  return "采集完成";
}
