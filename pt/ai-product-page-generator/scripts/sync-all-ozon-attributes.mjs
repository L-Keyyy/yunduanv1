import { setTimeout as wait } from "node:timers/promises";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apiOrigin =
  process.env.OZON_SYNC_API_ORIGIN?.trim() || "http://127.0.0.1:3000";
const includeValues = process.argv.includes("--include-values");
const refreshTree = process.argv.includes("--refresh-tree");
const force = process.argv.includes("--force");
const delayArg = process.argv.find((value) => value.startsWith("--delay-ms="));
const maxValuesArg = process.argv.find((value) =>
  value.startsWith("--max-values="),
);
const limitArg = process.argv.find((value) => value.startsWith("--limit="));
const delayMs = Math.max(0, Number(delayArg?.split("=")[1] || 200));
const limit = Math.max(0, Number(limitArg?.split("=")[1] || 0));
const maxValuesPerAttribute = includeValues
  ? Math.max(1, Number(maxValuesArg?.split("=")[1] || 1000))
  : 0;

async function postSync(body) {
  const response = await fetch(`${apiOrigin}/api/ozon/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.success) {
    throw new Error(
      payload?.error?.message ||
        `同步接口返回 HTTP ${response.status}`,
    );
  }
  return payload.data;
}

async function completedCategoryIds() {
  if (force) return new Set();
  const runs = await prisma.ozonSyncRun.findMany({
    where: { action: "category_attributes", status: "SUCCESS" },
    select: { inputPayload: true },
  });
  const ids = new Set();
  for (const run of runs) {
    const input = run.inputPayload;
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const categoryRecordId = String(input.categoryRecordId || "");
    if (!categoryRecordId) continue;
    if (!includeValues) {
      ids.add(categoryRecordId);
      continue;
    }
    if (
      input.includeValues === true &&
      Number(input.maxValuesPerAttribute || 0) >= maxValuesPerAttribute
    ) {
      ids.add(categoryRecordId);
    }
  }
  return ids;
}

async function main() {
  await prisma.ozonSyncRun.updateMany({
    where: {
      action: "all_category_attributes",
      status: "RUNNING",
    },
    data: {
      status: "FAILED",
      errorMessage: "检测到新的断点续传任务，旧任务已结束。",
      completedAt: new Date(),
    },
  });

  if (refreshTree) {
    console.log("正在刷新 Ozon 类目树…");
    await postSync({ action: "category_tree", language: "DEFAULT" });
  }

  const categories = await prisma.ozonCategory.findMany({
    where: {
      isLeaf: true,
      disabled: false,
      descriptionCategoryId: { not: null },
      typeId: { not: null },
    },
    orderBy: [{ label: "asc" }],
    select: { id: true, label: true },
  });
  const completed = await completedCategoryIds();
  const pending = categories.filter((category) => !completed.has(category.id));
  const queue = limit ? pending.slice(0, limit) : pending;
  const masterRun = await prisma.ozonSyncRun.create({
    data: {
      action: "all_category_attributes",
      status: "RUNNING",
      inputPayload: {
        totalCategories: categories.length,
        queuedCategories: queue.length,
        pendingCategories: pending.length,
        skippedCategories: categories.length - queue.length,
        includeValues,
        maxValuesPerAttribute,
        delayMs,
      },
    },
  });

  let categoriesSynced = 0;
  let attributesSynced = 0;
  let valuesSynced = 0;
  const failures = [];
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  for (let index = 0; index < queue.length; index += 1) {
    if (stopping) break;
    const category = queue[index];
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        result = await postSync({
          action: "category_attributes",
          categoryRecordId: category.id,
          includeValues,
          language: "DEFAULT",
          maxValuesPerAttribute,
        });
        break;
      } catch (error) {
        lastError = error;
        await wait(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
      }
    }

    if (result) {
      categoriesSynced += 1;
      attributesSynced += Number(result.attributesSynced || 0);
      valuesSynced += Number(result.valuesSynced || 0);
    } else {
      failures.push({
        categoryId: category.id,
        label: category.label,
        error:
          lastError instanceof Error ? lastError.message : String(lastError),
      });
    }

    const processed = index + 1;
    if (processed % 10 === 0 || processed === queue.length || !result) {
      await prisma.ozonSyncRun.update({
        where: { id: masterRun.id },
        data: {
          categoriesSynced,
          attributesSynced,
          valuesSynced,
          outputPayload: {
            processed,
            total: queue.length,
            failures: failures.slice(-100),
            lastCategoryId: category.id,
            lastCategoryLabel: category.label,
          },
        },
      });
      console.log(
        JSON.stringify({
          processed,
          total: queue.length,
          categoriesSynced,
          attributesSynced,
          valuesSynced,
          failed: failures.length,
          current: category.label,
        }),
      );
    }
    if (delayMs) await wait(delayMs);
  }

  await prisma.ozonSyncRun.update({
    where: { id: masterRun.id },
    data: {
      status: stopping ? "FAILED" : "SUCCESS",
      categoriesSynced,
      attributesSynced,
      valuesSynced,
      errorMessage: stopping
        ? "同步进程被停止，可再次运行同一命令断点续跑。"
        : failures.length
          ? `${failures.length} 个类目同步失败，再次运行会自动重试。`
          : null,
      outputPayload: {
        processed: categoriesSynced + failures.length,
        total: queue.length,
        failed: failures.length,
        failures: failures.slice(-500),
      },
      completedAt: new Date(),
    },
  });

  console.log(
    JSON.stringify({
      done: !stopping,
      categoriesSynced,
      attributesSynced,
      valuesSynced,
      failed: failures.length,
      runId: masterRun.id,
    }),
  );
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
