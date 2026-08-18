#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import http from "node:http";
import https from "node:https";

import {
  SerialCheckpointQueue,
  asRecord,
  chooseSingleVariant,
  domesticFreightCny,
  isPetToyProduct,
  overrideBatchFeatures,
  readJsonFile,
  selectExactlyOneSku,
  stableBatchOfferId,
  textValue,
  tripledCnyPrice,
  variantId,
  workflowImageUrls,
} from "./lib/pet-toy-batch.mjs";

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    manifest: "storage/pet-toy-batch/sources.json",
    checkpoint: "storage/pet-toy-batch/checkpoint.json",
    limit: 100,
    maxAttempts: 3,
    submit: false,
    generateImages: true,
    translateSelected: true,
    precomputedAiFile: "",
    precomputedAiText: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--submit") args.submit = true;
    else if (token === "--skip-images") args.generateImages = false;
    else if (token === "--skip-translation") args.translateSelected = false;
    else if (token === "--base-url") args.baseUrl = argv[++index];
    else if (token === "--manifest") args.manifest = argv[++index];
    else if (token === "--checkpoint") args.checkpoint = argv[++index];
    else if (token === "--precomputed-ai-file") args.precomputedAiFile = argv[++index];
    else if (token === "--limit") args.limit = Number(argv[++index]);
    else if (token === "--max-attempts") args.maxAttempts = Number(argv[++index]);
    else throw new Error(`未知参数：${token}`);
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

async function api(args, pathname, init = {}) {
  const url = new URL(pathname, `${args.baseUrl}/`);
  const body = init.body ? String(init.body) : "";
  const timeoutMs = init.timeoutMs || 8 * 60_000;
  const payload = await new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: init.method || "GET",
        headers: {
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
          ...(init.headers || {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            reject(new Error(`接口没有返回 JSON：${pathname}`));
            return;
          }
          if ((response.statusCode || 500) >= 400 || !parsed?.success) {
            reject(
              new Error(
                parsed?.error?.message || `HTTP ${response.statusCode}: ${pathname}`,
              ),
            );
            return;
          }
          resolve(parsed);
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`本地接口等待超时（${timeoutMs}ms）：${pathname}`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
  return payload.data;
}

async function patchItem(args, itemId, body) {
  return api(args, `/api/listing-workflow/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function findWorkflowItem(args, input) {
  if (input.workflowItemId) {
    return api(args, `/api/listing-workflow/items/${encodeURIComponent(input.workflowItemId)}`);
  }
  const items = await api(args, "/api/listing-workflow/items");
  const item = items.find((candidate) =>
    (input.offerId && candidate.offerId === input.offerId) ||
    (input.sourceUrl && candidate.sourceUrl === input.sourceUrl)
  );
  if (!item) throw new Error(`采集阶段未找到商品：${input.offerId || input.sourceUrl}`);
  return item;
}

function selectedTranslationImages(item, sourceImages) {
  const workflow = asRecord(asRecord(item.scrapedData).workflowImages);
  const selectedIds = new Set(
    Array.isArray(workflow.selectedImageIds) ? workflow.selectedImageIds.map(textValue) : [],
  );
  if (!selectedIds.size || !Array.isArray(workflow.items)) return [];
  const primary = sourceImages[0];
  return workflow.items
    .map(asRecord)
    .filter((image) => selectedIds.has(textValue(image.id)))
    .map((image) => ({
      id: textValue(image.id),
      name: textValue(image.name) || "pet-toy.jpg",
      url: textValue(image.url),
    }))
    .filter((image) => image.url && image.url !== primary)
    .slice(0, 20);
}

async function translateImages(args, item, images, runId) {
  if (!args.translateSelected || !images.length) return [];
  const translated = await api(args, "/api/listing-workflow/image-translate-atlas", {
    method: "POST",
    body: JSON.stringify({
      images,
      targetLanguage: "ru",
      workflowItemId: item.id,
      workflowRunId: runId,
      workflowTranslationTotal: images.length,
    }),
  });
  return Array.isArray(translated.images)
    ? translated.images.map((image) => textValue(image.imageUrl)).filter(Boolean)
    : [];
}

async function publicImageReachable(imageUrl, timeoutMs = 10_000) {
  if (!/^https?:\/\//i.test(imageUrl || "")) return false;
  const url = new URL(imageUrl);
  return new Promise((resolve) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { method: "HEAD" },
      (response) => {
        response.resume();
        resolve((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 400);
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

async function generateMainImage(args, item, sourceImage, runId) {
  if (!args.generateImages) return sourceImage ? [sourceImage] : [];
  try {
    const imageGeneration = asRecord(args.stageAiPrompts?.imageGeneration);
    const prompt = textValue(imageGeneration.prompt);
    if (!prompt) {
      throw new Error("全局主图提示词为空，请先在主页保存主图提示词。");
    }
    const aspectRatio = ["1:1", "3:4", "9:16"].includes(
      textValue(imageGeneration.aspectRatio),
    )
      ? textValue(imageGeneration.aspectRatio)
      : "1:1";
    const useReferenceImages =
      typeof imageGeneration.useReference === "boolean"
        ? imageGeneration.useReference
        : true;
    const generated = await api(args, "/api/listing-workflow/image-generate", {
      method: "POST",
      body: JSON.stringify({
        providerId: "browser-webai",
        model: "doubao-image-web",
        // 批处理和网页加工共用主页保存的最新全局提示词，不再覆盖成白底模板。
        prompt,
        aspectRatio,
        referenceImages: sourceImage ? [sourceImage] : [],
        useReferenceImages: useReferenceImages && Boolean(sourceImage),
        workflowItemId: item.id,
        workflowRunId: runId,
        splitGrid: true,
      }),
    });
    const outputs = Array.isArray(generated.gridImages) && generated.gridImages.length === 4
      ? [...generated.gridImages].sort((left, right) => left.index - right.index)
      : [generated];
    const publicUrls = outputs
      .map((output) => textValue(output.imageUrl))
      .filter(Boolean);
    if (
      publicUrls.length === outputs.length &&
      (await Promise.all(publicUrls.map(publicImageReachable))).every(Boolean)
    ) {
      return publicUrls;
    }
    if (publicUrls.length) {
      process.stderr.write(
        `[${new Date().toISOString()}] ${item.id} 生图公网地址当前不可达，本轮使用来源主图继续。\n`,
      );
    }
    return sourceImage ? [sourceImage] : [];
  } catch (error) {
    if (!sourceImage) throw error;
    process.stderr.write(
      `[${new Date().toISOString()}] ${item.id} 豆包主图生成异常，当前轮次使用来源主图继续：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return sourceImage ? [sourceImage] : [];
  }
}

async function waitForImport(args, taskId) {
  const deadline = Date.now() + 8 * 60_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await api(args, "/api/listing-workflow/ozon-import-status", {
      method: "POST",
      body: JSON.stringify({ taskId }),
      timeoutMs: 90_000,
    });
    if (last.terminal) return last;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Ozon task_id=${taskId} 在等待窗口内仍未结束：${JSON.stringify(last?.items || [])}`);
}

async function processProduct(args, input) {
  const original = await findWorkflowItem(args, input);
  if (!isPetToyProduct(original)) {
    throw new Error(`商品不是宠物玩具：${original.title}`);
  }
  const selectedVariant = chooseSingleVariant(original.scrapedData) || {
    skuId: `${original.offerId}-default`,
    sourceSkuId: `${original.offerId}-default`,
    specText: "默认款",
    sourceSpecText: "默认款",
    price: original.costPrice || original.currentPrice,
    stock: "999",
  };
  const selectedSkuId = variantId(selectedVariant) || original.offerId;
  const sourceCost = textValue(selectedVariant?.price || original.costPrice || original.currentPrice);
  const domesticFreight = domesticFreightCny(original.scrapedData);
  if (domesticFreight === null) {
    throw new Error("缺少 1688 国内运费，商品已转人工核价。 ");
  }
  const salePrice = tripledCnyPrice(sourceCost, domesticFreight);
  const offerId = stableBatchOfferId(original.offerId, selectedSkuId);
  const selectedData = selectExactlyOneSku(original.scrapedData, selectedVariant);
  const runId = `pet-toy-batch:${original.id}:${Date.now()}`;

  let item = await patchItem(args, original.id, {
    stage: "PROCESSING",
    status: "AI_RUNNING",
    currentPrice: salePrice,
    costPrice: sourceCost,
    scrapedData: {
      ...selectedData,
      stageAiPrompts: args.stageAiPrompts,
      petToyBatch: {
        runId,
        selectedSkuId,
        sourceCostCny: sourceCost,
        domesticFreightCny: domesticFreight,
        salePrice: salePrice,
        pricingRule: "(PURCHASE_CNY+DOMESTIC_FREIGHT_CNY)_X3",
        startedAt: new Date().toISOString(),
      },
    },
  });

  try {
    const sourceImages = workflowImageUrls(item);
    const quick = await api(args, "/api/listing-workflow/quick-match", {
      method: "POST",
      body: JSON.stringify({
        scrapedData: {
          ...asRecord(item.scrapedData),
          title: item.title,
          offerId: item.offerId,
          price: sourceCost,
          imageUrl: sourceImages[0] || item.imageUrl || "",
        },
        providerId: "browser-webai",
        model: "gpt-thinking",
        featureFillMode: "max",
        ...(args.precomputedAiText
          ? { precomputedAiText: args.precomputedAiText }
          : {}),
      }),
      // Keep the caller alive for the quick-match route's full browser retry
      // window plus response parsing/audit persistence.
      timeoutMs: 14 * 60_000,
    });
    if (!quick.category?.descriptionCategoryId || !quick.category?.typeId) {
      throw new Error("AI 返回缺少 Ozon descriptionCategoryId/typeId。");
    }

    const translatedImages = await translateImages(
      args,
      item,
      selectedTranslationImages(item, sourceImages),
      runId,
    );
    const generatedImages = await generateMainImage(
      args,
      item,
      sourceImages[0] || "",
      runId,
    );
    const primaryImage = generatedImages[0];
    if (!primaryImage) throw new Error("主图处理后没有得到可上传图片 URL。");
    const images = {
      primary_image: primaryImage,
      images: Array.from(new Set([
        ...generatedImages.slice(1),
        ...translatedImages,
        ...sourceImages.filter((url) => !generatedImages.includes(url)),
      ])).slice(0, 29),
    };
    const features = overrideBatchFeatures(quick.features, {
      categoryLabel: quick.category.label,
      descriptionCategoryId: quick.category.descriptionCategoryId,
      typeId: quick.category.typeId,
      offerId,
      title: textValue(
        quick.features?.find((feature) => textValue(feature.attributeId) === "4180")?.value,
      ) || item.title,
      costPrice: sourceCost,
      price: salePrice,
      currencyCode: "CNY",
      images,
    });
    item = await patchItem(args, item.id, {
      status: "MATCHED",
      categoryId: quick.category.id,
      categoryLabel: quick.category.label,
      categoryPath: quick.category.path,
      currentPrice: salePrice,
      features,
      aiResponse: {
        ...asRecord(item.aiResponse),
        ...asRecord(quick.aiResponse),
        petToyBatch: {
          runId,
          selectedSkuId,
          sourceCostCny: sourceCost,
          domesticFreightCny: domesticFreight,
          salePrice,
          pricingRule: "(PURCHASE_CNY+DOMESTIC_FREIGHT_CNY)_X3",
          generatedPrimaryImage: primaryImage,
          generatedImageUrls: generatedImages,
          generatedGridCount: generatedImages.length,
          imageGenerationFallback:
            generatedImages.length === 1 && primaryImage === (sourceImages[0] || ""),
          completedAt: new Date().toISOString(),
        },
      },
      notes: [
        ...(Array.isArray(quick.notes) ? quick.notes : []),
        "宠物玩具批处理：单商品只保留 1 个 SKU，售价=(采购人民币价格+单件国内运费)×3。",
        ...(generatedImages.length === 1 && primaryImage === (sourceImages[0] || "")
          ? ["豆包本轮主图结果未取回，已使用来源主图完成当前上架；保留后续改图重试标记。"]
          : []),
      ],
    });

    const importInput = {
      action: "preview",
      category: {
        descriptionCategoryId: quick.category.descriptionCategoryId,
        typeId: quick.category.typeId,
      },
      features,
      images,
    };
    const preview = await api(args, "/api/listing-workflow/ozon-import", {
      method: "POST",
      body: JSON.stringify(importInput),
    });
    if (preview.errors?.length) {
      throw new Error(`Ozon 预检失败：${preview.errors.join("；")}`);
    }
    if (!args.submit) {
      return {
        status: "previewed",
        workflowItemId: item.id,
        offerId,
        selectedSkuId,
        sourceCostCny: sourceCost,
        salePrice,
        primaryImage,
        warnings: preview.warnings,
      };
    }

    const submitted = await api(args, "/api/listing-workflow/ozon-import", {
      method: "POST",
      body: JSON.stringify({ ...importInput, action: "submit", confirmed: true }),
      timeoutMs: 150_000,
    });
    const taskId = submitted.taskId;
    const importStatus = await waitForImport(args, taskId);
    const importedItem = importStatus.items.find((candidate) => candidate.offer_id === offerId);
    if (importedItem?.status !== "imported") {
      throw new Error(`Ozon 导入失败：${JSON.stringify(importedItem || importStatus.items)}`);
    }
    await patchItem(args, item.id, {
      aiResponse: {
        ...asRecord(item.aiResponse),
        ozonImport: {
          taskId,
          offerId,
          status: "imported",
          productId: importedItem.product_id || null,
          importedAt: new Date().toISOString(),
        },
      },
    });
    return {
      status: "imported",
      workflowItemId: item.id,
      offerId,
      selectedSkuId,
      sourceCostCny: sourceCost,
      salePrice,
      primaryImage,
      taskId,
      productId: importedItem.product_id || null,
    };
  } catch (error) {
    await patchItem(args, item.id, {
      status: "AI_FAILED",
      notes: [
        ...(Array.isArray(item.notes) ? item.notes : []),
        `宠物玩具批处理失败：${error instanceof Error ? error.message : String(error)}`,
      ],
    }).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preferences = await api(args, "/api/listing-workflow/preferences");
  args.stageAiPrompts = asRecord(preferences.stageAiPrompts);
  if (!textValue(asRecord(args.stageAiPrompts.imageGeneration).prompt)) {
    throw new Error("主页尚未保存可用的主图提示词。");
  }
  if (args.precomputedAiFile) {
    const audit = await readJsonFile(path.resolve(args.precomputedAiFile), null);
    args.precomputedAiText = textValue(audit?.completionText ?? audit);
    if (!args.precomputedAiText) {
      throw new Error(`预计算 AI 文件中没有 completionText：${args.precomputedAiFile}`);
    }
  }
  const manifestPath = path.resolve(args.manifest);
  const checkpointPath = path.resolve(args.checkpoint);
  const manifest = await readJsonFile(manifestPath, null);
  if (!Array.isArray(manifest) || !manifest.length) {
    throw new Error(`批处理来源清单为空：${manifestPath}`);
  }
  const entries = manifest.slice(0, args.limit);
  const queue = new SerialCheckpointQueue({
    checkpointPath,
    maxAttempts: args.maxAttempts,
  });
  await queue.initialize(entries);
  const checkpoint = await queue.run(async (input, job) => {
    process.stdout.write(
      `[${new Date().toISOString()}] ${job.key} attempt=${job.attempts} start\n`,
    );
    const result = await processProduct(args, input);
    process.stdout.write(
      `[${new Date().toISOString()}] ${job.key} status=${result.status} offer=${result.offerId}\n`,
    );
    return result;
  });
  const summary = checkpoint.jobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});
  process.stdout.write(`${JSON.stringify({ checkpointPath, summary }, null, 2)}\n`);
  if (summary.failed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
