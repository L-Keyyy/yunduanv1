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

function firstPresentValue(source, keys) {
  if (!source || typeof source !== 'object') {
    return null;
  }

  for (const key of keys) {
    if (source[key] !== null && source[key] !== undefined && String(source[key]).trim() !== '') {
      return source[key];
    }
  }
  return null;
}

function sourceWithName(value, name = '') {
  return String(`${value || ''} ${name || ''}`).replace(/\u00a0/g, ' ').toLowerCase().trim();
}

function parseWeightToGrams(value, { name = '', defaultUnit = null } = {}) {
  const numeric = parseNumericValue(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const source = sourceWithName(value, name);
  const normalizedName = normalizeName(name);
  let unit = null;
  if (/(^|[^a-zа-я])(кг|kg|килограмм(?:а|ов)?)([^a-zа-я]|$)/i.test(source) || /千克|公斤/.test(source)) {
    unit = 'kg';
  } else if (/(^|[^a-zа-я])(г|гр|g|gram|grams|грамм(?:а|ов)?)([^a-zа-я]|$)/i.test(source) || /克/.test(source)) {
    unit = 'g';
  } else if (defaultUnit === 'kg' || defaultUnit === 'g') {
    unit = defaultUnit;
  } else if (/(^|\s)(кг|kg)(\s|$)/i.test(normalizedName)) {
    unit = 'kg';
  } else if (/(^|\s)(г|g)(\s|$)/i.test(normalizedName)) {
    unit = 'g';
  }

  if (unit === 'kg') {
    return Math.round(numeric * 1000);
  }
  if (unit === 'g') {
    return Math.round(numeric);
  }
  return null;
}

function inferDimensionUnit(value, name = '', defaultUnit = null) {
  const source = sourceWithName(value, name);
  const normalizedName = normalizeName(name);
  if (/(^|[^a-zа-я])(мм|mm|миллиметр(?:а|ов)?)([^a-zа-я]|$)/i.test(source) || /毫米/.test(source)) {
    return 'mm';
  }
  if (/(^|[^a-zа-я])(см|cm|сантиметр(?:а|ов)?)([^a-zа-я]|$)/i.test(source) || /厘米/.test(source)) {
    return 'cm';
  }
  if (/(^|[^a-zа-я])(м|m|метр(?:а|ов)?)([^a-zа-я]|$)/i.test(source) || /米/.test(source)) {
    return 'm';
  }
  if (['mm', 'cm', 'm'].includes(defaultUnit)) {
    return defaultUnit;
  }
  if (/(^|\s)(мм|mm)(\s|$)/i.test(normalizedName)) {
    return 'mm';
  }
  if (/(^|\s)(см|cm)(\s|$)/i.test(normalizedName)) {
    return 'cm';
  }
  if (/(^|\s)(м|m)(\s|$)/i.test(normalizedName)) {
    return 'm';
  }
  return null;
}

function parseDimensionToMm(value, { name = '', defaultUnit = null } = {}) {
  const numeric = parseNumericValue(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const unit = inferDimensionUnit(value, name, defaultUnit);
  const multiplier = { mm: 1, cm: 10, m: 1000 }[unit];
  return multiplier ? Math.round(numeric * multiplier) : null;
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

function parseDimensionTriplet(value, name = '') {
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

  const unit = inferDimensionUnit(value, name, 'mm');
  const multiplier = { mm: 1, cm: 10, m: 1000 }[unit] || 1;
  return {
    depth: lengthValue * multiplier,
    width: widthValue * multiplier,
    height: heightValue * multiplier,
  };
}

function characteristicRawValue(item) {
  if (item?.valueText !== null && item?.valueText !== undefined && String(item.valueText).trim()) {
    return String(item.valueText).trim();
  }
  return Array.isArray(item?.values) ? item.values.map((value) => String(value || '').trim()).filter(Boolean).join(', ') : '';
}

function isPackageDimensionName(name) {
  return /(упаков|package|shipping|посылк)/i.test(name);
}

const DIMENSION_AXIS_KEYWORDS = {
  height: ['высота', 'height', '高'],
  width: ['ширина', 'width', '宽'],
  depth: ['длина', 'глубина', 'length', 'depth', '长'],
};

const DIMENSION_SKIP_RE = /(объем|volume|литр|мл|ml|вес|масса|weight|диаметр|diameter)/i;

function isDimensionScalarName(name, axis) {
  if (!name || DIMENSION_SKIP_RE.test(name)) {
    return false;
  }
  return (DIMENSION_AXIS_KEYWORDS[axis] || []).some((keyword) => name.includes(keyword));
}

function findDimensionScalar(characteristics, axis, { packageOnly = false } = {}) {
  for (const item of characteristics || []) {
    const name = normalizeName(item?.name);
    if (!isDimensionScalarName(name, axis)) {
      continue;
    }
    const isPackageLike = isPackageDimensionName(name);
    if (packageOnly && !isPackageLike) {
      continue;
    }
    const value = parseDimensionToMm(characteristicRawValue(item), { name: item?.name || '' });
    if (!value) {
      continue;
    }
    return {
      value,
      source: isPackageLike ? `json-package-${axis}` : `json-${axis}`,
    };
  }
  return null;
}

function findTripletDimensions(characteristics, { packageOnly = false } = {}) {
  for (const item of characteristics || []) {
    const name = normalizeName(item?.name);
    if (!name) {
      continue;
    }

    if (DIMENSION_SKIP_RE.test(name)) {
      continue;
    }
    const isDimensionLike = /(размер|габарит|dimensions|dimension|длина|ширина|высота|length|width|height)/i.test(name);
    const isPackageLike = isPackageDimensionName(name);
    if (!isDimensionLike) {
      continue;
    }
    if (packageOnly && !isPackageLike) {
      continue;
    }

    const rawValue = characteristicRawValue(item);
    const triplet = parseDimensionTriplet(rawValue, item?.name || '');
    if (!triplet) {
      continue;
    }

    return {
      height: Math.round(triplet.height),
      width: Math.round(triplet.width),
      depth: Math.round(triplet.depth),
      source: isPackageLike ? 'json-package-triplet' : 'json-triplet',
    };
  }

  return null;
}

function extractPayloadDimensions(scrapedData = {}, { packageOnly = false } = {}) {
  const candidateKeys = packageOnly
    ? ['packageDimensions', 'shippingDimensions', 'packageSize']
    : ['dimensions', 'productDimensions', 'productSize', 'size'];

  for (const key of candidateKeys) {
    const payload = scrapedData?.[key];
    if (payload === null || payload === undefined) {
      continue;
    }
    if (typeof payload === 'string') {
      const triplet = parseDimensionTriplet(payload, key);
      if (triplet) {
        return {
          height: Math.round(triplet.height),
          width: Math.round(triplet.width),
          depth: Math.round(triplet.depth),
          source: `payload-${key}`,
        };
      }
      continue;
    }
    if (typeof payload !== 'object') {
      continue;
    }

    const height = parseDimensionToMm(firstPresentValue(payload, ['height', 'heightMm', 'heightMM', 'height_mm', 'h']), {
      name: `${key} height`,
      defaultUnit: 'mm',
    });
    const width = parseDimensionToMm(firstPresentValue(payload, ['width', 'widthMm', 'widthMM', 'width_mm', 'w']), {
      name: `${key} width`,
      defaultUnit: 'mm',
    });
    const depth = parseDimensionToMm(
      firstPresentValue(payload, ['depth', 'length', 'lengthMm', 'lengthMM', 'length_mm', 'depthMm', 'depthMM', 'depth_mm', 'l']),
      {
        name: `${key} depth`,
        defaultUnit: 'mm',
      }
    );
    if (height && width && depth) {
      return { height, width, depth, source: `payload-${key}` };
    }
  }

  return null;
}

function extractDimensions(characteristics) {
  const heightEntry = findDimensionScalar(characteristics, 'height', { packageOnly: true }) ||
    findDimensionScalar(characteristics, 'height');
  const widthEntry = findDimensionScalar(characteristics, 'width', { packageOnly: true }) ||
    findDimensionScalar(characteristics, 'width');
  const depthEntry = findDimensionScalar(characteristics, 'depth', { packageOnly: true }) ||
    findDimensionScalar(characteristics, 'depth');

  const foundCount = [heightEntry, widthEntry, depthEntry].filter(Boolean).length;

  return {
    height: heightEntry?.value || config.DEFAULTS.default_height_mm,
    width: widthEntry?.value || config.DEFAULTS.default_width_mm,
    depth: depthEntry?.value || config.DEFAULTS.default_depth_mm,
    dimension_unit: 'mm',
    source: foundCount === 0 ? 'default' : foundCount === 3 ? 'json' : 'mixed',
  };
}

function extractPreferredDimensions(characteristics, scrapedData = {}) {
  const payloadPackage = extractPayloadDimensions(scrapedData, { packageOnly: true });
  const packageTriplet = findTripletDimensions(characteristics, { packageOnly: true });
  const payloadGeneric = payloadPackage || packageTriplet ? null : extractPayloadDimensions(scrapedData);
  const genericTriplet = payloadPackage || packageTriplet || payloadGeneric ? null : findTripletDimensions(characteristics);
  const base = extractDimensions(characteristics);

  if (!payloadPackage && !packageTriplet && !payloadGeneric && !genericTriplet) {
    return base;
  }

  const chosen = payloadPackage || packageTriplet || payloadGeneric || genericTriplet;
  return {
    ...base,
    height: Number.isFinite(chosen?.height) ? chosen.height : base.height,
    width: Number.isFinite(chosen?.width) ? chosen.width : base.width,
    depth: Number.isFinite(chosen?.depth) ? chosen.depth : base.depth,
    source: chosen?.source || base.source,
  };
}

function extractWeight(characteristics, scrapedData = {}) {
  const packageWeight = scrapedData?.packageWeight || {};
  if (packageWeight && typeof packageWeight === 'object') {
    let grams = parseWeightToGrams(firstPresentValue(packageWeight, ['grams', 'weightG', 'weightGrams', 'weight_g']), {
      defaultUnit: 'g',
    });
    if (grams) {
      return { weight: grams, weight_unit: 'g', source: 'payload-package-g' };
    }
    grams = parseWeightToGrams(packageWeight.weightKg, { defaultUnit: 'kg' });
    if (grams) {
      return { weight: grams, weight_unit: 'g', source: 'payload-package-kg' };
    }
    for (const key of ['weightText', 'orderInfo', 'text', 'value']) {
      grams = parseWeightToGrams(packageWeight[key], { name: key });
      if (grams) {
        return { weight: grams, weight_unit: 'g', source: `payload-package-${key}` };
      }
    }
  }

  for (const item of characteristics || []) {
    const name = normalizeName(item?.name);
    if (!/(вес|масса|weight)/i.test(name) || !/(упаков|package|shipping|посылк)/i.test(name)) {
      continue;
    }
    const grams = parseWeightToGrams(characteristicRawValue(item), { name: item?.name || '' });
    if (grams) {
      return { weight: grams, weight_unit: 'g', source: 'json-package' };
    }
  }

  const productWeight = scrapedData?.productWeight || {};
  if (productWeight && typeof productWeight === 'object') {
    let grams = parseWeightToGrams(firstPresentValue(productWeight, ['grams', 'weightG', 'weightGrams', 'weight_g']), {
      defaultUnit: 'g',
    });
    if (grams) {
      return { weight: grams, weight_unit: 'g', source: 'payload-product-g' };
    }
    grams = parseWeightToGrams(productWeight.weightKg, { defaultUnit: 'kg' });
    if (grams) {
      return { weight: grams, weight_unit: 'g', source: 'payload-product-kg' };
    }
    for (const key of ['weightText', 'characteristicValueText', 'text', 'value']) {
      grams = parseWeightToGrams(productWeight[key], { name: key });
      if (grams) {
        return { weight: grams, weight_unit: 'g', source: `payload-product-${key}` };
      }
    }
  }

  for (const item of characteristics || []) {
    const name = normalizeName(item?.name);
    if (!/(вес|масса|weight)/i.test(name) || /(упаков|package|shipping|посылк)/i.test(name)) {
      continue;
    }
    const grams = parseWeightToGrams(characteristicRawValue(item), { name: item?.name || '' });
    if (grams) {
      return { weight: grams, weight_unit: 'g', source: 'json-product' };
    }
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

  const dims = extractPreferredDimensions(chars, scrapedData);
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
