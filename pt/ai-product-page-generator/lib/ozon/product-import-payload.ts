import type { OzonMappedAttributeValue } from "@/lib/ozon/ai-response-mapper";
import { findOzonColorValue, isOzonColorAttributeId } from "@/lib/ozon/color-match";
import { isIgnoredOzonAttributeId } from "@/lib/ozon/ignored-attributes";

export type OzonPayloadFeatureInput = {
  attributeId: string;
  group: "base" | "category" | "source";
  ozonCode?: string | null;
  value: string;
  ozonComplexId?: number;
  optionMappings?: Array<{
    label?: string;
    value: string;
    dictionaryValueId?: number;
  }>;
  ozonAttributeValues?: OzonMappedAttributeValue[];
  aiJsonValue?: string;
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
    depth?: number | string;
    width?: number | string;
    height?: number | string;
    weight?: number | string;
    dimensionUnit?: "mm" | "cm" | "in";
    weightUnit?: "g" | "kg" | "lb";
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

const MINIMUM_LISTING_PRICE_CNY = 15;

function numericPrice(value: string) {
  const normalized = priceText(value);
  return normalized ? Number(normalized) : null;
}

function minimumDiscountGap(price: number) {
  if (price < 400) return 20.01;
  if (price <= 10_000) return price * 0.0501;
  return 500.01;
}

function containsHanText(value: unknown) {
  return /[\u3400-\u9fff]/u.test(String(value ?? ""));
}

function uploadedAttributeValues(item: Record<string, unknown>) {
  const plain = Array.isArray(item.attributes) ? item.attributes : [];
  const complex = Array.isArray(item.complex_attributes)
    ? item.complex_attributes.flatMap((group) => {
        if (!group || typeof group !== "object") return [];
        const attributes = (group as Record<string, unknown>).attributes;
        return Array.isArray(attributes) ? attributes : [];
      })
    : [];
  return [...plain, ...complex].flatMap((attribute) => {
    if (!attribute || typeof attribute !== "object") return [];
    const record = attribute as Record<string, unknown>;
    const values = Array.isArray(record.values) ? record.values : [];
    return values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const text = String((value as Record<string, unknown>).value ?? "").trim();
      return text ? [{ attributeId: record.id, text }] : [];
    });
  });
}

function isOzonUploadImageCandidate(value: string) {
  return (
    !/(?:\.search|\.summ|\.310x310|\.220x220)\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(value) &&
    !/(?:\.free\.pinggy\.net|trycloudflare\.com|localhost|127\.0\.0\.1)/i.test(value)
  );
}

function cleanAttributeValues(
  values: OzonMappedAttributeValue[] | undefined,
  fallbackValue: string,
) {
  const normalized = (values ?? []).flatMap((value) => {
    const dictionaryValueId = positiveInteger(value.dictionary_value_id);
    const text = String(value.value ?? "").trim();
    const uploadText = containsHanText(text) ? "" : text;
    if (!dictionaryValueId && !uploadText) return [];
    return [
      {
        ...(dictionaryValueId ? { dictionary_value_id: dictionaryValueId } : {}),
        ...(uploadText ? { value: uploadText } : {}),
      },
    ];
  });
  return normalized.length
    ? normalized
    : fallbackValue.trim() && !/[\u3400-\u9fff]/u.test(fallbackValue)
      ? [{ value: fallbackValue.trim() }]
      : [];
}

function featureOzonId(feature: OzonPayloadFeatureInput) {
  return String(feature.ozonCode ?? feature.attributeId).trim();
}

function isColorNameFeature(feature: OzonPayloadFeatureInput) {
  const text = `${feature.attributeId} ${feature.ozonCode ?? ""}`.toLowerCase();
  return text.includes("10097");
}

function colorLookupValues(
  feature: OzonPayloadFeatureInput,
  features: OzonPayloadFeatureInput[],
) {
  const values: unknown[] = [
    ...(feature.ozonAttributeValues?.map((value) => value.value) ?? []),
    feature.aiJsonValue,
    feature.value,
  ];
  if (isOzonColorAttributeId(featureOzonId(feature))) {
    const colorName = features.find(isColorNameFeature);
    if (colorName) {
      values.unshift(
        ...(colorName.ozonAttributeValues?.map((value) => value.value) ?? []),
        colorName.aiJsonValue,
        colorName.value,
      );
    }
  }
  return values;
}

function colorAttributeValues(
  feature: OzonPayloadFeatureInput,
  features: OzonPayloadFeatureInput[],
) {
  if (!isOzonColorAttributeId(featureOzonId(feature))) return [];
  const matchedColor = findOzonColorValue(
    feature.optionMappings ?? [],
    colorLookupValues(feature, features),
  );
  return matchedColor
    ? [
        {
          dictionary_value_id: matchedColor.dictionary_value_id,
          value: matchedColor.value,
        },
      ]
    : [];
}

function canonicalAttributeText(
  features: OzonPayloadFeatureInput[],
  attributeId: string,
) {
  const feature = features.find(
    (item) =>
      item.group !== "base" &&
      String(item.ozonCode ?? item.attributeId) === attributeId,
  );
  return (
    feature?.ozonAttributeValues
      ?.map((value) => String(value.value ?? "").trim())
      .find((value) => value && !containsHanText(value)) ?? ""
  );
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

  const parsedPrice = numericPrice(base.get("price") ?? "");
  const effectivePrice = parsedPrice === null
    ? null
    : Math.max(MINIMUM_LISTING_PRICE_CNY, parsedPrice);
  const price = effectivePrice === null
    ? ""
    : effectivePrice.toFixed(2).replace(/\.00$/, "");
  if (price) item.price = price;
  else errors.push("缺少有效的商品售价 price。");
  if (parsedPrice !== null && parsedPrice < MINIMUM_LISTING_PRICE_CNY) {
    warnings.push(
      `商品售价 ${parsedPrice.toFixed(2)} 元低于店铺下限，已调整为 ${MINIMUM_LISTING_PRICE_CNY.toFixed(2)} 元。`,
    );
  }

  const parsedOldPrice = numericPrice(base.get("old_price") ?? "");
  if (effectivePrice !== null && parsedOldPrice !== null) {
    const minimumOldPrice = effectivePrice + minimumDiscountGap(effectivePrice);
    const effectiveOldPrice = Math.max(parsedOldPrice, minimumOldPrice);
    item.old_price = effectiveOldPrice.toFixed(2).replace(/\.00$/, "");
    if (parsedOldPrice < minimumOldPrice) {
      warnings.push("折扣前价格的价差不足，已按 Ozon 折扣规则自动调整。");
    }
  }

  if (effectivePrice !== null) {
    const parsedMinPrice = numericPrice(base.get("min_price") ?? "");
    const effectiveMinPrice = Math.min(
      effectivePrice,
      Math.max(MINIMUM_LISTING_PRICE_CNY, parsedMinPrice ?? 0),
    );
    item.min_price = effectiveMinPrice.toFixed(2).replace(/\.00$/, "");
  }

  const offerId = (base.get("offer_id") ?? "").slice(0, 50);
  if (offerId) item.offer_id = offerId;
  else warnings.push("缺少 offer_id，建议上传前补充稳定的卖家 SKU。");

  const name = (
    canonicalAttributeText(input.features, "4180") ||
    base.get("name") ||
    ""
  ).slice(0, 500);
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

  const weightUnit = (base.get("weight_unit") ?? "").toLowerCase();
  if (["g", "kg", "lb"].includes(weightUnit)) item.weight_unit = weightUnit;

  for (const field of ["depth", "width", "height", "weight"] as const) {
    const value = positiveInteger(base.get(field));
    if (value) item[field] = value;
  }

  const requestedPrimaryImage = String(
    input.images?.primary_image ?? "",
  ).trim();
  const primaryImage = isOzonUploadImageCandidate(requestedPrimaryImage)
    ? requestedPrimaryImage
    : "";
  const additionalImages = (input.images?.images ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .filter(isOzonUploadImageCandidate)
    .filter((value, index, values) => value !== primaryImage && values.indexOf(value) === index)
    .slice(0, primaryImage ? 29 : 30);
  if (requestedPrimaryImage && !primaryImage) {
    warnings.push("主图是 1688 缩略图，已从 Ozon 上传内容中排除。");
  }
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
      if (isIgnoredOzonAttributeId(attributeId)) continue;
      const values =
        cleanAttributeValues(feature.ozonAttributeValues, feature.value).length
          ? cleanAttributeValues(feature.ozonAttributeValues, feature.value)
          : colorAttributeValues(feature, features);
      if (!values.length) {
        warnings.push(
          `${warningPrefix}特征“${feature.attributeId}”只有中文展示值，没有 Ozon 标准上传值，已跳过。`,
        );
        continue;
      }
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

        for (const field of ["depth", "width", "height", "weight"] as const) {
          const value = positiveInteger(variant[field]);
          if (value) variantItem[field] = value;
        }
        if (variant.dimensionUnit) {
          variantItem.dimension_unit = variant.dimensionUnit;
        }
        if (variant.weightUnit) {
          variantItem.weight_unit = variant.weightUnit;
        }

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

  for (const [index, uploadItem] of items.entries()) {
    const itemLabel = String(uploadItem.offer_id || `第 ${index + 1} 个商品`);
    if (!['mm', 'cm', 'in'].includes(String(uploadItem.dimension_unit ?? '').toLowerCase())) {
      warnings.push(`SKU ${itemLabel} 的尺寸单位必须是 mm、cm 或 in。`);
    }
    if (!['g', 'kg', 'lb'].includes(String(uploadItem.weight_unit ?? '').toLowerCase())) {
      warnings.push(`SKU ${itemLabel} 的重量单位必须是 g、kg 或 lb。`);
    }
    for (const field of ["depth", "width", "height", "weight"] as const) {
      if (!positiveInteger(uploadItem[field])) {
        warnings.push(`SKU ${itemLabel} 的 ${field} 必须是大于 0 的整数。`);
      }
    }
    if (containsHanText(uploadItem.name)) {
      errors.push(`SKU ${itemLabel} 的 Ozon 上传名称仍包含中文。`);
    }
    for (const attribute of uploadedAttributeValues(uploadItem)) {
      if (containsHanText(attribute.text)) {
        errors.push(
          `SKU ${itemLabel} 的属性 ${String(attribute.attributeId)} 上传值仍包含中文。`,
        );
      }
    }
  }

  return {
    payload: { items },
    errors,
    warnings,
  };
}
