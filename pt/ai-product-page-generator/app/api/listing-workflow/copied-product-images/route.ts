import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import { z } from "zod";

import { listOzonConnectionStates } from "@/lib/ozon/config-service";
import { ozonSellerRequest } from "@/lib/ozon/client";
import { handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const productSchema = z.object({
  storeId: z.string().trim().min(1),
  offerId: z.string().trim().min(1),
});

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    products: z.array(productSchema).min(1).max(1000),
  }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("retry") }),
]);

function queuePaths() {
  const root = path.resolve(process.cwd(), "storage", "copied-product-image-queue");
  return {
    root,
    selection: path.join(root, "selection.json"),
    checkpoint: path.join(root, "checkpoint.json"),
    control: path.join(root, "control.json"),
    audit: path.join(root, "audit.json"),
    log: path.join(root, "worker.log"),
    script: path.resolve(process.cwd(), "scripts", "regenerate-rr4x-main-images.mjs"),
  };
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function readRecord(filePath: string) {
  const text = await fsp.readFile(filePath, "utf8").catch(() => "{}");
  const value = JSON.parse(text) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function primaryImage(item: Record<string, unknown>) {
  return Array.isArray(item.primary_image)
    ? text(item.primary_image[0])
    : text(item.primary_image);
}

async function listStoreProducts(configId: string, prefix: string) {
  const listed: Array<Record<string, unknown>> = [];
  let lastId = "";
  do {
    const payload = await ozonSellerRequest<{
      result?: { items?: Array<Record<string, unknown>>; last_id?: string };
    }>(
      "/v3/product/list",
      { filter: { visibility: "ALL" }, last_id: lastId, limit: 1000 },
      { configId },
    );
    const page = payload.result?.items ?? [];
    listed.push(
      ...page.filter((item) => !prefix || text(item.offer_id).startsWith(prefix)),
    );
    const next = text(payload.result?.last_id);
    if (!page.length || !next || next === lastId) break;
    lastId = next;
  } while (true);

  const info: Array<Record<string, unknown>> = [];
  for (let index = 0; index < listed.length; index += 100) {
    const offerIds = listed
      .slice(index, index + 100)
      .map((item) => text(item.offer_id))
      .filter(Boolean);
    if (!offerIds.length) continue;
    const payload = await ozonSellerRequest<{ items?: Array<Record<string, unknown>> }>(
      "/v3/product/info/list",
      { offer_id: offerIds },
      { configId },
    );
    info.push(...(payload.items ?? []));
  }
  return info.filter((item) => {
    const statuses = item.statuses;
    return Boolean(
      statuses &&
        typeof statuses === "object" &&
        !Array.isArray(statuses) &&
        (statuses as Record<string, unknown>).is_created === true,
    );
  });
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

async function spawnWorker() {
  const paths = queuePaths();
  await fsp.mkdir(paths.root, { recursive: true });
  const logFd = fs.openSync(paths.log, "a");
  const child = spawn(
    process.execPath,
    [
      "--env-file=.env",
      paths.script,
      "--prefix",
      "",
      "--selection",
      paths.selection,
      "--checkpoint",
      paths.checkpoint,
      "--control",
      paths.control,
      "--audit",
      paths.audit,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
    },
  );
  child.unref();
  fs.closeSync(logFd);
  return child.pid ?? null;
}

export async function GET(request: Request) {
  try {
    const prefix = new URL(request.url).searchParams.get("prefix")?.trim() ?? "";
    const stores = (await listOzonConnectionStates()).filter((store) => store.ready && store.id);
    const results = await Promise.all(
      stores.map(async (store) => {
        try {
          const products = await listStoreProducts(store.id!, prefix);
          return products.map((item) => ({
            key: `${store.id}:${text(item.offer_id)}`,
            storeId: store.id!,
            storeName: store.name,
            offerId: text(item.offer_id),
            productId: text(item.id ?? item.product_id),
            name: text(item.name),
            imageUrl: primaryImage(item),
            imageCount:
              (Array.isArray(item.images) ? item.images.length : 0) +
              (primaryImage(item) ? 1 : 0),
          }));
        } catch (error) {
          return [{
            key: `${store.id}:error`,
            storeId: store.id!,
            storeName: store.name,
            offerId: "",
            productId: "",
            name: "",
            imageUrl: "",
            imageCount: 0,
            error: error instanceof Error ? error.message : "店铺商品读取失败",
          }];
        }
      }),
    );
    const products = results.flat().filter((item) => item.offerId);
    return ok({ prefix, stores: stores.length, products });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const paths = queuePaths();
    const now = new Date().toISOString();
    const checkpoint = await readRecord(paths.checkpoint);

    if (input.action === "pause") {
      await writeJsonAtomic(paths.control, {
        pauseRequested: true,
        reason: "用户暂停跟卖商品图片重生队列",
        requestedAt: now,
      });
      return ok({ action: input.action, status: "pause_requested" });
    }

    if (workerAlive(checkpoint)) {
      throw new Error("图片重生队列正在运行，请先等待当前商品结束或暂停队列。");
    }

    if (input.action === "start") {
      await writeJsonAtomic(paths.selection, {
        createdAt: now,
        mode: "existing-product-image-replacement",
        products: input.products,
      });
      await writeJsonAtomic(paths.checkpoint, {
        schemaVersion: 1,
        mode: "existing-product-image-replacement",
        callsFeatureAi: false,
        callsProductImport: false,
        status: "starting",
        createdAt: now,
        updatedAt: now,
        generations: {},
        products: {},
      });
    } else if (!(await fsp.stat(paths.selection).catch(() => null))) {
      throw new Error("还没有保存过商品选择，请先勾选商品并启动一次。");
    }

    await writeJsonAtomic(paths.control, {
      pauseRequested: false,
      action: input.action,
      clearedAt: now,
    });
    const workerPid = await spawnWorker();
    const latest = await readRecord(paths.checkpoint);
    await writeJsonAtomic(paths.checkpoint, {
      ...latest,
      status: "starting",
      workerPid,
      lastAction: input.action,
      updatedAt: now,
    });
    return ok({ action: input.action, status: "starting", workerPid });
  } catch (error) {
    return handleRouteError(error);
  }
}
