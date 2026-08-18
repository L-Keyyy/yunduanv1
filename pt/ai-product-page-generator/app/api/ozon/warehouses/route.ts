import { NextRequest } from "next/server";

import { ozonSellerRequest } from "@/lib/ozon/client";
import { handleRouteError, ok } from "@/lib/utils/route";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function warehouseEntries(payload: unknown) {
  const root = record(payload);
  const result = root.result;
  if (Array.isArray(result)) return result;
  const resultRecord = record(result);
  for (const candidate of [
    resultRecord.items,
    resultRecord.warehouses,
    root.items,
    root.warehouses,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const configId = request.nextUrl.searchParams.get("configId")?.trim() || null;
    const response = await ozonSellerRequest<JsonRecord>(
      "/v2/warehouse/list",
      {},
      { timeoutMs: 60_000, configId },
    );
    const warehouses = warehouseEntries(response).flatMap((entry) => {
      const item = record(entry);
      const id = String(item.warehouse_id ?? item.warehouseId ?? item.id ?? "").trim();
      const name = String(item.name ?? item.warehouse_name ?? "").trim();
      if (!id || !name) return [];
      return [{
        id,
        name,
        status: String(item.status ?? "").trim() || null,
        isRfbs: Boolean(item.is_rfbs ?? item.isRfbs),
      }];
    });
    return ok({ configId, warehouses, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return handleRouteError(error);
  }
}
