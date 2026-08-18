#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function isDoubaoQuotaError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /(?:豆包.*(?:额度|免费次数).*(?:用完|耗尽))|(?:今日图片生成免费次数用完)/i.test(
    message,
  );
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function api(baseUrl, pathname, init = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= (init.attempts || 4); attempt += 1) {
    try {
      const response = await fetch(new URL(pathname, `${baseUrl}/`), {
        method: init.method || "GET",
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs || 8 * 60_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.error?.message || `HTTP ${response.status}: ${pathname}`,
        );
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (isDoubaoQuotaError(error)) throw error;
      if (attempt < (init.attempts || 4)) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
  }
  throw lastError || new Error(`${pathname} 请求失败`);
}

function sourceImageUrls(item) {
  const data = asRecord(item.scrapedData);
  const detail = asRecord(data.detailCapture);
  const selectedVariant = asRecord(data.selectedVariant);
  const urls = [
    detail.imageUrl,
    ...(Array.isArray(detail.galleryImages) ? detail.galleryImages : []),
    ...(Array.isArray(detail.images) ? detail.images : []),
    ...(Array.isArray(selectedVariant.images) ? selectedVariant.images : []),
    ...(Array.isArray(data.gallery) ? data.gallery : []),
    ...(Array.isArray(data.images) ? data.images : []),
    item.imageUrl,
  ];
  return unique(urls).filter(
    (url) =>
      /^https?:\/\//i.test(url) &&
      !/raw\.githubusercontent\.com\/L-Keyyy\/ozon-product-images/i.test(url) &&
      !/cdn\.jsdelivr\.net\/gh\/L-Keyyy\/ozon-product-images@/i.test(url) &&
      !/(trycloudflare|pinggy\.net|\/api\/files\/generated\/listing-workflow)/i.test(url),
  );
}

function categoryInput(item) {
  const ai = asRecord(item.aiResponse);
  const quick = asRecord(ai.quickMode);
  const match = asRecord(ai.categoryMatch);
  const candidates = [
    asRecord(quick.category),
    asRecord(match.category),
    match,
  ];
  let descriptionCategoryId = null;
  let typeId = null;
  for (const candidate of candidates) {
    const description = Number(candidate.descriptionCategoryId);
    const type = Number(candidate.typeId);
    if (!descriptionCategoryId && Number.isSafeInteger(description) && description > 0) {
      descriptionCategoryId = description;
    }
    if (!typeId && Number.isSafeInteger(type) && type > 0) typeId = type;
  }
  return { descriptionCategoryId, typeId };
}

async function waitForImport(baseUrl, taskId) {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const result = await api(baseUrl, "/api/listing-workflow/ozon-import-status", {
      method: "POST",
      body: { taskId },
      timeoutMs: 90_000,
    });
    if (result.terminal) return result;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error(`Ozon task_id=${taskId} 等待超时`);
}

function generatedImageEntry(result, index = 0) {
  return {
    id: `generated:${result.filePath}`,
    name: result.fileName,
    url: result.imageUrl,
    label: index === 0 ? "AI 主图" : `AI 详情图 ${index}`,
    source: "generated",
  };
}

function generatedImageEntries(result) {
  const gridImages = Array.isArray(result?.gridImages)
    ? [...result.gridImages].sort((left, right) => left.index - right.index)
    : [];
  return (gridImages.length === 4 ? gridImages : [result]).map(
    generatedImageEntry,
  );
}

function translatedImageEntry(result, index) {
  return {
    id: `translated:${result.filePath}`,
    name: result.fileName,
    url: result.imageUrl,
    label: index === 0 ? "谷歌翻译主图" : `谷歌翻译图 ${index + 1}`,
    source: "translated",
  };
}

async function main() {
  const baseUrl = argValue("--base-url", "http://127.0.0.1:3000").replace(/\/+$/, "");
  const sourceCheckpointPath = path.resolve(
    argValue("--source-checkpoint", "storage/pet-toy-batch/production-checkpoint.json"),
  );
  const checkpointPath = path.resolve(
    argValue("--checkpoint", "storage/pet-toy-batch/regenerate-translate-upload-checkpoint.json"),
  );
  const controlPath = path.resolve(
    argValue("--control", "storage/pet-toy-batch/regenerate-upload-control.json"),
  );
  const imageMapPath = path.resolve(
    argValue("--image-map", "storage/pet-toy-batch/prompt-translated-image-map.json"),
  );
  const limit = Math.max(1, Number(argValue("--limit", "100")));
  const translateImages = !process.argv.includes("--skip-translation");
  const imageProvider = argValue("--image-provider", "browser-webai");
  const imageModel = argValue("--image-model", "gpt-image-1.5");
  const retryFailedOnly = process.argv.includes("--retry-failed-only");
  // Ozon 每张商品卡最多 15 张图片：1 张主图 + 14 张附图。
  const maxImages = Math.max(1, Math.min(15, Number(argValue("--max-images", "15"))));

  const [sourceCheckpoint, preferences, existingCheckpoint] = await Promise.all([
    readJson(sourceCheckpointPath, null),
    api(baseUrl, "/api/listing-workflow/preferences"),
    readJson(checkpointPath, { version: 1, jobs: {} }),
  ]);
  if (!sourceCheckpoint?.jobs?.length) throw new Error("生产批处理检查点为空");
  const prompts = asRecord(preferences.stageAiPrompts);
  const imageGeneration = asRecord(prompts.imageGeneration);
  const prompt = text(argValue("--prompt")) || text(imageGeneration.prompt);
  if (!prompt) throw new Error("主页全局主图提示词为空");
  const aspectRatio = ["1:1", "3:4", "9:16"].includes(text(imageGeneration.aspectRatio))
    ? text(imageGeneration.aspectRatio)
    : "1:1";
  const useReference = imageGeneration.useReference !== false;
  const effectiveStageAiPrompts = {
    ...prompts,
    imageGeneration: {
      ...imageGeneration,
      prompt,
      aspectRatio: "3:4",
    },
  };
  const importedSourceJobs = sourceCheckpoint.jobs.filter(
    (job) => job.status === "imported" && job.input?.workflowItemId,
  );
  const targetLimit = Number(existingCheckpoint.targetLimit) || limit;
  const targetSourceJobs = importedSourceJobs.slice(0, targetLimit);
  const failedItemIds = new Set(
    Object.values(asRecord(existingCheckpoint.jobs))
      .filter((job) => job?.status === "failed")
      .map((job) => text(job?.itemId)),
  );
  const sourceJobs = (retryFailedOnly
    ? targetSourceJobs.filter((job) =>
        failedItemIds.has(text(job.input?.workflowItemId)),
      )
    : importedSourceJobs
  ).slice(0, limit);
  const checkpoint = {
    version: 1,
    status: "running",
    pauseReason: null,
    pausedAt: null,
    prompt,
    aspectRatio,
    useReference,
    translateImages,
    imageProvider,
    imageModel,
    targetLimit,
    workerPid: process.pid,
    workerStartedAt: new Date().toISOString(),
    retryFailedOnly,
    maxImages,
    startedAt: existingCheckpoint.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobs: asRecord(existingCheckpoint.jobs),
  };

  const persist = async () => {
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
  };

  const pauseIfRequested = async () => {
    const control = asRecord(await readJson(controlPath, {}));
    if (control.pauseRequested !== true) return false;
    checkpoint.status = "paused";
    checkpoint.pauseReason =
      text(control.reason) || "用户已暂停队列，当前商品处理完成后停止";
    checkpoint.pausedAt = new Date().toISOString();
    checkpoint.workerPid = null;
    await persist();
    return true;
  };

  for (let productIndex = 0; productIndex < sourceJobs.length; productIndex += 1) {
    if (await pauseIfRequested()) break;
    const sourceJob = sourceJobs[productIndex];
    const itemId = sourceJob.input.workflowItemId;
    const previous = asRecord(checkpoint.jobs[itemId]);
    if (
      previous.status === "complete" &&
      previous.prompt === prompt &&
      previous.translateImages === translateImages &&
      previous.imageModel === imageModel &&
      previous.generated?.gridImages?.length === 4 &&
      ["uploaded", "processing"].includes(previous.ozonImageUpload?.status)
    ) {
      process.stdout.write(`[${productIndex + 1}/${sourceJobs.length}] ${itemId} 已完成，跳过\n`);
      continue;
    }
    const job = {
      ...previous,
      itemId,
      offerId: sourceJob.result?.offerId || "",
      prompt,
      translateImages,
      imageProvider,
      imageModel,
      status: "running",
      startedAt: previous.startedAt || new Date().toISOString(),
      error: null,
      translations: Array.isArray(previous.translations) ? previous.translations : [],
    };
    checkpoint.jobs[itemId] = job;
    await persist();

    try {
      const item = await api(baseUrl, `/api/listing-workflow/items/${encodeURIComponent(itemId)}`);
      const sourceImages = sourceImageUrls(item).slice(0, Math.max(maxImages - 1, 1));
      if (!sourceImages.length) throw new Error("没有找到可作为参考的1688商品图");
      process.stdout.write(
        `[${productIndex + 1}/${sourceJobs.length}] ${item.title} 生图，提示词=${prompt}\n`,
      );

      const generationPrompt = `${prompt}\n商品名称：${item.title}`;

      if (
        !job.generated ||
        job.generated.prompt !== generationPrompt ||
        job.generated.model !== imageModel ||
        job.generated.gridImages?.length !== 4
      ) {
        job.generated = await api(baseUrl, "/api/listing-workflow/image-generate", {
          method: "POST",
          body: {
            providerId: imageProvider,
            model: imageModel,
            prompt: generationPrompt,
            aspectRatio,
            referenceImages: useReference ? [sourceImages[0]] : [],
            useReferenceImages: useReference,
            splitGrid: true,
          },
          timeoutMs: 8 * 60_000,
          attempts: 1,
        });
        await persist();
      }

      const generatedImages = generatedImageEntries(job.generated);
      const translationSources = [...generatedImages, ...sourceImages.map((url, index) => ({
        id: `source:${index}:${url}`,
        name: `source-${index + 1}.jpg`,
        url,
      }))].slice(0, maxImages);
      const translated = [];
      if (translateImages) {
        for (let imageIndex = 0; imageIndex < translationSources.length; imageIndex += 1) {
          const source = translationSources[imageIndex];
          const saved = asRecord(job.translations[imageIndex]);
          if (saved.sourceUrl === source.url && saved.result?.imageUrl) {
            translated.push(saved.result);
            continue;
          }
          process.stdout.write(
            `  Google 串行翻译 ${imageIndex + 1}/${translationSources.length}: ${source.name}\n`,
          );
          const result = await api(baseUrl, "/api/listing-workflow/image-translate-atlas", {
            method: "POST",
            body: {
              images: [{ id: source.id, name: source.name, url: source.url }],
              targetLanguage: "ru",
            },
            timeoutMs: 8 * 60_000,
            attempts: 5,
          });
          const translatedImage = result.images?.[0];
          if (!translatedImage?.imageUrl) throw new Error(`第 ${imageIndex + 1} 张谷歌翻译没有返回图片`);
          job.translations[imageIndex] = {
            sourceUrl: source.url,
            result: translatedImage,
            completedAt: new Date().toISOString(),
          };
          translated.push(translatedImage);
          await persist();
        }
        job.translations = job.translations.slice(0, translationSources.length);
      } else {
        job.translations = [];
      }
      const managedImages = translateImages
        ? translated.map(translatedImageEntry)
        : [
            ...generatedImages,
            ...translationSources.slice(generatedImages.length).map((source, index) => ({
              id: source.id,
              name: source.name,
              url: source.url,
              label: `商品图 ${index + generatedImages.length + 1}`,
              source: "crawler",
            })),
          ].slice(0, maxImages);
      const finalUrls = managedImages.map((image) => image.url);
      if (!finalUrls.length) throw new Error("谷歌串行翻译后没有可上传图片");

      const scrapedData = asRecord(item.scrapedData);
      const storedWorkflow = asRecord(scrapedData.workflowImages);
      const patched = await api(baseUrl, `/api/listing-workflow/items/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        body: {
          imageUrl: finalUrls[0],
          scrapedData: {
            ...scrapedData,
            stageAiPrompts: effectiveStageAiPrompts,
            gallery: finalUrls,
            images: finalUrls,
            imageUrls: finalUrls,
            workflowImages: {
              ...storedWorkflow,
              items: managedImages,
              primaryImageUrl: finalUrls[0],
              selectedImageIds: managedImages.map((image) => image.id),
              selectedImageUrls: finalUrls,
              updatedAt: new Date().toISOString(),
            },
          },
          aiResponse: {
            ...asRecord(item.aiResponse),
            regeneratedTranslatedImages: {
              prompt,
              generatedImageUrl: job.generated.imageUrl,
              googleSerial: translateImages,
              translationPaused: !translateImages,
              translatedCount: translateImages ? finalUrls.length : 0,
              completedAt: new Date().toISOString(),
            },
          },
        },
      });

      const itemOzonImport = asRecord(asRecord(item.aiResponse).ozonImport);
      const knownProductId =
        job.productId ||
        sourceJob.result?.productId ||
        itemOzonImport.productId ||
        null;
      let submittedTaskId = job.taskId || null;
      let productId = knownProductId;
      let ozonImageUpload = null;

      if (knownProductId) {
        process.stdout.write(`  四张裁剪图完成，直接更新 Ozon 商品图片\n`);
        ozonImageUpload = await api(
          baseUrl,
          "/api/listing-workflow/ozon-image-upload",
          {
            method: "POST",
            body: {
              listingWorkflowItemId: itemId,
              offerId: sourceJob.result?.offerId || itemOzonImport.offerId,
              productId: knownProductId,
              imageUrls: finalUrls,
            },
            timeoutMs: 3 * 60_000,
            attempts: 5,
          },
        );
        productId = ozonImageUpload.productId;
      } else {
        // 商品第一次进入 Ozon 时仍走完整导入；后续裁剪图更新只走图片专用接口。
        const importInput = {
          category: categoryInput(patched),
          features: patched.features || [],
          images: {
            primary_image: finalUrls[0],
            images: finalUrls.slice(1, 15),
          },
        };
        const preview = await api(baseUrl, "/api/listing-workflow/ozon-import", {
          method: "POST",
          body: { ...importInput, action: "preview" },
        });
        if (preview.errors?.length) throw new Error(`Ozon预检失败：${preview.errors.join("；")}`);
        const submitted = await api(baseUrl, "/api/listing-workflow/ozon-import", {
          method: "POST",
          body: { ...importInput, action: "submit", confirmed: true },
          timeoutMs: 150_000,
        });
        submittedTaskId = submitted.taskId;
        const status = await waitForImport(baseUrl, submitted.taskId);
        const imported = status.items?.find(
          (candidate) => candidate.offer_id === sourceJob.result?.offerId,
        ) || status.items?.[0];
        if (imported?.status !== "imported") {
          throw new Error(`Ozon图片更新失败：${JSON.stringify(imported || status.items)}`);
        }
        productId = imported.product_id || null;
        ozonImageUpload = {
          status: "uploaded",
          productId,
          offerId: imported.offer_id || sourceJob.result?.offerId || "",
          imageCount: finalUrls.length,
          primaryImageUrl: finalUrls[0],
          imageUrls: finalUrls,
          submittedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          via: "product-import",
        };
      }

      job.status = "complete";
      job.taskId = submittedTaskId;
      job.productId = productId;
      job.ozonImageUpload = ozonImageUpload;
      job.finalImages = finalUrls;
      job.completedAt = new Date().toISOString();
      await persist();
      process.stdout.write(
        `[${productIndex + 1}/${sourceJobs.length}] 完成：四宫格生图1张并裁成4张，${translateImages ? `Google串行${finalUrls.length}张，` : "图片翻译已暂停，"}Ozon图片=${ozonImageUpload.status}\n`,
      );
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      if (isDoubaoQuotaError(error)) {
        const pausedAt = new Date().toISOString();
        job.status = "pending";
        job.pausedAt = pausedAt;
        checkpoint.status = "paused";
        checkpoint.pauseReason = job.error;
        checkpoint.pausedAt = pausedAt;
        await persist();
        process.stderr.write(
          `[${productIndex + 1}/${sourceJobs.length}] 豆包生图额度已用完，队列已暂停：${job.error}\n`,
        );
        break;
      }
      job.status = "failed";
      job.failedAt = new Date().toISOString();
      await persist();
      process.stderr.write(
        `[${productIndex + 1}/${sourceJobs.length}] ${itemId} 失败：${job.error}\n`,
      );
    }
    if (await pauseIfRequested()) break;
  }

  const imageMap = Object.values(checkpoint.jobs)
    .filter((job) => Array.isArray(job.finalImages) && job.finalImages.length)
    .map((job) => ({
      id: job.itemId,
      exists: true,
      file: text(job.finalImages[0]).split("/").pop() || "",
      primaryImageUrl: job.finalImages[0],
      imageUrls: job.finalImages.slice(1),
      googleSerial: translateImages,
      prompt: job.prompt,
    }));
  await writeJsonAtomic(imageMapPath, imageMap);
  const summary = Object.values(checkpoint.jobs).reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});
  if (checkpoint.status !== "paused") {
    checkpoint.status = "complete";
    checkpoint.completedAt = new Date().toISOString();
  }
  checkpoint.workerPid = null;
  await persist();
  process.stdout.write(`${JSON.stringify({ checkpointPath, imageMapPath, summary }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
