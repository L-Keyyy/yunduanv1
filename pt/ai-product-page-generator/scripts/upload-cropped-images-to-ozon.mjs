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

function uniqueUrls(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter((value) => /^https?:\/\//i.test(value))));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function api(baseUrl, pathname, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(new URL(pathname, `${baseUrl}/`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4 * 60_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
  }
  throw lastError || new Error(`${pathname} 请求失败`);
}

async function main() {
  const baseUrl = argValue("--base-url", "http://127.0.0.1:3000").replace(/\/+$/, "");
  const checkpointPath = path.resolve(argValue(
    "--checkpoint",
    "storage/pet-toy-batch/regenerate-upload-checkpoint.json",
  ));
  const sourceCheckpointPath = path.resolve(argValue(
    "--source-checkpoint",
    "storage/pet-toy-batch/production-checkpoint.json",
  ));
  const limit = Math.max(1, Number(argValue("--limit", "100")));
  const retryUploaded = process.argv.includes("--retry-uploaded");
  const [checkpoint, sourceCheckpoint] = await Promise.all([
    readJson(checkpointPath),
    readJson(sourceCheckpointPath),
  ]);
  const sourceByItemId = new Map(
    (sourceCheckpoint.jobs || [])
      .filter((job) => text(job.input?.workflowItemId))
      .map((job) => [text(job.input.workflowItemId), job]),
  );
  const jobs = Object.values(asRecord(checkpoint.jobs))
    .filter((job) => job?.generated?.gridImages?.length === 4)
    .filter((job) => uniqueUrls(job.finalImages).length >= 4)
    .slice(0, limit);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  checkpoint.ozonImageUploadWorker = {
    status: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    total: jobs.length,
  };
  await writeJsonAtomic(checkpointPath, checkpoint);

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const itemId = text(job.itemId);
    const sourceJob = sourceByItemId.get(itemId);
    const previousStatus = text(job.ozonImageUpload?.status);
    if (!retryUploaded && ["uploaded", "processing"].includes(previousStatus)) {
      skipped += 1;
      process.stdout.write(`[${index + 1}/${jobs.length}] ${itemId} 已上传，跳过\n`);
      continue;
    }
    const imageUrls = uniqueUrls(job.finalImages).slice(0, 30);
    const aiImport = asRecord(job.ozonImport);
    const productId =
      job.productId ||
      sourceJob?.result?.productId ||
      aiImport.productId ||
      null;
    const offerId =
      text(sourceJob?.result?.offerId) ||
      text(job.offerId) ||
      text(aiImport.offerId);
    try {
      process.stdout.write(
        `[${index + 1}/${jobs.length}] 上传 ${imageUrls.length} 张裁剪/商品图：${offerId || itemId}\n`,
      );
      const result = await api(
        baseUrl,
        "/api/listing-workflow/ozon-image-upload",
        {
          listingWorkflowItemId: itemId,
          offerId: offerId || undefined,
          productId,
          imageUrls,
        },
      );
      job.ozonImageUpload = result;
      job.productId = result.productId;
      job.taskId = result.taskId || job.taskId || null;
      job.ozonImageUploadedAt = new Date().toISOString();
      job.error = null;
      uploaded += 1;
      process.stdout.write(
        `  完成：${result.status}，通道=${result.method}，task_id=${result.taskId || "-"}\n`,
      );
    } catch (error) {
      failed += 1;
      job.ozonImageUpload = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      };
      process.stderr.write(`  失败：${job.ozonImageUpload.error}\n`);
    }
    checkpoint.ozonImageUploadWorker = {
      ...checkpoint.ozonImageUploadWorker,
      uploaded,
      skipped,
      failed,
      current: index + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(checkpointPath, checkpoint);
  }

  checkpoint.ozonImageUploadWorker = {
    ...checkpoint.ozonImageUploadWorker,
    status: failed ? "completed_with_errors" : "complete",
    uploaded,
    skipped,
    failed,
    completedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(checkpointPath, checkpoint);
  process.stdout.write(`上传结束：成功 ${uploaded}，跳过 ${skipped}，失败 ${failed}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
