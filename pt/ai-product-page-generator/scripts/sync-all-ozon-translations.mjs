import { setTimeout as wait } from "node:timers/promises";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apiOrigin =
  process.env.OZON_SYNC_API_ORIGIN?.trim() || "http://127.0.0.1:3000";
const delayArg = process.argv
  .filter((value) => value.startsWith("--delay-ms="))
  .at(-1);
const limitArg = process.argv
  .filter((value) => value.startsWith("--limit="))
  .at(-1);
const batchSizeArg = process.argv
  .filter((value) => value.startsWith("--batch-size="))
  .at(-1);
const delayMs = Math.max(0, Number(delayArg?.split("=")[1] || 120));
const limit = Math.max(0, Number(limitArg?.split("=")[1] || 0));
const batchSize = Math.min(
  50,
  Math.max(1, Number(batchSizeArg?.split("=")[1] || 20)),
);
const dryRun = process.argv.includes("--dry-run");

async function postChineseSync(categoryRecordIds) {
  const response = await fetch(`${apiOrigin}/api/ozon/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "category_attribute_translations_zh",
      categoryRecordIds,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.success) {
    throw new Error(
      payload?.error?.message ||
        `中文属性同步接口返回 HTTP ${response.status}`,
    );
  }
  return payload.data;
}

async function buildCoverageQueue() {
  await prisma.$executeRawUnsafe(`
    UPDATE "OzonAttribute"
    SET "nameZh" = (
      SELECT translated."nameZh"
      FROM "OzonAttribute" AS translated
      WHERE translated."name" = "OzonAttribute"."name"
        AND translated."nameZh" IS NOT NULL
      LIMIT 1
    )
    WHERE "nameZh" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "OzonAttribute" AS translated
        WHERE translated."name" = "OzonAttribute"."name"
          AND translated."nameZh" IS NOT NULL
      )
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "OzonAttributeValue"
    SET "valueZh" = (
      SELECT translated."valueZh"
      FROM "OzonAttributeValue" AS translated
      WHERE translated."value" = "OzonAttributeValue"."value"
        AND translated."valueZh" IS NOT NULL
      LIMIT 1
    )
    WHERE "valueZh" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "OzonAttributeValue" AS translated
        WHERE translated."value" = "OzonAttributeValue"."value"
          AND translated."valueZh" IS NOT NULL
      )
  `);
  const categories = await prisma.ozonCategory.findMany({
    where: {
      disabled: false,
      typeId: { not: null },
      attributes: { some: { nameZh: null } },
    },
    select: {
      id: true,
      label: true,
      attributes: {
        where: { nameZh: null },
        select: { name: true },
      },
    },
  });
  categories.sort(
    (left, right) => right.attributes.length - left.attributes.length,
  );

  const uncovered = new Set(
    categories.flatMap((category) =>
      category.attributes.map((attribute) => attribute.name),
    ),
  );
  const queue = [];
  for (const category of categories) {
    const newlyCovered = category.attributes.filter((attribute) =>
      uncovered.has(attribute.name),
    );
    if (!newlyCovered.length) continue;
    queue.push({
      id: category.id,
      label: category.label,
      coverage: newlyCovered.length,
    });
    for (const attribute of newlyCovered) {
      uncovered.delete(attribute.name);
    }
    if (!uncovered.size) break;
  }
  const categoriesWithMissingValues = await prisma.ozonCategory.findMany({
    where: {
      disabled: false,
      typeId: { not: null },
      attributes: { some: { values: { some: { valueZh: null } } } },
    },
    select: {
      id: true,
      label: true,
      attributes: {
        where: { values: { some: { valueZh: null } } },
        select: {
          _count: {
            select: { values: { where: { valueZh: null } } },
          },
        },
      },
    },
  });
  const combined = new Map(
    categoriesWithMissingValues.map((category) => [
      category.id,
      {
        id: category.id,
        label: category.label,
        coverage: category.attributes.reduce(
          (sum, attribute) => sum + attribute._count.values,
          0,
        ),
      },
    ]),
  );
  for (const item of queue) {
    const existing = combined.get(item.id);
    combined.set(item.id, {
      ...item,
      coverage: item.coverage + (existing?.coverage ?? 0),
    });
  }
  return {
    queue: Array.from(combined.values()).sort(
      (left, right) => right.coverage - left.coverage,
    ),
    uniqueAttributeIds: queue.reduce(
      (sum, item) => sum + item.coverage,
      0,
    ),
  };
}

async function main() {
  const before = await prisma.ozonAttribute.count({
    where: { nameZh: null },
  });
  const beforeValues = await prisma.ozonAttributeValue.count({
    where: { valueZh: null },
  });
  const coverage = await buildCoverageQueue();
  const queue = limit ? coverage.queue.slice(0, limit) : coverage.queue;
  let completed = 0;
  const failures = [];

  console.log(
    JSON.stringify({
      missingRecords: before,
      missingValueRecords: beforeValues,
      uniqueAttributeIds: coverage.uniqueAttributeIds,
      categoryRequests: queue.length,
      batchRequests: Math.ceil(queue.length / batchSize),
      batchSize,
    }),
  );
  if (dryRun) return;

  let processed = 0;
  for (let offset = 0; offset < queue.length; offset += batchSize) {
    const batch = queue.slice(offset, offset + batchSize);
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        result = await postChineseSync(batch.map((category) => category.id));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await wait(Math.min(20_000, 1000 * 2 ** (attempt - 1)));
      }
    }
    if (result) {
      completed += Number(result.categoriesSynced || 0);
      failures.push(...(result.failures || []));
    } else {
      failures.push(
        ...batch.map((category) => ({
          categoryId: category.id,
          label: category.label,
          error:
            lastError instanceof Error ? lastError.message : String(lastError),
        })),
      );
    }
    processed += batch.length;
    const remaining = await prisma.ozonAttribute.count({
      where: { nameZh: null },
    });
    const remainingValues = await prisma.ozonAttributeValue.count({
      where: { valueZh: null },
    });
    console.log(
      JSON.stringify({
        processed,
        total: queue.length,
        completed,
        failed: failures.length,
        remainingRecords: remaining,
        remainingValueRecords: remainingValues,
        currentBatch: batch.map((category) => category.label),
      }),
    );
    if (delayMs) await wait(delayMs);
  }

  const remaining = await prisma.ozonAttribute.count({
    where: { nameZh: null },
  });
  const remainingValues = await prisma.ozonAttributeValue.count({
    where: { valueZh: null },
  });
  console.log(
    JSON.stringify({
      done: remaining === 0 && remainingValues === 0,
      completed,
      failed: failures.length,
      remainingRecords: remaining,
      remainingValueRecords: remainingValues,
      failures: failures.slice(-100),
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
