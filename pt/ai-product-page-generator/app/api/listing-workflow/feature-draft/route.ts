import { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  extractJsonContainers,
  parseStructuredJson,
} from "@/lib/ai/parse-structured-json";
import {
  BROWSER_AI_PROVIDER_ID,
  BROWSER_AI_PROVIDER_NAME,
  generateBrowserText,
  isBrowserAiProvider,
} from "@/lib/browser-ai/client";
import { prisma } from "@/lib/db/prisma";
import {
  auditProductFacts,
  isPreparedProductFacts,
  prepareProductFacts,
  type PreparedProductFacts,
  type PreparedProductVariant,
} from "@/lib/listing-workflow/product-facts";
import {
  persistWorkflowFeatureFailure,
  persistWorkflowFeatureResult,
  type ProcessingWorkflowContext,
  type WorkflowFeatureResult,
} from "@/lib/listing-workflow/processing-state";
import {
  DEFAULT_FEATURE_FILL_SYSTEM_PROMPT,
  DEFAULT_FEATURE_FILL_TASK_PROMPT,
} from "@/lib/listing-workflow/text-prompts";
import { ozonListingBaseFields, type OzonAttributeNode } from "@/lib/ozon/feature-tree";
import { mapOzonAiResponse } from "@/lib/ozon/ai-response-mapper";
import { findOzonColorValue, isOzonColorAttributeId } from "@/lib/ozon/color-match";
import { isIgnoredOzonAttribute } from "@/lib/ozon/ignored-attributes";
import { getOzonFeatureSnapshot, type OzonAttributeSnapshot } from "@/lib/ozon/snapshot";
import { searchOzonAttributeValues } from "@/lib/ozon/sync-service";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const featureDraftRequestSchema = z.object({
  scrapedData: z.record(z.string(), z.unknown()),
  preparedProduct: z.record(z.string(), z.unknown()).optional().nullable(),
  categoryId: z.string().min(1).optional().nullable(),
  providerId: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional().nullable(),
  customPrompt: z.string().trim().max(4000).optional().nullable(),
  systemPrompt: z.string().trim().max(8000).optional().nullable(),
  precomputedAiText: z.string().trim().min(2).max(2_000_000).optional().nullable(),
  workflowItemId: z.string().trim().min(1).max(200).optional().nullable(),
  workflowRunId: z.string().trim().min(1).max(300).optional().nullable(),
});

const aiFeatureItemSchema = z.object({
  attributeId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .pipe(z.string().min(1)),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ]),
  confidence: z.coerce.number().min(0).max(1).optional(),
  status: z
    .preprocess(
      (value) => (typeof value === "string" ? value.toLowerCase() : value),
      z.enum(["auto", "review", "missing"]),
    )
    .optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  dictionary_value_id: z.coerce.number().int().positive().optional(),
});

const aiDisplayFeatureItemSchema = z.object({
  attributeId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .pipe(z.string().min(1)),
  keyZh: z.string().trim().optional(),
  valueZh: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ]),
});

const aiVariantFeatureResponseSchema = z.object({
  skuId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().min(1)),
  specLine: z.string().trim().optional().default(""),
  displayFeatures: z.array(aiDisplayFeatureItemSchema).default([]),
  uploadFeatures: z.array(aiFeatureItemSchema).default([]),
});

const aiDualFeatureResponseSchema = z.object({
  displayFeatures: z.array(aiDisplayFeatureItemSchema).default([]),
  uploadFeatures: z.array(aiFeatureItemSchema).default([]),
  variants: z.array(aiVariantFeatureResponseSchema).default([]),
  notes: z
    .union([z.array(z.string()), z.string()])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
});

type SourceFact = {
  key: string;
  value: string;
};

type DraftFeature = {
  attributeId: string;
  label: string;
  displayLabel?: string;
  value: string;
  confidence: number;
  required: boolean;
  group: "base" | "category" | "source";
  ozonCode: string | null;
  valueType: string | null;
  status: "auto" | "review" | "missing";
  source: string;
  reason: string;
  dictionaryValueCount: number;
  options: string[];
  optionMappings?: Array<{
    label: string;
    value: string;
    dictionaryValueId?: number;
  }>;
  ozonAttributeValues?: Array<{
    dictionary_value_id?: number;
    value?: string;
  }>;
  aiJsonKey?: string;
  aiJsonPath?: string;
  aiJsonValue?: string;
};

const BRAND_DEFAULT_VALUE = "没有品牌";
const COUNTRY_DEFAULT_VALUE = "中国";
const MANUFACTURER_DEFAULT_VALUE = "China";
const FACTORY_PACKAGE_DEFAULT_VALUE = "1";
const SAFE_HAZARD_DEFAULT_LABEL = "不危险";
const SAFE_HAZARD_DEFAULT_UPLOAD_VALUE = "Не опасен";
const DEFAULT_SHELF_LIFE_DAYS = "30";
const DEFAULT_WARRANTY_DAYS = 30;
const DEFAULT_WARRANTY_LABEL = "30天";
const DEFAULT_WARRANTY_UPLOAD_VALUE = "1 месяц";

const FEATURE_COVERAGE_GUIDANCE = [
  "覆盖率要求：在不制造商品事实的前提下，返回所有可以从商品事实、所选 SKU、商品图片或商品类型可靠确定及确定性推导的适用字段，不要只返回必填字段。",
  "可以生成与商品事实一致的主题标签、配套清单和批次标识；配套清单应写清商品主体和实际件数。",
  "当输入只有一个所选 SKU，且标题、规格和事实均没有套装或多件装描述时，每商品件数、统一计量单位数量、原厂包装数量、套装工具数量可填写 1。若有明确多件数，以事实为准。",
  "普通无电池、无液体、无化学品的固体工具或配件，可在危险等级允许值中选择“不危险/Не опасен”；存在任何危险品迹象时省略。",
  "附带商品图片时，可用清晰可见的颜色、形状和单件数量作为补充依据；图片看不清的内容仍应省略。",
  "商品不是刷子时，刷宽、刷毛长度、刷毛材质、刷型和刷束形状均不适用，必须省略；通用商品材质不得写入刷毛材质。",
].join("\n");

const SKU_VARIANT_GUIDANCE = [
  "本段多 SKU 规则优先于前文任何根字段顺序要求：根 JSON 的第一个键必须是 variants，先完整返回所有 SKU，再返回公共 uploadFeatures、displayFeatures 和 notes。",
  "多 SKU 返回要求：productFacts.variants 中的每个 skuId 都必须在根 JSON 的 variants 数组中原样返回一次，数量、集合和顺序与输入一致。",
  "根级 uploadFeatures/displayFeatures 只放所有 SKU 共用的字段；颜色、尺寸、规格、容量、包装数量、每件数量等差异字段放入对应 SKU 的 uploadFeatures/displayFeatures。",
  "每个 SKU 必须返回 specLine，格式为“字段=值｜字段=值”，只能使用全角分隔符｜；优先完整保留 sku title、specText、specs 和 package 中的明确事实。",
  "每个 SKU 的 displayFeatures 与 uploadFeatures 必须使用相同 attributeId；只返回 attributeTemplate 中存在的 attributeId，缺少依据的值省略。",
  "不得合并相似 SKU，不得依据数组位置猜测 skuId，也不得把某个 SKU 的尺寸、包装或价格复制给其他 SKU。",
].join("\n");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecordArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return Object.keys(record).length ? [record] : [];
      })
    : [];
}

function textValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function featureImageCandidates(data: Record<string, unknown>) {
  const detailCapture = asRecord(data.detailCapture);
  const selectedVariant = asRecord(data.selectedVariant);
  const workflowImages = asRecord(data.workflowImages);
  const candidates = [
    textValue(detailCapture.imageUrl),
    textValue(selectedVariant.imageUrl),
    ...asRecordArray(workflowImages.items)
      .filter((image) => image.source === "crawler")
      .map((image) => textValue(image.url)),
    ...(Array.isArray(data.images)
      ? data.images.map((image) => textValue(image))
      : []),
  ];
  return [...new Set(candidates.filter(Boolean))].slice(0, 2);
}

async function imageToDataUrl(url: string, requestOrigin: string) {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)) return url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL(url, requestOrigin), {
      headers: {
        Accept: "image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8",
        "User-Agent": "Mozilla/5.0 Chrome/149 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`商品图片下载失败：${response.status}`);
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "image/jpeg";
    if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(mimeType)) {
      throw new Error("商品图片格式不适合视觉匹配");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
      throw new Error("商品图片大小超出视觉匹配范围");
    }
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function featureVisionImages(
  data: Record<string, unknown>,
  requestOrigin: string,
) {
  const images: string[] = [];
  for (const url of featureImageCandidates(data)) {
    try {
      images.push(await imageToDataUrl(url, requestOrigin));
    } catch {
      // 单张图片不可用时继续使用其余图片和结构化商品事实。
    }
  }
  return images;
}

function compactText(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function joinTextList(value: unknown) {
  if (!Array.isArray(value)) return textValue(value);
  return value
    .map((item) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return textValue(item);
      const record = asRecord(item);
      return textValue(record.text) || textValue(record.name) || textValue(record.label) || textValue(record.value) || textValue(record.title);
    })
    .filter(Boolean)
    .join(", ");
}

function descriptionText(value: unknown) {
  const record = asRecord(value);
  return (
    compactText(textValue(record.text)) ||
    compactText(textValue(record.html)) ||
    compactText(textValue(record.rawSectionHtml)) ||
    compactText(textValue(value))
  );
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function addFact(facts: SourceFact[], key: string, value: unknown) {
  const text = textValue(value);
  if (!key.trim() || !text) return;
  if (text.length > 500) return;
  facts.push({ key: key.trim(), value: text });
}

function findFact(facts: SourceFact[], keys: string[]) {
  const normalizedKeys = keys.map(normalizeText);
  return facts.find((fact) => {
    const key = normalizeText(fact.key);
    return normalizedKeys.some((candidate) => key.includes(candidate) || candidate.includes(key));
  }) ?? null;
}

function numberFromText(value: string) {
  const matched = value.match(/-?\d+(?:[.,]\d+)?/);
  return matched ? matched[0].replace(",", ".") : value;
}

function packageWeightText(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return textValue(value);

  const record = asRecord(value);
  const hasExplicitKg = record.weightKg !== undefined;
  const hasExplicitG = record.weightG !== undefined;
  const rawWeight =
    textValue(record.weightText) ||
    textValue(record.weightKg) ||
    textValue(record.weightG) ||
    textValue(record.value) ||
    textValue(record.weight);
  if (!rawWeight) return "";

  const unit = hasExplicitKg
    ? "kg"
    : hasExplicitG
      ? "g"
      : textValue(record.weightUnit) || textValue(record.unit);
  const amount = Number(numberFromText(rawWeight));
  const normalizedUnit = normalizeText(unit || rawWeight);
  if (Number.isFinite(amount)) {
    if (/kg|公斤|千克/.test(normalizedUnit)) return String(Math.round(amount * 1000));
    if (/g|克/.test(normalizedUnit)) return String(Math.round(amount));
  }

  return rawWeight;
}

function packageDimensionText(value: unknown, kind: "depth" | "width" | "height") {
  const record = asRecord(value);
  const millimeters = textValue(record[`${kind}Mm`]);
  if (millimeters) return numberFromText(millimeters);

  const raw = textValue(record[kind]);
  if (!raw) return "";
  const amount = Number(numberFromText(raw));
  if (!Number.isFinite(amount)) return raw;
  const unit = normalizeText(textValue(record.dimensionUnit) || raw);
  if (/cm|厘米|公分/.test(unit)) return String(Math.round(amount * 10 * 1000) / 1000);
  if (/(^|[^m])m($|[^m])|米/.test(unit)) return String(Math.round(amount * 1000 * 1000) / 1000);
  return String(amount);
}

function normalizeShelfLifeDays(value: string) {
  const matched = value.match(/(\d+(?:[.,]\d+)?)/);
  if (!matched) return value;
  const amount = Number(matched[1].replace(",", "."));
  if (!Number.isFinite(amount)) return value;
  const normalized = normalizeText(value);
  if (/год|лет|year|年/.test(normalized)) return String(Math.round(amount * 365));
  if (/месяц|month|月/.test(normalized)) return String(Math.round(amount * 30));
  if (/дн|day|天/.test(normalized)) return String(Math.round(amount));
  return value;
}

function addObjectFacts(facts: SourceFact[], value: unknown) {
  const record = asRecord(value);
  for (const [key, entry] of Object.entries(record)) {
    addFact(facts, key, entry);
  }
}

function addArrayFacts(facts: SourceFact[], value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value.slice(0, 160)) {
    const record = asRecord(item);
    const key =
      textValue(record.name) ||
      textValue(record.key) ||
      textValue(record.label) ||
      textValue(record.title) ||
      textValue(record.attrName) ||
      textValue(record.attributeName);
    const valueText =
      textValue(record.value) ||
      textValue(record.valueText) ||
      textValue(record.text) ||
      textValue(record.content) ||
      textValue(record.attrValue) ||
      textValue(record.attributeValue) ||
      (Array.isArray(record.values) ? record.values.map((entry) => textValue(entry)).filter(Boolean).join(", ") : "");

    if (key && valueText) {
      addFact(facts, key, valueText);
    }
  }
}

function extractSourceFacts(data: Record<string, unknown>) {
  const facts: SourceFact[] = [];
  const packageInfo = asRecord(data.packageInfo ?? data.packaging ?? data.package);
  addFact(facts, "商品标题", data.title ?? data.name ?? data.item_name ?? data.productName ?? data.goods_name ?? data.subject);
  addFact(facts, "平台", data.platform ?? data.source ?? data.site);
  addFact(facts, "商品ID", data.itemId ?? data.item_id ?? data.offerId ?? data.offer_id ?? data.goods_id);
  addFact(facts, "价格", data.price ?? data.salePrice ?? data.min_price ?? data.priceRange);
  addFact(facts, "原价", data.old_price ?? data.oldPrice ?? data.originalPrice ?? data.listPrice);
  addFact(facts, "最低价", data.min_price ?? data.minPrice);
  addFact(facts, "条码", data.barcode ?? data.ean ?? data.gtin);
  addFact(facts, "发货地", data.deliveryAddress ?? data.location ?? data.shipFrom);
  addFact(facts, "重量", data.weight ?? data.packageWeight ?? data.grossWeight);
  addFact(facts, "商品简述", data.summary ?? data.shortDescription ?? data.descriptionText ?? descriptionText(data.description));
  addFact(facts, "标签", joinTextList(data.hashtags) || joinTextList(data.tags) || joinTextList(data.keywords) || joinTextList(data.marketingLabels));
  addFact(facts, "#主题标签", joinTextList(data.topicTags) || joinTextList(data.hashtags) || joinTextList(data.tags) || joinTextList(data.keywords));
  addFact(facts, "成分", data.composition ?? data.ingredientsText ?? joinTextList(data.ingredients) ?? data.ingredients);
  addFact(facts, "储存条件", data.storageConditions ?? data.storageCondition ?? data.storage ?? data.keepConditions);
  addFact(facts, "保质期（天）", data.shelfLifeDays ?? data.shelf_life_days ?? data.expirationDays ?? data.expiration_days);
  addFact(facts, "保质期", data.shelfLife ?? data.shelf_life ?? data.expiration ?? data.expirationDate ?? data.expiration_date);
  addFact(facts, "统一计量单位中的商品数量", data.unitQuantity ?? data.unit_quantity ?? data.quantityInUnit ?? data.quantity_in_unit ?? data.packageQuantity);
  addFact(facts, "生产工艺", data.productionProcess ?? data.production_process ?? data.productionTechnology ?? data.production_technology ?? data.technology);
  addFact(facts, "最高温度", data.maxTemperature ?? data.max_temperature ?? data.maximumTemperature ?? data.maximum_temperature);
  addFact(facts, "最低温度", data.minTemperature ?? data.min_temperature ?? data.minimumTemperature ?? data.minimum_temperature);
  addFact(facts, "包装长", packageDimensionText(packageInfo, "depth"));
  addFact(facts, "包装宽", packageDimensionText(packageInfo, "width"));
  addFact(facts, "包装高", packageDimensionText(packageInfo, "height"));
  addFact(facts, "包装重量", packageWeightText(data.packageWeight) || packageWeightText(packageInfo));
  addObjectFacts(facts, data.characteristics);
  addArrayFacts(facts, data.characteristics);
  addObjectFacts(facts, data.attributes);
  addArrayFacts(facts, data.attributes);
  addObjectFacts(facts, data.props);
  addArrayFacts(facts, data.props);
  addObjectFacts(facts, data.specs);
  addArrayFacts(facts, data.specs);
  addObjectFacts(facts, data.parameters);
  addArrayFacts(facts, data.parameters);

  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${normalizeText(fact.key)}:${normalizeText(fact.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenBaseFields(nodes: OzonAttributeNode[]): OzonAttributeNode[] {
  return nodes.flatMap((node) => {
    const children = flattenBaseFields(node.children ?? []);
    return node.ozonCode || children.length === 0 ? [node, ...children] : children;
  });
}

function readBaseValue(field: OzonAttributeNode, facts: SourceFact[], category: { label: string; descriptionCategoryId: number | null; typeId: number | null } | null) {
  if (field.id === "category_type") {
    if (!category) return null;
    return {
      value: `${category.label} / ${category.descriptionCategoryId ?? "-"} / ${category.typeId ?? "-"}`,
      confidence: 0.86,
      source: "Ozon 类目",
      reason: "已匹配到 Ozon description_category_id / type_id。",
    };
  }

  if (field.id === "offer_id") {
    return {
      value: `OZ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      confidence: 0.9,
      source: "系统随机生成",
      reason: "每次新采集自动生成独立卖家货号，用户可以在第一阶段手动修改。",
    };
  }

  if (field.id === "name") {
    const matched = findFact(facts, ["商品标题", "标题", "名称", "title", "name"]);
    if (matched) return { value: matched.value, confidence: 0.82, source: matched.key, reason: "按来源标题生成商品名称草稿。" };
  }

  if (field.id === "short_description") {
    const matched = findFact(facts, ["商品简述", "简述", "描述", "详情", "description", "summary"]);
    if (matched) return { value: matched.value, confidence: 0.68, source: matched.key, reason: "按来源描述生成商品简述草稿，建议人工压缩为清晰卖点。" };
  }

  if (field.id === "tags") {
    const matched = findFact(facts, ["标签", "关键词", "hashtags", "tags", "keywords"]);
    if (matched) return { value: matched.value, confidence: 0.64, source: matched.key, reason: "按来源标签或关键词生成运营标签草稿。" };
  }

  if (field.id === "topic_tags") {
    const matched = findFact(facts, ["#主题标签", "主题标签", "标签", "关键词", "hashtags", "tags", "keywords"]);
    if (matched) return { value: matched.value, confidence: 0.64, source: matched.key, reason: "按来源标签、标题关键词或卖点生成 Ozon 内容质量主题标签草稿。" };
  }

  if (field.id === "composition") {
    const matched = findFact(facts, ["成分", "配料", "组成", "ingredients", "composition", "состав"]);
    if (matched) return { value: matched.value, confidence: 0.74, source: matched.key, reason: "按来源详情、规格参数或包装 OCR 填写成分，上传前需按类目属性复核。" };
  }

  if (field.id === "storage_conditions") {
    const matched = findFact(facts, ["储存条件", "保存条件", "贮存条件", "storageconditions", "storage", "условияхранения", "условияхранить"]);
    if (matched) return { value: matched.value, confidence: 0.72, source: matched.key, reason: "按来源详情、规格参数或包装 OCR 填写储存条件。" };
  }

  if (field.id === "shelf_life_days") {
    const matched = findFact(facts, ["保质期（天）", "保质期", "有效期", "shelflife", "expiration", "срокгодности"]);
    if (matched) {
      return {
        value: normalizeShelfLifeDays(matched.value),
        confidence: 0.7,
        source: matched.key,
        reason: "按来源保质期填写；若来源不是天数，已做基础换算，建议人工确认。",
      };
    }
  }

  if (field.id === "unit_quantity") {
    const matched = findFact(facts, ["统一计量单位中的商品数量", "净含量", "数量", "件数", "规格", "unitquantity", "quantityinunit", "количествотовара"]);
    if (matched) return { value: numberFromText(matched.value), confidence: 0.58, source: matched.key, reason: "按来源规格/数量字段生成计量数量草稿，需结合类目单位人工确认。" };
  }

  if (field.id === "production_process") {
    const matched = findFact(facts, ["生产工艺", "生产工程", "工艺", "加工工艺", "technology", "productionprocess", "технологияпроизводства"]);
    if (matched) return { value: matched.value, confidence: 0.6, source: matched.key, reason: "按来源规格参数或详情页填写生产工艺草稿。" };
  }

  if (field.id === "max_temperature") {
    const matched = findFact(facts, ["最高温度", "最高储存温度", "最高保存温度", "maxtemperature", "maximumtemperature", "максимальнаятемпература"]);
    if (matched) return { value: numberFromText(matched.value), confidence: 0.6, source: matched.key, reason: "按来源温度字段填写最高温度草稿。" };
  }

  if (field.id === "min_temperature") {
    const matched = findFact(facts, ["最低温度", "最低储存温度", "最低保存温度", "mintemperature", "minimumtemperature", "минимальнаятемпература"]);
    if (matched) return { value: numberFromText(matched.value), confidence: 0.6, source: matched.key, reason: "按来源温度字段填写最低温度草稿。" };
  }

  if (field.id === "brand") {
    return {
      value: BRAND_DEFAULT_VALUE,
      confidence: 0.9,
      source: "业务默认",
      reason: "按当前上架规则，品牌字段自动填写“没有品牌”。",
    };
  }

  if (field.id === "price" || field.id === "old_price" || field.id === "min_price") {
    return null;
  }

  if (field.id === "cost_price") {
    const matched = findFact(facts, ["价格", "price", "saleprice"]);
    if (matched) {
      return {
        value: numberFromText(matched.value),
        confidence: 0.9,
        source: matched.key,
        reason: "抓取到的来源商品价格自动写入成本；该字段不会上传到 Ozon。",
      };
    }
  }

  if (field.id === "currency_code") {
    return { value: "CNY", confidence: 0.72, source: "店铺默认", reason: "先按本地上架模块默认币种 CNY 填写，可按店铺策略修改。" };
  }

  if (field.id === "barcode") {
    const matched = findFact(facts, ["条码", "条形码", "商品条形码", "barcode", "ean", "gtin"]);
    if (matched) return { value: matched.value, confidence: 0.76, source: matched.key, reason: "按来源条码字段填写。" };
  }

  if (field.id === "images") {
    return { value: "等待图片处理模块回填", confidence: 0.5, source: "图片模块", reason: "主图和附图由当前工作流图片板块处理后回填。" };
  }

  if (field.id === "weight") {
    const matched = findFact(facts, ["包装重量", "重量", "weight", "вес"]);
    if (matched) return { value: matched.value, confidence: 0.68, source: matched.key, reason: "按来源重量字段填写，上传前需统一单位。" };
  }

  if (field.id === "weight_unit") {
    return { value: "g", confidence: 0.7, source: "本地默认", reason: "本地上架模块默认重量单位为 g。" };
  }

  if (field.id === "dimension_unit") {
    return { value: "mm", confidence: 0.7, source: "本地默认", reason: "本地上架模块默认尺寸单位为 mm。" };
  }

  const dimensionFact = findFact(facts, [field.label, field.id, field.ozonCode ?? ""]);
  if (dimensionFact) {
    return { value: dimensionFact.value, confidence: 0.55, source: dimensionFact.key, reason: `按来源字段“${dimensionFact.key}”填写。` };
  }

  return null;
}

function buildListingBaseDraft(facts: SourceFact[], category: { label: string; descriptionCategoryId: number | null; typeId: number | null } | null) {
  return flattenBaseFields(ozonListingBaseFields).map<DraftFeature>((field) => {
    const matched = readBaseValue(field, facts, category);
    const required = field.requirement === "required";
    return {
      attributeId: `base:${field.id}`,
      label: field.label,
      value: matched?.value ?? "",
      confidence: matched?.confidence ?? (required ? 0.22 : 0.45),
      required,
      group: "base",
      ozonCode: field.ozonCode ?? null,
      valueType: field.valueType,
      status: matched?.value ? (field.humanReview ? "review" : "auto") : required ? "missing" : "review",
      source: matched?.source ?? "",
      reason: matched?.reason ?? field.aiHint,
      dictionaryValueCount: 0,
      options: [],
    };
  });
}

function buildGenericDraft(facts: SourceFact[]) {
  return facts
    .filter((fact) => !isMediaOrUploadOnlyFact(fact))
    .slice(0, 80)
    .map<DraftFeature>((fact, index) => ({
    attributeId: `source-${String(index + 1).padStart(3, "0")}`,
    label: fact.key,
    value: fact.value,
    confidence: 0.58,
    required: false,
    group: "source",
    ozonCode: null,
    valueType: "string",
    status: "review",
    source: fact.key,
    reason: "本地 Ozon 类目/属性表尚未就绪，先保留为可编辑源特征；同步 Ozon 表后可再生成带 attribute id 的上架特征。",
    dictionaryValueCount: 0,
    options: [],
  }));
}

const aliasGroups: Array<{ patterns: string[]; keys: string[] }> = [
  { patterns: ["бренд", "品牌", "brand"], keys: ["品牌", "brand", "牌子"] },
  { patterns: ["цвет", "颜色", "color"], keys: ["颜色", "颜色分类", "color", "colour"] },
  { patterns: ["размер", "尺码", "尺寸", "size"], keys: ["尺码", "尺寸", "size", "规格"] },
  { patterns: ["материал", "材质", "material"], keys: ["材质", "面料", "material"] },
  { patterns: ["вес", "重量", "weight"], keys: ["重量", "packageweight", "weight"] },
  { patterns: ["пол", "性别", "gender"], keys: ["性别", "适用性别", "gender"] },
  { patterns: ["сезон", "季节", "season"], keys: ["季节", "适用季节", "season"] },
  { patterns: ["страна", "产地", "country"], keys: ["产地", "国家", "发货地", "country"] },
  { patterns: ["модель", "型号", "model"], keys: ["型号", "货号", "model", "商品ID"] },
  { patterns: ["название", "名称", "title", "name"], keys: ["商品标题", "名称", "标题", "title", "name"] },
  { patterns: ["состав", "成分", "ingredients", "composition"], keys: ["成分", "配料", "ingredients", "composition", "состав"] },
  { patterns: ["условия хранения", "储存条件", "保存条件", "storage"], keys: ["储存条件", "保存条件", "storage", "storageconditions"] },
  { patterns: ["срок годности", "保质期", "shelf life", "expiration"], keys: ["保质期（天）", "保质期", "有效期", "shelflife", "expiration"] },
  { patterns: ["температура", "温度", "temperature"], keys: ["最高温度", "最低温度", "maxtemperature", "mintemperature"] },
  { patterns: ["количество товара", "计量单位", "unit quantity", "quantity"], keys: ["统一计量单位中的商品数量", "净含量", "数量", "unitquantity", "quantityinunit"] },
  { patterns: ["технология производства", "生产工艺", "production process", "technology"], keys: ["生产工艺", "生产工程", "technology", "productionprocess"] },
];

function semanticText(value: string) {
  return normalizeText(value).replace(/[^a-zа-яё0-9\u4e00-\u9fff]+/giu, "");
}

function isBrandText(value: string) {
  const text = semanticText(value);
  return text.includes("brand") || text.includes("品牌") || text.includes("бренд");
}

function isCountryText(value: string) {
  const text = semanticText(value);
  return (
    text.includes("country") ||
    text.includes("国家") ||
    text.includes("产地") ||
    text.includes("原产国") ||
    text.includes("страна")
  );
}

function isBrandFeature(feature: Pick<DraftFeature, "attributeId" | "label" | "ozonCode">) {
  return [feature.attributeId, feature.label, feature.ozonCode ?? ""].some(isBrandText);
}

function isModelNameFeature(
  feature: Pick<
    DraftFeature,
    "attributeId" | "label" | "displayLabel" | "ozonCode"
  >,
) {
  const text = featureSearchText(feature);
  return (
    text.includes("9048") ||
    text.includes("названиемодели") ||
    text.includes("modelname") ||
    text.includes("型号名称")
  );
}

function isCountryFeature(feature: Pick<DraftFeature, "attributeId" | "label" | "ozonCode">) {
  return [feature.attributeId, feature.label, feature.ozonCode ?? ""].some(isCountryText);
}

function featureSearchText(
  feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">,
) {
  return semanticText(
    `${feature.attributeId} ${feature.label} ${feature.displayLabel ?? ""} ${feature.ozonCode ?? ""}`,
  );
}

function isManufacturerFeature(
  feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">,
) {
  const text = featureSearchText(feature);
  return (
    text.includes("23487") ||
    text.includes("производитель") ||
    text.includes("manufacturer") ||
    text.includes("制造商")
  );
}

function isFactoryPackageFeature(
  feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">,
) {
  const text = featureSearchText(feature);
  return (
    text.includes("11650") ||
    text.includes("количествозаводскихупаковок") ||
    text.includes("原厂包装数量")
  );
}

function isHazardClassFeature(
  feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">,
) {
  const text = featureSearchText(feature);
  return (
    text.includes("9782") ||
    text.includes("классопасноститовара") ||
    text.includes("产品危险等级")
  );
}

function isWarrantyFeature(
  feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">,
) {
  const text = featureSearchText(feature);
  return (
    text.includes("10400") ||
    text.includes("гарантия") ||
    text.includes("warranty") ||
    text.includes("保证")
  );
}

function isShelfLifeFeature(
  feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">,
) {
  const text = featureSearchText(feature);
  return (
    text.includes("8205") ||
    text.includes("срокгодности") ||
    text.includes("shelflife") ||
    text.includes("保质期")
  );
}

function warrantyOptionDays(value: string) {
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  if (/无担保|безгарант|пожизн|lifetime/.test(normalized)) return null;
  const amountText = normalized.match(/\d+(?:[.,]\d+)?/)?.[0];
  if (!amountText) return null;
  const amount = Number(amountText.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (/дн|day|天/.test(normalized)) return amount;
  if (/нед|week|周/.test(normalized)) return amount * 7;
  if (/месяц|month|个月|月/.test(normalized)) return amount * 30;
  if (/год|лет|year|年|岁/.test(normalized)) return amount * 365;
  return null;
}

function dictionaryDefaultFeature(
  feature: DraftFeature,
  mapping: NonNullable<DraftFeature["optionMappings"]>[number] | undefined,
  fallbackLabel: string,
  fallbackUploadValue: string,
  reason: string,
) {
  const dictionaryValueId = Number(mapping?.dictionaryValueId);
  const uploadValue = mapping?.value || fallbackUploadValue;
  return {
    ...feature,
    value: mapping?.label || fallbackLabel,
    confidence: Math.max(feature.confidence, 0.94),
    status: "auto" as const,
    source: "业务默认",
    reason,
    ozonAttributeValues: [
      {
        ...(Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
          ? { dictionary_value_id: dictionaryValueId }
          : {}),
        value: uploadValue,
      },
    ],
  };
}

function isColorNameFeature(feature: Pick<DraftFeature, "attributeId" | "label" | "displayLabel" | "ozonCode">) {
  const normalized = semanticText(
    `${feature.attributeId} ${feature.label} ${feature.displayLabel ?? ""} ${feature.ozonCode ?? ""}`,
  );
  return (
    normalized.includes("10097") ||
    normalized.includes("названиецвета") ||
    normalized.includes("颜色名称")
  );
}

function colorLookupValues(feature: DraftFeature, features: DraftFeature[]) {
  const values = [
    ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
    feature.aiJsonValue,
    feature.value,
  ];
  if (isOzonColorAttributeId(feature.ozonCode || feature.attributeId)) {
    const colorNameFeature = features.find(isColorNameFeature);
    if (colorNameFeature) {
      values.unshift(
        ...(colorNameFeature.ozonAttributeValues?.map((value) => value.value) ?? []),
        colorNameFeature.aiJsonValue,
        colorNameFeature.value,
      );
    }
  }
  return values.filter((value): value is string => Boolean(value?.trim()));
}

function applyBusinessDefaultsToFeature(feature: DraftFeature): DraftFeature {
  const hasReturnedValue = [
    ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
    feature.aiJsonValue,
    feature.value,
  ].some((value) => String(value ?? "").trim());
  if (
    hasReturnedValue &&
    (Boolean(feature.aiJsonPath) || /AI|快速模式/i.test(feature.source))
  ) {
    return feature;
  }

  if (
    String(feature.ozonCode || feature.attributeId).replace(/^base:/, "") ===
    "23249"
  ) {
    if (feature.value.trim()) return feature;
    return {
      ...feature,
      value: "1",
      aiJsonValue: "1",
      ozonAttributeValues: [{ value: "1" }],
      confidence: Math.max(feature.confidence, 0.94),
      status: "auto",
      source: "业务默认",
      reason: "AI 和来源数据未返回数量时，默认填写 1。",
    };
  }

  if (isBrandFeature(feature)) {
    return {
      ...feature,
      value: BRAND_DEFAULT_VALUE,
      confidence: Math.max(feature.confidence, 0.9),
      status: "auto",
      source: "业务默认",
      reason: "按当前上架规则，品牌字段自动填写“没有品牌”。",
    };
  }

  if (isCountryFeature(feature)) {
    return {
      ...feature,
      value: COUNTRY_DEFAULT_VALUE,
      confidence: Math.max(feature.confidence, 0.9),
      status: "auto",
      source: "业务默认",
      reason: "按当前上架规则，国家/产地字段自动填写“中国”。",
    };
  }

  if (isManufacturerFeature(feature)) {
    return {
      ...feature,
      value: MANUFACTURER_DEFAULT_VALUE,
      aiJsonValue: MANUFACTURER_DEFAULT_VALUE,
      ozonAttributeValues: [{ value: MANUFACTURER_DEFAULT_VALUE }],
      confidence: Math.max(feature.confidence, 0.94),
      status: "auto",
      source: "业务默认",
      reason: "按当前上架规则，制造商固定填写 China，并覆盖 AI 返回值。",
    };
  }

  if (isFactoryPackageFeature(feature)) {
    return {
      ...feature,
      value: FACTORY_PACKAGE_DEFAULT_VALUE,
      confidence: Math.max(feature.confidence, 0.94),
      status: "auto",
      source: "业务默认",
      reason: "按当前上架规则，原厂包装数量固定填写 1，并覆盖 AI 返回值。",
    };
  }

  if (isHazardClassFeature(feature)) {
    const safeOption = feature.optionMappings?.find((option) =>
      /не\s*опасен|不危险|not\s*dangerous/i.test(
        `${option.label ?? ""} ${option.value}`,
      ),
    );
    return dictionaryDefaultFeature(
      feature,
      safeOption,
      SAFE_HAZARD_DEFAULT_LABEL,
      SAFE_HAZARD_DEFAULT_UPLOAD_VALUE,
      "按当前上架规则，产品危险等级固定选择“不危险”，并覆盖 AI 返回值。",
    );
  }

  if (isShelfLifeFeature(feature)) {
    return {
      ...feature,
      value: DEFAULT_SHELF_LIFE_DAYS,
      confidence: Math.max(feature.confidence, 0.94),
      status: "auto",
      source: "业务默认",
      reason: "按当前上架规则，保质期固定填写 30 天，并覆盖 AI 返回值。",
      ozonAttributeValues: [{ value: DEFAULT_SHELF_LIFE_DAYS }],
    };
  }

  if (isWarrantyFeature(feature)) {
    const warrantyOption = (feature.optionMappings ?? [])
      .flatMap((option) => {
        const days = warrantyOptionDays(`${option.label ?? ""} ${option.value}`);
        return days === null ? [] : [{ option, days }];
      })
      .find((candidate) => candidate.days === DEFAULT_WARRANTY_DAYS)?.option;
    return dictionaryDefaultFeature(
      feature,
      warrantyOption
        ? { ...warrantyOption, label: DEFAULT_WARRANTY_LABEL }
        : undefined,
      DEFAULT_WARRANTY_LABEL,
      DEFAULT_WARRANTY_UPLOAD_VALUE,
      "按当前上架规则，保证固定填写 30 天（Ozon 字典对应 1 个月），并覆盖 AI 返回值。",
    );
  }

  return feature;
}

function applyBusinessDefaults(features: DraftFeature[]) {
  return features.map(applyBusinessDefaultsToFeature);
}

function modelCodeFromTitle(title: string) {
  const candidates =
    title.match(
      /(?:[A-Za-z]{1,12}[-_./]?\d[A-Za-z0-9_-]{1,30}|\d[A-Za-z][A-Za-z0-9_-]{1,30})/g,
    ) ?? [];
  return (
    candidates
      .map((value) => value.replace(/[./]+$/g, "").trim())
      .find((value) => value.length >= 3 && value.length <= 40) ?? ""
  );
}

function stableProductModel(
  preparedProduct: PreparedProductFacts,
  facts: SourceFact[],
) {
  const explicitModel = facts.find((fact) => {
    const key = semanticText(fact.key);
    return (
      !/(?:卖家|sku|offer)/i.test(key) &&
      (key.includes("型号") ||
        key.includes("款号") ||
        key.includes("货号") ||
        key === "model" ||
        key.includes("modelname"))
    );
  });
  const explicitValue = explicitModel?.value.trim().slice(0, 120) ?? "";
  if (explicitValue) {
    return {
      value: explicitValue,
      source: explicitModel?.key || "来源型号",
      reason: "已从商品来源字段提取稳定型号；同一商品的全部 SKU 共用此型号。",
    };
  }

  const titleCode = modelCodeFromTitle(preparedProduct.title);
  if (titleCode) {
    return {
      value: titleCode,
      source: "商品标题",
      reason: "已从商品标题提取稳定型号；同一商品的全部 SKU 共用此型号。",
    };
  }

  const productId = preparedProduct.productId
    .replace(/[^A-Za-z0-9_-]+/g, "")
    .slice(0, 44);
  const fallbackCode =
    productId ||
    createHash("sha1")
      .update(
        `${preparedProduct.source}\n${preparedProduct.title}`.trim() ||
          "product-model",
      )
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
  return {
    value: `M-${fallbackCode}`.slice(0, 50),
    source: productId ? "来源商品ID" : "系统稳定生成",
    reason:
      "来源未提供明确型号，已按来源商品生成固定型号；重复加工及同商品全部 SKU 保持一致。",
  };
}

function applyStableProductModel(
  features: DraftFeature[],
  preparedProduct: PreparedProductFacts,
  facts: SourceFact[],
) {
  const model = stableProductModel(preparedProduct, facts);
  return features.map((feature) =>
    isModelNameFeature(feature)
      ? {
          ...feature,
          value: model.value,
          confidence: Math.max(feature.confidence, 0.96),
          status: "auto" as const,
          source: model.source,
          reason: model.reason,
          ozonAttributeValues: [{ value: model.value }],
        }
      : feature,
  );
}

function isExcludedMediaAttribute(attribute: OzonAttributeSnapshot) {
  const type = attribute.type?.toLowerCase().trim() ?? "";
  const searchable = [
    attribute.name,
    attribute.nameZh ?? "",
    attribute.ozonAttributeId,
    type,
  ]
    .map((value) => normalizeText(value))
    .join(" ");
  const imageLike =
    /изображени|картин|фото|photo|picture|image|gallery|图片|照片|图像/.test(
      searchable,
    );

  return (
    /pdf|видео|video|richконтент|richcontent|richtext|rich|视频|富媒体|富文本/.test(
      searchable,
    ) ||
    (/url|ссылк|link|链接/.test(searchable) && !imageLike)
  );
}

function isMediaOrUploadOnlyFact(fact: SourceFact) {
  const searchable = normalizeText(`${fact.key} ${fact.value}`);
  const imageLike = /image|images|picture|pictures|photo|photos|gallery|图片|照片|图像/.test(
    searchable,
  );
  return (
    /pdf|video|videos|rich|media|视频|富媒体|富文本/.test(searchable) ||
    (/url|link|链接/.test(searchable) && !imageLike)
  );
}

function findHeuristicValue(attribute: OzonAttributeSnapshot, facts: SourceFact[]) {
  if (
    isExcludedMediaAttribute(attribute) ||
    isIgnoredOzonAttribute(attribute)
  ) {
    return null;
  }
  const attrName = normalizeText(attribute.name);
  const attributeId = String(attribute.ozonAttributeId);
  const isBristleAttribute = /ворс|щетин|bristle|刷毛|鬃毛|桩材/.test(
    normalizeText(`${attribute.name} ${attribute.nameZh ?? ""}`),
  );
  const selectedSkuPackageFactKeys: Record<string, string[]> = {
    "4497": ["包装重量(g)", "商品重量(g)"],
    "4383": ["商品重量(g)", "包装重量(g)"],
    "6728": ["商品重量(g)", "包装重量(g)"],
    "9802": ["商品长(mm)", "包装长(mm)"],
    "9799": ["商品宽(mm)", "包装宽(mm)"],
  };
  const selectedSkuPackageFact = selectedSkuPackageFactKeys[attributeId]
    ? findFact(facts, selectedSkuPackageFactKeys[attributeId])
    : null;
  if (selectedSkuPackageFact) {
    const sourceNumber = Number(numberFromText(selectedSkuPackageFact.value));
    const normalizedValue =
      attributeId === "6728" && Number.isFinite(sourceNumber)
        ? String(sourceNumber / 1000)
        : numberFromText(selectedSkuPackageFact.value);
    return {
      value: normalizedValue,
      confidence: 0.96,
      source: selectedSkuPackageFact.key,
      reason: "已按当前所选 1688 SKU 的商品件重尺逐项匹配并换算为 Ozon 单位。",
    };
  }
  if (isBrandText(attribute.name) || isBrandText(attribute.ozonAttributeId)) {
    return {
      value: BRAND_DEFAULT_VALUE,
      confidence: 0.9,
      source: "业务默认",
      reason: "按当前上架规则，品牌字段自动填写“没有品牌”。",
    };
  }

  if (isCountryText(attribute.name) || isCountryText(attribute.ozonAttributeId)) {
    return {
      value: COUNTRY_DEFAULT_VALUE,
      confidence: 0.9,
      source: "业务默认",
      reason: "按当前上架规则，国家/产地字段默认填写“中国”。",
    };
  }

  const direct = facts.find((fact) => {
    const factKey = normalizeText(fact.key);
    if (
      isBristleAttribute &&
      !/ворс|щетин|bristle|刷毛|鬃毛|毛料|桩材/.test(factKey)
    ) {
      return false;
    }
    return factKey && (attrName.includes(factKey) || factKey.includes(attrName));
  });
  if (direct) {
    return {
      value: direct.value,
      confidence: 0.72,
      source: direct.key,
      reason: `按爬虫字段“${direct.key}”自动匹配。`,
    };
  }

  for (const group of aliasGroups) {
    if (isBristleAttribute) continue;
    if (!group.patterns.some((pattern) => attrName.includes(normalizeText(pattern)))) continue;
    const matched = facts.find((fact) => group.keys.some((key) => normalizeText(fact.key).includes(normalizeText(key))));
    if (matched) {
      return {
        value: matched.value,
        confidence: 0.66,
        source: matched.key,
        reason: `按字段别名“${matched.key}”自动匹配。`,
      };
    }
  }

  return null;
}

function stringifyAiValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item)).filter(Boolean).join(", ");
  }
  return textValue(value);
}

function buildCategoryDraft(attributes: OzonAttributeSnapshot[], facts: SourceFact[]) {
  return attributes
    .filter(
      (attribute) =>
        !isExcludedMediaAttribute(attribute) &&
        !isIgnoredOzonAttribute(attribute),
    )
    .map<DraftFeature>((attribute) => {
      const matched = findHeuristicValue(attribute, facts);
      const hasDictionary = Boolean(
        attribute.dictionaryId && attribute.dictionaryId !== "0",
      );
      const optionMappings = attribute.values.map((value) => {
        const dictionaryValueId = Number(value.ozonValueId);
        return {
          label: value.valueZh || value.value,
          value: value.value,
          ...(Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
            ? { dictionaryValueId }
            : {}),
        };
      });
      const options = optionMappings.map((value) => value.label);
      if (matched) {
        return {
          attributeId: attribute.ozonAttributeId,
          label: attribute.name,
          displayLabel: attribute.nameZh || attribute.name,
          value: matched.value,
          confidence: matched.confidence,
          required: attribute.isRequired,
          group: "category",
          ozonCode: attribute.ozonAttributeId,
          valueType: attribute.type,
          status: hasDictionary ? "review" : "auto",
          source: matched.source,
          reason: hasDictionary
            ? `${matched.reason} 该字段有 Ozon 字典，上传前建议核对字典值。`
            : matched.reason,
          dictionaryValueCount: attribute.dictionaryValueCount,
          options,
          optionMappings,
        };
      }

      return {
        attributeId: attribute.ozonAttributeId,
        label: attribute.name,
        displayLabel: attribute.nameZh || attribute.name,
        value: "",
        confidence: attribute.isRequired ? 0.24 : 0.42,
        required: attribute.isRequired,
        group: "category",
        ozonCode: attribute.ozonAttributeId,
        valueType: attribute.type,
        status: attribute.isRequired ? "missing" : "review",
        source: "",
        reason: attribute.isRequired
          ? "Ozon 同步表标记为必填，爬虫 JSON 中暂未找到可直接匹配的值。"
          : hasDictionary
            ? "该字段绑定 Ozon 字典值，需要 AI 或人工从字典里确认。"
            : "需要人工复核后再上传。",
        dictionaryValueCount: attribute.dictionaryValueCount,
        options,
        optionMappings,
      };
    });
}

const SKU_SPEC_ATTRIBUTE_RULES: Array<{
  source: RegExp;
  target: RegExp;
}> = [
  {
    source: /颜色|色号|色彩|color|colour|цвет/i,
    target: /颜色|色号|color|colour|цвет/i,
  },
  {
    source: /尺寸|尺码|大小|号型|size|размер/i,
    target: /尺寸|尺码|号型|size|размер/i,
  },
  {
    source: /型号|款式|形状|类型|规格|model|style|форма|тип/i,
    target: /型号|款式|形状|产品形式|model|style|форма|тип/i,
  },
  {
    source: /容量|容积|净含量|capacity|volume|объ[её]м/i,
    target: /容量|容积|净含量|capacity|volume|объ[её]м/i,
  },
  {
    source: /包装数量|每件数量|件数|数量|套装|quantity|count|количество/i,
    target: /包装数量|每件数量|件数|数量|套装|quantity|count|количество/i,
  },
];

function buildVariantSpecDraft(
  variant: PreparedProductVariant,
  categoryDraft: DraftFeature[],
  attributes: OzonAttributeSnapshot[],
) {
  const attributeById = new Map(
    attributes.map((attribute) => [attribute.ozonAttributeId, attribute]),
  );
  const matched = new Map<string, DraftFeature>();
  for (const fact of [...variant.specs, ...variant.package]) {
    const sourceKey = fact.key.trim();
    const sourceValue = fact.value.trim();
    if (!sourceKey || !sourceValue) continue;
    const normalizedSourceKey = normalizeText(sourceKey);
    const rule = SKU_SPEC_ATTRIBUTE_RULES.find((candidate) =>
      candidate.source.test(sourceKey),
    );
    const candidates = categoryDraft
      .filter((feature) => !isModelNameFeature(feature))
      .map((feature) => {
        const attribute = attributeById.get(feature.attributeId);
        const targetText = [
          feature.displayLabel,
          feature.label,
          attribute?.nameZh,
          attribute?.name,
        ]
          .filter(Boolean)
          .join(" ");
        const normalizedTarget = normalizeText(targetText);
        const score =
          normalizedSourceKey &&
          (normalizedTarget.includes(normalizedSourceKey) ||
            normalizedSourceKey.includes(normalizedTarget))
            ? 3
            : rule?.target.test(targetText)
              ? 2
              : 0;
        return { feature, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    const selected = candidates[0]?.feature;
    if (!selected || matched.has(selected.attributeId)) continue;
    matched.set(selected.attributeId, {
      ...selected,
      value: sourceValue,
      confidence: 0.96,
      status: "review",
      source: `1688 SKU规格：${sourceKey}`,
      reason:
        "程序已按 SKU 规格名称匹配到当前 Ozon 属性；字典值会继续自动校验。",
      ozonAttributeValues: undefined,
      aiJsonKey: sourceKey,
      aiJsonPath: `variants.${variant.skuId}.${sourceKey}`,
      aiJsonValue: sourceValue,
    });
  }
  return [...matched.values()];
}

async function resolveFeatureDictionaryValues(
  features: DraftFeature[],
  attributes: OzonAttributeSnapshot[],
) {
  const attributeById = new Map(
    attributes.map((attribute) => [attribute.ozonAttributeId, attribute]),
  );
  return await Promise.all(
    features.map(async (feature) => {
      if (feature.group !== "category" || !feature.value.trim()) return feature;
      const attribute = attributeById.get(
        feature.ozonCode || feature.attributeId,
      );
      if (!attribute) return feature;
      const hasDictionary = Boolean(
        attribute.dictionaryId && attribute.dictionaryId !== "0",
      );
      const recoveredDisplayOnly =
        feature.source === "AI 中文展示 JSON" &&
        !feature.aiJsonValue?.trim();
      if (!hasDictionary) {
        if (recoveredDisplayOnly) {
          return {
            ...feature,
            status: "review" as const,
            ozonAttributeValues: undefined,
            reason:
              "AI 已返回中文展示值，但俄文上传值因回答截断而缺失；已回填到界面，重新匹配或人工确认俄文值后才能上传。",
          };
        }
        const uploadValue =
          feature.ozonAttributeValues?.find((value) => value.value?.trim())
            ?.value?.trim() || feature.value.trim();
        return {
          ...feature,
          ozonAttributeValues: [{ value: uploadValue }],
        };
      }

      const suppliedDictionaryValueId = feature.ozonAttributeValues
        ?.map((value) => Number(value.dictionary_value_id))
        .find((value) => Number.isSafeInteger(value) && value > 0);
      const suppliedUploadValue =
        feature.ozonAttributeValues?.find((value) => value.value?.trim())
          ?.value?.trim() || "";
      if (isOzonColorAttributeId(attribute.ozonAttributeId)) {
        const matchedColor = findOzonColorValue(
          attribute.values,
          colorLookupValues(feature, features),
        );
        if (matchedColor) {
          return {
            ...feature,
            value: matchedColor.label || feature.value,
            status: "auto" as const,
            ozonAttributeValues: [
              {
                dictionary_value_id: matchedColor.dictionary_value_id,
                value: matchedColor.value,
              },
            ],
            reason: `${feature.reason} 已根据“${matchedColor.sourceText}”匹配 Ozon 颜色字典值 ${matchedColor.value}。`,
          };
        }
      }
      const lookupValue = isBrandFeature(feature)
        ? "Нет бренда"
        : isCountryFeature(feature)
          ? "Китай"
          : suppliedUploadValue || feature.value.trim();
      const normalizedLookup = normalizeText(lookupValue);
      const isActiveChlorineComposition =
        attribute.ozonAttributeId === "10166" &&
        /次氯酸|有效氯|含氯|hypochlor|хлорноват|хлорсодержащ/i.test(
          lookupValue,
        );
      const semanticMatches = isActiveChlorineComposition
        ? attribute.values.filter((candidate) =>
            /含氯|активн.*хлор|хлорсодержащ/i.test(
              `${candidate.value} ${candidate.valueZh ?? ""}`,
            ),
          )
        : [];
      const cachedMatches = semanticMatches.length
        ? semanticMatches
        : attribute.values.filter(
        (candidate) =>
          (suppliedDictionaryValueId &&
            Number(candidate.ozonValueId) === suppliedDictionaryValueId) ||
          normalizeText(candidate.value) === normalizedLookup ||
          normalizeText(candidate.valueZh || "") === normalizedLookup,
        );
      const databaseMatches = cachedMatches.length
        ? cachedMatches
        : await prisma.ozonAttributeValue.findMany({
            where: {
              attributeId: attribute.id,
              OR: [
                ...(suppliedDictionaryValueId
                  ? [{ ozonValueId: String(suppliedDictionaryValueId) }]
                  : []),
                { value: lookupValue },
                { valueZh: lookupValue },
              ],
            },
            take: 2,
          });
      const matched = databaseMatches.length === 1 ? databaseMatches[0] : null;
      const dictionaryValueId = Number(matched?.ozonValueId);
      if (
        matched &&
        Number.isSafeInteger(dictionaryValueId) &&
        dictionaryValueId > 0
      ) {
        return {
          ...feature,
          ...(isActiveChlorineComposition
            ? { value: matched.valueZh || matched.value }
            : {}),
          ozonAttributeValues: [
            {
              dictionary_value_id: dictionaryValueId,
              value: matched.value,
            },
          ],
          reason: `${feature.reason} 已匹配 Ozon 字典值 ${matched.value}。`,
        };
      }
      return {
        ...feature,
        status: "review" as const,
        ozonAttributeValues: undefined,
        reason: `${feature.reason} 当前值尚未匹配到 Ozon 字典 ID，上传前需要人工复核。`,
      };
    }),
  );
}

type ParsedAiFeatureResponse = {
  displayFeatures: z.infer<typeof aiDisplayFeatureItemSchema>[];
  uploadFeatures: z.infer<typeof aiFeatureItemSchema>[];
  variants: z.infer<typeof aiVariantFeatureResponseSchema>[];
  notes: string[];
  repaired: boolean;
  displayOnlyIds: string[];
  uploadOnlyIds: string[];
};

function parseDirectFeatureMap(
  value: unknown,
  mode: "display",
): z.infer<typeof aiDisplayFeatureItemSchema>[];
function parseDirectFeatureMap(
  value: unknown,
  mode: "upload",
): z.infer<typeof aiFeatureItemSchema>[];
function parseDirectFeatureMap(
  value: unknown,
  mode: "display" | "upload",
) {
  const record = asRecord(value);
  if (mode === "display") {
    return Object.entries(record).flatMap(([attributeId, itemValue]) => {
      if (!/^\d+$/.test(attributeId)) return [];
      const parsed = aiDisplayFeatureItemSchema.safeParse({
        attributeId,
        valueZh: itemValue,
      });
      return parsed.success ? [parsed.data] : [];
    });
  }
  return Object.entries(record).flatMap(([attributeId, itemValue]) => {
    if (!/^\d+$/.test(attributeId)) return [];
    const parsed = aiFeatureItemSchema.safeParse({
      attributeId,
      value: itemValue,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function parseAiFeatureResponse(raw: string): ParsedAiFeatureResponse {
  const containers = extractJsonContainers(raw);
  const candidates = containers.length ? containers : [raw];
  const parsedValues: unknown[] = [];
  let repaired = false;
  for (const candidate of candidates) {
    try {
      const parsed = parseStructuredJson(candidate);
      parsedValues.push(parsed.value);
      repaired ||= parsed.repaired;
    } catch {
      // 单个区块失败时继续解析其他完整 JSON 区块。
    }
  }
  if (!parsedValues.length) {
    const parsed = parseStructuredJson(raw);
    parsedValues.push(parsed.value);
    repaired ||= parsed.repaired;
  }

  const displayFeatures: z.infer<typeof aiDisplayFeatureItemSchema>[] = [];
  const uploadFeatures: z.infer<typeof aiFeatureItemSchema>[] = [];
  const variants: z.infer<typeof aiVariantFeatureResponseSchema>[] = [];
  const notes: string[] = [];

  for (const value of parsedValues) {
    const record = asRecord(value);
    const dual = aiDualFeatureResponseSchema.safeParse(record);
    if (dual.success) {
      displayFeatures.push(...dual.data.displayFeatures);
      uploadFeatures.push(...dual.data.uploadFeatures);
      variants.push(...dual.data.variants);
      notes.push(...(dual.data.notes ?? []));
    }

    if (Array.isArray(record.variants)) {
      for (const candidate of record.variants) {
        const parsed = aiVariantFeatureResponseSchema.safeParse(candidate);
        if (parsed.success) variants.push(parsed.data);
      }
    }

    const displayCandidates =
      record.displayFeatures ?? record.display_features ?? record.display;
    if (Array.isArray(displayCandidates)) {
      for (const candidate of displayCandidates) {
        const parsed = aiDisplayFeatureItemSchema.safeParse(candidate);
        if (parsed.success) displayFeatures.push(parsed.data);
      }
    } else if (displayCandidates) {
      displayFeatures.push(
        ...parseDirectFeatureMap(displayCandidates, "display"),
      );
    }

    const uploadCandidates =
      record.uploadFeatures ?? record.upload_features ?? record.upload;
    if (Array.isArray(uploadCandidates)) {
      for (const candidate of uploadCandidates) {
        const parsed = aiFeatureItemSchema.safeParse(candidate);
        if (parsed.success) uploadFeatures.push(parsed.data);
      }
    } else if (uploadCandidates) {
      uploadFeatures.push(
        ...parseDirectFeatureMap(uploadCandidates, "upload"),
      );
    }

    if (Array.isArray(record.features)) {
      for (const candidate of record.features) {
        const candidateRecord = asRecord(candidate);
        if ("valueZh" in candidateRecord || "keyZh" in candidateRecord) {
          const parsed = aiDisplayFeatureItemSchema.safeParse(candidate);
          if (parsed.success) displayFeatures.push(parsed.data);
        } else {
          const parsed = aiFeatureItemSchema.safeParse(candidate);
          if (parsed.success) uploadFeatures.push(parsed.data);
        }
      }
    }

    if (!Array.isArray(record.features) && !displayCandidates && !uploadCandidates) {
      const directDisplay = parseDirectFeatureMap(record, "display");
      const directUpload = parseDirectFeatureMap(record, "upload");
      if (parsedValues.length > 1 && parsedValues.indexOf(value) === 0) {
        displayFeatures.push(...directDisplay);
      } else if (parsedValues.length > 1) {
        uploadFeatures.push(...directUpload);
      }
    }

    if (Array.isArray(record.notes)) {
      notes.push(
        ...record.notes.filter(
          (note): note is string => typeof note === "string" && Boolean(note.trim()),
        ),
      );
    } else if (typeof record.notes === "string" && record.notes.trim()) {
      notes.push(record.notes.trim());
    }
  }

  const uniqueDisplay = Array.from(
    new Map(displayFeatures.map((feature) => [feature.attributeId, feature])).values(),
  );
  const uniqueUpload = Array.from(
    new Map(uploadFeatures.map((feature) => [feature.attributeId, feature])).values(),
  );
  const displayIds = new Set(uniqueDisplay.map((feature) => feature.attributeId));
  const uploadIds = new Set(uniqueUpload.map((feature) => feature.attributeId));
  const uniqueVariants = Array.from(
    new Map(variants.map((variant) => [variant.skuId, variant])).values(),
  );

  return {
    displayFeatures: uniqueDisplay,
    uploadFeatures: uniqueUpload,
    variants: uniqueVariants,
    notes: [...new Set(notes)],
    repaired,
    displayOnlyIds: [...displayIds].filter((attributeId) => !uploadIds.has(attributeId)),
    uploadOnlyIds: [...uploadIds].filter((attributeId) => !displayIds.has(attributeId)),
  };
}

function mergeAiFeatures(
  baseDraft: DraftFeature[],
  aiResponse: ParsedAiFeatureResponse,
) {
  const uploadById = new Map(
    aiResponse.uploadFeatures.map((feature) => [feature.attributeId, feature]),
  );
  const displayById = new Map(
    aiResponse.displayFeatures.map((feature) => [feature.attributeId, feature]),
  );
  return applyBusinessDefaults(baseDraft.map((feature) => {
    const uploadFeature = uploadById.get(feature.attributeId);
    const displayFeature = displayById.get(feature.attributeId);
    const uploadValue = stringifyAiValue(uploadFeature?.value);
    const displayValue = stringifyAiValue(displayFeature?.valueZh);
    const value = displayValue || uploadValue;
    if (!uploadFeature || !uploadValue) {
      return displayValue
        ? {
            ...feature,
            value: displayValue,
            displayLabel: displayFeature?.keyZh || feature.displayLabel,
            confidence: Math.max(feature.confidence, 0.62),
            status: "review" as const,
            source: "AI 中文展示 JSON",
            reason:
              "AI 已返回中文展示值，但对应的 Ozon 俄文上传字段未完整返回；界面已回填，上传前需要重新匹配或人工复核。",
            ozonAttributeValues: undefined,
            aiJsonKey: displayFeature?.keyZh,
            aiJsonPath: `displayFeatures.${feature.attributeId}`,
            aiJsonValue: undefined,
          }
        : feature;
    }
    const dictionaryValueId = Number(uploadFeature.dictionary_value_id);
    return {
      ...feature,
      value,
      displayLabel: displayFeature?.keyZh || feature.displayLabel,
      confidence:
        uploadFeature.confidence ?? Math.max(feature.confidence, 0.78),
      status: uploadFeature.status ?? "auto",
      source: uploadFeature.source || "AI",
      reason:
        uploadFeature.reason ||
        "由选中的文本模型根据爬虫 JSON 和 Ozon 属性表填写。",
      ozonAttributeValues: [
        {
          ...(Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
            ? { dictionary_value_id: dictionaryValueId }
            : {}),
          value: uploadValue,
        },
      ],
      aiJsonKey: displayFeature?.keyZh,
      aiJsonPath: `uploadFeatures.${feature.attributeId}`,
      aiJsonValue: uploadValue,
    };
  }));
}

function applySelectedSkuPackageValues(
  features: DraftFeature[],
  facts: SourceFact[],
) {
  const factKeysByAttributeId: Record<string, string[]> = {
    "4497": ["包装重量(g)", "商品重量(g)"],
    "4383": ["商品重量(g)", "包装重量(g)"],
    "6728": ["商品重量(g)", "包装重量(g)"],
    "9802": ["商品长(mm)", "包装长(mm)"],
    "9799": ["商品宽(mm)", "包装宽(mm)"],
  };
  return features.map((feature) => {
    const attributeId = String(feature.ozonCode || feature.attributeId);
    const factKeys = factKeysByAttributeId[attributeId];
    if (!factKeys) return feature;
    const matched = findFact(facts, factKeys);
    if (!matched) return feature;
    const sourceValue = numberFromText(matched.value);
    const sourceNumber = Number(sourceValue);
    const value =
      attributeId === "6728" && Number.isFinite(sourceNumber)
        ? String(sourceNumber / 1000)
        : sourceValue;
    if (!value) return feature;
    return {
      ...feature,
      value,
      confidence: 0.98,
      status: "auto" as const,
      source: matched.key,
      reason:
        "当前值来自所选 1688 SKU 对应的商品件重尺，优先级高于通用 AI 推断。",
      ozonAttributeValues: [{ value }],
    };
  });
}

function modelCanFillFeatures(model: { capabilities: Record<string, unknown>; isAvailable?: boolean }) {
  const capabilities = model.capabilities ?? {};
  const isImageOnly = Boolean(capabilities.image_gen || capabilities.image_edit) && !capabilities.text;
  return model.isAvailable !== false && Boolean(capabilities.text || capabilities.structured_output || capabilities.vision) && !isImageOnly;
}

function attributeValuesForAi(attribute: OzonAttributeSnapshot) {
  return attribute.values;
}

function compactPreparedProductForPrompt(
  product: ReturnType<typeof prepareProductFacts>,
  options: {
    factLimit: number;
    factValueLimit: number;
    descriptionLimit: number;
    variantSpecLimit: number;
  },
) {
  const compactFacts = (values: Array<{ key: string; value: string }>, limit: number) =>
    values.slice(0, limit).map((fact) => ({
      key: fact.key.slice(0, 120),
      value: fact.value.slice(0, options.factValueLimit),
    }));

  return {
    ...product,
    description: product.description.slice(0, options.descriptionLimit),
    facts: compactFacts(product.facts, options.factLimit),
    package: compactFacts(product.package, product.package.length),
    variants: product.variants.map((variant) => ({
      ...variant,
      title: variant.title.slice(0, 240),
      specText: variant.specText.slice(0, 500),
      specs: compactFacts(variant.specs, options.variantSpecLimit),
      package: compactFacts(variant.package, variant.package.length),
    })),
  };
}

async function hydratePriorityDictionaryValues(
  categoryId: string,
  attributes: OzonAttributeSnapshot[],
) {
  const targets = attributes.flatMap((attribute) => {
    if (isBrandText(attribute.name)) {
      return [
        {
          attribute,
          uploadValue: "Нет бренда",
          displayValue: BRAND_DEFAULT_VALUE,
        },
      ];
    }
    if (isCountryText(attribute.name)) {
      return [{ attribute, uploadValue: "Китай", displayValue: "中国" }];
    }
    if (attribute.ozonAttributeId === "10400") {
      return [
        {
          attribute,
          uploadValue: DEFAULT_WARRANTY_UPLOAD_VALUE,
          displayValue: DEFAULT_WARRANTY_LABEL,
        },
      ];
    }
    return [];
  });

  for (const target of targets) {
    const exists = target.attribute.values.some(
      (value) => normalizeText(value.value) === normalizeText(target.uploadValue),
    );
    if (exists) continue;
    try {
      await searchOzonAttributeValues({
        categoryRecordId: categoryId,
        attributeRecordId: target.attribute.id,
        value: target.uploadValue,
        limit: 10,
      });
      await prisma.ozonAttributeValue.updateMany({
        where: {
          attributeId: target.attribute.id,
          value: target.uploadValue,
          valueZh: null,
        },
        data: { valueZh: target.displayValue },
      });
      const values = await prisma.ozonAttributeValue.findMany({
        where: {
          attributeId: target.attribute.id,
          value: target.uploadValue,
        },
        take: 2,
      });
      for (const value of values) {
        if (
          target.attribute.values.some(
            (candidate) => candidate.ozonValueId === value.ozonValueId,
          )
        ) {
          continue;
        }
        target.attribute.values.unshift({
          id: value.id,
          ozonValueId: value.ozonValueId,
          value: value.value,
          valueZh: value.valueZh,
          info: value.info,
          picture: value.picture,
        });
      }
    } catch {
      // 缺少 Ozon 连接或搜索不到值时继续使用已缓存字典，不阻断特征匹配。
    }
  }
}

function salvageFeatureFragments(raw: string) {
  const fragments = raw.match(/\{[^{}]*["']?attributeId["']?\s*:[^{}]*\}/giu) ?? [];
  return fragments.flatMap((fragment) => {
    try {
      const parsed = parseStructuredJson(fragment);
      const feature = aiFeatureItemSchema.safeParse(parsed.value);
      return feature.success ? [feature.data] : [];
    } catch {
      return [];
    }
  });
}

function salvageDisplayFeatureFragments(raw: string) {
  const fragments =
    raw.match(/\{[^{}]*["']?attributeId["']?\s*:[^{}]*\}/giu) ?? [];
  return fragments.flatMap((fragment) => {
    try {
      const parsed = parseStructuredJson(fragment);
      const feature = aiDisplayFeatureItemSchema.safeParse(parsed.value);
      return feature.success ? [feature.data] : [];
    } catch {
      return [];
    }
  });
}

export async function POST(request: NextRequest) {
  let workflowContext: ProcessingWorkflowContext | null = null;
  try {
    const parsed = featureDraftRequestSchema.parse(await request.json());
    if (parsed.workflowItemId && parsed.workflowRunId) {
      workflowContext = {
        itemId: parsed.workflowItemId,
        runId: parsed.workflowRunId,
      };
    }
    const respond = async <T extends WorkflowFeatureResult>(result: T) => {
      await persistWorkflowFeatureResult(workflowContext, result);
      return ok(result);
    };
    const currentPreparedProduct = prepareProductFacts(parsed.scrapedData);
    const preparedProduct =
      currentPreparedProduct.title ||
      currentPreparedProduct.facts.length ||
      currentPreparedProduct.variants.length
        ? currentPreparedProduct
        : isPreparedProductFacts(parsed.preparedProduct)
          ? parsed.preparedProduct
          : currentPreparedProduct;
    const promptAudit = auditProductFacts(
      parsed.scrapedData,
      preparedProduct,
    );
    const facts = extractSourceFacts({
      title: preparedProduct.title,
      source: preparedProduct.source,
      price: preparedProduct.price,
      description: preparedProduct.description,
      characteristics: [
        ...preparedProduct.facts,
        ...preparedProduct.package,
      ],
      specs: preparedProduct.variants.flatMap((variant) => variant.specs),
    });
    const snapshot = await getOzonFeatureSnapshot({ categoryId: parsed.categoryId ?? undefined });
    const category = snapshot.selectedCategory;
    const categorySummary = category
      ? {
          id: category.id,
          label: category.label,
          path: category.path,
          descriptionCategoryId: category.descriptionCategoryId,
          typeId: category.typeId,
        }
      : null;
    const listingBaseDraft = applyBusinessDefaults(buildListingBaseDraft(facts, categorySummary));

    if (!category?.attributes?.length) {
      return respond({
        category: categorySummary,
        features: [...listingBaseDraft, ...buildGenericDraft(facts)],
        preparedProduct,
        promptAudit: { ...promptAudit, jsonRepaired: false },
        aiStatus: {
          ok: false,
          message: snapshot.connection.ready
            ? "已先生成基础上架表；当前还没有匹配到可用的类目属性，源特征会暂存为可编辑草稿。同步/匹配到具体 Ozon 类目后会追加展示该类目的特殊必填特征。"
            : "已先生成基础上架表；当前还没有 Ozon API 凭证和类目属性表。请先配置 Ozon Client-Id / Api-Key 并同步类目树，随后会追加该类目的特殊必填特征。",
        },
        notes: [],
      });
    }

    const categoryAttributes = category.attributes;
    await hydratePriorityDictionaryValues(category.id, categoryAttributes);
    const categoryDraft = applyStableProductModel(
      applyBusinessDefaults(buildCategoryDraft(category.attributes, facts)),
      preparedProduct,
      facts,
    );
    const baseDraft = [...listingBaseDraft, ...categoryDraft];
    const modelId = parsed.model?.trim();
    if (!modelId) {
      return respond({
        category: categorySummary,
        features: baseDraft,
        preparedProduct,
        promptAudit: { ...promptAudit, jsonRepaired: false },
        aiStatus: {
          ok: false,
          message: "未选择特征填写模型，已先生成基础表和当前类目特殊特征草稿。",
        },
        notes: [],
      });
    }

    const attributeById = new Map(
      category.attributes.map((attribute) => [
        attribute.ozonAttributeId,
        attribute,
      ]),
    );
    // categoryDraft 已在 buildCategoryDraft 中排除视频、PDF、富媒体等。
    // 品牌、型号、原产国和制造商由本地确定性规则填写，避免把相应字典发给 AI，
    // 也避免同商品的不同 SKU 获得不同的随机型号。
    // 不应再依据必填状态、当前值或属性名对白名单做二次裁剪：
    // 第二阶段必须看到当前 Ozon 类目的全部可填写属性。
    const aiAttributeDraft = categoryDraft.filter(
      (feature) =>
        !isBrandFeature(feature) &&
        !isModelNameFeature(feature) &&
        !isCountryFeature(feature) &&
        !isManufacturerFeature(feature),
    );
    const browserPrompt = isBrowserAiProvider(parsed.providerId);
    const buildPromptPayload = (
      allowedValueLimit: number,
      productOptions: Parameters<typeof compactPreparedProductForPrompt>[1],
    ) => ({
      productFacts: compactPreparedProductForPrompt(
        preparedProduct,
        productOptions,
      ),
      matchedCategory: {
        label: category.label,
        path: category.path,
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
      },
      attributeTemplate: aiAttributeDraft.flatMap((draft) => {
        const attribute = attributeById.get(draft.attributeId);
        if (!attribute) return [];
        return [
          {
            attributeId: attribute.ozonAttributeId,
            name: attribute.name,
            nameZh: attribute.nameZh || attribute.name,
            type: attribute.type,
            required: attribute.isRequired,
            allowedValues:
              attribute.dictionaryId && attribute.dictionaryId !== "0"
                ? attributeValuesForAi(attribute)
                    .slice(0, allowedValueLimit)
                    .map((value) => {
                      const dictionaryValueId = Number(value.ozonValueId);
                      return {
                        value: value.value.slice(0, 120),
                        valueZh: (value.valueZh || value.value).slice(0, 120),
                        ...(Number.isSafeInteger(dictionaryValueId) &&
                        dictionaryValueId > 0
                          ? { dictionary_value_id: dictionaryValueId }
                          : {}),
                      };
                    })
                : [],
          },
        ];
      }),
    });
    let promptPayload = buildPromptPayload(
      browserPrompt ? 12 : 80,
      browserPrompt
        ? {
            factLimit: 70,
            factValueLimit: 320,
            descriptionLimit: 1000,
            variantSpecLimit: 24,
          }
        : {
            factLimit: preparedProduct.facts.length,
            factValueLimit: 600,
            descriptionLimit: 1800,
            variantSpecLimit: 160,
          },
    );
    if (browserPrompt && JSON.stringify(promptPayload).length > 26_000) {
      promptPayload = buildPromptPayload(6, {
        factLimit: 48,
        factValueLimit: 240,
        descriptionLimit: 700,
        variantSpecLimit: 16,
      });
    }
    if (browserPrompt && JSON.stringify(promptPayload).length > 26_000) {
      promptPayload = buildPromptPayload(3, {
        factLimit: 32,
        factValueLimit: 180,
        descriptionLimit: 500,
        variantSpecLimit: 12,
      });
    }
    if (browserPrompt && JSON.stringify(promptPayload).length > 26_000) {
      promptPayload = buildPromptPayload(0, {
        factLimit: 24,
        factValueLimit: 160,
        descriptionLimit: 400,
        variantSpecLimit: 10,
      });
    }

    const systemPrompt =
      parsed.systemPrompt || DEFAULT_FEATURE_FILL_SYSTEM_PROMPT;
    const taskPrompt = [
      parsed.customPrompt || DEFAULT_FEATURE_FILL_TASK_PROMPT,
      FEATURE_COVERAGE_GUIDANCE,
      preparedProduct.variants.length > 1 ? SKU_VARIANT_GUIDANCE : "",
    ].join("\n\n");
    const visualImages = browserPrompt && !parsed.precomputedAiText
      ? await featureVisionImages(parsed.scrapedData, request.nextUrl.origin)
      : [];
    const serializedPromptPayload = browserPrompt
      ? JSON.stringify(promptPayload)
      : JSON.stringify(promptPayload, null, 2);
    const userPrompt = [
      taskPrompt,
      visualImages.length
        ? `本次附带 ${visualImages.length} 张商品实拍图，仅作为可见外观事实的补充依据。`
        : "本次没有可用商品实拍图，只依据结构化商品事实填写。",
      `输入 JSON：\n${serializedPromptPayload}`,
    ].filter(Boolean).join("\n\n");
    const sentPromptChars = parsed.precomputedAiText
      ? 0
      : systemPrompt.length + userPrompt.length;
    if (browserPrompt && !parsed.precomputedAiText) {
      console.info(
        `[listing-feature-draft] browser prompt chars=${sentPromptChars} payload=${serializedPromptPayload.length} attributes=${aiAttributeDraft.length} variants=${preparedProduct.variants.length} images=${visualImages.length}`,
      );
    }

    let completionText: string;
    let responseProviderId: string;
    let responseProviderName: string;
    if (parsed.precomputedAiText) {
      completionText = parsed.precomputedAiText;
      responseProviderId = parsed.providerId || BROWSER_AI_PROVIDER_ID;
      responseProviderName = "China Product to Ozon 快速模式";
    } else if (isBrowserAiProvider(parsed.providerId)) {
      completionText = await generateBrowserText({
        model: modelId,
        systemPrompt,
        userPrompt,
        images: visualImages,
      });
      responseProviderId = BROWSER_AI_PROVIDER_ID;
      responseProviderName = BROWSER_AI_PROVIDER_NAME;
    } else {
      const { provider, adapter } = await getProviderAdapter(parsed.providerId ?? undefined);
      const selectedModel = provider.models.find((model) => model.modelId === modelId);
      if (!selectedModel || !modelCanFillFeatures(selectedModel)) {
        return respond({
          category: categorySummary,
          features: baseDraft,
          preparedProduct,
          promptAudit: { ...promptAudit, jsonRepaired: false },
          aiStatus: {
            ok: false,
            message: selectedModel
              ? "当前选择的模型不适合做文本/结构化特征填写，请切换到 DeepSeek Chat、GPT、Qwen 等文本模型。"
              : "当前 Provider 里没有找到这个模型，请重新扫描或保存 AI 配置。",
          },
          notes: [],
        });
      }

      const completion = await adapter.generateText({
        model: modelId,
        timeoutMs: 90000,
        systemPrompt,
        userPrompt,
        monitor: { operation: "ozon_feature_fill" },
      });
      completionText = completion.text;
      responseProviderId = provider.id;
      responseProviderName = provider.name;
    }

    let aiParsed: ParsedAiFeatureResponse;
    let salvagedFragments = false;
    try {
      aiParsed = parseAiFeatureResponse(completionText);
      if (
        !aiParsed.uploadFeatures.length &&
        !aiParsed.variants.some((variant) => variant.uploadFeatures.length)
      ) {
        throw new Error("AI 返回中没有可用的公共或 SKU uploadFeatures。");
      }
    } catch (error) {
      const salvaged = salvageFeatureFragments(completionText);
      const salvagedDisplay =
        salvageDisplayFeatureFragments(completionText);
      if (!salvaged.length && !salvagedDisplay.length) {
        return respond({
          category: categorySummary,
          features: baseDraft,
          preparedProduct,
          promptAudit: {
            ...promptAudit,
            jsonRepaired: false,
            sentAttributeCount: aiAttributeDraft.length,
            sentPromptChars,
          },
          aiStatus: {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "AI 返回内容无法解析为 JSON。",
          },
          notes: [
            "已保留本地自动匹配草稿，请在原始回答中检查模型输出。",
          ],
          aiResponse: {
            text: completionText,
            providerId: responseProviderId,
            providerName: responseProviderName,
            model: modelId,
            generatedAt: new Date().toISOString(),
            ozonMapping: null,
          },
        });
      }
      salvagedFragments = true;
      const displayIds = new Set(
        salvagedDisplay.map((feature) => feature.attributeId),
      );
      const uploadIds = new Set(
        salvaged.map((feature) => feature.attributeId),
      );
      aiParsed = {
        displayFeatures: salvagedDisplay,
        uploadFeatures: salvaged,
        variants: [],
        notes: [],
        repaired: true,
        displayOnlyIds: [...displayIds].filter(
          (attributeId) => !uploadIds.has(attributeId),
        ),
        uploadOnlyIds: [...uploadIds].filter(
          (attributeId) => !displayIds.has(attributeId),
        ),
      };
    }
    const usableUploadFeatures = aiParsed.uploadFeatures.filter((feature) =>
      Boolean(stringifyAiValue(feature.value)),
    );
    const canonicalResponse = JSON.stringify({
      features: usableUploadFeatures,
    });
    const ozonMapping = mapOzonAiResponse(canonicalResponse);
    const knownAttributeIds = new Set(
      categoryDraft.map((feature) => feature.attributeId),
    );
    const returnedKnownIds = new Set(
      usableUploadFeatures
        .map((feature) => feature.attributeId)
        .filter((attributeId) => knownAttributeIds.has(attributeId)),
    );
    const returnedDisplayKnownIds = new Set(
      aiParsed.displayFeatures
        .map((feature) => feature.attributeId)
        .filter((attributeId) => knownAttributeIds.has(attributeId)),
    );
    const returnedAnyKnownIds = new Set([
      ...returnedKnownIds,
      ...returnedDisplayKnownIds,
    ]);
    const mergedCategoryDraft = await resolveFeatureDictionaryValues(
      applySelectedSkuPackageValues(
        mergeAiFeatures(categoryDraft, aiParsed),
        facts,
      ),
      category.attributes,
    );
    const aiVariantBySkuId = new Map(
      aiParsed.variants.map((variant) => [variant.skuId, variant]),
    );
    const variantFeatures = await Promise.all(
      preparedProduct.variants.map(async (variant) => {
        const aiVariant = aiVariantBySkuId.get(variant.skuId);
        const derivedDraft = buildVariantSpecDraft(
          variant,
          categoryDraft,
          categoryAttributes,
        );
        const uploadFeatures =
          aiVariant?.uploadFeatures.filter((feature) =>
            Boolean(stringifyAiValue(feature.value)),
          ) ?? [];
        const displayFeatures = aiVariant?.displayFeatures ?? [];
        const returnedIds = new Set([
          ...uploadFeatures.map((feature) => feature.attributeId),
          ...displayFeatures.map((feature) => feature.attributeId),
        ]);
        const variantBaseById = new Map(
          derivedDraft.map((feature) => [feature.attributeId, feature]),
        );
        for (const attributeId of returnedIds) {
          if (variantBaseById.has(attributeId)) continue;
          const baseFeature = categoryDraft.find(
            (feature) => feature.attributeId === attributeId,
          );
          if (baseFeature) variantBaseById.set(attributeId, baseFeature);
        }
        const variantParsed: ParsedAiFeatureResponse = {
          displayFeatures,
          uploadFeatures,
          variants: [],
          notes: [],
          repaired: aiParsed.repaired,
          displayOnlyIds: [],
          uploadOnlyIds: [],
        };
        const draft = variantBaseById.size
          ? await resolveFeatureDictionaryValues(
              mergeAiFeatures(
                [...variantBaseById.values()],
                variantParsed,
              ),
              categoryAttributes,
            )
          : [];
        const fallbackSpecLine = [...variant.specs, ...variant.package]
          .map((fact) => {
            const key = fact.key.replace(/[|｜=]/g, "/").trim();
            const value = fact.value.replace(/[|｜]/g, "/").trim();
            return key && value ? `${key}=${value}` : "";
          })
          .filter(Boolean)
          .join("｜");
        return {
          skuId: variant.skuId,
          title: variant.title,
          specText: variant.specText,
          specLine:
            aiVariant?.specLine ||
            fallbackSpecLine ||
            `规格=${variant.specText || variant.title || variant.skuId}`,
          price: variant.price,
          stock: variant.stock,
          package: variant.package,
          features: draft,
          status:
            draft.length
              ? "matched"
              : aiVariant
                ? "review"
                : "missing",
        };
      }),
    );
    const returnedVariantIds = new Set(aiParsed.variants.map((variant) => variant.skuId));
    const expectedVariantIds = new Set(
      preparedProduct.variants.map((variant) => variant.skuId),
    );
    const matchedVariantCount = [...expectedVariantIds].filter((skuId) =>
      returnedVariantIds.has(skuId),
    ).length;
    const effectiveVariantCount = variantFeatures.filter(
      (variant) => variant.features.length > 0,
    ).length;
    const requiredFeatures = mergedCategoryDraft.filter(
      (feature) => feature.required,
    );
    const requiredFilled = requiredFeatures.filter((feature) =>
      feature.value.trim(),
    ).length;
    const aiSucceeded =
      returnedKnownIds.size > 0 ||
      effectiveVariantCount > 0;
    const responseNotes = [...aiParsed.notes];
    if (aiParsed.repaired) {
      responseNotes.unshift(
        salvagedFragments
          ? "AI 回答提前结束，程序已恢复其中完整的字段对象。"
          : "AI 返回的非严格 JSON 已由程序自动修复。",
      );
    }
    if (aiParsed.displayOnlyIds.length || aiParsed.uploadOnlyIds.length) {
      responseNotes.push(
        `中文展示版与 Ozon 上架版有 ${aiParsed.displayOnlyIds.length + aiParsed.uploadOnlyIds.length} 个 attributeId 未成对；程序仍保留可上传字段，并用标准值临时展示缺少中文值的项目。`,
      );
    }
    if (returnedAnyKnownIds.size < categoryDraft.length) {
      responseNotes.push(
        `AI 返回了 ${returnedAnyKnownIds.size}/${categoryDraft.length} 个可展示类目字段，其中 ${returnedKnownIds.size} 个包含 Ozon 上传值；其余字段保留本地匹配值或待人工填写。`,
      );
    }
    if (
      preparedProduct.variants.length > 1 &&
      effectiveVariantCount < preparedProduct.variants.length
    ) {
      responseNotes.push(
        `已生成 ${effectiveVariantCount}/${preparedProduct.variants.length} 个 SKU 规格结果，其中 AI 原样返回 ${matchedVariantCount} 个；缺少的 SKU 已保留原始规格摘要并标记为待确认。`,
      );
    }
    return respond({
      category: categorySummary,
      features: [
        ...listingBaseDraft,
        ...mergedCategoryDraft,
      ],
      variantFeatures,
      preparedProduct,
      promptAudit: {
        ...promptAudit,
        jsonRepaired: aiParsed.repaired,
        salvagedFragments,
        displayFeatureCount: aiParsed.displayFeatures.length,
        uploadFeatureCount: usableUploadFeatures.length,
        pairedFeatureCount: usableUploadFeatures.filter((feature) =>
          aiParsed.displayFeatures.some(
            (display) => display.attributeId === feature.attributeId,
          ),
        ).length,
        sentAttributeCount: aiAttributeDraft.length,
        sentPromptChars,
        visualEvidenceCount: visualImages.length,
        returnedAttributeCount: returnedAnyKnownIds.size,
        returnedUploadAttributeCount: returnedKnownIds.size,
        returnedVariantCount: matchedVariantCount,
        effectiveVariantCount,
        variantCount: preparedProduct.variants.length,
        attributeCount: categoryDraft.length,
        requiredFilled,
        requiredCount: requiredFeatures.length,
      },
      aiStatus: {
        ok: aiSucceeded,
        message: aiSucceeded
          ? `已使用 ${modelId} 返回 ${returnedAnyKnownIds.size}/${categoryDraft.length} 个公共类目字段，并生成 ${effectiveVariantCount}/${preparedProduct.variants.length} 个 SKU 规格结果；必填字段已填写 ${requiredFilled}/${requiredFeatures.length}。`
          : returnedDisplayKnownIds.size
            ? `模型返回了 ${returnedDisplayKnownIds.size} 个中文展示字段，但没有完整返回 Ozon 上传值；界面已回填，请重新匹配补全上传值。`
            : `模型没有返回当前类目的有效 attributeId，已保留本地草稿，请查看原始回答后重试。`,
      },
      notes: responseNotes,
      aiResponse: {
        text: completionText,
        providerId: responseProviderId,
        providerName: responseProviderName,
        model: modelId,
        generatedAt: new Date().toISOString(),
        ozonMapping: ozonMapping.recognized ? ozonMapping : null,
        coverage: {
          sentAttributeCount: aiAttributeDraft.length,
          returnedAttributeCount: returnedAnyKnownIds.size,
          returnedUploadAttributeCount: returnedKnownIds.size,
          visualEvidenceCount: visualImages.length,
          variantCount: preparedProduct.variants.length,
          returnedVariantCount: matchedVariantCount,
          effectiveVariantCount,
        },
      },
    });
  } catch (error) {
    if (workflowContext) {
      const message =
        error instanceof Error ? error.message : "特征匹配请求异常";
      await persistWorkflowFeatureFailure(workflowContext, message).catch(
        () => undefined,
      );
    }
    return handleRouteError(error);
  }
}
