import { Prisma, type ListingWorkflowItem } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { readListingWorkflowPreferences } from "@/lib/listing-workflow/preferences";
import { ensurePermanentWorkflowImageUrl } from "@/lib/listing-workflow/public-image-host";
import { ozonSellerRequest } from "@/lib/ozon/client";
import { buildOzonProductImportPayload } from "@/lib/ozon/product-import-payload";

type JsonRecord = Record<string, unknown>;
type Feature = JsonRecord & {
  attributeId: string;
  group: "base" | "category" | "source";
  ozonCode?: string | null;
  value: string;
};

export type OzonErrorRepairState = {
  status: "idle" | "running" | "completed" | "failed";
  totalUploaded: number;
  detected: number;
  processed: number;
  repaired: number;
  stockUpdated: number;
  stockPending: number;
  failed: number;
  currentOfferId: string | null;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
};

type RepairTarget = {
  item: ListingWorkflowItem;
  offerId: string;
  features: Feature[];
  needsTextRepair: boolean;
};

const globalRepair = globalThis as typeof globalThis & {
  __ozonErrorRepairState?: OzonErrorRepairState;
  __ozonErrorRepairPromise?: Promise<void> | null;
};

const hanPattern = /[\u3400-\u9fff]/u;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function featuresOf(item: ListingWorkflowItem): Feature[] {
  return Array.isArray(item.features)
    ? (item.features as unknown[]).flatMap((value) => {
        const feature = record(value);
        const attributeId = String(feature.attributeId ?? "").trim();
        const group = feature.group;
        if (!attributeId || !["base", "category", "source"].includes(String(group))) return [];
        return [{
          ...feature,
          attributeId,
          group: group as Feature["group"],
          value: String(feature.value ?? ""),
          ozonCode: feature.ozonCode == null ? null : String(feature.ozonCode),
        }];
      })
    : [];
}

function importedOfferId(item: ListingWorkflowItem) {
  const ai = record(item.aiResponse);
  const imported = record(ai.ozonImport);
  if (imported.status === "imported" && imported.offerId) return String(imported.offerId);
  const workflow = record(item.workflowData);
  const scraped = record(item.scrapedData);
  const published = record(workflow.ozonPublish || scraped.ozonPublish);
  if (published.status === "imported" && published.offerId) return String(published.offerId);
  return "";
}

function hasChineseUploadText(features: Feature[]) {
  return features.some((feature) => {
    if (feature.group === "base") {
      return feature.ozonCode === "name" && hanPattern.test(feature.value);
    }
    const mapped = Array.isArray(feature.ozonAttributeValues)
      ? feature.ozonAttributeValues.map(record).map((value) => String(value.value ?? "")).filter(Boolean)
      : [];
    return (mapped.length ? mapped : [feature.value]).some((value) => hanPattern.test(value));
  });
}

async function repairTargets() {
  const items = await prisma.listingWorkflowItem.findMany({
    where: { stage: "PROCESSING" },
    orderBy: { updatedAt: "asc" },
  });
  return items.flatMap((item): RepairTarget[] => {
    const offerId = importedOfferId(item);
    if (!offerId) return [];
    const features = featuresOf(item);
    const ai = record(item.aiResponse);
    const repair = record(ai.ozonErrorRepair);
    return [{
      item,
      offerId,
      features,
      needsTextRepair: hasChineseUploadText(features) || Number(repair.version ?? 0) < 5,
    }];
  });
}

export async function inspectOzonErrorProducts() {
  const targets = await repairTargets();
  return {
    totalUploaded: targets.length,
    detected: targets.filter((target) => target.needsTextRepair).length,
    running: getOzonErrorRepairState().status === "running",
    state: getOzonErrorRepairState(),
  };
}

function defaultState(): OzonErrorRepairState {
  return {
    status: "idle",
    totalUploaded: 0,
    detected: 0,
    processed: 0,
    repaired: 0,
    stockUpdated: 0,
    stockPending: 0,
    failed: 0,
    currentOfferId: null,
    errors: [],
    startedAt: null,
    completedAt: null,
  };
}

export function getOzonErrorRepairState() {
  globalRepair.__ozonErrorRepairState ??= defaultState();
  return globalRepair.__ozonErrorRepairState;
}

function chunks<T>(values: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

const translationCache = new Map<string, string>();

async function translateToRussian(value: string) {
  const source = value.trim();
  if (!source || !hanPattern.test(source)) return source;
  const cached = translationCache.get(source);
  if (cached) return cached;
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "zh-CN");
  url.searchParams.set("tl", "ru");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", source);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`);
      const payload = (await response.json()) as unknown;
      const translated = Array.isArray(payload)
        ? (Array.isArray(payload[0]) ? payload[0] : [])
            .map((part) => Array.isArray(part) ? String(part[0] ?? "") : "")
            .join("")
            .trim()
        : "";
      if (!translated || hanPattern.test(translated)) throw new Error("俄文翻译结果仍含中文");
      translationCache.set(source, translated);
      return translated;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("俄文翻译失败");
}

function sourceColor(item: ListingWorkflowItem) {
  const scraped = record(item.scrapedData);
  const selection = record(scraped.skuSelection);
  const selectedIds = new Set(
    Array.isArray(selection.selectedSkuIds) ? selection.selectedSkuIds.map(String) : [],
  );
  const variants = [scraped.skus, scraped.variants].find(Array.isArray) as unknown[] | undefined;
  const text = (variants ?? [])
    .map(record)
    .filter((variant) => !selectedIds.size || selectedIds.has(String(variant.skuId ?? "")))
    .map((variant) => `${String(variant.specText ?? "")} ${String(variant.title ?? "")}`)
    .join(" ");
  const colors: Array<[RegExp, string]> = [
    [/白/u, "белый"], [/黑/u, "черный"], [/红/u, "красный"], [/橙/u, "оранжевый"],
    [/黄/u, "желтый"], [/绿/u, "зеленый"], [/蓝/u, "синий"], [/紫/u, "фиолетовый"],
    [/粉/u, "розовый"], [/灰/u, "серый"], [/(?:棕|咖啡)/u, "коричневый"],
  ];
  const matched = colors.filter(([pattern]) => pattern.test(text)).map(([, value]) => value);
  return matched.length ? Array.from(new Set(matched)).join(", ") : "разноцветный";
}

function sourceProductText(item: ListingWorkflowItem) {
  const scraped = record(item.scrapedData);
  const selection = record(scraped.skuSelection);
  const selectedIds = new Set(
    Array.isArray(selection.selectedSkuIds) ? selection.selectedSkuIds.map(String) : [],
  );
  const variants = [scraped.skus, scraped.variants].find(Array.isArray) as unknown[] | undefined;
  const variantText = (variants ?? [])
    .map(record)
    .filter((variant) => !selectedIds.size || selectedIds.has(String(variant.skuId ?? "")))
    .map((variant) => `${String(variant.specText ?? "")} ${String(variant.title ?? "")}`)
    .join(" ");
  return `${item.title} ${variantText}`.trim();
}

function firstSizeCm(value: string) {
  const match = value.match(/(\d+(?:[.,]\d+)?)\s*(?:cm|厘米|CM)/u);
  return match ? `${match[1].replace(",", ".")} см` : "";
}

function conciseRussianName(item: ListingWorkflowItem) {
  const source = sourceProductText(item);
  const both = /狗/u.test(source) && /猫/u.test(source);
  const audience = both
    ? "для кошек и собак"
    : /猫/u.test(source)
      ? "для кошек"
      : /狗|犬/u.test(source)
        ? "для собак"
        : "для домашних животных";
  const type = /猫抓板/u.test(source)
    ? "Когтеточка"
    : /隧道/u.test(source)
      ? "Игровой тоннель"
      : /逗猫棒|猫棒/u.test(source)
        ? "Дразнилка"
        : /飞盘|飞碟/u.test(source)
          ? "Летающий диск"
          : /漏食球|藏食球/u.test(source)
            ? "Мяч-дозатор"
            : /球/u.test(source)
              ? "Мяч"
              : /绳|拔河/u.test(source)
                ? "Игровой канат"
                : /磨牙棒|骨/u.test(source)
                  ? "Жевательная игрушка"
                  : /毛绒|玩偶/u.test(source)
                    ? "Плюшевая игрушка"
                    : "Игрушка";
  const material = /ETPU/i.test(source)
    ? "из ETPU"
    : /乳胶|乳橡胶|latex/i.test(source)
      ? "из латекса"
      : /橡胶|TPR/i.test(source)
        ? "из резины"
        : /毛绒/u.test(source)
          ? "из плюша"
          : /棉绳|棉/u.test(source)
            ? "из хлопка"
            : /尼龙/u.test(source)
              ? "из нейлона"
              : "";
  const traits = [
    /发声|响纸/u.test(source) ? "со звуком" : "",
    /耐咬/u.test(source) ? "прочная" : "",
    /磨牙/u.test(source) ? "для жевания" : "",
    /益智/u.test(source) ? "развивающая" : "",
    /嗅闻/u.test(source) ? "для поиска лакомств" : "",
    /电动|自嗨/u.test(source) ? "интерактивная" : "",
  ].filter(Boolean).slice(0, 3);
  return [type, material, audience, ...traits, firstSizeCm(source)]
    .filter(Boolean)
    .join(", ")
    .slice(0, 180);
}

function firstNumber(value: string) {
  const match = value.match(/\d+(?:[.,]\d+)?/);
  return match ? match[0].replace(",", ".") : "1";
}

function compactRussian(value: string) {
  const cleaned = value
    .replace(/[\u3400-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return cleaned.length > 180
    ? `${cleaned.slice(0, 176).replace(/\s+\S*$/, "")}...`
    : cleaned;
}

function canonicalDictionaryFeature(feature: Feature) {
  if (feature.attributeId === "85") {
    return {
      ...feature,
      value: "Нет бренда",
      ozonAttributeValues: [{ dictionary_value_id: 126745801, value: "Нет бренда" }],
    };
  }
  if (feature.attributeId === "4389") {
    return {
      ...feature,
      value: "Китай",
      ozonAttributeValues: [{ dictionary_value_id: 90296, value: "Китай" }],
    };
  }
  return feature;
}

async function repairedFeatures(target: RepairTarget) {
  const name = conciseRussianName(target.item);
  const color = sourceColor(target.item);
  const transformed = await Promise.all(target.features.map(async (original) => {
    const feature = canonicalDictionaryFeature(original);
    if ((feature.group === "base" && feature.ozonCode === "offer_id")) {
      return { ...feature, value: target.offerId };
    }
    if ((feature.group === "base" && feature.ozonCode === "name") || feature.attributeId === "4180") {
      return {
        ...feature,
        value: name,
        ...(feature.attributeId === "4180" ? { ozonAttributeValues: [{ value: name }] } : {}),
      };
    }
    if (feature.attributeId === "4191") {
      const value = `${name}. Подходит для активных игр с домашними животными.`;
      return { ...feature, value, ozonAttributeValues: [{ value }] };
    }
    if (feature.attributeId === "10097") {
      return { ...feature, value: color, ozonAttributeValues: [{ value: color }] };
    }
    if (feature.attributeId === "9048") {
      const value = `M-${target.item.offerId}`.slice(0, 80);
      return { ...feature, value, ozonAttributeValues: [{ value }] };
    }
    if (["8962", "11650", "23249"].includes(feature.attributeId)) {
      const value = feature.attributeId === "23249" ? "1.0" : "1";
      return { ...feature, value, ozonAttributeValues: [{ value }] };
    }
    if (feature.group !== "base" && hanPattern.test(feature.value)) {
      const mappings = Array.isArray(feature.optionMappings)
        ? feature.optionMappings.map(record)
        : [];
      const mapped = mappings.find((mapping) =>
        String(mapping.label ?? "").trim() === feature.value.trim() &&
        !hanPattern.test(String(mapping.value ?? "")),
      );
      if (mapped?.value) {
        const value = String(mapped.value);
        const dictionaryValueId = Number(mapped.dictionaryValueId);
        return {
          ...feature,
          value,
          ozonAttributeValues: [{
            ...(Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
              ? { dictionary_value_id: dictionaryValueId }
              : {}),
            value,
          }],
        };
      }
      const valueType = String(feature.valueType ?? "").toLowerCase();
      const value = /integer|decimal|number/.test(valueType)
        ? firstNumber(feature.value)
        : compactRussian(await translateToRussian(feature.value));
      return { ...feature, value, ozonAttributeValues: [{ value }] };
    }
    return feature;
  }));
  if (!transformed.some((feature) => feature.attributeId === "8962")) {
    transformed.push({
      attributeId: "8962",
      group: "category",
      ozonCode: "8962",
      value: "1",
      ozonAttributeValues: [{ value: "1" }],
    });
  }
  if (!transformed.some((feature) => feature.attributeId === "4958")) {
    const source = sourceProductText(target.item);
    const values = [
      ...(/猫/u.test(source) ? [{ dictionary_value_id: 33754, value: "Для кошек" }] : []),
      ...(/狗|犬/u.test(source) ? [{ dictionary_value_id: 33746, value: "Для собак" }] : []),
    ];
    const uploadValues = values.length
      ? values
      : [{ dictionary_value_id: 33746, value: "Для собак" }];
    transformed.push({
      attributeId: "4958",
      group: "category",
      ozonCode: "4958",
      value: uploadValues.map((value) => value.value).join(", "),
      ozonAttributeValues: uploadValues,
    });
  }
  return transformed;
}

function imagesFromFeatures(features: Feature[]) {
  const value = features.find((feature) => feature.group === "base" && feature.ozonCode === "primary_image/images")?.value;
  if (!value) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function categoryFromFeatures(features: Feature[]) {
  const value = features.find((feature) => feature.group === "base" && feature.ozonCode === "description_category_id/type_id")?.value || "";
  const numbers = value.match(/\d+/g)?.map(Number).filter((entry) => entry > 0) ?? [];
  return { descriptionCategoryId: numbers.at(-2) ?? null, typeId: numbers.at(-1) ?? null };
}

const safeRepairAttributeIds = new Set([
  "85",
  "9048",
  "4191",
  "4497",
  "4383",
  "10400",
  "11650",
  "23249",
  "8962",
  "4958",
  "4180",
  "10097",
  "5379",
  "4389",
]);

function safeRepairFeatures(features: Feature[]) {
  return features.filter((feature) =>
    feature.group === "base" || safeRepairAttributeIds.has(feature.attributeId),
  );
}

function taskId(payload: unknown) {
  const result = record(record(payload).result);
  const value = Number(result.task_id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Ozon 没有返回有效 task_id");
  return value;
}

async function waitImport(task: number) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const payload = await ozonSellerRequest<JsonRecord>("/v1/product/import/info", { task_id: task });
    const items = record(record(payload).result).items;
    if (Array.isArray(items) && items.length && items.every((item) => ["imported", "failed", "skipped"].includes(String(record(item).status)))) {
      return items.map(record);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Ozon 任务 ${task} 等待超时`);
}

function productWeight(item: ListingWorkflowItem, features: Feature[]) {
  const scraped = record(item.scrapedData);
  const selection = record(scraped.skuSelection);
  const selectedIds = new Set(Array.isArray(selection.selectedSkuIds) ? selection.selectedSkuIds.map(String) : []);
  const variants = [scraped.skus, scraped.variants].find(Array.isArray) as unknown[] | undefined;
  for (const raw of variants ?? []) {
    const variant = record(raw);
    if (selectedIds.size && !selectedIds.has(String(variant.skuId ?? ""))) continue;
    const packageInfo = record(variant.packageInfo);
    const weight = Number(String(packageInfo.weightG ?? "").replace(",", "."));
    if (Number.isFinite(weight) && weight > 0) return weight;
  }
  const base = features.find((feature) => feature.group === "base" && feature.ozonCode === "weight")?.value;
  const weight = Number(String(base ?? "").replace(",", "."));
  return Number.isFinite(weight) && weight > 0 ? weight : 300;
}

function warehouseFor(target: RepairTarget, rules: Awaited<ReturnType<typeof readListingWorkflowPreferences>>["warehouseRules"]) {
  const weight = productWeight(target.item, target.features);
  const price = Number(String(target.item.currentPrice ?? "").replace(",", "."));
  return rules.find((rule) =>
    weight >= rule.minWeightGrams && weight <= rule.maxWeightGrams &&
    price >= rule.minPriceCny && price <= rule.maxPriceCny && rule.warehouseId
  ) ?? null;
}

async function executeRepair() {
  const state = getOzonErrorRepairState();
  const targets = await repairTargets();
  state.totalUploaded = targets.length;
  state.detected = targets.filter((target) => target.needsTextRepair).length;
  const liveInfo = await ozonSellerRequest<{ items?: Array<JsonRecord> }>(
    "/v3/product/info/list",
    { offer_id: targets.map((target) => target.offerId) },
    { timeoutMs: 120_000 },
  );
  const sourcePrimaryImageByOffer = new Map(
    (liveInfo.items ?? []).flatMap((item) => {
      const offerId = String(item.offer_id ?? "");
      const primaryImage = String(item.primary_image ?? "");
      return offerId && primaryImage ? [[offerId, primaryImage] as const] : [];
    }),
  );
  const primaryImageByOffer = new Map<string, string>();
  for (const target of targets.filter((entry) => entry.needsTextRepair)) {
    const source = sourcePrimaryImageByOffer.get(target.offerId);
    if (source) {
      primaryImageByOffer.set(
        target.offerId,
        await ensurePermanentWorkflowImageUrl(source),
      );
    }
  }
  const repairedPayloads: Array<{ target: RepairTarget; features: Feature[]; payload: JsonRecord }> = [];

  for (const group of chunks(targets.filter((target) => target.needsTextRepair), 8)) {
    const built = await Promise.all(group.map(async (target) => {
      state.currentOfferId = target.offerId;
      const features = await repairedFeatures(target);
      const uploadFeatures = safeRepairFeatures(features);
      const result = buildOzonProductImportPayload({
        category: categoryFromFeatures(uploadFeatures),
        features: uploadFeatures as never,
        images: primaryImageByOffer.get(target.offerId)
          ? { primary_image: primaryImageByOffer.get(target.offerId), images: [] }
          : imagesFromFeatures(features) as never,
      });
      if (result.errors.length || result.payload.items.length !== 1) {
        throw new Error(`${target.offerId}: ${result.errors.join("；") || "上传结构异常"}`);
      }
      return { target, features, payload: result.payload.items[0] };
    }));
    repairedPayloads.push(...built);
  }

  for (const group of chunks(repairedPayloads, 20)) {
    state.currentOfferId = group[0]?.target.offerId ?? null;
    const submitted = await ozonSellerRequest<JsonRecord>("/v3/product/import", {
      items: group.map((entry) => entry.payload),
    }, { timeoutMs: 120_000 });
    const task = taskId(submitted);
    const statuses = await waitImport(task);
    for (const entry of group) {
      const status = statuses.find((candidate) => candidate.offer_id === entry.target.offerId);
      state.processed += 1;
      if (status?.status !== "imported" && status?.status !== "skipped") {
        state.failed += 1;
        state.errors.push(`${entry.target.offerId}: ${JSON.stringify(status?.errors ?? status ?? "failed")}`);
        continue;
      }
      state.repaired += 1;
      const ai = record(entry.target.item.aiResponse);
      await prisma.listingWorkflowItem.update({
        where: { id: entry.target.item.id },
        data: {
          features: entry.features as unknown as Prisma.InputJsonValue,
          aiResponse: {
            ...ai,
            ozonErrorRepair: {
              version: 5,
              taskId: task,
              offerId: entry.target.offerId,
              status: "imported",
              repairedAt: new Date().toISOString(),
            },
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  const repairedOffers = new Set(repairedPayloads.map((entry) => entry.target.offerId));
  const repairedLiveItems = (liveInfo.items ?? []).filter((item) =>
    repairedOffers.has(String(item.offer_id ?? "")),
  );
  for (const group of chunks(repairedLiveItems, 5)) {
    await Promise.all(group.map(async (item) => {
      const productId = Number(item.id ?? item.product_id);
      const primaryImage = primaryImageByOffer.get(String(item.offer_id ?? "")) ?? "";
      if (!Number.isSafeInteger(productId) || productId <= 0 || !primaryImage) return;
      await ozonSellerRequest<JsonRecord>("/v1/product/pictures/import", {
        product_id: productId,
        images: [primaryImage],
      }, { timeoutMs: 120_000 }).catch(() => null);
    }));
  }

  const preferences = await readListingWorkflowPreferences();
  const stocks = targets.flatMap((target) => {
    const warehouse = warehouseFor(target, preferences.warehouseRules);
    if (!warehouse?.warehouseId) {
      state.failed += 1;
      state.errors.push(`${target.offerId}: 没有匹配到仓库`);
      return [];
    }
    return [{
      offer_id: target.offerId,
      stock: preferences.productQuantity,
      warehouse_id: Number(warehouse.warehouseId),
    }];
  });
  let pendingStocks = stocks;
  for (let attempt = 1; attempt <= 10 && pendingStocks.length; attempt += 1) {
    const nextPending: typeof pendingStocks = [];
    for (const group of chunks(pendingStocks, 100)) {
      const response = await ozonSellerRequest<JsonRecord>("/v2/products/stocks", { stocks: group });
      const rows = record(response).result;
      if (!Array.isArray(rows)) {
        nextPending.push(...group);
        continue;
      }
      const inputByOffer = new Map(group.map((stock) => [stock.offer_id, stock]));
      for (const rowValue of rows) {
        const row = record(rowValue);
        const offerId = String(row.offer_id ?? "");
        if (row.updated === true && (!Array.isArray(row.errors) || row.errors.length === 0)) {
          state.stockUpdated += 1;
          continue;
        }
        const input = inputByOffer.get(offerId);
        if (input) nextPending.push(input);
      }
    }
    pendingStocks = nextPending;
    state.stockPending = pendingStocks.length;
    if (pendingStocks.length && attempt < 10) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  for (const stock of pendingStocks) {
    state.failed += 1;
    state.errors.push(`${stock.offer_id}: Ozon 审核完成后需重试库存`);
  }
  state.processed += targets.filter((target) => !target.needsTextRepair).length;
}

export function startOzonErrorRepair() {
  const current = getOzonErrorRepairState();
  if (current.status === "running") return current;
  const state: OzonErrorRepairState = {
    ...defaultState(),
    status: "running",
    startedAt: new Date().toISOString(),
  };
  globalRepair.__ozonErrorRepairState = state;
  globalRepair.__ozonErrorRepairPromise = executeRepair()
    .then(() => {
      state.status = state.failed ? "failed" : "completed";
      state.currentOfferId = null;
      state.completedAt = new Date().toISOString();
    })
    .catch((error) => {
      state.status = "failed";
      state.failed += 1;
      state.errors.push(error instanceof Error ? error.message : String(error));
      state.currentOfferId = null;
      state.completedAt = new Date().toISOString();
    })
    .finally(() => {
      globalRepair.__ozonErrorRepairPromise = null;
    });
  return state;
}
