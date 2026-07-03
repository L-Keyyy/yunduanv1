export type ListingWorkflowStage = "COLLECTED" | "PROCESSING";
export type ListingWorkflowStatus =
  | "READY"
  | "PENDING_AI"
  | "AI_RUNNING"
  | "MATCHED"
  | "AI_FAILED";

export type ListingWorkflowFeature = {
  attributeId: string;
  label: string;
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
  if (status === "PENDING_AI") return "等待 AI 匹配";
  return "采集完成";
}
