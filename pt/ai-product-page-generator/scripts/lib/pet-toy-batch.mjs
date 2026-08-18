import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PET_TOY_KEYWORDS = [
  "宠物玩具",
  "猫玩具",
  "狗玩具",
  "犬玩具",
  "逗猫",
  "猫抓",
  "磨牙",
  "耐咬",
  "宠物球",
  "宠物飞盘",
  "宠物漏食",
  "pet toy",
  "dog toy",
  "cat toy",
  "игрушка для животных",
  "игрушка для собак",
  "игрушка для кошек",
];

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function textValue(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function positiveMoney(value) {
  const match = textValue(value).match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const amount = Number(match[0].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function tripledCnyPrice(value, domesticFreight = 0) {
  const amount = positiveMoney(value);
  if (!amount) throw new Error(`采购价无效：${textValue(value) || "空"}`);
  const freight = Number(domesticFreight);
  if (!Number.isFinite(freight) || freight < 0) {
    throw new Error(`国内运费无效：${textValue(domesticFreight) || "空"}`);
  }
  return (Math.round((amount + freight) * 3 * 100) / 100).toFixed(2);
}

export function domesticFreightCny(scrapedData) {
  const data = asRecord(scrapedData);
  const freight = asRecord(data.domesticFreight);
  const amount = positiveMoney(
    freight.unitCny ?? freight.priceCny ?? freight.feeCny ?? freight.totalCny,
  );
  if (amount !== null) return amount;
  if (Number(freight.totalCny) === 0) return 0;
  return null;
}

export function variantId(variant) {
  variant = asRecord(variant);
  return textValue(
    variant.skuId ??
      variant.sku_id ??
      variant.sourceSkuId ??
      variant.source_sku_id ??
      variant.productId ??
      variant.product_id ??
      variant.id,
  );
}

function variantStock(variant) {
  const value = positiveMoney(variant.stock ?? variant.quantity ?? variant.amount);
  return value ?? 0;
}

export function chooseSingleVariant(scrapedData) {
  const data = asRecord(scrapedData);
  const variants = Array.isArray(data.variants)
    ? data.variants.map(asRecord).filter((variant) => variantId(variant))
    : [];
  if (!variants.length) return null;

  const selection = asRecord(data.skuSelection);
  const selectedIds = Array.isArray(selection.selectedSkuIds)
    ? selection.selectedSkuIds.map(textValue).filter(Boolean)
    : [];
  for (const selectedId of selectedIds) {
    const selected = variants.find((variant) => variantId(variant) === selectedId);
    if (selected && positiveMoney(selected.price)) return selected;
  }

  return variants
    .filter((variant) => positiveMoney(variant.price))
    .sort((left, right) => {
      const leftInStock = variantStock(left) > 0 ? 0 : 1;
      const rightInStock = variantStock(right) > 0 ? 0 : 1;
      if (leftInStock !== rightInStock) return leftInStock - rightInStock;
      const priceDelta = positiveMoney(left.price) - positiveMoney(right.price);
      if (priceDelta !== 0) return priceDelta;
      return variantStock(right) - variantStock(left);
    })[0] ?? null;
}

function filterVariants(value, skuId) {
  return Array.isArray(value)
    ? value.map(asRecord).filter((variant) => variantId(variant) === skuId)
    : value;
}

export function selectExactlyOneSku(scrapedData, variant) {
  const data = asRecord(scrapedData);
  if (!variant) return data;
  const skuId = variantId(variant);
  if (!skuId) throw new Error("选中的规格缺少 skuId。");
  const detailCapture = asRecord(data.detailCapture);
  return {
    ...data,
    variants: filterVariants(data.variants, skuId),
    ...(Array.isArray(data.rawVariants)
      ? { rawVariants: filterVariants(data.rawVariants, skuId) }
      : {}),
    ...(Object.keys(detailCapture).length
      ? {
          detailCapture: {
            ...detailCapture,
            ...(Array.isArray(detailCapture.variants)
              ? { variants: filterVariants(detailCapture.variants, skuId) }
              : {}),
          },
        }
      : {}),
    skuSelection: {
      mode: "multiple",
      selectedSkuIds: [skuId],
      selectedCount: 1,
      totalCount: Array.isArray(data.variants) ? data.variants.length : 1,
    },
    selectedVariant: variant,
  };
}

export function isPetToyProduct(item) {
  const data = asRecord(item?.scrapedData);
  const repair = asRecord(data.collectionRepair);
  if (repair.source === "1688_search_card") return true;
  const haystack = [
    item?.title,
    item?.categoryLabel,
    ...(Array.isArray(item?.categoryPath) ? item.categoryPath : []),
    data.title,
    data.description,
    data.category,
    data.categoryName,
  ]
    .map(textValue)
    .join(" ")
    .toLowerCase();
  return PET_TOY_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function stableBatchOfferId(sourceOfferId, skuId) {
  const source = textValue(sourceOfferId).replace(/[^a-zA-Z0-9_-]/g, "");
  const sku = textValue(skuId).replace(/[^a-zA-Z0-9_-]/g, "");
  const raw = `PT-${source || "SOURCE"}-${sku || "SKU"}`;
  if (raw.length <= 50) return raw;
  const digest = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return `${raw.slice(0, 39)}-${digest}`;
}

function baseId(feature) {
  return textValue(feature.attributeId).replace(/^base:/, "");
}

function baseFeature(id, value) {
  return {
    attributeId: `base:${id}`,
    label: id,
    value: textValue(value),
    required: true,
    group: "base",
    ozonCode: id,
    status: "auto",
    source: "宠物玩具批处理",
    reason: "由串行上架队列按固定规则写入。",
  };
}

export function overrideBatchFeatures(features, input) {
  const values = {
    category_type: `${input.categoryLabel || "Ozon"} / ${input.descriptionCategoryId} / ${input.typeId}`,
    offer_id: input.offerId,
    name: input.title,
    price: input.price,
    cost_price: input.costPrice,
    currency_code: input.currencyCode || "CNY",
    images: JSON.stringify(input.images),
    weight: input.weight || "300",
    weight_unit: input.weightUnit || "g",
    depth: input.depth || "200",
    width: input.width || "150",
    height: input.height || "100",
    dimension_unit: input.dimensionUnit || "mm",
  };
  const source = Array.isArray(features) ? features.map((feature) => ({ ...feature })) : [];
  const byBaseId = new Map(
    source
      .filter((feature) => feature.group === "base")
      .map((feature, index) => [baseId(feature), index]),
  );
  for (const [id, value] of Object.entries(values)) {
    const index = byBaseId.get(id);
    if (index === undefined) {
      source.push(baseFeature(id, value));
      continue;
    }
    source[index] = {
      ...source[index],
      value: textValue(value),
      status: "auto",
      source: "宠物玩具批处理",
      reason: "由串行上架队列按固定规则写入。",
    };
  }
  return source;
}

export function workflowImageUrls(item) {
  const data = asRecord(item?.scrapedData);
  const workflow = asRecord(data.workflowImages);
  const managed = Array.isArray(workflow.items)
    ? workflow.items.map(asRecord).map((image) => textValue(image.url)).filter(Boolean)
    : [];
  const gallery = Array.isArray(data.gallery) ? data.gallery.map(textValue).filter(Boolean) : [];
  const images = Array.isArray(data.images) ? data.images.map(textValue).filter(Boolean) : [];
  return Array.from(new Set([item?.imageUrl, ...managed, ...gallery, ...images].map(textValue).filter(Boolean)));
}

export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export class SerialCheckpointQueue {
  constructor({ checkpointPath, maxAttempts = 3 }) {
    this.checkpointPath = checkpointPath;
    this.maxAttempts = maxAttempts;
    this.checkpoint = null;
  }

  async initialize(entries) {
    const existing = await readJsonFile(this.checkpointPath, null);
    const jobs = entries.map((entry, index) => {
      const key = textValue(entry.workflowItemId || entry.offerId || entry.sourceUrl || index);
      const prior = existing?.jobs?.find((job) => job.key === key);
      return prior ?? {
        key,
        input: entry,
        status: "pending",
        attempts: 0,
        history: [],
      };
    });
    this.checkpoint = {
      version: 1,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobs,
    };
    await this.save();
    return this.checkpoint;
  }

  async save() {
    this.checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.checkpointPath, this.checkpoint);
  }

  async run(worker) {
    for (const job of this.checkpoint.jobs) {
      if (job.status === "imported") continue;
      if (job.attempts >= this.maxAttempts) continue;
      job.status = "running";
      job.attempts += 1;
      job.startedAt = new Date().toISOString();
      job.history.push({ status: "running", at: job.startedAt, attempt: job.attempts });
      await this.save();
      try {
        const result = await worker(job.input, job);
        job.status = result?.status || "completed";
        job.result = result;
        job.error = null;
        job.completedAt = new Date().toISOString();
        job.history.push({ status: job.status, at: job.completedAt });
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.completedAt = new Date().toISOString();
        job.history.push({ status: "failed", at: job.completedAt, error: job.error });
      }
      await this.save();
    }
    return this.checkpoint;
  }
}
