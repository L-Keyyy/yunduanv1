/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
const config = require('./config');

function normalizeName(value) {
  return String(value || '').toLowerCase().trim();
}

function getCharValue(characteristics, name) {
  const targetName = normalizeName(name);
  const found = (characteristics || []).find((item) => normalizeName(item?.name) === targetName);
  if (!found) {
    return null;
  }

  if (found.valueText !== null && found.valueText !== undefined && String(found.valueText).trim()) {
    return found.valueText;
  }

  const fallbackValues = Array.isArray(found.values)
    ? found.values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return fallbackValues.length ? fallbackValues.join(', ') : null;
}

function getFirstCharValue(characteristics, names) {
  for (const name of names) {
    const value = getCharValue(characteristics, name);
    if (value !== null && value !== undefined && String(value).trim()) {
      return value;
    }
  }
  return null;
}

function parseNumericValue(value) {
  if (value === null || value === undefined) {
    return NaN;
  }

  const match = String(value)
    .replace(/\s+/g, '')
    .replace(',', '.')
    .match(/-?\d+(?:\.\d+)?/);

  return match ? Number(match[0]) : NaN;
}

function normalizeCharacteristicEntry(item) {
  const name = String(item?.name || '').trim();
  if (!name) {
    return null;
  }

  const values = Array.isArray(item?.values)
    ? item.values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const valueText = String(item?.valueText || '').trim() || values.join(', ');

  if (!valueText && values.length === 0) {
    return null;
  }

  return {
    name,
    valueText,
    values: [...new Set(values.length ? values : valueText ? [valueText] : [])],
  };
}

function buildCharacteristicPool(scrapedData = {}) {
  const merged = new Map();

  function mergeItems(items = []) {
    for (const item of items) {
      const normalized = normalizeCharacteristicEntry(item);
      if (!normalized) {
        continue;
      }

      const key = normalizeName(normalized.name);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, normalized);
        continue;
      }

      if (!existing.valueText && normalized.valueText) {
        existing.valueText = normalized.valueText;
      }

      const nextValues = [...new Set([...(existing.values || []), ...(normalized.values || [])])];
      existing.values = nextValues;
      if (!existing.valueText && nextValues.length) {
        existing.valueText = nextValues.join(', ');
      }
    }
  }

  mergeItems(scrapedData.characteristics || []);
  mergeItems(
    (scrapedData.shortCharacteristics || []).map((item) => ({
      name: item?.name,
      valueText: Array.isArray(item?.values) ? item.values.join(', ') : '',
      values: item?.values || [],
    }))
  );

  return [...merged.values()];
}

function generateOfferId(scrapedSku, productTitle) {
  const prefix = scrapedSku || String(Date.now());
  const titleChars = (productTitle || '').substring(0, 4);
  return `${prefix}${titleChars}`;
}

function resolveDimensionValue(primaryValue, fallbackValue, defaultValue) {
  if (Number.isFinite(primaryValue)) {
    return Math.round(primaryValue);
  }
  if (Number.isFinite(fallbackValue)) {
    return Math.round(fallbackValue * 10);
  }
  return defaultValue;
}

function parseDimensionTriplet(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const matches = String(value)
    .replace(/,/g, '.')
    .match(/\d+(?:\.\d+)?/g);

  if (!matches || matches.length < 3) {
    return null;
  }

  const [lengthValue, widthValue, heightValue] = matches.slice(0, 3).map(Number);
  if (![lengthValue, widthValue, heightValue].every(Number.isFinite)) {
    return null;
  }

  return {
    depth: lengthValue,
    width: widthValue,
    height: heightValue,
  };
}

function findTripletDimensions(characteristics, { packageOnly = false } = {}) {
  for (const item of characteristics || []) {
    const name = normalizeName(item?.name);
    if (!name) {
      continue;
    }

    const isDimensionLike = /(размер|габарит|dimensions|dimension)/i.test(name);
    const isPackageLike = /(упаков|package|shipping)/i.test(name);
    if (!isDimensionLike) {
      continue;
    }
    if (packageOnly && !isPackageLike) {
      continue;
    }

    const rawValue =
      (item?.valueText !== null && item?.valueText !== undefined && String(item.valueText).trim()) ||
      (Array.isArray(item?.values) ? item.values.join(', ') : '');
    const triplet = parseDimensionTriplet(rawValue);
    if (!triplet) {
      continue;
    }

    const multiplier = /(^|[^a-zа-я])(см|cm)([^a-zа-я]|$)/i.test(name) ? 10 : 1;
    return {
      height: Math.round(triplet.height * multiplier),
      width: Math.round(triplet.width * multiplier),
      depth: Math.round(triplet.depth * multiplier),
      source: isPackageLike ? 'json-package-triplet' : 'json-triplet',
    };
  }

  return null;
}

function extractDimensions(characteristics) {
  const heightMm = parseNumericValue(
    getFirstCharValue(characteristics, ['Высота упаковки, мм', 'Высота, мм'])
  );
  const widthMm = parseNumericValue(
    getFirstCharValue(characteristics, ['Ширина упаковки, мм', 'Ширина, мм'])
  );
  const depthMm = parseNumericValue(
    getFirstCharValue(characteristics, ['Длина упаковки, мм', 'Глубина упаковки, мм', 'Длина, мм', 'Глубина, мм'])
  );

  const heightCm = parseNumericValue(getCharValue(characteristics, 'Высота, см'));
  const widthCm = parseNumericValue(getCharValue(characteristics, 'Ширина, см'));
  const depthCm = parseNumericValue(
    getFirstCharValue(characteristics, ['Глубина, см', 'Длина, см'])
  );

  const foundCount = [
    Number.isFinite(heightMm) || Number.isFinite(heightCm),
    Number.isFinite(widthMm) || Number.isFinite(widthCm),
    Number.isFinite(depthMm) || Number.isFinite(depthCm),
  ].filter(Boolean).length;

  return {
    height: resolveDimensionValue(heightMm, heightCm, config.DEFAULTS.default_height_mm),
    width: resolveDimensionValue(widthMm, widthCm, config.DEFAULTS.default_width_mm),
    depth: resolveDimensionValue(depthMm, depthCm, config.DEFAULTS.default_depth_mm),
    dimension_unit: 'mm',
    source: foundCount === 0 ? 'default' : foundCount === 3 ? 'json' : 'mixed',
  };
}

function extractPreferredDimensions(characteristics) {
  const packageTriplet = findTripletDimensions(characteristics, { packageOnly: true });
  const genericTriplet = packageTriplet ? null : findTripletDimensions(characteristics);
  const base = extractDimensions(characteristics);

  if (!packageTriplet && !genericTriplet) {
    return base;
  }

  const chosen = packageTriplet || genericTriplet;
  return {
    ...base,
    height: Number.isFinite(chosen?.height) ? chosen.height : base.height,
    width: Number.isFinite(chosen?.width) ? chosen.width : base.width,
    depth: Number.isFinite(chosen?.depth) ? chosen.depth : base.depth,
    source: chosen?.source || base.source,
  };
}

function extractWeight(characteristics, scrapedData = {}) {
  const packageWeightGrams = parseNumericValue(
    getFirstCharValue(characteristics, ['Вес с упаковкой, г', 'Вес товара с упаковкой, г'])
  );
  if (Number.isFinite(packageWeightGrams)) {
    return {
      weight: Math.round(packageWeightGrams),
      weight_unit: 'g',
      source: 'json-package-g',
    };
  }

  const packageWeightKg = parseNumericValue(
    getFirstCharValue(characteristics, ['Вес с упаковкой, кг', 'Вес товара с упаковкой, кг'])
  );
  if (Number.isFinite(packageWeightKg)) {
    return {
      weight: Math.round(packageWeightKg * 1000),
      weight_unit: 'g',
      source: 'json-package-kg',
    };
  }

  const checkoutWeightKg = Number(scrapedData?.packageWeight?.weightKg);
  if (Number.isFinite(checkoutWeightKg) && checkoutWeightKg > 0) {
    return {
      weight: Math.round(checkoutWeightKg * 1000),
      weight_unit: 'g',
      source: 'checkout',
    };
  }

  const weightGrams = parseNumericValue(
    getFirstCharValue(characteristics, ['Вес, г', 'Вес товара, г'])
  );
  if (Number.isFinite(weightGrams)) {
    return {
      weight: Math.round(weightGrams),
      weight_unit: 'g',
      source: 'json-g',
    };
  }

  const weightKg = parseNumericValue(
    getFirstCharValue(characteristics, ['Вес, кг', 'Вес товара, кг'])
  );
  if (Number.isFinite(weightKg)) {
    return {
      weight: Math.round(weightKg * 1000),
      weight_unit: 'g',
      source: 'json-kg',
    };
  }

  return {
    weight: 500,
    weight_unit: 'g',
    source: 'default',
  };
}

function extractImages(gallery) {
  const allImages = (gallery.images || []).map((img) => img.src);
  const cover = gallery.coverImage || allImages[0] || '';
  const maxImages = 15;
  const otherImages = allImages.filter((src) => src !== cover).slice(0, maxImages - 1);

  return {
    primary_image: cover,
    images: otherImages,
  };
}

function extractDescription(descriptionObj) {
  if (!descriptionObj) {
    return '';
  }

  if (descriptionObj.text && descriptionObj.text.trim()) {
    return descriptionObj.text.trim();
  }

  if (descriptionObj.html) {
    return descriptionObj.html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return '';
}

function cleanProduct(scrapedData, categoryInfo, ozonAttributes, overrides = {}) {
  const chars = buildCharacteristicPool(scrapedData);
  const scrapedSku = getCharValue(chars, 'Артикул') || String(scrapedData.productId);

  const dims = extractPreferredDimensions(chars);
  const weightInfo = extractWeight(chars, scrapedData);
  const imageInfo = extractImages(scrapedData.gallery || {});
  const description = extractDescription(scrapedData.description);
  const attributes = [...(ozonAttributes || [])];

  const modelNameAttrId = 9048;
  const explicitModel = String(overrides.model || '').trim();
  const fallbackModel = `${scrapedSku}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  const modelValue = explicitModel || fallbackModel;
  const existingModelAttr = attributes.find((item) => item.id === modelNameAttrId);

  if (existingModelAttr) {
    existingModelAttr.values = [{ dictionary_value_id: 0, value: modelValue }];
  } else {
    attributes.push({
      id: modelNameAttrId,
      complex_id: 0,
      values: [{ dictionary_value_id: 0, value: modelValue }],
    });
  }

  const item = {
    offer_id: overrides.offer_id || generateOfferId(scrapedSku, scrapedData.title),
    name: overrides.name || scrapedData.title || '',
    description_category_id: categoryInfo.description_category_id,
    type_id: categoryInfo.type_id,
    barcode: overrides.barcode || config.DEFAULTS.barcode,
    description: overrides.description || description,
    price: overrides.price || '0',
    old_price: overrides.old_price || '0',
    min_price: overrides.min_price || null,
    currency_code: config.DEFAULTS.currency_code,
    vat: config.DEFAULTS.vat,
    height: dims.height,
    width: dims.width,
    depth: dims.depth,
    dimension_unit: dims.dimension_unit,
    weight: weightInfo.weight,
    weight_unit: weightInfo.weight_unit,
    primary_image: imageInfo.primary_image,
    images: imageInfo.images,
    attributes,
  };

  const meta = {
    source_product_id: scrapedData.productId,
    source_url: scrapedData.sourceUrl,
    scraped_sku: scrapedSku,
    dimensions_source: dims.source,
    weight_source: weightInfo.source,
    total_images: imageInfo.images.length + 1,
    generated_at: new Date().toISOString(),
  };

  return { item, meta };
}

module.exports = {
  buildCharacteristicPool,
  cleanProduct,
  generateOfferId,
  extractDimensions,
  extractWeight,
  extractImages,
  extractDescription,
  getCharValue,
  getFirstCharValue,
  parseNumericValue,
};
