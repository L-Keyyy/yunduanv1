import { NextRequest } from "next/server";
import { z } from "zod";

import { ozonSellerRequest } from "@/lib/ozon/client";
import { buildOzonProductImportPayload } from "@/lib/ozon/product-import-payload";
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
      }),
    )
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
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
      { timeoutMs: 120_000 },
    );
    return ok({
      ...built,
      submitted: true,
      response,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
