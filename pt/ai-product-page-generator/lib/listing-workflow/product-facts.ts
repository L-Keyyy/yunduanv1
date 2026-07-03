export type ProductFact = {
  key: string;
  value: string;
};

export type PreparedProductVariant = {
  skuId: string;
  title: string;
  specText: string;
  specs: ProductFact[];
  price: string;
  stock: string;
};

export type PreparedProductFacts = {
  title: string;
  source: string;
  productId: string;
  price: string;
  currency: string;
  description: string;
  facts: ProductFact[];
  variants: PreparedProductVariant[];
  package: ProductFact[];
};

export type ProductFactsAudit = {
  rawBytes: number;
  preparedBytes: number;
  removedUrlCount: number;
  removedImageReferenceCount: number;
  factCount: number;
  variantCount: number;
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isProductFact(value: unknown): value is ProductFact {
  const record = asRecord(value);
  return isString(record.key) && isString(record.value);
}

function isPreparedProductVariant(
  value: unknown,
): value is PreparedProductVariant {
  const record = asRecord(value);
  return (
    isString(record.skuId) &&
    isString(record.title) &&
    isString(record.specText) &&
    Array.isArray(record.specs) &&
    record.specs.every(isProductFact) &&
    isString(record.price) &&
    isString(record.stock)
  );
}

export function isPreparedProductFacts(
  value: unknown,
): value is PreparedProductFacts {
  const record = asRecord(value);
  return (
    isString(record.title) &&
    isString(record.source) &&
    isString(record.productId) &&
    isString(record.price) &&
    isString(record.currency) &&
    isString(record.description) &&
    Array.isArray(record.facts) &&
    record.facts.every(isProductFact) &&
    Array.isArray(record.variants) &&
    record.variants.every(isPreparedProductVariant) &&
    Array.isArray(record.package) &&
    record.package.every(isProductFact)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalarText(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function cleanText(value: unknown, maxLength = 600) {
  const raw = scalarText(value);
  if (!raw) return "";
  return raw
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu, " ")
    .replace(/(?:https?:)?\/\/[^\s"'<>]+/giu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function firstText(values: unknown[], maxLength = 600) {
  for (const value of values) {
    const text = cleanText(value, maxLength);
    if (text) return text;
  }
  return "";
}

function joinTextList(value: unknown) {
  if (!Array.isArray(value)) return cleanText(value);
  return value
    .map((entry) => {
      if (
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean"
      ) {
        return cleanText(entry, 160);
      }
      const record = asRecord(entry);
      return firstText(
        [
          record.valueText,
          record.value,
          record.text,
          record.name,
          record.label,
          record.title,
        ],
        160,
      );
    })
    .filter(Boolean)
    .join(", ")
    .slice(0, 600);
}

function descriptionText(value: unknown) {
  const record = asRecord(value);
  return firstText(
    [
      record.text,
      record.summary,
      record.description,
      record.html,
      record.rawSectionHtml,
      value,
    ],
    1800,
  );
}

function addFact(
  facts: ProductFact[],
  key: unknown,
  value: unknown,
  maxLength = 600,
) {
  const normalizedKey = cleanText(key, 120);
  const normalizedValue = cleanText(value, maxLength);
  if (!normalizedKey || !normalizedValue) return;
  facts.push({ key: normalizedKey, value: normalizedValue });
}

function addRecordFacts(
  facts: ProductFact[],
  value: unknown,
  prefix = "",
) {
  const record = asRecord(value);
  for (const [key, entry] of Object.entries(record)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      continue;
    }
    addFact(facts, prefix ? `${prefix}${key}` : key, entry);
  }
}

function addArrayFacts(
  facts: ProductFact[],
  value: unknown,
  prefix = "",
) {
  if (!Array.isArray(value)) return;
  for (const entry of value.slice(0, 160)) {
    const record = asRecord(entry);
    const key = firstText(
      [
        record.name,
        record.key,
        record.label,
        record.title,
        record.attrName,
        record.attributeName,
      ],
      120,
    );
    const factValue =
      firstText(
        [
          record.value,
          record.valueText,
          record.text,
          record.content,
          record.attrValue,
          record.attributeValue,
        ],
        600,
      ) || joinTextList(record.values);
    if (key && factValue) {
      addFact(facts, prefix ? `${prefix}${key}` : key, factValue);
    }
  }
}

function deduplicateFacts(facts: ProductFact[]) {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const fingerprint = `${fact.key.toLowerCase().replace(/\s+/g, "")}:${fact.value
      .toLowerCase()
      .replace(/\s+/g, "")}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function variantFacts(value: unknown): PreparedProductVariant | null {
  const variant = asRecord(value);
  if (!Object.keys(variant).length) return null;
  const specs: ProductFact[] = [];
  addRecordFacts(specs, variant.specs);
  addArrayFacts(specs, variant.characteristics);
  addArrayFacts(specs, variant.attributes);
  return {
    skuId: firstText([variant.skuId, variant.sku_id, variant.id], 120),
    title: firstText([variant.title, variant.name], 500),
    specText: firstText(
      [variant.specText, variant.spec, variant.variantName],
      300,
    ),
    specs: deduplicateFacts(specs).slice(0, 40),
    price: firstText([variant.price, variant.salePrice], 80),
    stock: firstText([variant.stock, variant.quantity], 80),
  };
}

function selectedVariants(data: Record<string, unknown>) {
  const selection = asRecord(data.skuSelection);
  const selectedIds = new Set(
    Array.isArray(selection.selectedSkuIds)
      ? selection.selectedSkuIds.map((value) => String(value))
      : [],
  );
  const variants = Array.isArray(data.variants) ? data.variants : [];
  const selected = selectedIds.size
    ? variants.filter((value) => {
        const variant = asRecord(value);
        const skuId = firstText(
          [variant.skuId, variant.sku_id, variant.id],
          120,
        );
        return selectedIds.has(skuId);
      })
    : variants;
  const normalized = selected
    .slice(0, 60)
    .map(variantFacts)
    .filter((value): value is PreparedProductVariant => Boolean(value));

  if (!normalized.length && data.selectedVariant) {
    const single = variantFacts(data.selectedVariant);
    if (single) normalized.push(single);
  }
  return normalized;
}

export function prepareProductFacts(
  data: Record<string, unknown>,
): PreparedProductFacts {
  const description = asRecord(data.description);
  const pricing = asRecord(data.pricing);
  const packageInfo = asRecord(
    data.packageInfo ?? data.packageWeight ?? data.packaging ?? data.package,
  );
  const facts: ProductFact[] = [];

  addArrayFacts(facts, data.facts);
  addRecordFacts(facts, data.characteristics);
  addArrayFacts(facts, data.characteristics);
  addRecordFacts(facts, data.attributes);
  addArrayFacts(facts, data.attributes);
  addRecordFacts(facts, data.props);
  addArrayFacts(facts, data.props);
  addRecordFacts(facts, data.specs);
  addArrayFacts(facts, data.specs);
  addRecordFacts(facts, data.parameters);
  addArrayFacts(facts, data.parameters);
  addArrayFacts(facts, description.characteristics);
  addArrayFacts(facts, description.attributes);
  addArrayFacts(facts, data.selectedVariant, "SKU ");

  const packageFacts: ProductFact[] = [];
  [
    ["重量", packageInfo.weight ?? packageInfo.value],
    ["重量(g)", packageInfo.weightG],
    ["重量(kg)", packageInfo.weightKg],
    ["包装长", packageInfo.depth ?? packageInfo.length],
    ["包装宽", packageInfo.width],
    ["包装高", packageInfo.height],
    ["尺寸单位", packageInfo.dimensionUnit],
    ["重量单位", packageInfo.weightUnit ?? packageInfo.unit],
  ].forEach(([key, value]) => addFact(packageFacts, key, value));

  return {
    title: firstText(
      [
        data.title,
        data.name,
        data.item_name,
        data.productName,
        data.goods_name,
        data.subject,
      ],
      500,
    ),
    source: firstText([data.source, data.platform, data.site], 80),
    productId: firstText(
      [
        data.productId,
        data.itemId,
        data.item_id,
        data.offerId1688,
        data.offerId,
        data.offer_id,
        data.goods_id,
      ],
      160,
    ),
    price: firstText(
      [
        pricing.purchasePriceCny,
        pricing.price,
        data.price,
        data.salePrice,
        data.min_price,
      ],
      80,
    ),
    currency: firstText([pricing.currency, data.currency], 20) || "CNY",
    description: firstText(
      [
        data.summary,
        data.shortDescription,
        data.descriptionText,
        descriptionText(data.description),
      ],
      1800,
    ),
    facts: deduplicateFacts(facts).slice(0, 180),
    variants: selectedVariants(data),
    package: deduplicateFacts(packageFacts),
  };
}

export function auditProductFacts(
  raw: Record<string, unknown>,
  prepared: PreparedProductFacts,
): ProductFactsAudit {
  const rawJson = JSON.stringify(raw);
  const preparedJson = JSON.stringify(prepared);
  const urlMatches = rawJson.match(/(?:https?:)?\/\/[^"\\\s]+/giu) ?? [];
  const imageMatches =
    rawJson.match(/\.(?:avif|gif|jpe?g|png|webp)(?:[?#][^"\\]*)?/giu) ?? [];
  return {
    rawBytes: Buffer.byteLength(rawJson),
    preparedBytes: Buffer.byteLength(preparedJson),
    removedUrlCount: urlMatches.length,
    removedImageReferenceCount: imageMatches.length,
    factCount: prepared.facts.length,
    variantCount: prepared.variants.length,
  };
}
