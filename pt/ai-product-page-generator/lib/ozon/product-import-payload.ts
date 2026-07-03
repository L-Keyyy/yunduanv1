import type { OzonMappedAttributeValue } from "@/lib/ozon/ai-response-mapper";

export type OzonPayloadFeatureInput = {
  attributeId: string;
  group: "base" | "category" | "source";
  ozonCode?: string | null;
  value: string;
  ozonComplexId?: number;
  ozonAttributeValues?: OzonMappedAttributeValue[];
};

export type OzonPayloadBuildInput = {
  category?: {
    descriptionCategoryId?: number | null;
    typeId?: number | null;
  } | null;
  features: OzonPayloadFeatureInput[];
  images?: {
    primary_image?: string;
    images?: string[];
  } | null;
  variants?: Array<{
    skuId: string;
    offerId?: string;
    name?: string;
    price?: string;
    images?: {
      primary_image?: string;
      images?: string[];
    } | null;
    features?: OzonPayloadFeatureInput[];
  }>;
};

export type OzonPayloadBuildResult = {
  payload: {
    items: Array<Record<string, unknown>>;
  };
  errors: string[];
  warnings: string[];
};

function baseFeatureId(feature: OzonPayloadFeatureInput) {
  return feature.attributeId.replace(/^base:/, "");
}

function positiveInteger(value: unknown) {
  const matched = String(value ?? "").match(/\d+(?:[.,]\d+)?/);
  if (!matched) return null;
  const parsed = Math.round(Number(matched[0].replace(",", ".")));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function priceText(value: string) {
  const matched = value.trim().match(/\d+(?:[.,]\d{1,2})?/);
  if (!matched) return "";
  const parsed = Number(matched[0].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0
    ? parsed.toFixed(2).replace(/\.00$/, "")
    : "";
}

function cleanAttributeValues(
  values: OzonMappedAttributeValue[] | undefined,
  fallbackValue: string,
) {
  const normalized = (values ?? []).flatMap((value) => {
    const dictionaryValueId = positiveInteger(value.dictionary_value_id);
    const text = String(value.value ?? "").trim();
    if (!dictionaryValueId && !text) return [];
    return [
      {
        ...(dictionaryValueId ? { dictionary_value_id: dictionaryValueId } : {}),
        ...(text ? { value: text } : {}),
      },
    ];
  });
  return normalized.length
    ? normalized
    : fallbackValue.trim()
      ? [{ value: fallbackValue.trim() }]
      : [];
}

function parseCategoryFromField(value: string) {
  const numbers = value.match(/\d+/g)?.map(Number).filter((item) => item > 0) ?? [];
  return {
    descriptionCategoryId: numbers.length >= 2 ? numbers[numbers.length - 2] : null,
    typeId: numbers.length >= 1 ? numbers[numbers.length - 1] : null,
  };
}

export function buildOzonProductImportPayload(
  input: OzonPayloadBuildInput,
): OzonPayloadBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const base = new Map(
    input.features
      .filter((feature) => feature.group === "base")
      .map((feature) => [baseFeatureId(feature), feature.value.trim()]),
  );
  const categoryFromField = parseCategoryFromField(base.get("category_type") ?? "");
  const descriptionCategoryId =
    positiveInteger(input.category?.descriptionCategoryId) ??
    categoryFromField.descriptionCategoryId;
  const typeId =
    positiveInteger(input.category?.typeId) ??
    categoryFromField.typeId;
  const item: Record<string, unknown> = {};

  if (descriptionCategoryId) item.description_category_id = descriptionCategoryId;
  else errors.push("缺少有效的 description_category_id。");
  if (typeId) item.type_id = typeId;
  else errors.push("缺少有效的 type_id。");

  const price = priceText(base.get("price") ?? "");
  if (price) item.price = price;
  else errors.push("缺少有效的商品售价 price。");

  const oldPrice = priceText(base.get("old_price") ?? "");
  if (oldPrice) item.old_price = oldPrice;

  const offerId = (base.get("offer_id") ?? "").slice(0, 50);
  if (offerId) item.offer_id = offerId;
  else warnings.push("缺少 offer_id，建议上传前补充稳定的卖家 SKU。");

  const name = (base.get("name") ?? "").slice(0, 500);
  if (name) item.name = name;
  else warnings.push("缺少商品名称 name。");

  const barcode = base.get("barcode") ?? "";
  if (barcode) item.barcode = barcode;

  const currencyCode = (base.get("currency_code") ?? "").toUpperCase();
  const allowedCurrencies = new Set(["RUB", "BYN", "KZT", "EUR", "USD", "CNY"]);
  if (allowedCurrencies.has(currencyCode)) item.currency_code = currencyCode;
  else if (currencyCode) warnings.push(`币种 ${currencyCode} 不是当前 Ozon 导入结构允许的值。`);

  const dimensionUnit = (base.get("dimension_unit") ?? "").toLowerCase();
  if (["mm", "cm", "in"].includes(dimensionUnit)) item.dimension_unit = dimensionUnit;
  else warnings.push("尺寸单位必须是 mm、cm 或 in。");

  const weightUnit = (base.get("weight_unit") ?? "").toLowerCase();
  if (["g", "kg", "lb"].includes(weightUnit)) item.weight_unit = weightUnit;
  else warnings.push("重量单位必须是 g、kg 或 lb。");

  for (const field of ["depth", "width", "height", "weight"] as const) {
    const value = positiveInteger(base.get(field));
    if (value) item[field] = value;
    else warnings.push(`${field} 必须是大于 0 的整数。`);
  }

  const primaryImage = String(input.images?.primary_image ?? "").trim();
  const additionalImages = (input.images?.images ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .filter((value, index, values) => value !== primaryImage && values.indexOf(value) === index)
    .slice(0, primaryImage ? 29 : 30);
  if (primaryImage) item.primary_image = primaryImage;
  if (additionalImages.length) item.images = additionalImages;
  if (!primaryImage && !additionalImages.length) warnings.push("缺少可上传的商品图片。");

  const serializeAttributes = (
    features: OzonPayloadFeatureInput[],
    warningPrefix = "",
  ) => {
    const plain = new Map<string, Record<string, unknown>>();
    const complex = new Map<number, Map<string, Record<string, unknown>>>();
    for (const feature of features) {
      if (feature.group === "base" || !feature.value.trim()) continue;
      const attributeId = positiveInteger(feature.ozonCode ?? feature.attributeId);
      if (!attributeId) {
        warnings.push(
          `${warningPrefix}特征“${feature.attributeId}”没有有效的 Ozon 属性 ID，保留在前端但不会上传。`,
        );
        continue;
      }
      const values = cleanAttributeValues(feature.ozonAttributeValues, feature.value);
      if (!values.length) continue;
      const complexId = positiveInteger(feature.ozonComplexId) ?? 0;
      const attribute = {
        id: attributeId,
        complex_id: complexId,
        values,
      };
      if (complexId > 0) {
        const group = complex.get(complexId) ?? new Map();
        group.set(String(attributeId), attribute);
        complex.set(complexId, group);
      } else {
        plain.set(String(attributeId), attribute);
      }
    }
    return {
      plain: Array.from(plain.values()),
      complex: Array.from(complex.values()).map((attributes) => ({
        attributes: Array.from(attributes.values()),
      })),
    };
  };

  const commonAttributes = serializeAttributes(input.features);
  if (commonAttributes.plain.length) item.attributes = commonAttributes.plain;
  if (commonAttributes.complex.length) {
    item.complex_attributes = commonAttributes.complex;
  }

  const variants = input.variants?.filter((variant) => variant.skuId.trim()) ?? [];
  const items = variants.length
    ? variants.map((variant) => {
        const variantItem = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
        const skuId = variant.skuId.trim();
        const variantOfferId = (
          variant.offerId?.trim() ||
          [offerId || "SKU", skuId].filter(Boolean).join("-")
        ).slice(0, 50);
        variantItem.offer_id = variantOfferId;

        const variantName = variant.name?.trim();
        if (variantName) variantItem.name = variantName.slice(0, 500);
        const variantPrice = priceText(variant.price ?? "");
        if (variantPrice) variantItem.price = variantPrice;
        else if (variant.price) {
          errors.push(`SKU ${skuId} 的 price 无效。`);
        }

        const variantPrimaryImage = String(
          variant.images?.primary_image ?? "",
        ).trim();
        const variantImages = (variant.images?.images ?? [])
          .map((value) => String(value).trim())
          .filter(Boolean);
        if (variantPrimaryImage) variantItem.primary_image = variantPrimaryImage;
        if (variantImages.length) variantItem.images = variantImages.slice(0, 29);

        if (variant.features?.length) {
          const variantAttributes = serializeAttributes(
            variant.features,
            `SKU ${skuId} `,
          );
          const plainById = new Map(
            [
              ...((variantItem.attributes as Array<Record<string, unknown>> | undefined) ?? []),
              ...variantAttributes.plain,
            ].map((attribute) => [String(attribute.id), attribute]),
          );
          if (plainById.size) {
            variantItem.attributes = Array.from(plainById.values());
          }
          if (variantAttributes.complex.length) {
            variantItem.complex_attributes = [
              ...((variantItem.complex_attributes as Array<Record<string, unknown>> | undefined) ?? []),
              ...variantAttributes.complex,
            ];
          }
        }
        return variantItem;
      })
    : [item];

  return {
    payload: { items },
    errors,
    warnings,
  };
}
