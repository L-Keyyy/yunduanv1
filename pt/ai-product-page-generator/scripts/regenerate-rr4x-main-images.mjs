#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    prefix: "RR4X-",
    plan: "storage/ozon-500-round-robin-plan.json",
    checkpoint: "storage/rr4x-ai-image-replacement-checkpoint.json",
    audit: "storage/rr4x-ai-image-replacement-audit.json",
    selection: "",
    control: "",
    limit: Number.POSITIVE_INFINITY,
    maxAttempts: 3,
    imageProvider: "browser-webai",
    imageModel: "doubao-image-web",
    fallbackImageProvider: "browser-webai",
    fallbackImageModel: "gpt-image-1.5",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--base-url") args.baseUrl = argv[++index];
    else if (token === "--prefix") args.prefix = argv[++index];
    else if (token === "--plan") args.plan = argv[++index];
    else if (token === "--checkpoint") args.checkpoint = argv[++index];
    else if (token === "--audit") args.audit = argv[++index];
    else if (token === "--selection") args.selection = argv[++index];
    else if (token === "--control") args.control = argv[++index];
    else if (token === "--limit") args.limit = Number(argv[++index]);
    else if (token === "--max-attempts") args.maxAttempts = Number(argv[++index]);
    else if (token === "--image-provider") args.imageProvider = argv[++index];
    else if (token === "--image-model") args.imageModel = argv[++index];
    else if (token === "--fallback-image-provider") args.fallbackImageProvider = argv[++index];
    else if (token === "--fallback-image-model") args.fallbackImageModel = argv[++index];
    else throw new Error(`未知参数：${token}`);
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function decrypt(value) {
  const [ivHex, tagHex, encryptedHex] = String(value || "").split(":");
  const key = crypto
    .createHash("sha256")
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

function textValue(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sourceSkuFromOffer(offerId) {
  return textValue(offerId).match(/(\d{6,})$/)?.[1] || "";
}

function supplierOfferId(url) {
  return textValue(url).match(/(?:offerId=|offer\/)(\d{5,30})/i)?.[1] || "";
}

function primaryImage(item) {
  return Array.isArray(item?.primary_image)
    ? textValue(item.primary_image[0])
    : textValue(item?.primary_image);
}

function existingImages(item) {
  return Array.from(new Set([
    primaryImage(item),
    ...(Array.isArray(item?.images) ? item.images.map(textValue) : []),
  ].filter(Boolean)));
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function localApi(args, pathname, init = {}) {
  const url = new URL(pathname, `${args.baseUrl}/`);
  const body = init.body ? String(init.body) : "";
  const payload = await new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: init.method || "GET",
      headers: {
        ...(body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : {}),
        ...(init.headers || {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode || 500;
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
        } catch (error) {
          reject(error);
          return;
        }
        if (status >= 400 || !parsed?.success) {
          const error = new Error(parsed?.error?.message || `HTTP ${status}: ${pathname}`);
          error.status = status;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    request.setTimeout(init.timeoutMs || 15 * 60_000, () => {
      request.destroy(new Error(`本地图片接口等待超时：${pathname}`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
  return payload.data;
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
      if (Number(error?.status || 0) >= 400 && Number(error?.status || 0) < 500 && Number(error?.status || 0) !== 429) {
        throw error;
      }
    }
    await delay(attempt * 1500);
  }
  throw lastError || new Error(`${endpoint} 请求失败`);
}

async function listProducts(store, prefix) {
  const items = [];
  let lastId = "";
  do {
    const payload = await sellerRequest(store, "/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    });
    const result = payload?.result || payload || {};
    const page = Array.isArray(result.items) ? result.items : [];
    items.push(...page.filter((item) => textValue(item.offer_id).startsWith(prefix)));
    const next = textValue(result.last_id);
    if (!page.length || !next || next === lastId) break;
    lastId = next;
  } while (true);
  return items;
}

async function productInfo(store, offerIds) {
  const items = [];
  for (const batch of chunks(offerIds, 100)) {
    const payload = await sellerRequest(store, "/v3/product/info/list", {
      offer_id: batch,
    });
    items.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return items;
}

async function productPictures(store, productIds) {
  const items = [];
  for (const batch of chunks(productIds, 100)) {
    const payload = await sellerRequest(store, "/v2/product/pictures/info", {
      product_id: batch.map(Number),
    });
    items.push(...(Array.isArray(payload?.items) ? payload.items : []));
  }
  return items;
}

function processedPictureImages(item) {
  return Array.from(new Set([
    ...(Array.isArray(item?.primary_photo) ? item.primary_photo : []),
    ...(Array.isArray(item?.color_photo) ? item.color_photo : []),
    ...(Array.isArray(item?.photo) ? item.photo : []),
  ].map(textValue).filter(Boolean)));
}

function processedPrimaryImage(item) {
  return Array.isArray(item?.primary_photo)
    ? textValue(item.primary_photo[0])
    : "";
}

function buildCandidateMap(plan) {
  const rows = Array.isArray(plan?.candidates) ? plan.candidates : [];
  return new Map(rows.map((row) => [textValue(row.sourceSku), row]));
}

function bestPlanImage(candidate) {
  const url = textValue(candidate?.imageUrl ?? candidate?.image_url);
  if (!/^https:\/\//i.test(url)) return "";
  // 1688 缩略图常见为 `name.jpg_460x460q100.jpg`；只删尺寸片段会得到
  // `name.jpg.jpg` 并触发 404，因此连同重复扩展名一起还原原图地址。
  return url.replace(
    /\.(jpe?g|png|webp)_\d+x\d+(?:q\d+)?\.(?:jpe?g|png|webp)(?=$|[?#])/i,
    ".$1",
  );
}

async function isReachableImage(url) {
  if (!/^https:\/\//i.test(textValue(url))) return false;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Range: "bytes=0-2047",
      },
      signal: AbortSignal.timeout(20_000),
    });
    const contentType = textValue(response.headers.get("content-type"));
    await response.body?.cancel().catch(() => undefined);
    return response.ok && contentType.startsWith("image/");
  } catch {
    return false;
  }
}

async function referenceImage(candidate, fallbackImage) {
  const planned = bestPlanImage(candidate);
  const candidates = /alicdn\.com|1688\.com/i.test(planned)
    ? [planned, fallbackImage]
    : [fallbackImage, planned];
  for (const value of candidates) {
    if (await isReachableImage(value)) return value;
  }
  return "";
}

function isQuotaMessage(message) {
  return /(额度|次数.*(?:用完|耗尽|上限)|今日.*上限|quota|insufficient.*credit|usage.*limit|rate.*limit)/i.test(message);
}

function isLoginMessage(message) {
  return /(登录|登陆|login|sign\s*in|session.*expired|会话.*失效)/i.test(message);
}

async function generateImagesWithModel(args, preferences, sourceImage, selection) {
  const config = asRecord(asRecord(preferences.stageAiPrompts).imageGeneration);
  const prompt = textValue(config.prompt);
  if (!prompt) throw new Error("主页图片提示词为空。");
  const result = await localApi(args, "/api/listing-workflow/image-generate", {
    method: "POST",
    body: JSON.stringify({
      providerId: selection.providerId,
      model: selection.model,
      prompt,
      aspectRatio: "3:4",
      referenceImages: sourceImage ? [sourceImage] : [],
      useReferenceImages: Boolean(sourceImage),
      splitGrid: true,
    }),
    timeoutMs: 15 * 60_000,
  });
  const grid = Array.isArray(result?.gridImages)
    ? [...result.gridImages].sort((left, right) => Number(left.index) - Number(right.index))
    : [];
  const urls = grid.map((image) => textValue(image.imageUrl)).filter(Boolean);
  if (urls.length !== 4) {
    throw new Error(`${selection.model} 结果没有得到完整四张裁剪图（当前 ${urls.length} 张）。`);
  }
  if (!urls.every((url) => /^https:\/\//i.test(url))) {
    throw new Error("生成图只保存在本地，固定图片地址尚未发布成功。");
  }
  return {
    urls,
    providerId: selection.providerId,
    model: textValue(result?.model) || selection.model,
    gridSource: result.gridSource || null,
    warnings: result.warnings || [],
    generatedAt: new Date().toISOString(),
  };
}

async function generateImages(args, preferences, sourceImage, preferFallback = false) {
  if (!sourceImage) {
    throw new Error("缺少可访问的商品参考图，本轮已保留原卡等待重试。");
  }
  const primary = {
    providerId: args.imageProvider,
    model: args.imageModel,
    fallback: false,
  };
  const fallback = {
    providerId: args.fallbackImageProvider,
    model: args.fallbackImageModel,
    fallback: true,
  };
  const selections = preferFallback ? [fallback] : [primary, fallback];
  const errors = [];
  for (const selection of selections) {
    if (!selection.model) continue;
    if (
      errors.length > 0
      && selection.providerId === primary.providerId
      && selection.model === primary.model
    ) continue;
    try {
      const result = await generateImagesWithModel(
        args,
        preferences,
        sourceImage,
        selection,
      );
      return {
        ...result,
        fallbackUsed: selection.fallback || result.model !== primary.model,
        primaryError: errors[0]?.message || null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ selection, message, error });
      if (!selection.fallback) {
        process.stderr.write(
          `[${new Date().toISOString()}] ${selection.model} 生图未完成，切换 ${fallback.model}：${message}\n`,
        );
      }
    }
  }
  const final = errors.at(-1);
  const failure = new Error(
    errors.map(({ selection, message }) => `${selection.model}: ${message}`).join("；"),
  );
  failure.pauseStatus = isQuotaMessage(final?.message || "")
    ? "paused_quota"
    : isLoginMessage(final?.message || "")
      ? "paused_login"
      : "failed";
  throw failure;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkpointPath = path.resolve(args.checkpoint);
  const auditPath = path.resolve(args.audit);
  const plan = await readJson(path.resolve(args.plan), null);
  const candidateBySku = buildCandidateMap(plan);
  const preferences = await localApi(args, "/api/listing-workflow/preferences");
  // 店铺管理中的“当前”只决定前端默认店铺；换图队列覆盖全部已保存店铺。
  const records = await prisma.ozonApiConfig.findMany({
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });
  const stores = records.map((record) => ({
    ...record,
    apiKey: decrypt(record.apiKeyEncrypted),
  }));
  let targets = [];
  for (const store of stores) {
    const listed = await listProducts(store, args.prefix);
    const info = await productInfo(
      store,
      listed.map((item) => textValue(item.offer_id)).filter(Boolean),
    );
    const createdInfo = info.filter((item) => item?.statuses?.is_created === true);
    const pictures = await productPictures(
      store,
      createdInfo.map((item) => textValue(item.id ?? item.product_id)).filter(Boolean),
    );
    const pictureByProduct = new Map(
      pictures.map((item) => [textValue(item.product_id), item]),
    );
    const processedPrimaryUrls = Array.from(new Set(
      pictures.map(processedPrimaryImage).filter(Boolean),
    ));
    const reachablePrimary = new Map(await Promise.all(
      processedPrimaryUrls.map(async (url) => [url, await isReachableImage(url)]),
    ));
    for (const item of createdInfo) {
      // 失败卡尚未形成可更新的商品，图片接口会返回 VALIDATION ERROR；
      // 当前队列只处理已经创建的店铺商品，失败卡由独立重建流程处理。
      const offerId = textValue(item.offer_id);
      const productId = textValue(item.id ?? item.product_id);
      if (!offerId || !productId || productId === "0") continue;
      const sourceSku = sourceSkuFromOffer(offerId);
      const candidate = candidateBySku.get(sourceSku) || null;
      const supplierId = supplierOfferId(candidate?.supplierUrl);
      const picture = pictureByProduct.get(productId) || null;
      const processedPrimary = processedPrimaryImage(picture);
      const processedImages = processedPictureImages(picture);
      const imageErrors = (Array.isArray(item?.errors) ? item.errors : []).filter(
        (error) => /image/i.test(textValue(error?.code)),
      );
      targets.push({
        key: `${store.id}:${offerId}`,
        generationKey: supplierId ? `1688:${supplierId}` : `ozon:${sourceSku}`,
        store,
        storeId: store.id,
        storeName: store.name,
        offerId,
        productId,
        isCreated: item?.statuses?.is_created === true,
        sourceSku,
        supplierOfferId: supplierId,
        candidate,
        referencePrimaryImage: processedPrimary || primaryImage(item),
        currentPrimaryImage: processedPrimary,
        currentImages: processedImages,
        displayReady: Boolean(
          processedPrimary
          && reachablePrimary.get(processedPrimary)
          && imageErrors.length === 0,
        ),
        imageErrors,
        pictureErrors: Array.isArray(picture?.errors) ? picture.errors : [],
      });
    }
  }
  // 以 Ozon 已处理且实际可访问的图片为准，不把“接口字段有 URL”当成可显示。
  targets.sort((left, right) =>
    Number(left.displayReady) - Number(right.displayReady)
    || left.currentImages.length - right.currentImages.length
    || left.storeName.localeCompare(right.storeName, "zh-CN")
    || left.offerId.localeCompare(right.offerId),
  );
  if (args.selection) {
    const selection = await readJson(path.resolve(args.selection), null);
    const selectedKeys = new Set(
      (Array.isArray(selection?.products) ? selection.products : [])
        .map((item) => `${textValue(item.storeId)}:${textValue(item.offerId)}`),
    );
    targets = targets.filter((target) => selectedKeys.has(target.key));
  }
  const existing = await readJson(checkpointPath, null);
  const checkpoint = existing || {
    schemaVersion: 1,
    mode: "existing-product-image-replacement",
    callsFeatureAi: false,
    callsProductImport: false,
    status: "running",
    createdAt: new Date().toISOString(),
    generations: {},
    products: {},
  };
  targets = targets.map((target) => {
    const savedGenerationKey = checkpoint.products[target.key]?.generationKey;
    return savedGenerationKey
      && checkpoint.generations[savedGenerationKey]?.status === "generated"
      ? { ...target, generationKey: savedGenerationKey }
      : target;
  });
  // 先重传已有四张生成图的显示异常商品，避免为可直接修复的卡片再次等待生图。
  targets.sort((left, right) =>
    Number(checkpoint.generations[left.generationKey]?.status !== "generated")
    - Number(checkpoint.generations[right.generationKey]?.status !== "generated")
    || Number(left.displayReady) - Number(right.displayReady)
    || left.currentImages.length - right.currentImages.length
    || left.storeName.localeCompare(right.storeName, "zh-CN")
    || left.offerId.localeCompare(right.offerId),
  );
  checkpoint.status = "running";
  checkpoint.updatedAt = new Date().toISOString();
  const save = async () => {
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
  };
  await save();

  const groups = [...targets.reduce((map, target) => {
    const list = map.get(target.generationKey) || [];
    list.push(target);
    map.set(target.generationKey, list);
    return map;
  }, new Map()).entries()];
  let processedGroups = 0;
  let quotaPaused = false;

  outer:
  for (const [generationKey, group] of groups) {
    if (args.control) {
      const control = await readJson(path.resolve(args.control), {});
      if (control?.pauseRequested === true) {
        checkpoint.status = "paused";
        checkpoint.pausedAt = new Date().toISOString();
        checkpoint.pauseReason = textValue(control.reason) || "用户暂停图片重生队列";
        await save();
        break;
      }
    }
    if (processedGroups >= args.limit) break;
    // Ozon 的导入接口先返回已接收，随后仍可能抓图失败；以实时图片状态为准，
    // 避免检查点写成 uploaded 后永久跳过仍然缺图的商品。
    const pendingProducts = group.filter((target) => {
      const saved = checkpoint.products[target.key];
      return saved?.status !== "uploaded"
        || !target.displayReady
        || target.currentImages.length < 4;
    });
    if (!pendingProducts.length) continue;
    let generation = checkpoint.generations[generationKey];
    if (generation?.status !== "generated") {
      const attempts = Number(generation?.attempts || 0);
      const fallbackAttempts = Number(generation?.fallbackAttempts || 0);
      const preferFallback = checkpoint.primaryQuotaExhausted === true
        || attempts >= args.maxAttempts
        || isQuotaMessage(textValue(generation?.error));
      if (preferFallback && fallbackAttempts >= args.maxAttempts) continue;
      const sample = group[0];
      const sourceImage = await referenceImage(
        sample.candidate,
        sample.referencePrimaryImage,
      );
      generation = {
        ...generation,
        status: "generating",
        attempts: attempts + (preferFallback ? 0 : 1),
        fallbackAttempts: fallbackAttempts + 1,
        sourceImage,
        supplierOfferId: sample.supplierOfferId || null,
        sourceSku: sample.sourceSku,
        startedAt: new Date().toISOString(),
      };
      checkpoint.generations[generationKey] = generation;
      await save();
      try {
        const result = args.dryRun
          ? {
              urls: [sourceImage],
              providerId: args.imageProvider,
              model: args.imageModel,
              fallbackUsed: false,
              gridSource: null,
              warnings: ["dry-run"],
              generatedAt: new Date().toISOString(),
            }
          : await generateImages(args, preferences, sourceImage, preferFallback);
        generation = {
          ...generation,
          ...result,
          status: "generated",
          completedAt: new Date().toISOString(),
          error: null,
        };
        if (result.fallbackUsed && isQuotaMessage(textValue(result.primaryError))) {
          checkpoint.primaryQuotaExhausted = true;
          checkpoint.primaryQuotaDetectedAt = new Date().toISOString();
        }
        checkpoint.generations[generationKey] = generation;
        await save();
        process.stdout.write(
          `[${new Date().toISOString()}] ${generationKey} ${result.model} 生图完成，关联 ${group.length} 个原商品${result.fallbackUsed ? "（GPT 兜底）" : ""}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isQuotaMessage(message)) {
          checkpoint.primaryQuotaExhausted = true;
          checkpoint.primaryQuotaDetectedAt = new Date().toISOString();
        }
        const pauseStatus = textValue(error?.pauseStatus) || (isQuotaMessage(message)
          ? "paused_quota"
          : isLoginMessage(message)
            ? "paused_login"
            : "failed");
        checkpoint.generations[generationKey] = {
          ...generation,
          status: pauseStatus,
          error: message,
          updatedAt: new Date().toISOString(),
        };
        if (pauseStatus.startsWith("paused_")) {
          checkpoint.status = pauseStatus;
          checkpoint.pausedAt = new Date().toISOString();
          checkpoint.pauseReason = message;
          quotaPaused = pauseStatus === "paused_quota";
          await save();
          break outer;
        }
        await save();
        process.stderr.write(`[${new Date().toISOString()}] ${generationKey} 生图失败：${message}\n`);
        processedGroups += 1;
        continue;
      }
    }

    for (const target of pendingProducts) {
      const generatedUrls = Array.isArray(generation.urls) ? generation.urls : [];
      const retained = target.currentImages.filter((url) =>
        url !== target.currentPrimaryImage && !generatedUrls.includes(url),
      );
      const uploadImages = [...generatedUrls, ...retained].slice(0, 30);
      try {
        const response = args.dryRun
          ? { dryRun: true }
          : await sellerRequest(target.store, "/v1/product/pictures/import", {
              product_id: Number(target.productId),
              images: uploadImages,
            });
        checkpoint.products[target.key] = {
          storeId: target.storeId,
          storeName: target.storeName,
          offerId: target.offerId,
          productId: target.productId,
          generationKey,
          status: args.dryRun ? "dry-run" : "uploaded",
          oldPrimaryImage: target.currentPrimaryImage,
          newPrimaryImage: generatedUrls[0] || "",
          generatedImageUrls: generatedUrls,
          generationProviderId: generation.providerId || null,
          generationModel: generation.model || null,
          fallbackUsed: generation.fallbackUsed === true,
          retainedOldImageCount: retained.length,
          uploadedAt: new Date().toISOString(),
          response,
        };
        process.stdout.write(`[${new Date().toISOString()}] ${target.storeName} ${target.offerId} 主图替换已提交\n`);
      } catch (error) {
        checkpoint.products[target.key] = {
          storeId: target.storeId,
          storeName: target.storeName,
          offerId: target.offerId,
          productId: target.productId,
          generationKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        };
      }
      await save();
    }
    processedGroups += 1;
  }

  if (!checkpoint.status.startsWith("paused")) {
    const unfinished = targets.filter((target) => {
      const saved = checkpoint.products[target.key];
      return saved?.status !== "uploaded"
        || !target.displayReady
        || target.currentImages.length < 4;
    }).length;
    checkpoint.status = unfinished ? "running" : "completed";
  }
  const generationStatuses = Object.values(checkpoint.generations).reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1;
    return result;
  }, {});
  const productStatuses = Object.values(checkpoint.products).reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1;
    return result;
  }, {});
  const audit = {
    generatedAt: new Date().toISOString(),
    status: checkpoint.status,
    prefix: args.prefix,
    callsFeatureAi: false,
    callsProductImport: false,
    existingCreatedProducts: targets.length,
    uniqueGenerationGroups: groups.length,
    primaryImageModel: args.imageModel,
    fallbackImageModel: args.fallbackImageModel,
    processedGroupsThisRun: processedGroups,
    generationStatuses,
    productStatuses,
    checkpointPath,
    quotaPaused,
    primaryQuotaExhausted: checkpoint.primaryQuotaExhausted === true,
    pauseReason: checkpoint.pauseReason || null,
  };
  await save();
  await writeJsonAtomic(auditPath, audit);
  console.log(JSON.stringify(audit, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
