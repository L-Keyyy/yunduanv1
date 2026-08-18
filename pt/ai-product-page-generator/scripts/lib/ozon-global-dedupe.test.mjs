import assert from "node:assert/strict";
import test from "node:test";

import { chooseGlobalKeepers, storePriority } from "./ozon-global-dedupe.mjs";

test("主店优先于编号店铺，编号较小的店铺优先", () => {
  assert.ok(storePriority("Ozon Seller API") < storePriority("Ozon 店铺 2"));
  assert.ok(storePriority("Ozon 店铺 2") < storePriority("Ozon 店铺 6"));
});

test("跨店同商品全局只保留最高优先级店铺的一张卡", () => {
  const rows = [
    { identityKey: "supplier:1", storeName: "Ozon 店铺 3", offerId: "C" },
    { identityKey: "supplier:1", storeName: "Ozon Seller API", offerId: "A" },
    { identityKey: "supplier:1", storeName: "Ozon 店铺 2", offerId: "B" },
  ];
  const result = chooseGlobalKeepers(rows);
  assert.equal(result.keep[0].offerId, "A");
  assert.deepEqual(result.archive.map((row) => row.offerId), ["B", "C"]);
});

test("同一优先店铺有重复时只保留状态较好的卡", () => {
  const rows = [
    {
      identityKey: "supplier:2",
      storeName: "Ozon Seller API",
      offerId: "bad",
      isCreated: false,
      errorCount: 2,
      imageCount: 0,
    },
    {
      identityKey: "supplier:2",
      storeName: "Ozon Seller API",
      offerId: "good",
      isCreated: true,
      errorCount: 0,
      imageCount: 4,
    },
  ];
  const result = chooseGlobalKeepers(rows);
  assert.equal(result.keep[0].offerId, "good");
  assert.equal(result.archive[0].offerId, "bad");
});

