import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOzonPackageMetricsToSelectedSkus,
  deriveOzonPackageMetrics,
} from "../../lib/listing-workflow/skus.ts";

test("persists edited package metrics to the selected SKU", () => {
  const source = {
    skuSelection: {
      mode: "multiple",
      selectedSkuIds: ["sku-1"],
    },
    variants: [
      { skuId: "sku-1", packageInfo: { weightG: 400 } },
      { skuId: "sku-2", packageInfo: { weightG: 900 } },
    ],
  };
  const metrics = {
    depth: 185,
    width: 120,
    height: 86,
    weight: 400,
    dimensionUnit: "mm",
    weightUnit: "g",
  };

  const updated = applyOzonPackageMetricsToSelectedSkus(source, metrics);

  assert.deepEqual(
    deriveOzonPackageMetrics(updated.variants[0]),
    metrics,
  );
  assert.equal(updated.variants[0].packageInfo.source, "人工修改");
  assert.deepEqual(updated.variants[1], source.variants[1]);
});

test("accepts selected SKU ids stored outside scraped product data", () => {
  const source = {
    variants: [
      { skuId: "sku-1", packageInfo: { weightG: 400 } },
      { skuId: "sku-2", packageInfo: { weightG: 900 } },
    ],
  };
  const metrics = {
    depth: 185,
    width: 120,
    height: 86,
    weight: 400,
    dimensionUnit: "mm",
    weightUnit: "g",
  };

  const updated = applyOzonPackageMetricsToSelectedSkus(
    source,
    metrics,
    ["sku-1"],
  );

  assert.deepEqual(deriveOzonPackageMetrics(updated.variants[0]), metrics);
  assert.deepEqual(updated.variants[1], source.variants[1]);
});

test("splits combined 1688 package dimensions from product characteristics", () => {
  const product = {
    characteristics: [
      { name: "外形尺寸", valueText: "包装：185*120*86mm" },
    ],
  };
  const variant = {
    packageInfo: { weightG: "400", dimensionUnit: "cm", weightUnit: "g" },
  };

  assert.deepEqual(deriveOzonPackageMetrics(variant, undefined, product), {
    depth: 185,
    width: 120,
    height: 86,
    weight: 400,
    dimensionUnit: "mm",
    weightUnit: "g",
  });
});

test("raises only package dimensions below 100 x 50 x 10 mm", () => {
  assert.deepEqual(
    deriveOzonPackageMetrics({
      packageInfo: {
        depth: 80,
        width: 60,
        height: 5,
        weightG: 400,
        dimensionUnit: "mm",
      },
    }),
    {
      depth: 100,
      width: 60,
      height: 10,
      weight: 400,
      dimensionUnit: "mm",
      weightUnit: "g",
    },
  );
});
