import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPriceFloorRepair,
  compliantOldPrice,
  isOldPriceCompliant,
  requiredOldPriceGap,
} from "./ozon-price-floor.mjs";

test("售价低于 15 元时提升售价与最低价", () => {
  const repair = buildPriceFloorRepair({ price: 9.9, min_price: 0, old_price: 11.88 });
  assert.equal(repair.targetPrice, 15);
  assert.equal(repair.targetMinPrice, 15);
  assert.equal(repair.targetOldPrice, 35.01);
  assert.ok(repair.reasons.includes("price_below_floor"));
});

test("低价商品划线价满足 20 元最小价差", () => {
  assert.equal(requiredOldPriceGap(15), 20);
  assert.equal(compliantOldPrice(15), 35.01);
  assert.equal(isOldPriceCompliant(15, 35.01), true);
  assert.equal(isOldPriceCompliant(15, 18), false);
});

test("没有划线价时保持为零并仅补最低价", () => {
  const repair = buildPriceFloorRepair({
    price: 52,
    min_price: 0,
    old_price: 0,
    auto_action_enabled: false,
    auto_add_to_ozon_actions_list_enabled: false,
  });
  assert.equal(repair.targetPrice, 52);
  assert.equal(repair.targetMinPrice, 15);
  assert.equal(repair.targetOldPrice, 0);
});

test("折扣错误会生成合规划线价", () => {
  const repair = buildPriceFloorRepair(
    { price: 52, min_price: 15, old_price: 0 },
    { hasDiscountError: true },
  );
  assert.equal(repair.targetOldPrice, 72.01);
  assert.ok(repair.reasons.includes("discount_validation_error"));
});

