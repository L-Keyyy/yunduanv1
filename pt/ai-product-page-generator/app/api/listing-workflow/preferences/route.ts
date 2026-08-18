import { NextRequest } from "next/server";
import { z } from "zod";

import {
  readListingWorkflowPreferences,
  saveListingWorkflowFeatureFillMode,
  saveListingWorkflowFeatureModel,
  saveListingWorkflowImageModel,
  saveListingWorkflowProductQuantity,
  saveListingWorkflowStageAiPrompts,
  saveListingWorkflowWarehouseSettings,
} from "@/lib/listing-workflow/preferences";
import { handleRouteError, ok } from "@/lib/utils/route";

export const dynamic = "force-dynamic";

const stageAiPromptsSchema = z.object({
  categoryMatch: z.object({
    systemPrompt: z.string().trim().min(1).max(8000),
    taskPrompt: z.string().trim().min(1).max(4000),
  }),
  featureFill: z.object({
    systemPrompt: z.string().trim().min(1).max(8000),
    taskPrompt: z.string().trim().min(1).max(4000),
  }),
  imageGeneration: z.object({
    prompt: z.string().trim().min(1).max(5000),
    aspectRatio: z.enum(["1:1", "3:4", "9:16"]),
    useReference: z.boolean(),
  }),
});

const requestSchema = z
  .object({
    featureModel: z
      .object({
        providerId: z.string().trim().min(1).max(200),
        modelId: z.string().trim().min(1).max(300),
      })
      .optional(),
    imageModel: z
      .object({
        providerId: z.string().trim().min(1).max(200),
        modelId: z.string().trim().min(1).max(300),
      })
      .optional(),
    featureFillMode: z.enum(["normal", "max"]).optional(),
    productQuantity: z.number().int().min(0).max(999_999).optional(),
    warehouseRules: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(100),
          logisticsGroup: z.string().trim().min(1).max(200),
          minWeightGrams: z.number().nonnegative(),
          maxWeightGrams: z.number().nonnegative(),
          minPriceCny: z.number().nonnegative(),
          maxPriceCny: z.number().nonnegative(),
          warehouseName: z.string().trim().min(1).max(200),
          warehouseId: z.string().trim().min(1).max(100).nullable(),
        }),
      )
      .length(6)
      .optional(),
    stageAiPrompts: stageAiPromptsSchema.optional(),
  })
  .refine(
    (value) =>
      value.featureModel ||
      value.imageModel ||
      value.featureFillMode ||
      value.productQuantity !== undefined ||
      value.warehouseRules ||
      value.stageAiPrompts,
    {
      message: "至少提交一项工作流偏好",
    },
  );

export async function GET() {
  try {
    return ok(await readListingWorkflowPreferences());
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    let preferences = await readListingWorkflowPreferences();
    if (input.featureModel) {
      preferences = await saveListingWorkflowFeatureModel(input.featureModel);
    }
    if (input.imageModel) {
      preferences = await saveListingWorkflowImageModel(input.imageModel);
    }
    if (input.featureFillMode) {
      preferences = await saveListingWorkflowFeatureFillMode(
        input.featureFillMode,
      );
    }
    if (input.warehouseRules) {
      preferences = await saveListingWorkflowWarehouseSettings({
        productQuantity:
          input.productQuantity ?? preferences.productQuantity,
        warehouseRules: input.warehouseRules,
      });
    } else if (input.productQuantity !== undefined) {
      preferences = await saveListingWorkflowProductQuantity(
        input.productQuantity,
      );
    }
    if (input.stageAiPrompts) {
      preferences = await saveListingWorkflowStageAiPrompts(
        input.stageAiPrompts,
      );
    }
    return ok(preferences);
  } catch (error) {
    return handleRouteError(error);
  }
}
