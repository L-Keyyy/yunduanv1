import { NextRequest } from "next/server";
import { z } from "zod";

import { getOzonConnectionState, OzonConfigError } from "@/lib/ozon/client";
import {
  importOzonHdCache,
  OzonHdCacheMissingError,
  searchOzonAttributeValues,
  syncOzonCategoryAttributes,
  syncOzonCategoryTree,
} from "@/lib/ozon/sync-service";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

const syncSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("category_tree"),
    language: z.string().default("DEFAULT"),
  }),
  z.object({
    action: z.literal("ozon_hd_cache_import"),
    includeAttributes: z.boolean().default(true),
    includeValues: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("category_attributes"),
    categoryRecordId: z.string().min(1),
    includeValues: z.boolean().default(true),
    language: z.string().default("DEFAULT"),
    maxValuesPerAttribute: z.number().int().min(0).max(1000).default(100),
  }),
  z.object({
    action: z.literal("attribute_values_search"),
    categoryRecordId: z.string().min(1),
    attributeRecordId: z.string().min(1).optional(),
    ozonAttributeId: z.string().min(1).optional(),
    value: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
  }),
]);

export async function POST(request: NextRequest) {
  try {
    const parsed = syncSchema.parse(await request.json());

    if (parsed.action === "ozon_hd_cache_import") {
      const result = await importOzonHdCache({
        includeAttributes: parsed.includeAttributes,
        includeValues: parsed.includeValues,
      });
      return ok(result);
    }

    if (!(await getOzonConnectionState()).ready) {
      throw new OzonConfigError();
    }

    if (parsed.action === "category_tree") {
      const result = await syncOzonCategoryTree(parsed.language);
      return ok(result);
    }

    if (parsed.action === "attribute_values_search") {
      const result = await searchOzonAttributeValues({
        categoryRecordId: parsed.categoryRecordId,
        attributeRecordId: parsed.attributeRecordId,
        ozonAttributeId: parsed.ozonAttributeId,
        value: parsed.value,
        limit: parsed.limit,
      });
      return ok(result);
    }

    const result = await syncOzonCategoryAttributes({
      categoryRecordId: parsed.categoryRecordId,
      includeValues: parsed.includeValues,
      language: parsed.language,
      maxValuesPerAttribute: parsed.maxValuesPerAttribute,
    });
    return ok(result);
  } catch (error) {
    if (error instanceof OzonConfigError) {
      return fail("OZON_CONFIG_MISSING", error.message, null, 400);
    }

    if (error instanceof OzonHdCacheMissingError) {
      return fail("OZON_HD_CACHE_MISSING", error.message, null, 400);
    }

    return handleRouteError(error);
  }
}
