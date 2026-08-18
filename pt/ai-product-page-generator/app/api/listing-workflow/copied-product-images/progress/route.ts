import fs from "fs/promises";
import path from "path";

import { handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function countStatuses(rows: Record<string, unknown>) {
  return Object.values(rows).map(record).reduce<Record<string, number>>((result, row) => {
    const status = text(row.status) || "pending";
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
}

function workerAlive(checkpoint: Record<string, unknown>) {
  const pid = Number(checkpoint.workerPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const root = path.resolve(process.cwd(), "storage", "copied-product-image-queue");
    const [checkpointText, selectionText] = await Promise.all([
      fs.readFile(path.join(root, "checkpoint.json"), "utf8").catch(() => "{}"),
      fs.readFile(path.join(root, "selection.json"), "utf8").catch(() => "{}"),
    ]);
    const checkpoint = record(JSON.parse(checkpointText));
    const selection = record(JSON.parse(selectionText));
    const selected = Array.isArray(selection.products) ? selection.products.map(record) : [];
    const products = record(checkpoint.products);
    const generations = record(checkpoint.generations);
    const productStatuses = countStatuses(products);
    const generationStatuses = countStatuses(generations);
    const uploaded = productStatuses.uploaded || 0;
    const failed = productStatuses.failed || 0;
    const total = selected.length;
    const status = text(checkpoint.status) || "idle";
    return ok({
      status,
      total,
      uploaded,
      failed,
      pending: Math.max(total - uploaded - failed, 0),
      percent: total ? Math.round((uploaded / total) * 1000) / 10 : 0,
      workerAlive: workerAlive(checkpoint),
      callsFeatureAi: checkpoint.callsFeatureAi === true,
      callsProductImport: checkpoint.callsProductImport === true,
      pauseReason: text(checkpoint.pauseReason),
      pausedAt: text(checkpoint.pausedAt),
      updatedAt: text(checkpoint.updatedAt),
      productStatuses,
      generationStatuses,
      items: Object.values(products).map(record).slice(-100).reverse(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
