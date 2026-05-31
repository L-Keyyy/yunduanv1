export const DAILY_ANALYTICS_UPLOAD_STATE_KEY = "dailyAnalyticsUpload:lastResult";

const SELLER_ANALYTICS_PREFIX = "sellerAnalytics:";
const SELLER_CONTEXT_KEY = "sellerAnalytics:context";
const DEFAULT_MAX_RECORDS = 5000;
const MAX_METRICS_PER_RECORD = 80;

function toOptionalText(value, maxLength = 500) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return text.slice(0, maxLength);
}

function toOptionalNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toIsoString(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeMetric(rawMetric) {
  if (!rawMetric || typeof rawMetric !== "object") {
    return null;
  }

  const label = toOptionalText(rawMetric.label, 100);
  const key = toOptionalText(rawMetric.key, 80);
  const value = toOptionalText(rawMetric.value, 200);
  if (!label && !key && !value) {
    return null;
  }

  return {
    key,
    label,
    value
  };
}

function extractProductIdFromKey(key) {
  if (!key.startsWith(SELLER_ANALYTICS_PREFIX) || key === SELLER_CONTEXT_KEY) {
    return null;
  }

  const suffix = key.slice(SELLER_ANALYTICS_PREFIX.length);
  if (!/^\d+$/.test(suffix)) {
    return null;
  }

  const parsed = Number(suffix);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRecord(rawRecord, fallbackProductId) {
  if (!rawRecord || typeof rawRecord !== "object") {
    return null;
  }

  const productId = toOptionalNumber(rawRecord.productId) ?? fallbackProductId;
  if (!productId) {
    return null;
  }

  const metrics = Array.isArray(rawRecord.metrics)
    ? rawRecord.metrics.map(normalizeMetric).filter(Boolean).slice(0, MAX_METRICS_PER_RECORD)
    : [];

  const status = toOptionalText(rawRecord.status, 40) || "unknown";
  const updatedAt = toIsoString(rawRecord.updatedAt) || new Date().toISOString();

  return {
    productId,
    title: toOptionalText(rawRecord.title, 300),
    sourceUrl: toOptionalText(rawRecord.sourceUrl, 1000),
    status,
    notice: toOptionalText(rawRecord.notice, 500),
    updatedAt,
    metrics,
    raw: rawRecord.raw && typeof rawRecord.raw === "object" ? rawRecord.raw : null
  };
}

function normalizeContext(rawContext) {
  if (!rawContext || typeof rawContext !== "object") {
    return {};
  }

  return {
    companyId: toOptionalNumber(rawContext.companyId),
    sellerId: toOptionalNumber(rawContext.sellerId),
    sellerUrl: toOptionalText(rawContext.sellerUrl, 1000),
    updatedAt: toIsoString(rawContext.updatedAt)
  };
}

export function collectSellerAnalyticsRecords(storageEntries, maxRecords = DEFAULT_MAX_RECORDS) {
  const source = storageEntries && typeof storageEntries === "object" ? storageEntries : {};
  const records = [];

  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(SELLER_ANALYTICS_PREFIX) || key === SELLER_CONTEXT_KEY) {
      continue;
    }

    const productId = extractProductIdFromKey(key);
    if (!productId) {
      continue;
    }

    const normalized = normalizeRecord(value, productId);
    if (normalized) {
      records.push(normalized);
    }
  }

  records.sort((left, right) => {
    const leftTime = new Date(left.updatedAt || 0).getTime();
    const rightTime = new Date(right.updatedAt || 0).getTime();
    return rightTime - leftTime;
  });

  const requestedLimit = Number(maxRecords);
  const safeLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), DEFAULT_MAX_RECORDS)
      : DEFAULT_MAX_RECORDS;

  const clippedRecords = records.slice(0, safeLimit);

  let okCount = 0;
  let staleCount = 0;
  let unavailableCount = 0;
  let notFoundCount = 0;
  let otherCount = 0;

  for (const record of clippedRecords) {
    switch (record.status) {
      case "ok":
        okCount += 1;
        break;
      case "stale":
        staleCount += 1;
        break;
      case "unavailable":
        unavailableCount += 1;
        break;
      case "not_found":
        notFoundCount += 1;
        break;
      default:
        otherCount += 1;
        break;
    }
  }

  return {
    records: clippedRecords,
    stats: {
      totalRecords: clippedRecords.length,
      totalRecordsBeforeLimit: records.length,
      truncated: records.length > clippedRecords.length,
      okCount,
      staleCount,
      unavailableCount,
      notFoundCount,
      otherCount,
      lastUpdatedAt: clippedRecords[0]?.updatedAt || null
    }
  };
}

export function buildDailyAnalyticsUploadPayload(storageEntries, options = {}) {
  const source = storageEntries && typeof storageEntries === "object" ? storageEntries : {};
  const { records, stats } = collectSellerAnalyticsRecords(source, options.maxRecords);

  return {
    store_id: Number.isFinite(Number(options.storeId)) ? Number(options.storeId) : null,
    source: "extension_daily_analytics",
    uploaded_at: new Date().toISOString(),
    context: normalizeContext(source[SELLER_CONTEXT_KEY]),
    stats,
    records
  };
}
