import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SerialCheckpointQueue,
  chooseSingleVariant,
  domesticFreightCny,
  selectExactlyOneSku,
  stableBatchOfferId,
  tripledCnyPrice,
} from "./pet-toy-batch.mjs";

test("人民币价格严格乘以 3 并保留两位小数", () => {
  assert.equal(tripledCnyPrice("0.83"), "2.49");
  assert.equal(tripledCnyPrice("￥12.345"), "37.04");
  assert.equal(tripledCnyPrice("5", "2"), "21.00");
});

test("读取 1688 单件国内运费", () => {
  assert.equal(domesticFreightCny({ domesticFreight: { unitCny: 1.6 } }), 1.6);
  assert.equal(domesticFreightCny({ domesticFreight: { totalCny: 0 } }), 0);
  assert.equal(domesticFreightCny({}), null);
});

test("多规格只选择一个有价格的 SKU", () => {
  const data = {
    variants: [
      { skuId: "expensive", price: "9.00", stock: "100" },
      { skuId: "cheap", price: "2.00", stock: "20" },
    ],
    rawVariants: [
      { skuId: "expensive", price: "9.00" },
      { skuId: "cheap", price: "2.00" },
    ],
  };
  const selected = chooseSingleVariant(data);
  assert.equal(selected.skuId, "cheap");
  const result = selectExactlyOneSku(data, selected);
  assert.deepEqual(result.skuSelection.selectedSkuIds, ["cheap"]);
  assert.equal(result.variants.length, 1);
  assert.equal(result.rawVariants.length, 1);
});

test("已有用户选择优先于自动最低价", () => {
  const selected = chooseSingleVariant({
    skuSelection: { selectedSkuIds: ["chosen"] },
    variants: [
      { skuId: "cheap", price: "1.00", stock: "10" },
      { skuId: "chosen", price: "4.00", stock: "10" },
    ],
  });
  assert.equal(selected.skuId, "chosen");
});

test("offer_id 稳定且不超过 50 字符", () => {
  const first = stableBatchOfferId("8".repeat(80), "9".repeat(80));
  const second = stableBatchOfferId("8".repeat(80), "9".repeat(80));
  assert.equal(first, second);
  assert.ok(first.length <= 50);
});

test("串行队列按顺序运行并从检查点跳过 imported", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pet-toy-queue-"));
  const checkpointPath = path.join(directory, "checkpoint.json");
  const events = [];
  const queue = new SerialCheckpointQueue({ checkpointPath, maxAttempts: 2 });
  await queue.initialize([{ offerId: "a" }, { offerId: "b" }]);
  await queue.run(async (input) => {
    events.push(`start:${input.offerId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end:${input.offerId}`);
    return { status: "imported", offerId: input.offerId };
  });
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);

  const resumedEvents = [];
  const resumed = new SerialCheckpointQueue({ checkpointPath, maxAttempts: 2 });
  await resumed.initialize([{ offerId: "a" }, { offerId: "b" }]);
  await resumed.run(async (input) => {
    resumedEvents.push(input.offerId);
    return { status: "imported" };
  });
  assert.deepEqual(resumedEvents, []);
  await fs.rm(directory, { recursive: true, force: true });
});
