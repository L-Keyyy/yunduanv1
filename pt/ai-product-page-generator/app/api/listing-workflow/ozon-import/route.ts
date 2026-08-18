import { NextRequest } from "next/server";
import { z } from "zod";

import { ozonSellerRequest } from "@/lib/ozon/client";
import { buildOzonProductImportPayload } from "@/lib/ozon/product-import-payload";
import { ensurePermanentWorkflowImageUrls } from "@/lib/listing-workflow/public-image-host";
import { handleRouteError, ok } from "@/lib/utils/route";

const attributeValueSchema = z.object({
  dictionary_value_id: z.number().int().positive().optional(),
  value: z.string().optional(),
});

const optionMappingSchema = z.object({
  label: z.string().optional(),
  value: z.string(),
  dictionaryValueId: z.number().int().positive().optional(),
});

const featureSchema = z.object({
  attributeId: z.string().min(1),
  group: z.enum(["base", "category", "source"]),
  ozonCode: z.string().nullable().optional(),
  value: z.string(),
  ozonComplexId: z.number().int().nonnegative().optional(),
  optionMappings: z.array(optionMappingSchema).optional(),
  ozonAttributeValues: z.array(attributeValueSchema).optional(),
  aiJsonValue: z.string().optional(),
});

const requestSchema = z.object({
  action: z.enum(["preview", "submit"]).default("preview"),
  confirmed: z.boolean().optional(),
  configId: z.string().trim().min(1).optional(),
  category: z
    .object({
      descriptionCategoryId: z.number().int().positive().nullable().optional(),
      typeId: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
  features: z.array(featureSchema),
  images: z
    .object({
      primary_image: z.string().optional(),
      images: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  variants: z
    .array(
      z.object({
        skuId: z.string().min(1),
        offerId: z.string().optional(),
        name: z.string().optional(),
        price: z.string().optional(),
        images: z
          .object({
            primary_image: z.string().optional(),
            images: z.array(z.string()).optional(),
          })
          .nullable()
          .optional(),
        features: z.array(featureSchema).optional(),
        depth: z.union([z.number(), z.string()]).optional(),
        width: z.union([z.number(), z.string()]).optional(),
        height: z.union([z.number(), z.string()]).optional(),
        weight: z.union([z.number(), z.string()]).optional(),
        dimensionUnit: z.enum(["mm", "cm", "in"]).optional(),
        weightUnit: z.enum(["g", "kg", "lb"]).optional(),
      }),
    )
    .optional(),
});

function positiveTaskId(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object") return null;
  const taskId = Number((result as Record<string, unknown>).task_id);
  return Number.isSafeInteger(taskId) && taskId > 0 ? taskId : null;
}

async function permanentImages(
  images: { primary_image?: string; images?: string[] } | null | undefined,
) {
  if (!images) return images;
  const requested = [images.primary_image, ...(images.images ?? [])]
    .filter((value): value is string => Boolean(value?.trim()));
  if (!requested.length) return images;
  const permanent = await ensurePermanentWorkflowImageUrls(requested);
  return {
    primary_image: images.primary_image ? permanent[0] : undefined,
    images: images.primary_image ? permanent.slice(1) : permanent,
  };
}

export async function POST(request: NextRequest) {
  try {
    const parsed = requestSchema.parse(await request.json());
    const input = parsed.action === "submit"
      ? {
          ...parsed,
          images: await permanentImages(parsed.images),
          variants: parsed.variants
            ? await Promise.all(parsed.variants.map(async (variant) => ({
                ...variant,
                images: await permanentImages(variant.images),
              })))
            : parsed.variants,
        }
      : parsed;
    const built = buildOzonProductImportPayload(input);
    if (input.action === "preview") {
      return ok(built);
    }
    if (!input.confirmed) {
      throw new Error("上传 Ozon 前必须明确确认 confirmed=true。");
    }
    if (built.errors.length) {
      throw new Error(`Ozon 上传 JSON 校验失败：${built.errors.join("；")}`);
    }
    const response = await ozonSellerRequest<Record<string, unknown>>(
      "/v3/product/import",
      built.payload,
      { timeoutMs: 120_000, configId: input.configId },
    );
    const taskId = positiveTaskId(response);
    if (!taskId) {
      throw new Error("Ozon 已接收上传请求，但响应中缺少有效的 task_id。");
    }
    return ok({
      ...built,
      submitted: true,
      taskId,
      configId: input.configId ?? null,
      submittedAt: new Date().toISOString(),
      response,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
