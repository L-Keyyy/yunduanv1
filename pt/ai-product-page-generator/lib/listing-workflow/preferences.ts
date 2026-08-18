import fs from "fs/promises";
import path from "path";

import type { ListingModelSelection } from "@/lib/listing-workflow/items";
import {
  DEFAULT_LISTING_FEATURE_FILL_MODE,
  normalizeListingFeatureFillMode,
  type ListingFeatureFillMode,
} from "@/lib/listing-workflow/quick-mode";
import {
  DEFAULT_LISTING_STAGE_AI_PROMPTS,
  normalizeListingStageAiPrompts,
  type ListingStageAiPromptConfig,
} from "@/lib/listing-workflow/text-prompts";
import {
  DEFAULT_LISTING_PRODUCT_QUANTITY,
  normalizeListingProductQuantity,
  normalizeListingWarehouseRules,
  type ListingWarehouseRule,
} from "@/lib/listing-workflow/warehouse-settings";
import { env } from "@/lib/utils/env";

export type ListingWorkflowPreferences = {
  featureModel: ListingModelSelection;
  imageModel: ListingModelSelection;
  featureFillMode: ListingFeatureFillMode;
  productQuantity: number;
  warehouseRules: ListingWarehouseRule[];
  stageAiPrompts: ListingStageAiPromptConfig;
  updatedAt: string | null;
};

const defaultFeatureModel: ListingModelSelection = {
  providerId:
    process.env.LISTING_FEATURE_PROVIDER_ID?.trim() || "browser-webai",
  modelId: process.env.LISTING_FEATURE_MODEL_ID?.trim() || "gpt-thinking",
};

const defaultImageModel: ListingModelSelection = {
  providerId:
    process.env.LISTING_IMAGE_PROVIDER_ID?.trim() || "browser-webai",
  modelId:
    process.env.LISTING_IMAGE_MODEL_ID?.trim() || "doubao-image-web",
};

function preferencesPath() {
  return path.resolve(
    process.cwd(),
    env.STORAGE_ROOT,
    "listing-workflow-preferences.json",
  );
}

function modelSelection(value: unknown): ListingModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const providerId =
    typeof record.providerId === "string" ? record.providerId.trim() : "";
  const modelId =
    typeof record.modelId === "string" ? record.modelId.trim() : "";
  return providerId && modelId ? { providerId, modelId } : null;
}

export async function readListingWorkflowPreferences(): Promise<ListingWorkflowPreferences> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(preferencesPath(), "utf8"),
    ) as Record<string, unknown>;
    return {
      featureModel: modelSelection(parsed.featureModel) ?? defaultFeatureModel,
      imageModel: modelSelection(parsed.imageModel) ?? defaultImageModel,
      featureFillMode: normalizeListingFeatureFillMode(
        parsed.featureFillMode,
      ),
      productQuantity: normalizeListingProductQuantity(parsed.productQuantity),
      warehouseRules: normalizeListingWarehouseRules(parsed.warehouseRules),
      stageAiPrompts: normalizeListingStageAiPrompts(parsed.stageAiPrompts),
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return {
      featureModel: defaultFeatureModel,
      imageModel: defaultImageModel,
      featureFillMode: DEFAULT_LISTING_FEATURE_FILL_MODE,
      productQuantity: DEFAULT_LISTING_PRODUCT_QUANTITY,
      warehouseRules: normalizeListingWarehouseRules(null),
      stageAiPrompts: DEFAULT_LISTING_STAGE_AI_PROMPTS,
      updatedAt: null,
    };
  }
}

async function writeListingWorkflowPreferences(
  preferences: ListingWorkflowPreferences,
) {
  const filePath = preferencesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(preferences, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
  return preferences;
}

let preferencesWriteTail: Promise<void> = Promise.resolve();

function updateListingWorkflowPreferences(
  update: (
    current: ListingWorkflowPreferences,
  ) => ListingWorkflowPreferences,
): Promise<ListingWorkflowPreferences> {
  const task = preferencesWriteTail.then(async () => {
    const current = await readListingWorkflowPreferences();
    return writeListingWorkflowPreferences(update(current));
  });
  preferencesWriteTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function saveListingWorkflowFeatureModel(
  featureModel: ListingModelSelection,
): Promise<ListingWorkflowPreferences> {
  return updateListingWorkflowPreferences((current) => ({
    ...current,
    featureModel: {
      providerId: featureModel.providerId.trim(),
      modelId: featureModel.modelId.trim(),
    },
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveListingWorkflowImageModel(
  imageModel: ListingModelSelection,
): Promise<ListingWorkflowPreferences> {
  return updateListingWorkflowPreferences((current) => ({
    ...current,
    imageModel: {
      providerId: imageModel.providerId.trim(),
      modelId: imageModel.modelId.trim(),
    },
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveListingWorkflowFeatureFillMode(
  featureFillMode: ListingFeatureFillMode,
): Promise<ListingWorkflowPreferences> {
  return updateListingWorkflowPreferences((current) => ({
    ...current,
    featureFillMode: normalizeListingFeatureFillMode(featureFillMode),
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveListingWorkflowProductQuantity(
  productQuantity: number,
): Promise<ListingWorkflowPreferences> {
  return updateListingWorkflowPreferences((current) => ({
    ...current,
    productQuantity: normalizeListingProductQuantity(productQuantity),
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveListingWorkflowWarehouseSettings(input: {
  productQuantity: number;
  warehouseRules: ListingWarehouseRule[];
}): Promise<ListingWorkflowPreferences> {
  return updateListingWorkflowPreferences((current) => ({
    ...current,
    productQuantity: normalizeListingProductQuantity(input.productQuantity),
    warehouseRules: normalizeListingWarehouseRules(input.warehouseRules),
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveListingWorkflowStageAiPrompts(
  stageAiPrompts: ListingStageAiPromptConfig,
): Promise<ListingWorkflowPreferences> {
  return updateListingWorkflowPreferences((current) => ({
    ...current,
    stageAiPrompts: normalizeListingStageAiPrompts(stageAiPrompts),
    updatedAt: new Date().toISOString(),
  }));
}
