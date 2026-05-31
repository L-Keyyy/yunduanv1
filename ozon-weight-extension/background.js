import {
  DAILY_ANALYTICS_UPLOAD_STATE_KEY,
  buildDailyAnalyticsUploadPayload
} from "./daily_analytics_upload.js";
import {
  HOT_TAGS_UPLOAD_DEFAULTS,
  HOT_TAGS_UPLOAD_STATE_KEY,
  buildHotTagsUploadPayload
} from "./hot_tags_upload.js";

const JOB_PREFIX = "job:";
const SELLER_ANALYTICS_PREFIX = "sellerAnalytics:";
const SELLER_CONTEXT_KEY = "sellerAnalytics:context";
const SELLER_ANALYTICS_ENDPOINT =
  "https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3";
const SELLER_BRIDGE_URL = "https://seller.ozon.ru/app/analytics/what-to-sell";
const SELLER_HOT_TAGS_URL = "https://seller.ozon.ru/app/analytics/what-to-sell/all-queries";
const OZON_BUYER_BRIDGE_URL = "https://www.ozon.ru/";
const SELLER_ANALYTICS_CACHE_TTL_MS = 15 * 60 * 1000;
const HD_API_ORIGINS = [
  "http://35.209.87.105",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3001",
  "http://localhost:3001"
];
const HD_DASHBOARD_URL_PATTERNS = HD_API_ORIGINS.map((origin) => `${origin}/*`);
const HD_PRIMARY_APP_ORIGIN = "http://35.209.87.105";
const HD_API_KEY_STORAGE_KEY = "hd:accessToken";
const HD_AUTH_SESSION_STORAGE_KEY = "hd:authSession";
const HD_LOGIN_PATH = "/login?redirect=%2Fstore-management";
const HD_STATUS_REFRESH_MS = 1500;
const CLOUD_FOLLOW_COLLECT_ALARM = "cloud-follow-collect";
const CLOUD_FOLLOW_COLLECT_INTERVAL_MINUTES = 1;
const CLOUD_FOLLOW_COLLECT_BATCH_LIMIT = 5;
const CLOUD_FOLLOW_COLLECT_CONCURRENCY = 2;
const CLOUD_FOLLOW_COLLECT_DRAIN_DELAY_MS = 1200;
const CLOUD_FOLLOW_DEVICE_ID_KEY = "cloudFollow:deviceId";
const OZON_ENTRYPOINT_FETCH_TIMEOUT_MS = 20000;

const sellerAnalyticsInflight = new Map();
let sellerContextInflight = null;
let sellerBridgeTabPromise = null;
let ozonBuyerBridgeTabPromise = null;
let cloudFollowCollectInFlight = false;

function nowIso() {
  return new Date().toISOString();
}

function extractProductId(url) {
  const match = url.match(/-([0-9]{6,})(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStructuredProductJob(job) {
  return job?.jobType === "extract-all" || job?.jobType === "upload-product";
}

function jobKey(tabId) {
  return `${JOB_PREFIX}${tabId}`;
}

function analyticsKey(productId) {
  return `${SELLER_ANALYTICS_PREFIX}${productId}`;
}

function isSellerTabUrl(url = "") {
  return /:\/\/seller\.ozon\.ru\//i.test(url);
}

function isSellerLoginUrl(url = "") {
  return /:\/\/seller\.ozon\.ru\/app\/registration\/signin/i.test(url) || /[?&]auth=1(?:&|$)/i.test(url);
}

function isOzonBuyerTabUrl(url = "") {
  return /:\/\/(?:www\.)?ozon\.ru\//i.test(url);
}

function matchesSupportedUrl(url = "") {
  return /:\/\/(?:seller\.ozon\.ru|(?:www\.)?ozon\.ru)\//i.test(url);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return numericValue.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function formatInteger(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.round(numericValue).toLocaleString("en-US");
}

function formatPercent(value, digits = 2) {
  const formatted = formatNumber(value, digits);
  return formatted ? `${formatted}%` : null;
}

function formatRub(value, digits = 2) {
  const formatted = formatNumber(value, digits);
  return formatted ? `${formatted} ₽` : null;
}

function formatDays(value, digits = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }

  const formatted = formatNumber(numericValue, digits);
  return formatted ? `${formatted} d` : null;
}

function formatDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function buildMetric(label, value, key) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return null;
  }

  return {
    key: key || null,
    label,
    value: String(value)
  };
}

function averagePerDay(totalValue, days) {
  const numericValue = Number(totalValue);
  const numericDays = Number(days);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericDays) || numericDays <= 0) {
    return null;
  }

  return numericValue / numericDays;
}

function buildSellerAnalyticsMetrics(item) {
  const periodDays = 28;
  const monthlyRevenue = isFiniteNumber(item?.soldSum) ? item.soldSum : item?.gmvSum;
  const dailyRevenue = isFiniteNumber(item?.avgGmv) ? item.avgGmv : averagePerDay(monthlyRevenue, periodDays);
  const dailySales = averagePerDay(item?.soldCount, periodDays);
  const pdpViews = isFiniteNumber(item?.qtyViewPdp) ? item.qtyViewPdp : item?.sessionCount;

  return [
    buildMetric("\u54c1\u724c", item.brand, "brand"),
    buildMetric("\u7c7b\u76ee", item.category3 || item.category1, "category"),
    buildMetric("\u5356\u5bb6", item.sellerName, "storeName"),
    buildMetric("\u9500\u552e\u989d", formatRub(monthlyRevenue), "monthlyRevenue"),
    buildMetric("\u9500\u91cf", formatInteger(item.soldCount), "monthlySales"),
    buildMetric("\u5747\u4ef7", formatRub(item.avgPrice), "avgPrice"),
    buildMetric("\u6700\u4f4e\u4ef7", formatRub(item.minSellerPrice), "minPrice"),
    buildMetric("\u9519\u8fc7\u9500\u552e\u989d", formatRub(item.sumMissedGmv), "missedRevenue"),
    buildMetric("\u65e5\u5747\u9500\u552e\u989d", formatRub(dailyRevenue), "dailyRevenue"),
    buildMetric("\u65e5\u5747\u9500\u91cf", formatNumber(dailySales, 2), "dailySales"),
    buildMetric("\u641c\u7d22\u91cf", formatInteger(item.sessionCountSearch), "searchVolume"),
    buildMetric("\u641c\u7d22\u8f6c\u5316\u7387", formatPercent(item.convToCartSearch), "searchConversion"),
    buildMetric("\u5546\u8be6\u6d4f\u89c8", formatInteger(pdpViews), "clicks"),
    buildMetric("\u5546\u8be6\u52a0\u8d2d\u8f6c\u5316", formatPercent(item.convToCartPdp), "cartConversion"),
    buildMetric("\u66dd\u5149", formatInteger(item.views), "impressions"),
    buildMetric("\u66dd\u5149\u8f6c\u8ba2\u5355", formatPercent(item.convViewToOrder), "impressionConversion"),
    buildMetric("\u4fc3\u9500\u6298\u6263", formatPercent(item.discount), "promoDiscount"),
    buildMetric("\u4fc3\u9500\u8d21\u732e\u5ea6", formatPercent(item.promoRevenueShare), "promoConversion"),
    buildMetric("\u4fc3\u9500\u5929\u6570", formatDays(item.daysInPromo), "promoDays"),
    buildMetric("\u5e7f\u544a\u5929\u6570", formatDays(item.daysWithTrafarets), "adDays"),
    buildMetric("DRR", formatPercent(item.drr), "drr"),
    buildMetric("\u5151\u73b0\u7387", formatPercent(item.nullableRedemptionRate), "redemptionRate"),
    buildMetric("\u5e93\u5b58", formatInteger(item.stock), "stock"),
    buildMetric("\u5c65\u7ea6\u65b9\u5f0f", item.salesSchema, "fulfillment"),
    buildMetric("\u4f53\u79ef", formatNumber(item.volume, 3), "volume"),
    buildMetric("\u5e73\u5747\u914d\u9001\u65f6\u95f4", formatDays(item.avgDeliveryTime), "deliveryTime"),
    buildMetric("\u521b\u5efa\u65e5\u671f", formatDate(item.nullableCreateDate), "listedAt")
  ].filter(Boolean);
}

function normalizeSellerAnalyticsItem(item) {
  const productId =
    Number(item?.sku) ||
    extractProductId(item?.link || "") ||
    null;

  if (!Number.isFinite(productId)) {
    return null;
  }

  return {
    productId,
    title: item?.name || item?.skuName || null,
    sourceUrl: item?.link || null,
    updatedAt: nowIso(),
    status: "ok",
    raw: item || null,
    metrics: buildSellerAnalyticsMetrics(item)
  };
}

function buildSellerAnalyticsMiss(productId) {
  return {
    productId,
    title: null,
    sourceUrl: null,
    updatedAt: nowIso(),
    status: "not_found",
    raw: null,
    metrics: []
  };
}

function buildSellerAnalyticsUnavailable(productId, errorText) {
  return {
    productId,
    title: null,
    sourceUrl: null,
    updatedAt: nowIso(),
    status: "unavailable",
    notice: errorText || "Seller analytics is unavailable.",
    raw: null,
    metrics: []
  };
}

function markSellerAnalyticsStale(record, errorText) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    status: record.status === "ok" ? "stale" : record.status,
    notice: errorText ? `显示缓存数据，刷新失败：${errorText}` : "显示缓存数据"
  };
}

function isFreshSellerAnalyticsRecord(record) {
  if (!record?.updatedAt) {
    return false;
  }

  const updatedAt = new Date(record.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt < SELLER_ANALYTICS_CACHE_TTL_MS;
}

async function getSellerContext() {
  const data = await chrome.storage.local.get(SELLER_CONTEXT_KEY);
  return data[SELLER_CONTEXT_KEY] || null;
}

async function setSellerContext(context) {
  const next = {
    companyId: context?.companyId ? String(context.companyId) : null,
    language: context?.language || "zh-Hans",
    updatedAt: nowIso()
  };

  if (!next.companyId) {
    return null;
  }

  await chrome.storage.local.set({ [SELLER_CONTEXT_KEY]: next });
  return next;
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/Receiving end does not exist/i.test(String(error))) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "complete" && tab.url) {
      return tab;
    }

    await delay(500);
  }

  return chrome.tabs.get(tabId);
}

async function ensureSellerBridgeTab() {
  if (!sellerBridgeTabPromise) {
    sellerBridgeTabPromise = (async () => {
      const tabs = await chrome.tabs.query({});
      const reusableTab = tabs.find(
        (tab) => tab.id && isSellerTabUrl(tab.url || "") && !isSellerLoginUrl(tab.url || "")
      );

      if (reusableTab) {
        return reusableTab;
      }

      const bridgeTab = await chrome.tabs.create({
        url: SELLER_BRIDGE_URL,
        active: false
      });
      const readyTab = await waitForTabReady(bridgeTab.id);
      if (isSellerLoginUrl(readyTab?.url || "")) {
        throw new Error("Seller login required. Log in once so the extension can reuse local cookies.");
      }

      return readyTab;
    })().finally(() => {
      sellerBridgeTabPromise = null;
    });
  }

  return sellerBridgeTabPromise;
}

async function ensureSellerHotTagsTab() {
  const tabs = await chrome.tabs.query({});
  const exactTab = tabs.find(
    (tab) => tab.id && /:\/\/seller\.ozon\.ru\/app\/analytics\/what-to-sell\/all-queries/i.test(tab.url || "")
  );
  if (exactTab) {
    return exactTab;
  }

  const reusableTab = tabs.find((tab) => tab.id && isSellerTabUrl(tab.url || "") && !isSellerLoginUrl(tab.url || ""));
  if (reusableTab?.id) {
    await chrome.tabs.update(reusableTab.id, { url: SELLER_HOT_TAGS_URL, active: false });
    return waitForTabReady(reusableTab.id, 30000);
  }

  const bridgeTab = await chrome.tabs.create({ url: SELLER_HOT_TAGS_URL, active: false });
  const readyTab = await waitForTabReady(bridgeTab.id, 30000);
  if (isSellerLoginUrl(readyTab?.url || "")) {
    throw new Error("Seller login required. Log in once so the extension can reuse local cookies.");
  }
  return readyTab;
}

async function ensureOzonBuyerBridgeTab(preferredUrl = OZON_BUYER_BRIDGE_URL) {
  if (!ozonBuyerBridgeTabPromise) {
    ozonBuyerBridgeTabPromise = (async () => {
      const tabs = await chrome.tabs.query({});
      const reusableTab = tabs.find((tab) => tab.id && isOzonBuyerTabUrl(tab.url || ""));
      if (reusableTab) {
        return reusableTab;
      }

      const bridgeTab = await chrome.tabs.create({
        url: preferredUrl || OZON_BUYER_BRIDGE_URL,
        active: false
      });
      return waitForTabReady(bridgeTab.id);
    })().finally(() => {
      ozonBuyerBridgeTabPromise = null;
    });
  }

  return ozonBuyerBridgeTabPromise;
}

async function requestSellerContextFromTabs(options = {}) {
  const tabs = await chrome.tabs.query({});
  const sellerTabs = tabs.filter((tab) => tab.id && isSellerTabUrl(tab.url || ""));
  if (options.includeBridge && !sellerTabs.some((tab) => !isSellerLoginUrl(tab.url || ""))) {
    try {
      sellerTabs.unshift(await ensureSellerBridgeTab());
    } catch (_error) {
      // The caller will surface a clear login-required error below if no context exists.
    }
  }

  for (const tab of sellerTabs) {
    if (isSellerLoginUrl(tab.url || "")) {
      continue;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => ({
          companyId: globalThis.__companyId ? String(globalThis.__companyId) : null,
          language: document.documentElement?.lang || navigator.language || "zh-Hans"
        })
      });
      const context = results?.[0]?.result || null;
      if (context?.companyId) {
        return setSellerContext(context);
      }
    } catch (_error) {
      // Ignore this tab and continue with the next seller tab.
    }
  }

  return null;
}

async function resolveSellerContext(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await getSellerContext();
    if (cached?.companyId) {
      return cached;
    }
  }

  if (!sellerContextInflight) {
    sellerContextInflight = requestSellerContextFromTabs({ includeBridge: true }).finally(() => {
      sellerContextInflight = null;
    });
  }

  const context = await sellerContextInflight;
  if (context?.companyId) {
    return context;
  }

  throw new Error("Seller context unavailable. Keep a logged-in seller.ozon.ru tab open.");
}

async function getJob(tabId) {
  const key = jobKey(tabId);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function setJob(tabId, job) {
  const key = jobKey(tabId);
  await chrome.storage.local.set({ [key]: job });
  return job;
}

async function patchJob(tabId, patch) {
  const existing = (await getJob(tabId)) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  await setJob(tabId, next);
  return next;
}

async function removeJob(tabId) {
  await chrome.storage.local.remove(jobKey(tabId));
}

async function upsertSellerAnalytics(items) {
  const payload = {};

  for (const item of items || []) {
    const productId = Number(item?.productId);
    if (!Number.isFinite(productId)) {
      continue;
    }

    payload[analyticsKey(productId)] = {
      ...item,
      productId,
      updatedAt: item.updatedAt || nowIso()
    };
  }

  const keys = Object.keys(payload);
  if (!keys.length) {
    return 0;
  }

  await chrome.storage.local.set(payload);
  return keys.length;
}

async function fetchSellerAnalyticsResponse(productId, context) {
  const tabs = await chrome.tabs.query({});
  const sellerTabs = tabs.filter((tab) => tab.id && isSellerTabUrl(tab.url || ""));
  let lastError = null;

  for (const tab of sellerTabs) {
    if (isSellerLoginUrl(tab.url || "")) {
      lastError = "Seller login required. Log in once so the extension can reuse local cookies.";
      continue;
    }

    try {
      const response = await sendMessageToTab(tab.id, {
        type: "fetch-seller-analytics-item",
        productId,
        context
      });

      if (response?.ok) {
        return response.payload || { items: [] };
      }

      lastError = response?.error || lastError;
    } catch (error) {
      lastError = String(error);
    }
  }

  try {
    const bridgeTab = await ensureSellerBridgeTab();
    const response = await sendMessageToTab(bridgeTab.id, {
      type: "fetch-seller-analytics-item",
      productId,
      context
    });

    if (response?.ok) {
      return response.payload || { items: [] };
    }

    lastError = response?.error || lastError;
  } catch (error) {
    lastError = String(error);
  }

  throw new Error(lastError || "Seller analytics request failed: no seller cookie bridge available.");
}

async function fetchSellerAnalyticsForProductId(productId, context, allowRetry = true) {
  if (sellerAnalyticsInflight.has(productId)) {
    return sellerAnalyticsInflight.get(productId);
  }

  const task = (async () => {
    try {
      const parsed = await fetchSellerAnalyticsResponse(productId, context);
      const item =
        parsed?.items?.find(
          (candidate) =>
            Number(candidate?.sku) === productId ||
            extractProductId(candidate?.link || "") === productId
        ) ||
        parsed?.items?.[0] ||
        null;
      const record = item
        ? normalizeSellerAnalyticsItem(item)
        : buildSellerAnalyticsMiss(productId);
      await upsertSellerAnalytics([record]);
      return record;
    } catch (error) {
      const errorText = String(error);
      if (allowRetry && /PermissionDenied|Failed to get company ID|seller analytics request failed/i.test(errorText)) {
        const refreshedContext = await resolveSellerContext(true);
        return fetchSellerAnalyticsForProductId(productId, refreshedContext, false);
      }
      throw error;
    }
  })().finally(() => {
    sellerAnalyticsInflight.delete(productId);
  });

  sellerAnalyticsInflight.set(productId, task);
  return task;
}

async function fetchMissingSellerAnalytics(productIds, context) {
  const queue = [...productIds];
  const results = {};
  const workerCount = Math.min(4, queue.length);

  async function worker() {
    while (queue.length) {
      const productId = queue.shift();
      if (!productId) {
        continue;
      }

      try {
        results[productId] = await fetchSellerAnalyticsForProductId(productId, context);
      } catch (_error) {
        results[productId] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function getSellerAnalytics(productIds, options = {}) {
  const ids = [...new Set((productIds || []).map((value) => Number(value)).filter(Number.isFinite))];
  if (!ids.length) {
    return {};
  }

  const data = await chrome.storage.local.get(ids.map((productId) => analyticsKey(productId)));
  const result = {};
  const missingIds = [];

  for (const productId of ids) {
    const record = data[analyticsKey(productId)] || null;
    result[productId] = record;

    if (options.fetchMissing && (!record || !isFreshSellerAnalyticsRecord(record))) {
      missingIds.push(productId);
    }
  }

  if (options.fetchMissing && missingIds.length) {
    try {
      const context = await resolveSellerContext();
      const fetched = await fetchMissingSellerAnalytics(missingIds, context);
      for (const productId of missingIds) {
        if (Object.prototype.hasOwnProperty.call(fetched, productId) && fetched[productId]) {
          result[productId] = fetched[productId];
        } else {
          result[productId] = result[productId]
            ? markSellerAnalyticsStale(
                result[productId],
                "刷新失败，请保持已登录的 seller.ozon.ru 页签打开"
              )
            : buildSellerAnalyticsUnavailable(
                productId,
                "刷新失败，请保持已登录的 seller.ozon.ru 页签打开"
              );
        }
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      for (const productId of missingIds) {
        result[productId] = result[productId]
          ? markSellerAnalyticsStale(result[productId], errorText)
          : buildSellerAnalyticsUnavailable(productId, errorText);
      }
    }
  }

  return result;
}

async function getDailyAnalyticsUploadSummary(maxRecords = 5000) {
  const storageData = await chrome.storage.local.get(null);
  const payload = buildDailyAnalyticsUploadPayload(storageData, { maxRecords });
  return {
    generatedAt: nowIso(),
    stats: payload.stats || {},
    context: payload.context || {},
    lastUpload: storageData[DAILY_ANALYTICS_UPLOAD_STATE_KEY] || null
  };
}

async function uploadDailyAnalyticsSnapshot({ storeId = null, maxRecords = 5000 } = {}) {
  const storageData = await chrome.storage.local.get(null);
  const payload = buildDailyAnalyticsUploadPayload(storageData, { storeId, maxRecords });
  if (!Array.isArray(payload.records) || !payload.records.length) {
    throw new Error(
      "No local seller analytics data found. Keep seller.ozon.ru analytics open and collect data first."
    );
  }

  const { origin, data } = await fetchHdJsonSafe("/api/v1/extension/analytics-daily-upload", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const uploadedState = {
    ok: true,
    at: nowIso(),
    origin,
    storeId: Number(data?.store_id) || payload.store_id || null,
    uploadedAt: data?.uploaded_at || payload.uploaded_at,
    receivedCount: Number(data?.received_count) || payload.records.length,
    storedCount: Number(data?.stored_count) || 0,
    totalRecords: Number(payload.stats?.totalRecords) || payload.records.length
  };

  await chrome.storage.local.set({
    [DAILY_ANALYTICS_UPLOAD_STATE_KEY]: uploadedState
  });

  return {
    state: uploadedState,
    stats: payload.stats || {},
    context: payload.context || {},
    response: data || {}
  };
}

async function collectHotTagsFromSeller(options = {}) {
  const tab = await ensureSellerHotTagsTab();
  const response = await sendMessageToTab(tab.id, {
    type: "collect-hot-tags",
    options: {
      maxRows: options.maxRows || HOT_TAGS_UPLOAD_DEFAULTS.maxRows,
      groupSampleLimit: options.groupSampleLimit || HOT_TAGS_UPLOAD_DEFAULTS.groupSampleLimit,
      batchSize: options.batchSize || HOT_TAGS_UPLOAD_DEFAULTS.batchSize
    }
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Hot tags collection failed.");
  }
  return response.payload || {};
}

async function getHotTagsUploadSummary() {
  const storageData = await chrome.storage.local.get(HOT_TAGS_UPLOAD_STATE_KEY);
  return {
    generatedAt: nowIso(),
    lastUpload: storageData[HOT_TAGS_UPLOAD_STATE_KEY] || null
  };
}

async function uploadHotTagsSnapshot(options = {}) {
  const collected = await collectHotTagsFromSeller(options);
  const payload = buildHotTagsUploadPayload(collected);
  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    throw new Error("No hot-tags rows were collected from seller.ozon.ru.");
  }

  const { origin, data } = await fetchHdJsonSafe("/api/v1/extension/hot-tags-upload", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const uploadedState = {
    ok: true,
    at: nowIso(),
    origin,
    uploadedAt: data?.uploaded_at || payload.generated_at,
    receivedCount: Number(data?.received_count) || payload.rows.length,
    storedCount: Number(data?.stored_count) || payload.rows.length,
    companyId: data?.company_id || payload.company_id || null,
    visibleDynamicsAvailableCount: Number(payload.visible_dynamics_available_count) || 0
  };

  await chrome.storage.local.set({
    [HOT_TAGS_UPLOAD_STATE_KEY]: uploadedState
  });

  return {
    state: uploadedState,
    response: data || {},
    collected: {
      rows: payload.rows.length,
      groups: Array.isArray(payload.groups) ? payload.groups.length : 0,
      visibleDynamicsAvailableCount: payload.visible_dynamics_available_count
    }
  };
}

async function injectContentScriptIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !matchesSupportedUrl(tab.url || "")) {
        return;
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
      } catch (_error) {
        // Ignore tabs that cannot be scripted at the moment.
      }
    })
  );
}

function appendLog(job, message) {
  const logs = Array.isArray(job.logs) ? job.logs.slice(-49) : [];
  logs.push({ at: nowIso(), message });
  return logs;
}

function resolveUploadPrice(result) {
  return (
    result?.price ||
    result?.pricing?.uploadPrice ||
    result?.pricing?.priceText ||
    result?.pricing?.cardPriceText ||
    null
  );
}

function resolveOldPrice(result) {
  return result?.oldPrice || result?.pricing?.oldPrice || result?.pricing?.originalPriceText || null;
}

function normalizeHdPriceInput(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const compact = text.replace(/\s+/g, "").replace(/[^\d,.-]/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  let normalized = compact;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = compact.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = compact.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    normalized = /,\d{1,2}$/.test(compact) ? compact.replace(",", ".") : compact.replace(/,/g, "");
  } else {
    normalized = compact;
  }

  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const numericValue = Number(match[0]);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : null;
}

function normalizeModelInput(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 120) : "";
}

function buildHdUploadSnapshot(previous, patch = {}) {
  return {
    ...(previous || {}),
    ...patch,
    updatedAt: nowIso()
  };
}

function buildJobResultWithHdUpload(job, hdUpload) {
  const previous = job?.result || {};
  return {
    productId: previous.productId || previous.source_product_id || null,
    title: previous.title || previous.name || null,
    sourceUrl: previous.sourceUrl || null,
    hdUpload,
    localDataClearedAt: nowIso()
  };
}

function getExistingHdUpload(job) {
  return job?.hdUpload || job?.result?.hdUpload || null;
}

function isActiveHdUploadSnapshot(hdUpload) {
  if (!hdUpload || (!hdUpload.jobId && !hdUpload.productId)) {
    return false;
  }
  return !["failed", "error"].includes(String(hdUpload.status || "").toLowerCase());
}

function mapHdProductStage(payload) {
  switch (payload?.status) {
    case "queued":
      return "cloud_queued";
    case "draft":
      return "cloud_draft";
    case "cleaning":
      return "cloud_cleaning";
    case "ready":
      return "cloud_ready";
    case "uploading":
      return "cloud_uploading";
    case "uploaded":
      return "uploaded";
    case "failed":
      return "error";
    default:
      return "cloud_pending";
  }
}

function cloudAuthError(message = "请先登录 SaaS 后台，再回到 Ozon 页面刷新店铺。") {
  const error = new Error(message);
  error.code = "cloud_auth_required";
  return error;
}

function buildCloudLoginUrl() {
  return `${HD_PRIMARY_APP_ORIGIN}${HD_LOGIN_PATH}`;
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(atob(padded));
  } catch (_error) {
    return null;
  }
}

function normalizeHdSession(token, rawUser, origin = HD_PRIMARY_APP_ORIGIN) {
  const jwtPayload = decodeJwtPayload(token) || {};
  const user = rawUser && typeof rawUser === "object" ? rawUser : {};
  const username = String(user.username || jwtPayload.sub || "").trim();
  const userId = user.id ?? jwtPayload.user_id ?? null;
  const tenantId = user.tenant_id ?? jwtPayload.tenant_id ?? null;
  const tenantName = user.tenant_name || null;
  const displayName = user.display_name || username || "SaaS 用户";
  const accountKey = [tenantId || "tenant0", userId || username || "user"].join(":");

  if (!token || !username) {
    return null;
  }

  return {
    origin,
    accountKey,
    user: {
      id: userId,
      username,
      display_name: displayName,
      tenant_id: tenantId,
      tenant_name: tenantName
    },
    updatedAt: nowIso()
  };
}

async function persistHdSession(token, session) {
  if (!token || !session) {
    return null;
  }

  await chrome.storage.local.set({
    [HD_API_KEY_STORAGE_KEY]: token,
    [HD_AUTH_SESSION_STORAGE_KEY]: session
  });
  return session;
}

async function clearHdSession() {
  await chrome.storage.local.remove([HD_API_KEY_STORAGE_KEY, HD_AUTH_SESSION_STORAGE_KEY]);
}

async function readHdSessionFromDashboardTabs() {
  const tabs = await chrome.tabs.query({ url: HD_DASHBOARD_URL_PATTERNS });
  const sortedTabs = tabs
    .filter((tab) => tab?.id)
    .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)));

  for (const tab of sortedTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          let user = null;
          try {
            user = JSON.parse(localStorage.getItem("ozon_auth_user") || "null");
          } catch (_error) {
            user = null;
          }
          return {
            token: localStorage.getItem("ozon_access_token") || null,
            user
          };
        }
      });
      const payload = results?.[0]?.result || null;
      const token = payload?.token || null;
      const session = normalizeHdSession(token, payload?.user, new URL(tab.url || HD_PRIMARY_APP_ORIGIN).origin);
      if (token && session) {
        return persistHdSession(token, session);
      }
    } catch (_error) {
      // Ignore inaccessible dashboard tabs and continue.
    }
  }

  return null;
}

async function getStoredHdSession() {
  const stored = await chrome.storage.local.get([HD_API_KEY_STORAGE_KEY, HD_AUTH_SESSION_STORAGE_KEY]);
  const token = stored[HD_API_KEY_STORAGE_KEY] || null;
  const session = stored[HD_AUTH_SESSION_STORAGE_KEY] || normalizeHdSession(token, null);
  if (!token || !session) {
    return null;
  }
  return session;
}

async function getHdSession(forceRefresh = false) {
  if (forceRefresh) {
    const liveSession = await readHdSessionFromDashboardTabs();
    if (liveSession) {
      return liveSession;
    }
  }

  const storedSession = await getStoredHdSession();
  if (storedSession) {
    return storedSession;
  }

  return readHdSessionFromDashboardTabs();
}

async function getHdApiKey() {
  const liveSession = await readHdSessionFromDashboardTabs();
  if (liveSession) {
    const stored = await chrome.storage.local.get(HD_API_KEY_STORAGE_KEY);
    return stored[HD_API_KEY_STORAGE_KEY] || null;
  }

  const stored = await chrome.storage.local.get(HD_API_KEY_STORAGE_KEY);
  return stored[HD_API_KEY_STORAGE_KEY] || null;
}

async function openCloudLoginTab() {
  const loginUrl = buildCloudLoginUrl();
  const tabs = await chrome.tabs.query({ url: HD_DASHBOARD_URL_PATTERNS });
  const tab = tabs.find((item) => item?.id);
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true, url: loginUrl });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return loginUrl;
  }

  await chrome.tabs.create({ url: loginUrl, active: true });
  return loginUrl;
}

function parseResponseText(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { detail: text };
  }
}

function isLikelyNetworkFetchError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("fetch failed")
  );
}

async function fetchHdJsonSafe(pathname, options = {}, preferredOrigin = null) {
  const hdApiKey = await getHdApiKey();
  if (!hdApiKey) {
    throw cloudAuthError();
  }

  const origins = preferredOrigin
    ? [preferredOrigin, ...HD_API_ORIGINS.filter((origin) => origin !== preferredOrigin)]
    : HD_API_ORIGINS.slice();
  let serverError = null;
  let networkError = null;

  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}${pathname}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(hdApiKey ? { Authorization: `Bearer ${hdApiKey}` } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      const data = parseResponseText(text);

      if (response.status === 401 || response.status === 403) {
        await clearHdSession();
        const detail = String(data?.detail || data?.error || "").trim();
        throw cloudAuthError(
          detail && !/authentication required/i.test(detail)
            ? detail
            : "Cloud session expired. Please sign in to SaaS again."
        );
      }

      if (!response.ok) {
        const detail = String(data?.detail || data?.error || "").trim() || `HTTP ${response.status}`;
        const httpError = new Error(detail);
        httpError.status = response.status;
        httpError.origin = origin;

        if (response.status >= 500) {
          serverError = serverError || httpError;
          continue;
        }
        throw httpError;
      }

      return { origin, data };
    } catch (error) {
      if (error?.code === "cloud_auth_required") {
        throw error;
      }
      if (!isLikelyNetworkFetchError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      networkError = networkError || (error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (serverError) {
    throw serverError;
  }
  throw new Error(
    `\u6b27\u5356\u901a\u8bf7\u6c42\u5931\u8d25: ${
      networkError instanceof Error ? networkError.message : String(networkError || "unknown_error")
    }`
  );
}

async function getCloudFollowDeviceId() {
  const stored = await chrome.storage.local.get(CLOUD_FOLLOW_DEVICE_ID_KEY);
  const existing = stored[CLOUD_FOLLOW_DEVICE_ID_KEY];
  if (existing) {
    return existing;
  }
  const next = `cf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await chrome.storage.local.set({ [CLOUD_FOLLOW_DEVICE_ID_KEY]: next });
  return next;
}

function resolveCloudFollowCollectProductId(task) {
  const candidate = String(task?.resolved_product_id || task?.reference || "").match(/\d{6,}/)?.[0];
  if (!candidate) {
    return null;
  }
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCloudFollowEntrypointPaths(productId) {
  const productPath = `/product/${productId}/`;
  return [productPath, `${productPath}?layout_container=pdpPage2column&layout_page_index=2`];
}

function resolveCloudFollowCollectProductUrl(task, productId) {
  const reference = String(task?.reference || "").trim();
  const urlMatch = reference.match(/https?:\/\/(?:www\.)?ozon\.ru\/product\/\d{6,}[^\s]*/i);
  if (urlMatch?.[0]) {
    return urlMatch[0];
  }
  return `https://www.ozon.ru/product/${productId}/`;
}

function isCloudFollowEntrypointBlockedError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("entrypoint request failed: 403") ||
    message.includes("entrypoint request failed: 429") ||
    message.includes("entrypoint request timeout") ||
    message.includes("aborted") ||
    message.includes("access denied") ||
    message.includes("captcha") ||
    message.includes("<!doctype html")
  );
}

async function fetchCloudFollowEntrypointPayload(path) {
  const endpoint = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OZON_ENTRYPOINT_FETCH_TIMEOUT_MS);
  let response = null;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json"
      },
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Ozon entrypoint request timeout after ${OZON_ENTRYPOINT_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ozon entrypoint request failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Ozon entrypoint returned invalid payload.");
  }
  return payload;
}

async function fetchCloudFollowEntrypointBundle(productId) {
  const normalizedProductId = Number(productId);
  if (!Number.isFinite(normalizedProductId)) {
    throw new Error("Invalid product id for entrypoint bundle.");
  }
  const paths = buildCloudFollowEntrypointPaths(normalizedProductId);
  const payloads = [];
  for (const path of paths) {
    payloads.push(await fetchCloudFollowEntrypointPayload(path));
  }
  return {
    product_id: normalizedProductId,
    source_url: `https://www.ozon.ru/product/${normalizedProductId}/`,
    payloads
  };
}

function collectCloudFollowVariantIds(value, result, limit = 200, depth = 0) {
  if (result.size >= limit || depth > 32 || value == null) {
    return;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 100000) {
      result.add(Math.trunc(value));
    }
    return;
  }

  if (typeof value === "string") {
    const text = String(value);
    const linkMatches = text.match(/\/product\/(\d{6,})\//g) || [];
    for (const item of linkMatches) {
      const idMatch = item.match(/(\d{6,})/);
      if (idMatch) {
        result.add(Number(idMatch[1]));
      }
      if (result.size >= limit) {
        break;
      }
    }
    if (result.size < limit) {
      const rawIdMatch = text.match(/\b(\d{7,})\b/g) || [];
      for (const item of rawIdMatch) {
        const parsed = Number(item);
        if (Number.isFinite(parsed) && parsed >= 100000) {
          result.add(parsed);
        }
        if (result.size >= limit) {
          break;
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCloudFollowVariantIds(item, result, limit, depth + 1);
      if (result.size >= limit) {
        break;
      }
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (result.size >= limit) {
        break;
      }
      if (item != null && (lowerKey === "productid" || lowerKey === "sku")) {
        const parsed = Number(item);
        if (Number.isFinite(parsed) && parsed >= 100000) {
          result.add(Math.trunc(parsed));
        }
      }
      collectCloudFollowVariantIds(item, result, limit, depth + 1);
    }
  }
}

function extractCloudFollowVariantIdsFromPayload(payloads, baseProductId, maxVariants) {
  const candidates = new Set();
  collectCloudFollowVariantIds(payloads, candidates, Math.max(20, maxVariants * 8), 0);
  const result = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate) || Number(candidate) === Number(baseProductId)) {
      continue;
    }
    result.push(Number(candidate));
    if (result.length >= Math.max(0, maxVariants - 1)) {
      break;
    }
  }
  return result;
}

async function buildCloudFollowEntrypointBundles(task) {
  const baseProductId = resolveCloudFollowCollectProductId(task);
  if (!baseProductId) {
    throw new Error("Cannot resolve Ozon product id from collect task.");
  }
  const maxVariants = Math.max(1, Math.min(100, Number(task?.max_variants || 20)));
  const includeVariants = Boolean(task?.include_variants);
  const bundles = [];
  const baseBundle = await fetchCloudFollowEntrypointBundle(baseProductId);
  bundles.push(baseBundle);

  if (!includeVariants) {
    return bundles;
  }

  const variantIds = extractCloudFollowVariantIdsFromPayload(
    baseBundle.payloads || [],
    baseProductId,
    maxVariants
  );
  for (const variantId of variantIds) {
    try {
      bundles.push(await fetchCloudFollowEntrypointBundle(variantId));
    } catch (error) {
      console.warn(
        "[ozon-weight-extension] cloud follow variant fetch failed",
        variantId,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return bundles;
}

async function fetchCloudFollowProductDataViaTab(task) {
  const productId = resolveCloudFollowCollectProductId(task);
  if (!productId) {
    throw new Error("Cannot resolve Ozon product id from collect task.");
  }

  const includeVariants = Boolean(task?.include_variants);
  const maxVariants = Math.max(1, Math.min(100, Number(task?.max_variants || 20)));
  const productUrl = resolveCloudFollowCollectProductUrl(task, productId);
  const requestPayload = {
    type: "fetch-ozon-product-data",
    productId,
    productUrl,
    includeVariants,
    maxVariants
  };

  let lastError = null;
  const tabs = await chrome.tabs.query({});
  const buyerTabs = tabs.filter((tab) => tab.id && isOzonBuyerTabUrl(tab.url || ""));

  for (const tab of buyerTabs) {
    try {
      const response = await sendMessageToTab(tab.id, requestPayload);
      if (response?.ok && response?.productData) {
        return response;
      }
      lastError = response?.error || "Ozon content script returned empty payload.";
    } catch (error) {
      lastError = String(error);
    }
  }

  try {
    const bridgeTab = await ensureOzonBuyerBridgeTab(productUrl);
    const response = await sendMessageToTab(bridgeTab.id, requestPayload);
    if (response?.ok && response?.productData) {
      return response;
    }
    lastError = response?.error || lastError;
  } catch (error) {
    lastError = String(error);
  }

  throw new Error(lastError || "Ozon product fetch failed: no buyer tab available.");
}

async function markCloudFollowCollectTaskResult(taskId, result) {
  return fetchHdJsonSafe(`/api/v1/extension/cloud-follow/tasks/${taskId}/result`, {
    method: "POST",
    body: JSON.stringify(result)
  });
}

async function processCloudFollowCollectTask(task) {
  try {
    const bundles = await buildCloudFollowEntrypointBundles(task);
    await markCloudFollowCollectTaskResult(task.id, {
      ok: true,
      entrypoint_bundle: bundles[0] || null,
      entrypoint_bundle_list: bundles
    });
    return;
  } catch (error) {
    if (isCloudFollowEntrypointBlockedError(error)) {
      try {
        const response = await fetchCloudFollowProductDataViaTab(task);
        const productData =
          response?.productData && typeof response.productData === "object" ? response.productData : null;
        const productDataList = Array.isArray(response?.productDataList)
          ? response.productDataList.filter((item) => item && typeof item === "object")
          : productData
            ? [productData]
            : [];
        if (!productData && !productDataList.length) {
          throw new Error("Ozon content script returned empty product payload.");
        }

        await markCloudFollowCollectTaskResult(task.id, {
          ok: true,
          product_data: productData || productDataList[0] || null,
          product_data_list: productDataList
        });
        return;
      } catch (fallbackError) {
        const entrypointMessage = error instanceof Error ? error.message : String(error);
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        await markCloudFollowCollectTaskResult(task.id, {
          ok: false,
          error: `${entrypointMessage}; tab fallback failed: ${fallbackMessage}`
        }).catch(() => null);
        return;
      }
    }

    await markCloudFollowCollectTaskResult(task.id, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => null);
  }
}

async function pollCloudFollowCollectTasks() {
  if (cloudFollowCollectInFlight) {
    return;
  }
  cloudFollowCollectInFlight = true;
  try {
    const session = await getHdSession(false);
    if (!session) {
      return;
    }
    const deviceId = await getCloudFollowDeviceId();
    const { data } = await fetchHdJsonSafe("/api/v1/extension/cloud-follow/tasks/claim", {
      method: "POST",
      body: JSON.stringify({ limit: CLOUD_FOLLOW_COLLECT_BATCH_LIMIT, device_id: deviceId })
    });
    const tasks = Array.isArray(data?.result) ? data.result : [];
    if (tasks.length) {
      const queue = tasks.slice();
      const workerCount = Math.max(1, Math.min(CLOUD_FOLLOW_COLLECT_CONCURRENCY, queue.length));
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (queue.length) {
            const task = queue.shift();
            if (!task) {
              continue;
            }
            await processCloudFollowCollectTask(task);
          }
        })
      );
    }
    if (tasks.length >= CLOUD_FOLLOW_COLLECT_BATCH_LIMIT) {
      setTimeout(() => {
        void pollCloudFollowCollectTasks();
      }, CLOUD_FOLLOW_COLLECT_DRAIN_DELAY_MS);
    }
  } catch (error) {
    if (error?.code !== "cloud_auth_required") {
      console.warn(
        "[ozon-weight-extension] cloud follow collect poll failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  } finally {
    cloudFollowCollectInFlight = false;
  }
}

function ensureCloudFollowCollectAlarm() {
  chrome.alarms.create(CLOUD_FOLLOW_COLLECT_ALARM, {
    when: Date.now() + 5000,
    periodInMinutes: CLOUD_FOLLOW_COLLECT_INTERVAL_MINUTES
  });
}

async function fetchHdJson(pathname, options = {}, preferredOrigin = null) {
  const hdApiKey = await getHdApiKey();
  if (!hdApiKey) {
    throw cloudAuthError();
  }

  const origins = preferredOrigin
    ? [preferredOrigin, ...HD_API_ORIGINS.filter((origin) => origin !== preferredOrigin)]
    : HD_API_ORIGINS.slice();
  let lastError = null;

  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}${pathname}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(hdApiKey ? { Authorization: `Bearer ${hdApiKey}` } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      const data = parseResponseText(text);
      if (response.status === 401 || response.status === 403) {
        await clearHdSession();
        const detail = String(data?.detail || data?.error || "").trim();
        throw cloudAuthError(
          detail && !/authentication required/i.test(detail)
            ? detail
            : "云端登录已失效，请重新登录 SaaS 后台。"
        );
      }
      if (!response.ok) {
        throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
      }
      return { origin, data };
    } catch (error) {
      if (error?.code === "cloud_auth_required") {
        throw error;
      }
      lastError = error;
    }
  }

  throw new Error(
    `欧卖通请求失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function submitJobResultToHd(tabId, job, result) {
  const existingHdUpload = getExistingHdUpload(job);
  if (isActiveHdUploadSnapshot(existingHdUpload)) {
    return patchJob(tabId, {
      status: "running",
      stage: mapHdProductStage(existingHdUpload),
      hdUpload: existingHdUpload,
      result: buildJobResultWithHdUpload(job, existingHdUpload),
      error: null,
      logs: appendLog(job, `hd-job-reused:${existingHdUpload.jobId || existingHdUpload.productId || "unknown"}`)
    });
  }

  const customUpload = job?.customUpload || {};
  const uploadPrice =
    normalizeHdPriceInput(customUpload.followPrice) || normalizeHdPriceInput(resolveUploadPrice(result));
  if (!uploadPrice) {
    throw new Error("Cannot find buyer-side price for cloud upload.");
  }

  const payload = {
    scrapedJson: result,
    price: uploadPrice,
    old_price: normalizeHdPriceInput(customUpload.oldPrice) || normalizeHdPriceInput(resolveOldPrice(result)),
    follow_min_price: normalizeHdPriceInput(customUpload.minPrice),
    model: normalizeModelInput(customUpload.model),
    store_id: customUpload.storeId || null
  };

  const { origin, data } = await fetchHdJsonSafe("/api/v1/extension/one-click-upload", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const current = (await getJob(tabId)) || job;
  const hdUpload = buildHdUploadSnapshot(current.hdUpload, {
    origin,
    productId: data.product_id || null,
    jobId: data.job_id || null,
    status: data.status || "queued",
    price: data.price || uploadPrice,
    storeId: data.store_id || null,
    lastCheckedAt: null
  });

  return patchJob(tabId, {
    status: "running",
    stage: mapHdProductStage(data),
    hdUpload,
    result: buildJobResultWithHdUpload(current, hdUpload),
    error: null,
    logs: appendLog(current, `hd-job-created:${data.job_id || "unknown"}`)
  });
}

async function createDirectHdUpload(result, customUpload = {}) {
  const uploadPrice =
    normalizeHdPriceInput(customUpload.followPrice) || normalizeHdPriceInput(resolveUploadPrice(result));
  if (!uploadPrice) {
    throw new Error("Cannot find buyer-side price for cloud upload.");
  }

  const payload = {
    scrapedJson: result,
    price: uploadPrice,
    old_price: normalizeHdPriceInput(customUpload.oldPrice) || normalizeHdPriceInput(resolveOldPrice(result)),
    follow_min_price: normalizeHdPriceInput(customUpload.minPrice),
    model: normalizeModelInput(customUpload.model),
    store_id: customUpload.storeId || null
  };

  const { origin, data } = await fetchHdJsonSafe("/api/v1/extension/one-click-upload", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  return buildHdUploadSnapshot(null, {
    origin,
    productId: data.product_id || null,
    jobId: data.job_id || null,
    status: data.status || "queued",
    price: data.price || uploadPrice,
    storeId: data.store_id || null,
    lastCheckedAt: null
  });
}

async function refreshDirectHdUploadStatus(hdUpload) {
  if (!hdUpload?.productId) {
    return hdUpload;
  }

  const { origin, data } = await fetchHdJsonSafe(
    `/api/v1/extension/products/${hdUpload.productId}/status?job_id=${encodeURIComponent(
      hdUpload.jobId || ""
    )}`,
    { method: "GET", headers: { accept: "application/json" } },
    hdUpload.origin || null
  );

  return buildHdUploadSnapshot(hdUpload, {
    origin,
    productId: data.product_id || hdUpload.productId,
    jobId: data.job_id || hdUpload.jobId,
    status: data.status || hdUpload.status,
    jobStatus: data.job_status || null,
    ozonTaskId: data.ozon_task_id || null,
    ozonStatus: data.ozon_status || null,
    error: data.errors?.error || data.job_error || null,
    lastCheckedAt: nowIso()
  });
}

async function waitForDirectHdUploadCompletion(initialHdUpload, timeoutMs = 300000) {
  let hdUpload = initialHdUpload;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    hdUpload = await refreshDirectHdUploadStatus(hdUpload);

    if (hdUpload?.status === "uploaded") {
      return hdUpload;
    }

    if (hdUpload?.status === "failed" || hdUpload?.jobStatus === "failed") {
      throw new Error(hdUpload.error || "Cloud upload failed.");
    }

    await delay(1000);
  }

  throw new Error("Timed out waiting for cloud upload completion.");
}

async function maybeRefreshHdUploadStatus(tabId, job, force = false) {
  if (!job || job.jobType !== "upload-product" || job.status !== "running" || !job.hdUpload?.productId) {
    return job;
  }

  const lastCheckedAt = new Date(job.hdUpload.lastCheckedAt || 0).getTime();
  if (!force && Number.isFinite(lastCheckedAt) && Date.now() - lastCheckedAt < HD_STATUS_REFRESH_MS) {
    return job;
  }

  try {
    const { origin, data } = await fetchHdJsonSafe(
      `/api/v1/extension/products/${job.hdUpload.productId}/status?job_id=${encodeURIComponent(
        job.hdUpload.jobId || ""
      )}`,
      { method: "GET", headers: { accept: "application/json" } },
      job.hdUpload.origin || null
    );

    const hdUpload = buildHdUploadSnapshot(job.hdUpload, {
      origin,
      productId: data.product_id || job.hdUpload.productId,
      jobId: data.job_id || job.hdUpload.jobId,
      status: data.status || job.hdUpload.status,
      jobStatus: data.job_status || null,
      ozonTaskId: data.ozon_task_id || null,
      ozonStatus: data.ozon_status || null,
      error: data.errors?.error || data.job_error || null,
      lastCheckedAt: nowIso()
    });

    if (data.status === "failed" || data.job_status === "failed") {
      return patchJob(tabId, {
        status: "error",
        stage: "error",
        hdUpload,
        result: buildJobResultWithHdUpload(job, hdUpload),
        error: hdUpload.error || "Cloud upload failed.",
        logs: appendLog(job, "hd-status-failed")
      });
    }

    if (data.status === "uploaded") {
      return patchJob(tabId, {
        status: "done",
        stage: "uploaded",
        hdUpload,
        result: buildJobResultWithHdUpload(job, hdUpload),
        error: null,
        logs: appendLog(job, "hd-status-uploaded")
      });
    }

    return patchJob(tabId, {
      status: "running",
      stage: mapHdProductStage(data),
      hdUpload,
      result: buildJobResultWithHdUpload(job, hdUpload),
      error: null,
      logs: appendLog(job, `hd-status:${data.status || "pending"}`)
    });
  } catch (error) {
    return patchJob(tabId, {
      hdUpload: buildHdUploadSnapshot(job.hdUpload, {
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: nowIso()
      }),
      result: buildJobResultWithHdUpload(job, buildHdUploadSnapshot(job.hdUpload, {
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: nowIso()
      })),
      logs: appendLog(job, `hd-status-refresh-failed:${error instanceof Error ? error.message : String(error)}`)
    });
  }
}

async function sendRunJob(tabId) {
  const job = await getJob(tabId);
  if (!job || job.status !== "running") {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "run-job", job });
  } catch (error) {
    const initialError = String(error);
    const retriedJob = await patchJob(tabId, {
      logs: appendLog(job, `send-message-failed: ${initialError}`)
    });

    if (!/Receiving end does not exist/i.test(initialError)) {
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });

      const injectedJob = await patchJob(tabId, {
        logs: appendLog(retriedJob, "content-script-injected")
      });

      await chrome.tabs.sendMessage(tabId, { type: "run-job", job: injectedJob });
    } catch (retryError) {
      await patchJob(tabId, {
        logs: appendLog(retriedJob, `inject-or-retry-failed: ${String(retryError)}`)
      });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "start-job") {
      const tabId = message.tabId || sender.tab?.id;
      const url = message.url || sender.tab?.url;
      if (!tabId || !url) {
        sendResponse({ ok: false, error: "No active tab context for start-job." });
        return;
      }

      const job = {
        tabId,
        startUrl: url,
        productId: extractProductId(url),
        jobType: message.jobType || "weight",
        status: "running",
        stage: "product",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        logs: [{ at: nowIso(), message: "job-created" }],
        result: null,
        error: null,
        customUpload: {
          storeId: message.customUpload?.storeId || null,
          followPrice: normalizeHdPriceInput(message.customUpload?.followPrice),
          minPrice: normalizeHdPriceInput(message.customUpload?.minPrice),
          oldPrice: normalizeHdPriceInput(message.customUpload?.oldPrice),
          model: normalizeModelInput(message.customUpload?.model)
        }
      };

      await setJob(tabId, job);
      if (!message.deferRun) {
        await sendRunJob(tabId);
      }
      sendResponse({ ok: true, job });
      return;
    }

    if (message.type === "upload-scraped-product") {
      if (!message.scrapedJson) {
        sendResponse({ ok: false, error: "Missing scrapedJson for direct upload." });
        return;
      }

      try {
        const initialHdUpload = await createDirectHdUpload(message.scrapedJson, {
          storeId: message.storeId || null,
          followPrice: message.followPrice,
          minPrice: message.minPrice,
          oldPrice: message.oldPrice,
          model: message.model
        });
        let hdUpload = initialHdUpload;
        let warning = null;

        try {
          hdUpload = await waitForDirectHdUploadCompletion(initialHdUpload, 45000);
        } catch (waitError) {
          warning = waitError instanceof Error ? waitError.message : String(waitError);

          try {
            hdUpload = await refreshDirectHdUploadStatus(initialHdUpload);
          } catch (_) {
            hdUpload = buildHdUploadSnapshot(initialHdUpload, {
              lastCheckedAt: nowIso()
            });
          }

          const statusText = String(hdUpload?.status || "").toLowerCase();
          const jobStatusText = String(hdUpload?.jobStatus || "").toLowerCase();
          if (statusText === "failed" || jobStatusText === "failed") {
            throw new Error(hdUpload?.error || warning || "Cloud upload failed.");
          }

          hdUpload = buildHdUploadSnapshot(hdUpload, {
            warning,
            lastCheckedAt: nowIso()
          });
        }

        const isPending = String(hdUpload?.status || "").toLowerCase() !== "uploaded";
        sendResponse({
          ok: true,
          status: hdUpload.status,
          pending: isPending,
          warning,
          hdUpload
        });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "get-hd-session") {
      const session = await getHdSession(Boolean(message.force));
      if (session) {
        sendResponse({ ok: true, session });
      } else {
        sendResponse({
          ok: false,
          code: "cloud_auth_required",
          error: "请先登录 SaaS 后台，再回到 Ozon 页面刷新店铺。",
          loginUrl: buildCloudLoginUrl()
        });
      }
      return;
    }

    if (message.type === "connect-hd-account") {
      const session = await getHdSession(false);
      if (session) {
        sendResponse({ ok: true, session });
        return;
      }

      const loginUrl = await openCloudLoginTab();
      sendResponse({
        ok: false,
        code: "cloud_auth_required",
        error: "已打开云端登录页。登录完成后回到 Ozon 页面点击“刷新店铺”。",
        loginUrl
      });
      return;
    }

    if (message.type === "clear-hd-account") {
      await clearHdSession();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "get-hd-stores") {
      try {
        const session = await getHdSession(false);
        if (!session) {
          sendResponse({
            ok: false,
            code: "cloud_auth_required",
            error: "请先登录 SaaS 后台，再回到 Ozon 页面刷新店铺。",
            loginUrl: buildCloudLoginUrl()
          });
          return;
        }

        const { data } = await fetchHdJsonSafe("/api/v1/stores", {
          method: "GET",
          headers: { accept: "application/json" }
        });
        sendResponse({ ok: true, stores: Array.isArray(data) ? data : [], session });
      } catch (error) {
        sendResponse({
          ok: false,
          code: error?.code || "cloud_request_failed",
          error: error instanceof Error ? error.message : String(error),
          loginUrl: buildCloudLoginUrl()
        });
      }
      return;
    }

    if (message.type === "page-ready") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }

      let job = await getJob(tabId);
      job = await maybeRefreshHdUploadStatus(tabId, job);
      sendResponse({ ok: true, job });
      return;
    }

    if (message.type === "job-update") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }

      const current = await getJob(tabId);
      const next = await patchJob(tabId, {
        ...message.patch,
        logs: appendLog(current || {}, message.note || "job-updated")
      });
      sendResponse({ ok: true, job: next });
      return;
    }

    if (message.type === "job-result") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }

      const current = await getJob(tabId);
      let next = await patchJob(tabId, {
        status: current?.jobType === "upload-product" ? "running" : "done",
        stage: current?.jobType === "upload-product" ? "submit_cloud" : "done",
        result: message.result,
        error: null,
        logs: appendLog(current || {}, "job-completed")
      });

      if (current?.jobType === "upload-product") {
        try {
          next = await submitJobResultToHd(tabId, next, message.result);
          next = await maybeRefreshHdUploadStatus(tabId, next, true);
        } catch (uploadError) {
          next = await patchJob(tabId, {
            status: "error",
            stage: "error",
            error: uploadError instanceof Error ? uploadError.message : String(uploadError),
            logs: appendLog(next, `hd-submit-failed:${uploadError instanceof Error ? uploadError.message : String(uploadError)}`)
          });
        }
      }

      sendResponse({ ok: true, job: next });
      return;
    }

    if (message.type === "job-error") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }

      const current = await getJob(tabId);
      const next = await patchJob(tabId, {
        status: "error",
        stage: "error",
        error: message.error,
        logs: appendLog(current || {}, `job-error: ${message.error}`)
      });
      sendResponse({ ok: true, job: next });
      return;
    }

    if (message.type === "get-job") {
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "No tab context for get-job." });
        return;
      }

      let job = await getJob(tabId);
      job = await maybeRefreshHdUploadStatus(tabId, job);
      sendResponse({ ok: true, job });
      return;
    }

    if (message.type === "clear-job") {
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "No tab context for clear-job." });
        return;
      }

      await removeJob(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "upsert-seller-analytics") {
      const count = await upsertSellerAnalytics(message.items || []);
      sendResponse({ ok: true, count });
      return;
    }

    if (message.type === "set-seller-context") {
      const context = await setSellerContext(message.context || {});
      sendResponse({ ok: !!context, context });
      return;
    }

    if (message.type === "get-seller-analytics") {
      const records = await getSellerAnalytics(message.productIds || [], {
        fetchMissing: !!message.fetchMissing
      });
      sendResponse({ ok: true, records });
      return;
    }

    if (message.type === "get-daily-analytics-summary") {
      const summary = await getDailyAnalyticsUploadSummary(message.maxRecords || 5000);
      sendResponse({ ok: true, summary });
      return;
    }

    if (message.type === "upload-daily-analytics") {
      try {
        const result = await uploadDailyAnalyticsSnapshot({
          storeId: message.storeId || null,
          maxRecords: message.maxRecords || 5000
        });
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({
          ok: false,
          code: error?.code || null,
          error: error instanceof Error ? error.message : String(error),
          loginUrl: error?.code === "cloud_auth_required" ? buildCloudLoginUrl() : null
        });
      }
      return;
    }

    if (message.type === "get-hot-tags-upload-summary") {
      const summary = await getHotTagsUploadSummary();
      sendResponse({ ok: true, summary });
      return;
    }

    if (message.type === "upload-hot-tags") {
      try {
        const result = await uploadHotTagsSnapshot({
          maxRows: message.maxRows || HOT_TAGS_UPLOAD_DEFAULTS.maxRows,
          groupSampleLimit: message.groupSampleLimit || HOT_TAGS_UPLOAD_DEFAULTS.groupSampleLimit,
          batchSize: message.batchSize || HOT_TAGS_UPLOAD_DEFAULTS.batchSize
        });
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({
          ok: false,
          code: error?.code || null,
          error: error instanceof Error ? error.message : String(error),
          loginUrl: error?.code === "cloud_auth_required" ? buildCloudLoginUrl() : null
        });
      }
      return;
    }

    sendResponse({ ok: false, error: "unknown-message-type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeJob(tabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === CLOUD_FOLLOW_COLLECT_ALARM) {
    await pollCloudFollowCollectTasks();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await injectContentScriptIntoOpenTabs();
  ensureCloudFollowCollectAlarm();
  await pollCloudFollowCollectTasks();
});

chrome.runtime.onStartup.addListener(async () => {
  await injectContentScriptIntoOpenTabs();
  ensureCloudFollowCollectAlarm();
  await pollCloudFollowCollectTasks();
});

void (async () => {
  await injectContentScriptIntoOpenTabs();
  ensureCloudFollowCollectAlarm();
  await pollCloudFollowCollectTasks();
})();
