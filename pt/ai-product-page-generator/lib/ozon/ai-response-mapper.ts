export const OZON_BASE_FIELD_IDS = [
  "category_type",
  "offer_id",
  "name",
  "short_description",
  "tags",
  "brand",
  "price",
  "old_price",
  "min_price",
  "currency_code",
  "barcode",
  "images",
  "depth",
  "width",
  "height",
  "dimension_unit",
  "weight",
  "weight_unit",
] as const;

export type OzonBaseFieldId = (typeof OZON_BASE_FIELD_IDS)[number];

export type OzonMappedBaseField = {
  id: OzonBaseFieldId;
  value: string;
  source: string;
};

export type OzonMappedAttributeValue = {
  dictionary_value_id?: number;
  value?: string;
};

export type OzonMappedAttribute = {
  attributeId: string;
  label: string;
  value: string;
  complexId: number;
  values: OzonMappedAttributeValue[];
  jsonKey?: string;
  jsonPath?: string;
};

export type OzonAiVariantMapping = {
  index: number;
  skuKey: string;
  name: string;
  offerId: string;
  price: string;
  baseFields: OzonMappedBaseField[];
  attributes: OzonMappedAttribute[];
  images: {
    primaryImage: string;
    images: string[];
  };
  importItem: Record<string, unknown> | null;
};

export type OzonAiMapping = {
  recognized: boolean;
  category: {
    descriptionCategoryId: number | null;
    typeId: number | null;
  };
  baseFields: OzonMappedBaseField[];
  attributes: OzonMappedAttribute[];
  images: {
    primaryImage: string;
    images: string[];
  };
  variants: OzonAiVariantMapping[];
  importItem: Record<string, unknown> | null;
  warnings: string[];
};

const baseFieldIdSet = new Set<string>(OZON_BASE_FIELD_IDS);

const readableAiFieldLabels: Record<string, string> = {
  stock: "库存",
  quantity: "数量",
  purchasepricecny: "采购价（人民币）",
  purchaseprice: "采购价",
  color: "颜色",
  size: "尺寸 / 规格",
  material: "材质",
  model: "型号",
  category: "商品类目",
  description: "商品描述",
  video: "商品视频",
  currency: "币种",
  minimumorderquantity: "最小起订量",
  minorderquantity: "最小起订量",
  sku: "SKU",
};

const baseAliases: Record<OzonBaseFieldId, string[]> = {
  category_type: ["category_type"],
  offer_id: ["offer_id", "offerid", "seller_sku", "sellersku", "sku", "货号", "卖家sku"],
  name: ["name", "title", "product_name", "productname", "商品名称", "商品标题", "标题"],
  short_description: ["short_description", "shortdescription", "description", "summary", "商品简述", "简介"],
  tags: ["tags", "keywords", "hashtags", "关键词", "标签"],
  brand: ["brand", "品牌"],
  price: ["price", "sale_price", "saleprice", "售价", "销售价"],
  old_price: ["old_price", "oldprice", "original_price", "originalprice", "原价", "划线价"],
  min_price: ["min_price", "minprice", "最低价"],
  currency_code: ["currency_code", "currencycode", "currency", "币种"],
  barcode: ["barcode", "barcodes", "ean", "gtin", "条码", "条形码"],
  images: ["images", "image", "image_url", "imageurl", "primary_image", "primaryimage", "图片", "商品图片"],
  depth: ["depth", "length", "package_depth", "packagedepth", "package_length", "packagelength", "包装长", "包装长度"],
  width: ["width", "package_width", "packagewidth", "包装宽", "包装宽度"],
  height: ["height", "package_height", "packageheight", "包装高", "包装高度"],
  dimension_unit: ["dimension_unit", "dimensionunit", "size_unit", "sizeunit", "尺寸单位"],
  weight: ["weight", "package_weight", "packageweight", "包装重量"],
  weight_unit: ["weight_unit", "weightunit", "重量单位"],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKey(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^base:/, "")
    .replace(/[\s\-_/.:]+/g, "");
}

function readableAiFieldLabel(key: string) {
  return (
    readableAiFieldLabels[normalizeKey(key)] ||
    key.replace(/[_-]+/g, " ").trim()
  );
}

function formatJsonPath(path: string[]) {
  return path.reduce(
    (result, segment) =>
      segment.startsWith("[")
        ? `${result}${segment}`
        : result
          ? `${result}.${segment}`
          : segment,
    "",
  );
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean).join(", ");
  }
  if (!value || typeof value !== "object") return "";
  const record = asRecord(value);
  for (const candidate of [record.value, record.text, record.label, record.name]) {
    if (candidate === value) continue;
    const text = textValue(candidate);
    if (text) return text;
  }
  return "";
}

function positiveInteger(value: unknown) {
  const matched = textValue(value).match(/\d+/);
  if (!matched) return null;
  const parsed = Number(matched[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueStrings(values: unknown[]) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = textValue(value);
    if (!text || seen.has(text)) return [];
    seen.add(text);
    return [text];
  });
}

function parseJsonBlock(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (
    arrayStart >= 0 &&
    arrayEnd > arrayStart &&
    (objectStart < 0 || arrayStart < objectStart)
  ) {
    return candidate.slice(arrayStart, arrayEnd + 1);
  }
  if (objectStart >= 0 && objectEnd > objectStart) {
    return candidate.slice(objectStart, objectEnd + 1);
  }
  return candidate;
}

function decodeLooseJsonString(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }
}

function parseLooseScalarPairs(raw: string) {
  const result: Record<string, unknown> = {};
  const pairPattern =
    /"((?:\\.|[^"\\])*)"\s*:\s*(?:"((?:\\.|[^"\\])*)"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null))/g;
  let match: RegExpExecArray | null;
  while ((match = pairPattern.exec(raw))) {
    const key = decodeLooseJsonString(match[1]);
    if (!key) continue;
    if (match[2] !== undefined) {
      result[key] = decodeLooseJsonString(match[2]);
      continue;
    }
    const scalar = match[3];
    result[key] =
      scalar === "true"
        ? true
        : scalar === "false"
          ? false
          : scalar === "null"
            ? null
            : Number(scalar);
  }
  return result;
}

function parseAiJson(raw: string) {
  const candidate = parseJsonBlock(raw);
  const normalizedRaw = raw
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, "$1");
  const normalizedCandidate = candidate
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, "$1");
  const startsWithContainer = /^\s*[\[{]/.test(normalizedRaw);
  const attempts = startsWithContainer
    ? [candidate, normalizedCandidate]
    : [`{${normalizedRaw}}`];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // 继续尝试修复后的候选内容。
    }
  }

  const looseObject = parseLooseScalarPairs(normalizedRaw);
  if (Object.keys(looseObject).length) return looseObject;

  if (!startsWithContainer) {
    for (const attempt of [candidate, normalizedCandidate]) {
      try {
        return JSON.parse(attempt);
      } catch {
        // 最后尝试解析回复中存在的内部 JSON 对象。
      }
    }
  }
  throw new Error("AI 回答中没有可解析的 JSON");
}

function normalizedWeightInGrams(value: string) {
  const amount = Number(value.replace(",", ".").match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(amount)) return null;
  if (/\bkg\b|кг|公斤|千克/i.test(value)) return String(Math.round(amount * 1000));
  if (/\bg\b|(^|[^к])г([^a-zа-я]|$)|克/i.test(value)) return String(Math.round(amount));
  return null;
}

function normalizedDimensionInMillimeters(value: string) {
  const amount = Number(value.replace(",", ".").match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(amount)) return null;
  if (/\bcm\b|厘米|公分/i.test(value)) return String(Math.round(amount * 10 * 1000) / 1000);
  if (/\bmm\b|毫米/i.test(value)) return String(Math.round(amount * 1000) / 1000);
  if (/\bm\b|米/i.test(value)) return String(Math.round(amount * 1000 * 1000) / 1000);
  return null;
}

function findBaseFieldId(rawKey: unknown): OzonBaseFieldId | null {
  const normalized = normalizeKey(rawKey);
  if (baseFieldIdSet.has(normalized)) return normalized as OzonBaseFieldId;
  for (const id of OZON_BASE_FIELD_IDS) {
    if (baseAliases[id].some((alias) => normalizeKey(alias) === normalized)) {
      return id;
    }
  }
  return null;
}

function readAlias(records: Record<string, unknown>[], aliases: string[]) {
  const aliasSet = new Set(aliases.map(normalizeKey));
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (aliasSet.has(normalizeKey(key)) && textValue(value)) return value;
    }
  }
  return undefined;
}

function normalizeAttributeValues(value: unknown): OzonMappedAttributeValue[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((entry) => {
    const record = asRecord(entry);
    const dictionaryValueId = positiveInteger(
      record.dictionary_value_id ?? record.dictionaryValueId,
    );
    const text = textValue(record.value ?? record.text ?? entry);
    if (!dictionaryValueId && !text) return [];
    return [
      {
        ...(dictionaryValueId ? { dictionary_value_id: dictionaryValueId } : {}),
        ...(text ? { value: text } : {}),
      },
    ];
  });
}

function attributeDisplayValue(values: OzonMappedAttributeValue[]) {
  return values
    .map((value) => value.value || (value.dictionary_value_id ? `字典值 #${value.dictionary_value_id}` : ""))
    .filter(Boolean)
    .join(", ");
}

function sanitizeImportItem(
  item: Record<string, unknown>,
  category: { descriptionCategoryId: number | null; typeId: number | null },
  attributes: OzonMappedAttribute[],
  primaryImage: string,
  images: string[],
) {
  const output: Record<string, unknown> = {};
  const stringFields = [
    "offer_id",
    "name",
    "barcode",
    "color_image",
    "currency_code",
    "dimension_unit",
    "old_price",
    "price",
    "primary_image",
    "service_type",
    "vat",
    "weight_unit",
  ];
  const integerFields = ["depth", "height", "width", "weight"];
  const arrayFields = ["geo_names", "images360", "pdf_list", "promotions"];

  for (const key of stringFields) {
    const value = textValue(item[key]);
    if (value) output[key] = value;
  }
  for (const key of integerFields) {
    const value = positiveInteger(item[key]);
    if (value) output[key] = value;
  }
  for (const key of arrayFields) {
    if (Array.isArray(item[key]) && item[key].length) output[key] = item[key];
  }

  if (category.descriptionCategoryId) {
    output.description_category_id = category.descriptionCategoryId;
  }
  if (category.typeId) output.type_id = category.typeId;
  if (primaryImage) output.primary_image = primaryImage;
  if (images.length) output.images = images;
  if (attributes.length) {
    output.attributes = attributes.map((attribute) => ({
      id: positiveInteger(attribute.attributeId) ?? attribute.attributeId,
      complex_id: attribute.complexId,
      values: attribute.values,
    }));
  }
  if (Array.isArray(item.complex_attributes) && item.complex_attributes.length) {
    output.complex_attributes = item.complex_attributes;
  }

  return Object.keys(output).length ? output : null;
}

export function mapOzonAiResponse(raw: string): OzonAiMapping {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseAiJson(raw);
  } catch {
    return {
      recognized: false,
      category: { descriptionCategoryId: null, typeId: null },
      baseFields: [],
      attributes: [],
      images: { primaryImage: "", images: [] },
      variants: [],
      importItem: null,
      warnings: ["AI 回答中没有可解析的 JSON。"],
    };
  }

  if (Array.isArray(parsed)) parsed = { items: parsed };
  const root = asRecord(parsed);
  const firstItem = Array.isArray(root.items) ? asRecord(root.items[0]) : {};
  const item =
    Object.keys(firstItem).length
      ? firstItem
      : asRecord(root.item ?? root.product ?? root.ozonProduct ?? root.ozon_product);
  const product = Object.keys(item).length ? item : root;
  const records = [
    product,
    root,
    asRecord(product.base),
    asRecord(product.baseInfo),
    asRecord(product.base_info),
    asRecord(root.base),
    asRecord(root.baseInfo),
    asRecord(root.base_info),
  ];

  const descriptionCategoryId = positiveInteger(
    readAlias(records, ["description_category_id", "descriptionCategoryId"]),
  );
  const typeId = positiveInteger(readAlias(records, ["type_id", "typeId"]));
  const category = { descriptionCategoryId, typeId };

  const baseById = new Map<OzonBaseFieldId, OzonMappedBaseField>();
  const addBase = (id: OzonBaseFieldId, value: unknown, source: string) => {
    if (id === "images" || id === "category_type") return;
    const rawText = textValue(value);
    let text = rawText;
    if (id === "weight") {
      const normalizedWeight = normalizedWeightInGrams(rawText);
      if (normalizedWeight) {
        text = normalizedWeight;
        if (!baseById.has("weight_unit")) {
          baseById.set("weight_unit", {
            id: "weight_unit",
            value: "g",
            source: `${source}: 自动换算`,
          });
        }
      }
    }
    if (id === "depth" || id === "width" || id === "height") {
      const normalizedDimension = normalizedDimensionInMillimeters(rawText);
      if (normalizedDimension) {
        text = normalizedDimension;
        if (!baseById.has("dimension_unit")) {
          baseById.set("dimension_unit", {
            id: "dimension_unit",
            value: "mm",
            source: `${source}: 自动换算`,
          });
        }
      }
    }
    if (!text) return;
    baseById.set(id, { id, value: text, source });
  };

  for (const id of OZON_BASE_FIELD_IDS) {
    addBase(id, readAlias(records, baseAliases[id]), `AI Ozon JSON: ${id}`);
  }
  if (descriptionCategoryId || typeId) {
    baseById.set("category_type", {
      id: "category_type",
      value: `Ozon / ${descriptionCategoryId ?? "-"} / ${typeId ?? "-"}`,
      source: "AI Ozon JSON: description_category_id/type_id",
    });
  }

  const mappedAttributes = new Map<string, OzonMappedAttribute>();
  const addMappedAttribute = (attribute: OzonMappedAttribute) => {
    if (!attribute.attributeId || !attribute.value) return;
    mappedAttributes.set(`${attribute.attributeId}:${attribute.complexId}`, attribute);
  };

  const processFeatureArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const feature = asRecord(entry);
      const rawId =
        feature.attributeId ??
        feature.attribute_id ??
        feature.ozonCode ??
        feature.id ??
        feature.key ??
        feature.name;
      const baseId = findBaseFieldId(rawId);
      if (baseId) {
        addBase(baseId, feature.value ?? feature.values ?? feature.text, "AI 特征 JSON");
        continue;
      }
      const attributeId = textValue(rawId);
      const values = normalizeAttributeValues(feature.values ?? feature.value);
      const display = attributeDisplayValue(values);
      if (!attributeId || !display) continue;
      addMappedAttribute({
        attributeId,
        label: textValue(feature.label ?? feature.name) || `Ozon 属性 ${attributeId}`,
        value: display,
        complexId: positiveInteger(feature.complex_id ?? feature.complexId) ?? 0,
        values,
        jsonKey: textValue(feature.key ?? feature.name ?? feature.label ?? rawId),
        jsonPath: `features.${attributeId}`,
      });
    }
  };

  const processOzonAttributes = (value: unknown, inheritedComplexId = 0) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const attribute = asRecord(entry);
      const attributeId = textValue(attribute.id ?? attribute.attribute_id ?? attribute.attributeId);
      if (!attributeId) continue;
      const baseId = findBaseFieldId(attributeId);
      const values = normalizeAttributeValues(attribute.values ?? attribute.value);
      const display = attributeDisplayValue(values);
      if (!display) continue;
      if (baseId) {
        addBase(baseId, display, "AI attributes");
        continue;
      }
      addMappedAttribute({
        attributeId,
        label: textValue(attribute.name ?? attribute.label) || `Ozon 属性 ${attributeId}`,
        value: display,
        complexId:
          positiveInteger(attribute.complex_id ?? attribute.complexId) ??
          inheritedComplexId,
        values,
        jsonKey: textValue(attribute.name ?? attribute.label ?? attributeId),
        jsonPath: `attributes.${attributeId}`,
      });
    }
  };

  const handledContainerKeys = new Set([
    "complexattributes",
    "features",
  ]);
  const ignoredRecursiveKeys = new Set([
    "descriptioncategoryid",
    "typeid",
    "complexid",
    "dictionaryvalueid",
    "images",
    "imageurls",
    "pictures",
    "primaryimage",
    "mainimage",
    "videos",
    "videourls",
    "detailimages",
    "detailmedia",
  ]);
  let recursiveFeatureCount = 0;
  const recursiveFeatureLimit = 300;
  const collectRecursiveFeatures = (
    value: unknown,
    path: string[] = [],
    depth = 0,
    skippedRootKeys = new Set<string>(),
  ) => {
    if (
      recursiveFeatureCount >= recursiveFeatureLimit ||
      depth > 12 ||
      value === null ||
      value === undefined
    ) {
      return;
    }

    if (Array.isArray(value)) {
      if (value.every((entry) => entry === null || typeof entry !== "object")) {
        const key = path[path.length - 1] ?? "";
        const display = textValue(value);
        if (!key || !display || ignoredRecursiveKeys.has(normalizeKey(key))) return;
        const baseId = findBaseFieldId(key);
        const jsonPath = formatJsonPath(path);
        if (baseId) {
          addBase(baseId, display, `AI JSON: ${jsonPath}`);
          return;
        }
        addMappedAttribute({
          attributeId: `ai:${jsonPath}`.slice(0, 240),
          label: readableAiFieldLabel(key),
          value: display,
          complexId: 0,
          values: [{ value: display }],
          jsonKey: key,
          jsonPath,
        });
        recursiveFeatureCount += 1;
        return;
      }
      value.forEach((entry, index) => {
        collectRecursiveFeatures(entry, [...path, `[${index}]`], depth + 1);
      });
      return;
    }

    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(asRecord(value))) {
        const normalized = normalizeKey(key);
        if (
          (depth === 0 && skippedRootKeys.has(normalized)) ||
          handledContainerKeys.has(normalized) ||
          (normalized === "attributes" && Array.isArray(entry)) ||
          ignoredRecursiveKeys.has(normalized)
        ) {
          continue;
        }
        collectRecursiveFeatures(entry, [...path, key], depth + 1);
      }
      return;
    }

    const key = path[path.length - 1] ?? "";
    const display = textValue(value);
    if (!key || !display || ignoredRecursiveKeys.has(normalizeKey(key))) return;
    const baseId = findBaseFieldId(key);
    const jsonPath = formatJsonPath(path);
    if (baseId) {
      addBase(baseId, display, `AI JSON: ${jsonPath}`);
      return;
    }
    addMappedAttribute({
      attributeId: `ai:${jsonPath}`.slice(0, 240),
      label: readableAiFieldLabel(key),
      value: display,
      complexId: 0,
      values: [{ value: display }],
      jsonKey: key,
      jsonPath,
    });
    recursiveFeatureCount += 1;
  };

  processFeatureArray(root.features);
  processFeatureArray(product.features);
  processOzonAttributes(root.attributes);
  if (product !== root) processOzonAttributes(product.attributes);

  const complexGroups = [
    ...(Array.isArray(root.complex_attributes) ? root.complex_attributes : []),
    ...(product !== root && Array.isArray(product.complex_attributes)
      ? product.complex_attributes
      : []),
  ];
  for (const groupValue of complexGroups) {
    const group = asRecord(groupValue);
    const inheritedComplexId = positiveInteger(group.complex_id ?? group.complexId) ?? 0;
    processOzonAttributes(group.attributes, inheritedComplexId);
  }
  collectRecursiveFeatures(product);
  if (product !== root) {
    collectRecursiveFeatures(
      root,
      [],
      0,
      new Set(["items", "item", "product", "ozonproduct"]),
    );
  }
  if (recursiveFeatureCount >= recursiveFeatureLimit) {
    warnings.push(`AI JSON 字段超过 ${recursiveFeatureLimit} 项，仅同步前 ${recursiveFeatureLimit} 项。`);
  }

  const primaryImage = textValue(
    readAlias(records, [
      "primary_image",
      "primaryImage",
      "main_image",
      "mainImage",
      "image",
      "image_url",
      "imageUrl",
    ]),
  );
  const rawImages = readAlias(records, ["images", "image_urls", "imageUrls", "pictures"]);
  const images = uniqueStrings([
    ...(Array.isArray(rawImages) ? rawImages : rawImages ? [rawImages] : []),
  ]).filter((url) => url !== primaryImage);
  const allImages = uniqueStrings([primaryImage, ...images]);
  if (allImages.length) {
    baseById.set("images", {
      id: "images",
      value: JSON.stringify({
        primary_image: allImages[0],
        images: allImages.slice(1),
      }),
      source: "AI Ozon JSON: primary_image/images",
    });
  }

  const attributes = Array.from(mappedAttributes.values());
  const baseFields = Array.from(baseById.values());
  if (!descriptionCategoryId || !typeId) {
    warnings.push("AI JSON 未同时提供 description_category_id 和 type_id，无法自动锁定 Ozon 类目。");
  }
  if (!baseFields.length && !attributes.length) {
    warnings.push("JSON 可解析，但没有识别到 Ozon 基础字段或特征。");
  }

  const importItem = sanitizeImportItem(
    product,
    category,
    attributes.filter((attribute) => positiveInteger(attribute.attributeId)),
    allImages[0] || "",
    allImages.slice(1),
  );
  const rawItems = Array.isArray(root.items)
    ? root.items.map(asRecord).filter((entry) => Object.keys(entry).length > 0)
    : [];
  const variants: OzonAiVariantMapping[] =
    rawItems.length > 1
      ? rawItems.map((rawItem, index) => {
          const mapped = mapOzonAiResponse(
            JSON.stringify({ items: [rawItem] }),
          );
          const itemBase = new Map(
            mapped.baseFields.map((field) => [field.id, field.value]),
          );
          const name = itemBase.get("name") ?? "";
          const offerId = itemBase.get("offer_id") ?? "";
          const price = itemBase.get("price") ?? "";
          return {
            index,
            skuKey:
              offerId ||
              textValue(
                rawItem.sku_id ??
                  rawItem.skuId ??
                  rawItem.product_id ??
                  rawItem.productId,
              ) ||
              `sku-${index + 1}`,
            name,
            offerId,
            price,
            baseFields: mapped.baseFields,
            attributes: mapped.attributes,
            images: mapped.images,
            importItem: mapped.importItem,
          };
        })
      : [];

  return {
    recognized: baseFields.length > 0 || attributes.length > 0,
    category,
    baseFields,
    attributes,
    images: {
      primaryImage: allImages[0] || "",
      images: allImages.slice(1),
    },
    variants,
    importItem,
    warnings,
  };
}
