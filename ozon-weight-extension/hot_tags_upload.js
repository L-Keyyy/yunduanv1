export const HOT_TAGS_UPLOAD_STATE_KEY = "hotTagsUpload:lastResult";

export const HOT_TAGS_UPLOAD_DEFAULTS = {
  maxRows: 5000,
  groupSampleLimit: 50,
  batchSize: 5
};

function toOptionalText(value, maxLength = 1000) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function toSafeNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      query: toOptionalText(row.query, 300) || "",
      count: toSafeNumber(row.count, 0),
      dynamicsIn28: row.dynamicsIn28 ?? null,
      dynamicsIn7: row.dynamicsIn7 ?? null,
      addToCart: toSafeNumber(row.addToCart, 0),
      addToCartRate: toSafeNumber(row.addToCartRate, 0),
      orders: toSafeNumber(row.orders, 0),
      orderRate: toSafeNumber(row.orderRate, 0),
      noActionCount: toSafeNumber(row.noActionCount, 0),
      noActionShare: toSafeNumber(row.noActionShare, 0),
      sellers: toSafeNumber(row.sellers, 0)
    }))
    .filter((row) => row.query);
}

function normalizeQueryGroups(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      query: toOptionalText(row.query, 300) || "",
      group: toOptionalText(row.group, 200) || ""
    }))
    .filter((row) => row.query);
}

export function buildHotTagsUploadPayload(rawPayload) {
  const source = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const rows = normalizeRows(source.rows);
  const groups = Array.isArray(source.groups)
    ? source.groups.map((item) => toOptionalText(item, 200)).filter(Boolean)
    : [];

  return {
    source: "extension_hot_tags_upload",
    seller_url: toOptionalText(source.sellerUrl || source.seller_url, 1000),
    company_id: toSafeNumber(source.companyId ?? source.company_id, 0) || null,
    overall_total: toSafeNumber(source.overallTotal ?? source.overall_total, rows.length),
    fetched_total: toSafeNumber(source.fetchedTotal ?? source.fetched_total, rows.length),
    visible_dynamics_available_count: toSafeNumber(
      source.visibleDynamicsAvailableCount ?? source.visible_dynamics_available_count,
      0
    ),
    rows,
    query_groups: normalizeQueryGroups(source.queryGroups || source.query_groups),
    groups,
    generated_at: source.generatedAt || source.generated_at || new Date().toISOString()
  };
}
