import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
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
} from "@/lib/listing-workflow/product-facts";
import {
  DEFAULT_FEATURE_FILL_SYSTEM_PROMPT,
  DEFAULT_FEATURE_FILL_TASK_PROMPT,
} from "@/lib/listing-workflow/text-prompts";
import { ozonListingBaseFields, type OzonAttributeNode } from "@/lib/ozon/feature-tree";
import { mapOzonAiResponse } from "@/lib/ozon/ai-response-mapper";
import { findOzonColorValue, isOzonColorAttributeId } from "@/lib/ozon/color-match";
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

const aiDualFeatureResponseSchema = z.object({
  displayFeatures: z.array(aiDisplayFeatureItemSchema).default([]),
  uploadFeatures: z.array(aiFeatureItemSchema).default([]),
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

const BRAND_DEFAULT_VALUE = "无";
const COUNTRY_DEFAULT_VALUE = "中国";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
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
    return { value: BRAND_DEFAULT_VALUE, confidence: 0.9, source: "业务默认", reason: "按当前上架规则，品牌字段统一填写“无”。" };
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

function isCountryFeature(feature: Pick<DraftFeature, "attributeId" | "label" | "ozonCode">) {
  return [feature.attributeId, feature.label, feature.ozonCode ?? ""].some(isCountryText);
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
  if (isBrandFeature(feature)) {
    return {
      ...feature,
      value: BRAND_DEFAULT_VALUE,
      confidence: Math.max(feature.confidence, 0.9),
      status: feature.required ? "review" : feature.status === "missing" ? "review" : feature.status,
      source: "业务默认",
      reason: "按当前上架规则，品牌字段统一填写“无”。",
    };
  }

  if (isCountryFeature(feature)) {
    return {
      ...feature,
      value: COUNTRY_DEFAULT_VALUE,
      confidence: Math.max(feature.confidence, 0.9),
      status: feature.required ? "review" : feature.status === "missing" ? "review" : feature.status,
      source: "业务默认",
      reason: "按当前上架规则，国家/产地字段默认填写“中国”。",
    };
  }

  return feature;
}

function applyBusinessDefaults(features: DraftFeature[]) {
  return features.map(applyBusinessDefaultsToFeature);
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
  if (isExcludedMediaAttribute(attribute)) return null;
  const attrName = normalizeText(attribute.name);
  if (isBrandText(attribute.name) || isBrandText(attribute.ozonAttributeId)) {
    return {
      value: BRAND_DEFAULT_VALUE,
      confidence: 0.9,
      source: "业务默认",
      reason: "按当前上架规则，品牌字段统一填写“无”。",
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
    .filter((attribute) => !isExcludedMediaAttribute(attribute))
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
      const cachedMatches = attribute.values.filter(
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
  const notes: string[] = [];

  for (const value of parsedValues) {
    const record = asRecord(value);
    const dual = aiDualFeatureResponseSchema.safeParse(record);
    if (dual.success) {
      displayFeatures.push(...dual.data.displayFeatures);
      uploadFeatures.push(...dual.data.uploadFeatures);
      notes.push(...(dual.data.notes ?? []));
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

  return {
    displayFeatures: uniqueDisplay,
    uploadFeatures: uniqueUpload,
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

function modelCanFillFeatures(model: { capabilities: Record<string, unknown>; isAvailable?: boolean }) {
  const capabilities = model.capabilities ?? {};
  const isImageOnly = Boolean(capabilities.image_gen || capabilities.image_edit) && !capabilities.text;
  return model.isAvailable !== false && Boolean(capabilities.text || capabilities.structured_output || capabilities.vision) && !isImageOnly;
}

function attributeValuesForAi(
  attribute: OzonAttributeSnapshot,
  facts: SourceFact[],
) {
  const factValues = facts
    .flatMap((fact) => [fact.key, fact.value])
    .map(normalizeText)
    .filter(Boolean);
  const preferredValues = [
    ...(isBrandText(attribute.name) ? ["Нет бренда", "无品牌"] : []),
    ...(isCountryText(attribute.name) ? ["Китай", "中国"] : []),
  ].map(normalizeText);

  return attribute.values
    .map((value, index) => {
      const candidates = [normalizeText(value.value), normalizeText(value.valueZh || "")]
        .filter(Boolean);
      let score = 0;
      if (
        candidates.some((candidate) => preferredValues.includes(candidate))
      ) {
        score = 1000;
      } else {
        for (const candidate of candidates) {
          for (const fact of factValues) {
            if (candidate === fact) score = Math.max(score, 900);
            else if (
              candidate.length >= 2 &&
              fact.length >= 2 &&
              (candidate.includes(fact) || fact.includes(candidate))
            ) {
              score = Math.max(score, 700);
            }
          }
        }
      }
      return { value, index, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index,
    )
    .map((entry) => entry.value);
}

async function hydratePriorityDictionaryValues(
  categoryId: string,
  attributes: OzonAttributeSnapshot[],
) {
  const targets = attributes.flatMap((attribute) => {
    if (isBrandText(attribute.name)) {
      return [{ attribute, uploadValue: "Нет бренда", displayValue: "无" }];
    }
    if (isCountryText(attribute.name)) {
      return [{ attribute, uploadValue: "Китай", displayValue: "中国" }];
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
  try {
    const parsed = featureDraftRequestSchema.parse(await request.json());
    const preparedProduct = isPreparedProductFacts(parsed.preparedProduct)
      ? parsed.preparedProduct
      : prepareProductFacts(parsed.scrapedData);
    const promptAudit = auditProductFacts(
      parsed.scrapedData,
      preparedProduct,
    );
    const facts = extractSourceFacts(parsed.scrapedData);
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
      return ok({
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

    await hydratePriorityDictionaryValues(category.id, category.attributes);
    const categoryDraft = buildCategoryDraft(category.attributes, facts);
    const baseDraft = [...listingBaseDraft, ...categoryDraft];
    const modelId = parsed.model?.trim();
    if (!modelId) {
      return ok({
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
    // categoryDraft 已在 buildCategoryDraft 中排除视频、PDF、富媒体等
    // 不应再依据必填状态、当前值或属性名对白名单做二次裁剪：
    // 第二阶段必须看到当前 Ozon 类目的全部可填写属性。
    const aiAttributeDraft = categoryDraft;
    const promptPayload = {
      productFacts: preparedProduct,
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
                ? attributeValuesForAi(attribute, facts)
                    .slice(0, 80)
                    .map((value) => {
                      const dictionaryValueId = Number(value.ozonValueId);
                      return {
                        value: value.value.slice(0, 140),
                        valueZh: (value.valueZh || value.value).slice(0, 140),
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
    };

    const systemPrompt =
      parsed.systemPrompt || DEFAULT_FEATURE_FILL_SYSTEM_PROMPT;
    const taskPrompt =
      parsed.customPrompt || DEFAULT_FEATURE_FILL_TASK_PROMPT;
    const userPrompt = [
      taskPrompt,
      `输入 JSON：\n${JSON.stringify(promptPayload, null, 2)}`,
    ].filter(Boolean).join("\n\n");

    let completionText: string;
    let responseProviderId: string;
    let responseProviderName: string;
    if (isBrowserAiProvider(parsed.providerId)) {
      completionText = await generateBrowserText({
        model: modelId,
        systemPrompt,
        userPrompt,
      });
      responseProviderId = BROWSER_AI_PROVIDER_ID;
      responseProviderName = BROWSER_AI_PROVIDER_NAME;
    } else {
      const { provider, adapter } = await getProviderAdapter(parsed.providerId ?? undefined);
      const selectedModel = provider.models.find((model) => model.modelId === modelId);
      if (!selectedModel || !modelCanFillFeatures(selectedModel)) {
        return ok({
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
      if (!aiParsed.uploadFeatures.length) {
        throw new Error("AI 返回中没有可用的 uploadFeatures。");
      }
    } catch (error) {
      const salvaged = salvageFeatureFragments(completionText);
      const salvagedDisplay =
        salvageDisplayFeatureFragments(completionText);
      if (!salvaged.length && !salvagedDisplay.length) {
        return ok({
          category: categorySummary,
          features: baseDraft,
          preparedProduct,
          promptAudit: {
            ...promptAudit,
            jsonRepaired: false,
            sentAttributeCount: aiAttributeDraft.length,
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
      mergeAiFeatures(categoryDraft, aiParsed),
      category.attributes,
    );
    const requiredFeatures = mergedCategoryDraft.filter(
      (feature) => feature.required,
    );
    const requiredFilled = requiredFeatures.filter((feature) =>
      feature.value.trim(),
    ).length;
    const aiSucceeded = returnedKnownIds.size > 0;
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
    return ok({
      category: categorySummary,
      features: [
        ...listingBaseDraft,
        ...mergedCategoryDraft,
      ],
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
        returnedAttributeCount: returnedAnyKnownIds.size,
        returnedUploadAttributeCount: returnedKnownIds.size,
        attributeCount: categoryDraft.length,
        requiredFilled,
        requiredCount: requiredFeatures.length,
      },
      aiStatus: {
        ok: aiSucceeded,
        message: aiSucceeded
          ? `已使用 ${modelId} 返回 ${returnedAnyKnownIds.size}/${categoryDraft.length} 个可展示类目字段，其中 ${returnedKnownIds.size} 个包含 Ozon 上传值；必填字段已填写 ${requiredFilled}/${requiredFeatures.length}。`
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
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
