#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    sourceAudit: "storage/ozon-rr4x-after-global-dedupe-audit-20260812.json",
    plan: "storage/ozon-500-round-robin-plan.json",
    checkpoint: "storage/rr4x-image-absent-ai-repair-checkpoint.json",
    audit: "storage/rr4x-image-absent-ai-repair-audit.json",
    limit: Number.POSITIVE_INFINITY,
    offerId: "",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--base-url") args.baseUrl = String(argv[++index] || "");
    else if (token === "--source-audit") args.sourceAudit = String(argv[++index] || "");
    else if (token === "--plan") args.plan = String(argv[++index] || "");
    else if (token === "--checkpoint") args.checkpoint = String(argv[++index] || "");
    else if (token === "--audit") args.audit = String(argv[++index] || "");
    else if (token === "--limit") args.limit = Math.max(1, Number(argv[++index]));
    else if (token === "--offer-id") args.offerId = String(argv[++index] || "");
    else throw new Error(`未知参数：${token}`);
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function decrypt(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || "").split(":");
  const key = crypto.createHash("sha256")
    .update(process.env.APP_SECRET || "replace-with-your-own-long-secret")
    .digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

function text(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function sourceSku(offerId) {
  return text(offerId).match(/(\d{6,})$/)?.[1] || "";
}

function normalizeSourceImage(value) {
  const url = text(value);
  if (!/^https:\/\//i.test(url)) return "";
  return url.replace(
    /\.(jpe?g|png|webp)_\d+x\d+(?:q\d+)?\.(?:jpe?g|png|webp)(?=$|[?#])/i,
    ".$1",
  );
}

function errorCodes(item) {
  return (Array.isArray(item?.errors) ? item.errors : [])
    .map((error) => text(error?.code))
    .filter(Boolean);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function sellerRequest(store, endpoint, body, timeoutMs = 120_000) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${store.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
        method: "POST",
        headers: {
          "Client-Id": store.clientId,
          "Api-Key": store.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) return payload;
      const error = new Error(`${endpoint} ${response.status}: ${JSON.stringify(payload)}`);
      error.status = response.status;
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (status >= 400 && status < 500 && status !== 429) throw error;
    }
    await delay(attempt * 1_500);
  }
  throw lastError || new Error(`${endpoint} 请求失败`);
}

async function localApi(args, pathname, init = {}) {
  const response = await fetch(`${args.baseUrl}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeoutMs || 15 * 60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message || `${pathname} HTTP ${response.status}`);
  }
  return payload.data;
}

async function pollImport(store, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await sellerRequest(store, "/v1/product/import/info", {
      task_id: Number(taskId),
    });
    const items = Array.isArray(response?.result?.items) ? response.result.items : [];
    if (items.length && items.every((item) =>
      ["imported", "failed", "skipped"].includes(item.status)
    )) return items;
    await delay(3_000);
  }
  return [];
}

async function currentProduct(store, offerId) {
  const [infoResponse, attributesResponse] = await Promise.all([
    sellerRequest(store, "/v3/product/info/list", { offer_id: [offerId] }),
    sellerRequest(store, "/v4/product/info/attributes", {
      filter: { offer_id: [offerId], visibility: "ALL" },
      limit: 100,
    }),
  ]);
  return {
    info: infoResponse?.items?.[0] || null,
    attributes: attributesResponse?.result?.[0] || null,
  };
}

async function generateFourImages(args, preferences, referenceImage) {
  const prompt = text(preferences?.stageAiPrompts?.imageGeneration?.prompt);
  if (!prompt) throw new Error("主页图片提示词为空");
  // 豆包偶尔会在四张裁剪图中返回一个尚未发布的本地地址；直接重试
  // 同一模型比切换到等待时间很长的备用页面模型更快、更稳定。
  const selections = [
    { providerId: "browser-webai", model: "doubao-image-web" },
    { providerId: "browser-webai", model: "doubao-image-web" },
  ];
  const errors = [];
  for (const selection of selections) {
    try {
      const result = await localApi(args, "/api/listing-workflow/image-generate", {
        method: "POST",
        body: JSON.stringify({
          ...selection,
          prompt,
          aspectRatio: "3:4",
          referenceImages: [referenceImage],
          useReferenceImages: true,
          splitGrid: true,
        }),
        timeoutMs: 15 * 60_000,
      });
      const grid = Array.isArray(result?.gridImages)
        ? [...result.gridImages].sort((left, right) => Number(left.index) - Number(right.index))
        : [];
      const urls = grid.map((image) => text(image.imageUrl)).filter(Boolean);
      if (urls.length !== 4 || !urls.every((url) => /^https:\/\//i.test(url))) {
        throw new Error(`没有得到四张可上传图片（当前 ${urls.length} 张）`);
      }
      return {
        urls,
        providerId: selection.providerId,
        model: text(result?.model) || selection.model,
        warnings: result?.warnings || [],
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      errors.push(`${selection.model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join("；"));
}

async function verifyCreated(store, offerId, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await sellerRequest(store, "/v3/product/info/list", {
      offer_id: [offerId],
    });
    const item = response?.items?.[0];
    if (item?.statuses?.is_created === true) {
      return { created: true, item, errors: errorCodes(item) };
    }
    await delay(4_000);
  }
  const response = await sellerRequest(store, "/v3/product/info/list", {
    offer_id: [offerId],
  });
  const item = response?.items?.[0] || null;
  return { created: item?.statuses?.is_created === true, item, errors: errorCodes(item) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceAuditPath = path.resolve(args.sourceAudit);
  const planPath = path.resolve(args.plan);
  const checkpointPath = path.resolve(args.checkpoint);
  const auditPath = path.resolve(args.audit);
  const [sourceAudit, plan, records, preferences] = await Promise.all([
    readJson(sourceAuditPath),
    readJson(planPath),
    prisma.ozonApiConfig.findMany(),
    localApi(args, "/api/listing-workflow/preferences"),
  ]);
  const storeById = new Map(records.map((record) => [record.id, {
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }]));
  const candidateBySku = new Map(
    (Array.isArray(plan?.candidates) ? plan.candidates : [])
      .map((candidate) => [text(candidate.sourceSku), candidate]),
  );
  const targets = (Array.isArray(sourceAudit?.stores) ? sourceAudit.stores : [])
    .flatMap((storeRow) =>
      (Array.isArray(storeRow?.goal?.products) ? storeRow.goal.products : [])
        .filter((product) => errorCodes(product).includes("image_absent"))
        .map((product) => {
          const sku = sourceSku(product.offerId);
          const candidate = candidateBySku.get(sku);
          return {
            key: `${storeRow.configId}:${product.offerId}`,
            storeId: storeRow.configId,
            storeName: storeRow.name,
            offerId: text(product.offerId),
            productId: text(product.productId),
            sourceSku: sku,
            sourceImage: normalizeSourceImage(candidate?.imageUrl ?? candidate?.image_url),
          };
        }),
    )
    .filter((target) => !args.offerId || target.offerId === args.offerId)
    .slice(0, args.limit);

  const checkpoint = await readJson(checkpointPath, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: "running",
    products: {},
  });
  checkpoint.status = args.dryRun ? "dry-run" : "running";
  checkpoint.targetCount = targets.length;
  const save = async () => {
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
  };
  await save();

  let processed = 0;
  for (const target of targets) {
    const existing = checkpoint.products[target.key] || {};
    if (!args.dryRun && ["verified-created", "verification-pending"].includes(existing.status)) continue;
    const store = storeById.get(target.storeId);
    checkpoint.products[target.key] = {
      ...existing,
      ...target,
      status: args.dryRun ? "dry-run" : "running",
      updatedAt: new Date().toISOString(),
    };
    await save();
    if (args.dryRun) continue;
    try {
      if (!store) throw new Error("店铺配置不存在");
      if (!target.sourceImage) throw new Error("候选计划中缺少参考图");
      const current = await currentProduct(store, target.offerId);
      if (!current.info || !current.attributes) throw new Error("Ozon 商品信息或属性缺失");
      if (
        current.info?.statuses?.is_created === true
        && !errorCodes(current.info).includes("image_absent")
      ) {
        checkpoint.products[target.key] = {
          ...checkpoint.products[target.key],
          status: "verified-created",
          skippedGeneration: true,
          verifiedAt: new Date().toISOString(),
        };
        await save();
        continue;
      }
      let generation = existing.generation;
      if (existing.status === "failed") generation = null;
      if (!Array.isArray(generation?.urls) || generation.urls.length !== 4) {
        checkpoint.products[target.key].status = "generating";
        await save();
        generation = await generateFourImages(
          args,
          preferences,
          target.sourceImage,
        );
        checkpoint.products[target.key].generation = generation;
        checkpoint.products[target.key].status = "generated";
        await save();
      }
      const attributes = current.attributes;
      const info = current.info;
      const payload = {
        description_category_id: attributes.description_category_id,
        type_id: attributes.type_id,
        price: info.price,
        offer_id: target.offerId,
        name: attributes.name,
        currency_code: info.currency_code || "CNY",
        depth: attributes.depth,
        width: attributes.width,
        height: attributes.height,
        dimension_unit: attributes.dimension_unit,
        weight: attributes.weight,
        weight_unit: attributes.weight_unit,
        primary_image: generation.urls[0],
        images: generation.urls.slice(1),
        attributes: attributes.attributes || [],
        ...(attributes.complex_attributes?.length
          ? { complex_attributes: attributes.complex_attributes }
          : {}),
      };
      checkpoint.products[target.key].status = "submitting";
      await save();
      const submitted = await sellerRequest(store, "/v3/product/import", {
        items: [payload],
      });
      const taskId = submitted?.result?.task_id;
      const importItems = taskId ? await pollImport(store, taskId) : [];
      const terminal = importItems[0] || null;
      if (terminal?.status === "failed" || (terminal?.errors || []).length) {
        throw new Error(`Ozon 重提失败：${JSON.stringify(terminal)}`);
      }
      checkpoint.products[target.key] = {
        ...checkpoint.products[target.key],
        status: "submitted",
        taskId: taskId ? String(taskId) : null,
        importItems,
        submittedAt: new Date().toISOString(),
      };
      await save();
      // 导入任务返回 imported 且无错误后立即处理下一件，最后统一做严格图片审计；
      // 避免每件商品都串行等待 Ozon 图片异步处理两分钟。
      const verified = await verifyCreated(store, target.offerId, 1);
      checkpoint.products[target.key] = {
        ...checkpoint.products[target.key],
        status: verified.created ? "verified-created" : "verification-pending",
        remainingErrors: verified.errors,
        verifiedAt: new Date().toISOString(),
      };
      process.stdout.write(
        `${target.storeName} ${target.offerId}: ${
          verified.created ? "四张 AI 图片已补齐并创建成功" : "图片已提交，等待 Ozon 创建"
        }\n`,
      );
    } catch (error) {
      checkpoint.products[target.key] = {
        ...checkpoint.products[target.key],
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      };
      process.stderr.write(
        `${target.storeName} ${target.offerId}: ${checkpoint.products[target.key].error}\n`,
      );
    }
    processed += 1;
    await save();
  }

  const targetKeys = new Set(targets.map((target) => target.key));
  const rows = Object.values(checkpoint.products).filter((row) =>
    !args.offerId || targetKeys.has(row.key)
  );
  const counts = rows.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1;
    return result;
  }, {});
  checkpoint.status = args.dryRun
    ? "dry-run"
    : counts.failed
      ? "completed-with-errors"
      : (counts["verification-pending"] ? "verification-pending" : "completed");
  await save();
  const audit = {
    completedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    targetCount: targets.length,
    processedThisRun: processed,
    counts,
    checkpointPath,
    products: rows,
  };
  await writeJsonAtomic(auditPath, audit);
  console.log(JSON.stringify({
    completedAt: audit.completedAt,
    targetCount: audit.targetCount,
    processedThisRun: audit.processedThisRun,
    counts,
    auditPath,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
