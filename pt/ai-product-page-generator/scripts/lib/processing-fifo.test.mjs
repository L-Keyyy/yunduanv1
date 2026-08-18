import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(
  path.resolve(
    currentDirectory,
    "../../lib/listing-workflow/processing-fifo.ts",
  ),
  "utf8",
);
const items = [
  product("A", "2026-08-18T10:00:00.000Z"),
  product("B", "2026-08-18T10:00:01.000Z"),
];
const prisma = {
  listingWorkflowItem: {
    findUnique: async ({ where }) => items.find((item) => item.id === where.id),
    findMany: async () => items,
  },
};
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (id) => {
    if (id === "@/lib/db/prisma") return { prisma };
    throw new Error(`Unexpected import: ${id}`);
  },
  loaded,
  loaded.exports,
);
const { readProcessingFifoStatus, runProcessingFifo } = loaded.exports;

function product(id, queuedAt) {
  return {
    id,
    stage: "PROCESSING",
    createdAt: new Date(queuedAt),
    scrapedData: {},
    workflowData: {
      imageWorkflow: {
        runId: `run-${id}`,
        queuedAt,
        generationStatus: "running",
        translationStatus: "running",
        featureStatus: "running",
      },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("每条泳道按商品 queuedAt 排队，不同泳道并行", async () => {
  const events = [];
  let releaseA;
  const blocked = new Promise((resolve) => {
    releaseA = resolve;
  });

  const featureB = runProcessingFifo(
    "feature",
    { itemId: "B", runId: "run-B" },
    async () => events.push("feature-B"),
  );
  await tick();
  assert.deepEqual(events, []);

  const featureA = runProcessingFifo(
    "feature",
    { itemId: "A", runId: "run-A" },
    async () => {
      events.push("feature-A-start");
      await blocked;
      events.push("feature-A-end");
      items[0].workflowData.imageWorkflow.featureStatus = "done";
    },
  );
  const imageA = runProcessingFifo(
    "generation",
    { itemId: "A", runId: "run-A" },
    async () => events.push("image-A"),
  );
  await tick();
  assert.deepEqual(events, ["feature-A-start", "image-A"]);
  const status = await readProcessingFifoStatus();
  assert.equal(status.lanes.feature.activeItemId, "A");
  assert.deepEqual(
    status.lanes.feature.databaseOrder.map((item) => item.itemId),
    ["A", "B"],
  );
  assert.equal(status.lanes.feature.fifoCompliant, true);

  releaseA();
  await Promise.all([featureA, featureB, imageA]);
  assert.deepEqual(events, [
    "feature-A-start",
    "image-A",
    "feature-A-end",
    "feature-B",
  ]);
});

test("前一个任务异常且数据库仍为 running 时也会释放后一个商品", async () => {
  const events = [];
  const translationB = runProcessingFifo(
    "translation",
    { itemId: "B", runId: "run-B" },
    async () => events.push("translation-B"),
  );
  await tick();

  const translationA = runProcessingFifo(
    "translation",
    { itemId: "A", runId: "run-A" },
    async () => {
      events.push("translation-A");
      throw new Error("fixture failure");
    },
  );

  await assert.rejects(translationA, /fixture failure/);
  await translationB;
  assert.deepEqual(events, ["translation-A", "translation-B"]);
});
