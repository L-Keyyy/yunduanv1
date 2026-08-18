import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { sanitizeCollectedProductJson } from "@/lib/listing-workflow/ai-product-json";
import { handleRouteError, ok } from "@/lib/utils/route";

const stageSchema = z.enum(["COLLECTED", "PROCESSING"]);
const statusSchema = z.enum([
  "READY",
  "PENDING_AI",
  "AI_RUNNING",
  "MATCHED",
  "AI_FAILED",
]);
const featureSchema = z.record(z.string(), z.unknown());

const createItemSchema = z.object({
  stage: stageSchema.default("COLLECTED"),
  status: statusSchema.default("READY"),
  sourceUrl: z.string().trim().optional().nullable(),
  sourcePlatform: z.string().trim().optional().nullable(),
  title: z.string().trim().min(1).max(500),
  offerId: z.string().trim().min(1).max(200),
  imageUrl: z.string().trim().optional().nullable(),
  currentPrice: z.string().trim().optional().nullable(),
  oldPrice: z.string().trim().optional().nullable(),
  minPrice: z.string().trim().optional().nullable(),
  costPrice: z.string().trim().optional().nullable(),
  currency: z.string().trim().min(1).max(20).default("CNY"),
  categoryId: z.string().trim().optional().nullable(),
  categoryLabel: z.string().trim().optional().nullable(),
  categoryPath: z.array(z.string()).optional().nullable(),
  scrapedData: z.record(z.string(), z.unknown()),
  workflowData: z.record(z.string(), z.unknown()).optional().nullable(),
  features: z.array(featureSchema).optional().nullable(),
  aiResponse: z.record(z.string(), z.unknown()).optional().nullable(),
  notes: z.array(z.string()).optional().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const stageValue = request.nextUrl.searchParams.get("stage");
    const stage = stageValue ? stageSchema.parse(stageValue) : null;
    const items = await prisma.listingWorkflowItem.findMany({
      where: stage ? { stage } : undefined,
      orderBy: { updatedAt: "desc" },
    });
    return ok(items);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const input = createItemSchema.parse(await request.json());
    const item = await prisma.listingWorkflowItem.create({
      data: {
        ...input,
        scrapedData: sanitizeCollectedProductJson(
          input.scrapedData,
        ) as Prisma.InputJsonValue,
        workflowData: input.workflowData
          ? (input.workflowData as Prisma.InputJsonValue)
          : undefined,
        categoryPath: input.categoryPath
          ? (input.categoryPath as Prisma.InputJsonValue)
          : undefined,
        features: input.features
          ? (input.features as Prisma.InputJsonValue)
          : undefined,
        aiResponse: input.aiResponse
          ? (input.aiResponse as Prisma.InputJsonValue)
          : undefined,
        notes: input.notes ? (input.notes as Prisma.InputJsonValue) : undefined,
      },
    });
    return ok(item, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
