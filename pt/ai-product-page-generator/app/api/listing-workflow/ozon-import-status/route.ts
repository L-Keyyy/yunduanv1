import { NextRequest } from "next/server";
import { z } from "zod";

import { ozonSellerRequest } from "@/lib/ozon/client";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  taskId: z.coerce.number().int().positive(),
  configId: z.string().trim().min(1).optional(),
});

type OzonImportItem = {
  offer_id?: string;
  status?: string;
  errors?: unknown[];
  product_id?: number;
};

function importItems(payload: unknown): OzonImportItem[] {
  if (!payload || typeof payload !== "object") return [];
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object") return [];
  const items = (result as Record<string, unknown>).items;
  return Array.isArray(items) ? (items as OzonImportItem[]) : [];
}

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    const response = await ozonSellerRequest<Record<string, unknown>>(
      "/v1/product/import/info",
      { task_id: input.taskId },
      { timeoutMs: 60_000, configId: input.configId },
    );
    const items = importItems(response);
    return ok({
      taskId: input.taskId,
      terminal: items.length > 0 && items.every((item) =>
        item.status === "imported" || item.status === "failed"
      ),
      imported: items.filter((item) => item.status === "imported").length,
      failed: items.filter((item) => item.status === "failed").length,
      pending: items.filter((item) =>
        item.status !== "imported" && item.status !== "failed"
      ).length,
      items,
      response,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
