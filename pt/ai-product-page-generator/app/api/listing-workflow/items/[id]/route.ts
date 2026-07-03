import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

const updateItemSchema = z.object({
  stage: z.enum(["COLLECTED", "PROCESSING"]).optional(),
  status: z
    .enum(["READY", "PENDING_AI", "AI_RUNNING", "MATCHED", "AI_FAILED"])
    .optional(),
  sourceUrl: z.string().trim().optional().nullable(),
  sourcePlatform: z.string().trim().optional().nullable(),
  title: z.string().trim().min(1).max(500).optional(),
  offerId: z.string().trim().min(1).max(200).optional(),
  imageUrl: z.string().trim().optional().nullable(),
  currentPrice: z.string().trim().optional().nullable(),
  oldPrice: z.string().trim().optional().nullable(),
  minPrice: z.string().trim().optional().nullable(),
  costPrice: z.string().trim().optional().nullable(),
  currency: z.string().trim().min(1).max(20).optional(),
  categoryId: z.string().trim().optional().nullable(),
  categoryLabel: z.string().trim().optional().nullable(),
  categoryPath: z.array(z.string()).optional().nullable(),
  scrapedData: z.record(z.string(), z.unknown()).optional(),
  features: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .nullable(),
  aiResponse: z.record(z.string(), z.unknown()).optional().nullable(),
  notes: z.array(z.string()).optional().nullable(),
});

export async function GET(
  _request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    const item = await prisma.listingWorkflowItem.findUnique({
      where: { id: context.params.id },
    });
    if (!item) return fail("NOT_FOUND", "商品工作流记录不存在", null, 404);
    return ok(item);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    const input = updateItemSchema.parse(await request.json());
    const item = await prisma.listingWorkflowItem.update({
      where: { id: context.params.id },
      data: {
        ...input,
        categoryPath:
          input.categoryPath === undefined
            ? undefined
            : input.categoryPath === null
              ? Prisma.JsonNull
              : (input.categoryPath as Prisma.InputJsonValue),
        scrapedData: input.scrapedData
          ? (input.scrapedData as Prisma.InputJsonValue)
          : undefined,
        features:
          input.features === undefined
            ? undefined
            : input.features === null
              ? Prisma.JsonNull
              : (input.features as Prisma.InputJsonValue),
        aiResponse:
          input.aiResponse === undefined
            ? undefined
            : input.aiResponse === null
              ? Prisma.JsonNull
              : (input.aiResponse as Prisma.InputJsonValue),
        notes:
          input.notes === undefined
            ? undefined
            : input.notes === null
              ? Prisma.JsonNull
              : (input.notes as Prisma.InputJsonValue),
      },
    });
    return ok(item);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    const item = await prisma.listingWorkflowItem.delete({
      where: { id: context.params.id },
    });
    return ok(item);
  } catch (error) {
    return handleRouteError(error);
  }
}
