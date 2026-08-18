#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    manifest: "storage/rr4x-standard-rebuild/sources.json",
    checkpoint: "storage/rr4x-standard-rebuild/collect-checkpoint.json",
    limit: Number.POSITIVE_INFINITY,
    maxAttempts: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") args.baseUrl = argv[++index];
    else if (token === "--manifest") args.manifest = argv[++index];
    else if (token === "--checkpoint") args.checkpoint = argv[++index];
    else if (token === "--limit") args.limit = Number(argv[++index]);
    else if (token === "--max-attempts") args.maxAttempts = Number(argv[++index]);
    else throw new Error(`未知参数：${token}`);
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textValue(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function positiveMoney(value) {
  const match = textValue(value).match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const amount = Number(match[0].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function fourTimes(value, domesticFreight) {
  const amount = positiveMoney(value);
  const freight = Number(domesticFreight);
  return amount && Number.isFinite(freight) && freight >= 0
    ? (Math.round((amount + freight) * 4 * 100) / 100).toFixed(2)
    : "";
}

function variantId(variant, index) {
  const row = asRecord(variant);
  return textValue(
    row.skuId ?? row.sku_id ?? row.sourceSkuId ?? row.source_sku_id ??
      row.productId ?? row.product_id ?? row.id,
  ) || `sku-${index + 1}`;
}

function galleryUrls(scrapedData) {
  const data = asRecord(scrapedData);
  const gallery = asRecord(data.gallery);
  const candidates = [
    gallery.coverImage,
    ...(Array.isArray(gallery.images) ? gallery.images : []),
    ...(Array.isArray(data.images) ? data.images : []),
  ];
  const urls = [];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    const url = textValue(candidate) || textValue(
      record.src ?? record.url ?? record.imageUrl ?? record.imgUrl,
    );
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function sourcePrice(scrapedData, fallback) {
  const data = asRecord(scrapedData);
  const prices = [
    positiveMoney(data.price),
    ...(Array.isArray(data.variants)
      ? data.variants.map((variant) => positiveMoney(asRecord(variant).price))
      : []),
    positiveMoney(fallback),
  ].filter((value) => value !== null);
  return prices.length ? Math.min(...prices).toFixed(2) : "";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function api(args, pathname, init = {}) {
  const response = await fetch(new URL(pathname, `${args.baseUrl}/`), {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(init.timeoutMs || 180_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}: ${pathname}`);
  }
  return payload.data;
}

function stableImageId(url) {
  return `image:${crypto.createHash("sha1").update(url).digest("hex").slice(0, 16)}`;
}

async function collectOne(args, source, index, storeIds) {
  const collected = await api(args, "/api/crawlers/collect", {
    method: "POST",
    body: JSON.stringify({ url: source.sourceUrl }),
    timeoutMs: 180_000,
  });
  const scrapedData = asRecord(collected.scrapedData);
  const supplierOfferId = textValue(source.supplierOfferId);
  const localOfferId = `STD4X-${supplierOfferId}`;
  const images = galleryUrls(scrapedData);
  const variants = Array.isArray(scrapedData.variants) ? scrapedData.variants : [];
  const selectedSkuIds = variants.map(variantId);
  const costPrice = sourcePrice(scrapedData, source.purchasePrice1688Cny);
  const domesticFreight = Number(source.domesticFreight1688Cny);
  if (!Number.isFinite(domesticFreight) || domesticFreight < 0) {
    throw new Error(`1688 商品 ${supplierOfferId} 缺少国内运费`);
  }
  const targetStoreId = storeIds[index % storeIds.length] || source.previousStoreId || null;
  const now = new Date().toISOString();
  const workflowData = {
    standardRebuild: {
      mode: "standard-full-workflow",
      fastCopyDisabled: true,
      pricingRule: "(1688_CNY+DOMESTIC_FREIGHT_CNY)_X4",
      domesticFreight1688Cny: domesticFreight,
      supplierOfferId,
      sourceOzonSku: source.sourceOzonSku,
      previousPlacements: source.previousPlacements || [],
      targetStoreId,
      collectedAt: now,
    },
    skuSelection: {
      mode: "multiple",
      selectedSkuIds,
      selectedCount: selectedSkuIds.length,
      totalCount: selectedSkuIds.length,
    },
    workflowImages: {
      items: images.slice(0, 30).map((url, imageIndex) => ({
        id: stableImageId(url),
        name: imageIndex === 0 ? "1688-source-main.jpg" : `1688-source-${imageIndex + 1}.jpg`,
        url,
        label: imageIndex === 0 ? "主图" : "采集图",
        source: "crawler",
      })),
      selectedImageIds: [],
    },
  };
  const item = await prisma.listingWorkflowItem.upsert({
    where: { offerId: localOfferId },
    create: {
      stage: "COLLECTED",
      status: "PENDING_AI",
      sourceUrl: textValue(collected.sourceUrl) || source.sourceUrl,
      sourcePlatform: "1688",
      title: textValue(scrapedData.title) || source.sourceOzonTitle || localOfferId,
      offerId: localOfferId,
      imageUrl: images[0] || source.sourceImageUrl || null,
      currentPrice: fourTimes(costPrice, domesticFreight),
      oldPrice: null,
      costPrice,
      currency: "CNY",
      scrapedData,
      workflowData,
      notes: ["已从 1688 原始链接重新采集；待运行标准特征与图片加工。"],
    },
    update: {
      stage: "COLLECTED",
      status: "PENDING_AI",
      sourceUrl: textValue(collected.sourceUrl) || source.sourceUrl,
      sourcePlatform: "1688",
      title: textValue(scrapedData.title) || source.sourceOzonTitle || localOfferId,
      imageUrl: images[0] || source.sourceImageUrl || null,
      currentPrice: fourTimes(costPrice, domesticFreight),
      oldPrice: null,
      costPrice,
      currency: "CNY",
      categoryId: null,
      categoryLabel: null,
      categoryPath: null,
      scrapedData,
      workflowData,
      features: null,
      aiResponse: null,
      notes: ["已从 1688 原始链接重新采集；待运行标准特征与图片加工。"],
    },
  });
  return {
    workflowItemId: item.id,
    offerId: localOfferId,
    supplierOfferId,
    targetStoreId,
    title: item.title,
    sourceImageCount: images.length,
    selectedSkuCount: selectedSkuIds.length,
    costPrice,
    salePrice: item.currentPrice,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifest);
  const checkpointPath = path.resolve(args.checkpoint);
  const manifest = await readJson(manifestPath, null);
  if (!Array.isArray(manifest?.sources)) {
    throw new Error(`重建来源清单格式错误：${manifestPath}`);
  }
  const stores = await prisma.ozonApiConfig.findMany({
    where: { isActive: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!stores.length) throw new Error("没有可用的 Ozon 店铺配置。");
  const entries = manifest.sources.slice(0, args.limit);
  const existing = await readJson(checkpointPath, null);
  const priorByKey = new Map((existing?.jobs || []).map((job) => [job.key, job]));
  const checkpoint = {
    version: 1,
    mode: "standard-full-workflow",
    fastCopyDisabled: true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobs: entries.map((source, index) => priorByKey.get(String(source.supplierOfferId)) || {
      key: String(source.supplierOfferId),
      index,
      source,
      status: "pending",
      attempts: 0,
      history: [],
    }),
  };
  const save = async () => {
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
  };
  await save();
  const storeIds = stores.map((store) => store.id);
  for (const job of checkpoint.jobs) {
    if (job.status === "collected") continue;
    if (job.attempts >= args.maxAttempts) continue;
    job.status = "running";
    job.attempts += 1;
    job.history.push({ status: "running", at: new Date().toISOString(), attempt: job.attempts });
    await save();
    try {
      job.result = await collectOne(args, job.source, job.index, storeIds);
      job.status = "collected";
      job.error = null;
      job.history.push({ status: "collected", at: new Date().toISOString() });
      process.stdout.write(`[${new Date().toISOString()}] ${job.key} collected item=${job.result.workflowItemId} skus=${job.result.selectedSkuCount}\n`);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.history.push({ status: "failed", at: new Date().toISOString(), error: job.error });
      process.stderr.write(`[${new Date().toISOString()}] ${job.key} failed: ${job.error}\n`);
    }
    await save();
  }
  const summary = checkpoint.jobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});
  process.stdout.write(`${JSON.stringify({ checkpointPath, summary }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
