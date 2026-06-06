(() => {
if (globalThis.__ozonWeightMvpLoaded) {
  return;
}

globalThis.__ozonWeightMvpLoaded = true;

let activeRun = null;
let activeRunKey = null;
let sellerAnalyticsSyncTimer = null;
let sellerAnalyticsSyncObserver = null;
let buyerAnalyticsRefreshTimer = null;
let buyerAnalyticsRefreshObserver = null;
let buyerAnalyticsRecoveryTimer = null;
let productDashboardJobTimer = null;
let productDashboardTemplatePromise = null;
let operationBotModulePromise = null;
const cardSellerInfoCache = new Map();
const cardSellerInfoInflight = new Map();
const productOriginInfoCache = new Map();
const productOriginInfoInflight = new Map();
const productUploadInFlight = new Set();

const UNIT_FOLLOW_RE = "(?=\\s|$|[,.;:!?)}\\]])";
const KG_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:\\u043A\\u0433|kg)${UNIT_FOLLOW_RE}`, "i");
const GRAM_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:\\u0433\\u0440|\\u0433|g)${UNIT_FOLLOW_RE}`, "i");
const ITEM_RE = /(\d+)\s*\u0442\u043E\u0432\u0430\u0440/i;
const SELLER_ANALYTICS_STYLE_ID = "ozon-seller-analytics-style";
const SELLER_ANALYTICS_PANEL_CLASS = "ozon-seller-analytics-panel";
const PRODUCT_DASHBOARD_SLOT_ID = "ozon-seller-dashboard-slot";
const PRODUCT_DASHBOARD_SLOT_CLASS = "ozon-seller-dashboard-slot";
const PRODUCT_DASHBOARD_CLASS = "ozon-seller-dashboard";
const SELLER_ANALYTICS_METRICS = [
  { key: "brand", labels: ["品牌", "brand"] },
  { key: "category", labels: ["类目", "category"] },
  { key: "monthlyRevenue", labels: ["月销售额", "monthly revenue"] },
  { key: "monthlySales", labels: ["月销量", "monthly sales"] },
  { key: "dailyRevenue", labels: ["日销售额", "daily revenue"] },
  { key: "dailySales", labels: ["日销量", "daily sales"] },
  { key: "searchVolume", labels: ["搜索量", "search volume"] },
  { key: "searchConversion", labels: ["搜索转化率", "search conversion"] },
  { key: "campaigns", labels: ["促销活动", "campaigns"] },
  { key: "paidAds", labels: ["付费推广", "paid ads"] },
  { key: "clicks", labels: ["点击量", "clicks"] },
  { key: "cartConversion", labels: ["购物车转化率", "cart conversion"] },
  { key: "impressions", labels: ["展示总量", "impressions"] },
  { key: "impressionConversion", labels: ["展示转化率", "impression conversion"] },
  { key: "promoDiscount", labels: ["促销折扣", "promo discount"] },
  { key: "promoConversion", labels: ["促销贡献度", "促销转化率", "promo contribution", "promo conversion"] },
  { key: "adShare", labels: ["广告份额", "ad share"] },
  { key: "refundRate", labels: ["退货率", "refund rate"] },
  { key: "storeName", labels: ["卖家", "seller"] },
  { key: "volume", labels: ["体积", "volume"] },
  { key: "avgPrice", labels: ["平均价格", "average price"] },
  { key: "fulfillment", labels: ["配送方式", "fulfillment"] },
  { key: "weight", labels: ["重量", "weight"] },
  { key: "length", labels: ["长", "length"] },
  { key: "width", labels: ["宽", "width"] },
  { key: "height", labels: ["高", "height"] },
  { key: "listedAt", labels: ["商品上架", "listed at"] },
  { key: "updatedAtField", labels: ["数据更新", "updated at"] }
];
const SELLER_ANALYTICS_METRIC_ORDER = [
  "brand",
  "category",
  "monthlyRevenue",
  "monthlySales",
  "dailyRevenue",
  "dailySales",
  "searchVolume",
  "searchConversion",
  "clicks",
  "cartConversion",
  "impressions",
  "impressionConversion",
  "promoDiscount",
  "promoConversion",
  "refundRate",
  "avgPrice",
  "fulfillment",
  "weight",
  "length",
  "width",
  "height",
  "listedAt",
  "updatedAtField"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function splitNormalizedLines(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function normalizeValueText(text) {
  return normalizeText(normalizeText(String(text || "")).replace(/^[,;]+|[,;]+$/g, ""));
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values || []) {
    const normalized = normalizeText(String(value || ""));
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function absoluteUrl(url, base = location.href) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url, base).href;
  } catch (_error) {
    return url;
  }
}

function formatLocalDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return normalizeText(String(value));
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const JOB_STAGE_LABELS = {
  cloud_local_extract: "本地抓取",
  submit_cloud: "提交云端",
  queued: "云端排队",
  uploading: "云端上货",
  uploaded: "已完成",
  failed: "失败",
  error: "失败",
  cloud_pending: "云端排队",
  cloud_queued: "云端排队",
  cloud_draft: "云端建草稿",
  cloud_cleaning: "云端清洗",
  cloud_ready: "云端待提交",
  cloud_uploading: "云端上货",
  extract_product_data: "本地抓取",
  wait_characteristics_section: "等待商品参数",
  characteristics_features_fallback: "补抓商品参数",
  extract_request_failed_dom_fallback: "回退抓取包装重量",
  checkout_dom: "读取结算页",
  cart_dom: "读取购物车",
  cart_click_checkout: "跳转结算页",
  cart_navigate_checkout: "打开结算页"
};

function formatJobStage(stage) {
  const normalizedKey = normalizeText(stage).replace(/-/g, "_");
  return JOB_STAGE_LABELS[normalizedKey] || normalizeText(String(stage || "").replace(/[_-]+/g, " "));
}

function buildMetricMap(record) {
  const map = new Map();

  for (const metric of record?.metrics || []) {
    if (metric?.key) {
      map.set(metric.key, normalizeText(metric.value || ""));
    }

    const labelKey = normalizeMetricLabel(metric?.label || "");
    if (labelKey) {
      map.set(labelKey, normalizeText(metric.value || ""));
    }
  }

  return map;
}

function getMetricValue(metricMap, keys, fallback = "-") {
  const list = Array.isArray(keys) ? keys : [keys];

  for (const key of list) {
    const value = normalizeText(metricMap.get(key) || "");
    if (value) {
      return value;
    }
  }

  return fallback;
}

function formatCompactRubMetric(value) {
  const text = normalizeText(String(value || ""));
  if (!text || text === "-") {
    return "-";
  }

  const numericText = text.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const numericValue = Number(numericText);
  if (!Number.isFinite(numericValue) || numericValue < 100000) {
    return text;
  }

  return `${(numericValue / 10000).toFixed(1)}w ₽`;
}

function parseMetricNumber(value) {
  const text = normalizeText(String(value || ""));
  if (!text || text === "-") {
    return null;
  }

  const normalized = text.replace(/\s+/g, "").replace(/,/g, ".").replace(/[^\d.-]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function formatMinPriceMetric(value) {
  const text = normalizeText(String(value || ""));
  if (!text || text === "-") {
    return "-";
  }

  const numericValue = parseMetricNumber(text);
  if (numericValue !== null && numericValue <= 1) {
    return "-";
  }

  return text;
}

function formatDayMetric(value) {
  const text = normalizeText(String(value || ""));
  if (!text || text === "-") {
    return "-";
  }

  return text.replace(/(-?\d+(?:[.,]\d+)?)\s*d\b/gi, "$1天");
}

function formatListedDuration(value) {
  const text = normalizeText(String(value || ""));
  if (!text || text === "-") {
    return "-";
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return formatDayMetric(text);
  }

  const diffMs = Date.now() - parsed.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return formatDayMetric(text);
  }

  return `${Math.max(1, Math.round(diffMs / 86400000))}天`;
}

function buildCardSparklineSvg(metricMap, productId) {
  const monthlySales = parseMetricNumber(getMetricValue(metricMap, "monthlySales"));
  if (!Number.isFinite(monthlySales) || monthlySales <= 0) {
    return "";
  }

  const values = [
    parseMetricNumber(getMetricValue(metricMap, "dailySales")),
    monthlySales,
    parseMetricNumber(getMetricValue(metricMap, "searchConversion")),
    parseMetricNumber(getMetricValue(metricMap, "cartConversion")),
    parseMetricNumber(getMetricValue(metricMap, "promoConversion")),
    parseMetricNumber(getMetricValue(metricMap, "promoDays")),
    parseMetricNumber(getMetricValue(metricMap, "adDays"))
  ].filter((value) => Number.isFinite(value) && value > 0);

  if (values.length < 4) {
    return "";
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 70;
  const height = 30;
  const step = width / (values.length - 1);
  const coordinates = values.map((value, index) => {
    const x = (index * step).toFixed(2);
    const y = (height - 4 - ((value - min) / range) * (height - 8)).toFixed(2);
    return { x, y };
  });
  const points = coordinates.map(({ x, y }) => `${x},${y}`).join(" ");
  const last = coordinates[coordinates.length - 1];

  return `
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
      <polyline points="${points}" fill="none" stroke="#f97316" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="${last.x}" cy="${last.y}" r="2.4" fill="#f97316"></circle>
    </svg>
  `;
}

function buildCardStatMarkup(label, value, tone = "") {
  const displayValue = formatDayMetric(value || "-");

  return `
    <div class="${PRODUCT_DASHBOARD_CLASS}__card-stat">
      <div class="${PRODUCT_DASHBOARD_CLASS}__card-stat-label">${escapeHtml(label)}</div>
      <div class="${PRODUCT_DASHBOARD_CLASS}__card-stat-value${tone ? ` ${PRODUCT_DASHBOARD_CLASS}__card-stat-value--${tone}` : ""}">${escapeHtml(
        displayValue
      )}</div>
    </div>
  `;
}

function extractVisibleProductRating(root = document) {
  const text =
    root.querySelector?.('[data-widget="webReviewProductScore"]')?.innerText ||
    root.querySelector?.('[data-widget="webProductHeading"]')?.innerText ||
    root.innerText ||
    "";
  const normalized = normalizeText(text);
  if (!normalized) {
    return {
      score: null,
      reviewCount: null
    };
  }

  const scoreMatch = normalized.match(/\b(\d+(?:[.,]\d+)?)\b/);
  const reviewMatch =
    normalized.match(/(\d[\d\s\u00a0]*)\s*(?:review|reviews|отзыв(?:а|ов)?|评论|评价)/i) || null;

  return {
    score: scoreMatch ? scoreMatch[1].replace(",", ".") : null,
    reviewCount: reviewMatch ? normalizeText(reviewMatch[0]) : null
  };
}

function getDefaultProductDashboardTemplate() {
  return {
    title: "电商商品数据看板",
    sections: {
      sales: "销售表现",
      funnel: "流量与转化",
      logistics: "物流与价格",
      campaign: "营销活动"
    },
    buttons: {
      source: "1688 货源",
      follow: "强制跟卖",
      collect: "采集数据"
    }
  };
}

async function loadProductDashboardTemplate() {
  if (productDashboardTemplatePromise) {
    return productDashboardTemplatePromise;
  }

  productDashboardTemplatePromise = fetch(chrome.runtime.getURL("ui.json"))
    .then((response) => {
      if (!response.ok) {
        throw new Error(`ui-template-${response.status}`);
      }
      return response.text();
    })
    .then((html) => {
      const defaults = getDefaultProductDashboardTemplate();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const headings = [...doc.querySelectorAll("h3")]
        .map((element) => normalizeText(element.textContent || ""))
        .filter(Boolean);
      const buttons = [...doc.querySelectorAll("button")]
        .map((element) => normalizeText(element.textContent || ""))
        .filter(Boolean);

      return {
        title: normalizeText(doc.title || "") || defaults.title,
        sections: {
          sales: headings[0] || defaults.sections.sales,
          funnel: headings[1] || defaults.sections.funnel,
          logistics: headings[2] || defaults.sections.logistics,
          campaign: headings[3] || defaults.sections.campaign
        },
        buttons: {
          source: buttons[0] || defaults.buttons.source,
          follow: buttons[1] || defaults.buttons.follow,
          collect: buttons[2] || defaults.buttons.collect
        }
      };
    })
    .catch(() => getDefaultProductDashboardTemplate());

  return productDashboardTemplatePromise;
}

function isProductPage(url = location.href) {
  return /:\/\/(?:www\.)?ozon\.ru\/product\//i.test(url);
}

function isCheckoutPage(url = location.href) {
  return /:\/\/(?:www\.)?ozon\.ru\/gocheckout(?:[/?#]|$)/i.test(url);
}

function isCartPage(url = location.href) {
  return /:\/\/(?:www\.)?ozon\.ru\/cart(?:[/?#]|$)/i.test(url);
}

function isSellerPage(url = location.href) {
  return /:\/\/seller\.ozon\.ru\//i.test(url);
}

async function waitForCondition(test, timeoutMs = 10000, stepMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = test();
    if (value) {
      return value;
    }
    await sleep(stepMs);
  }
  return null;
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function updateJob(patch, note) {
  await sendMessage({ type: "job-update", patch, note });
}

async function failJob(error) {
  await sendMessage({
    type: "job-error",
    error: error instanceof Error ? error.message : String(error)
  });
}

function extractProductTitle(root = document) {
  return normalizeText(root.querySelector("h1")?.innerText || root.querySelector("h1")?.textContent || "");
}

function extractProductIdFromUrl(url = location.href) {
  const match = String(url || "").match(/-([0-9]{6,})(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

function showOverlay(message, color = "#1a73e8") {
  const existing = document.getElementById("ozon-weight-mvp-overlay");
  if (existing) {
    existing.remove();
  }

  const box = document.createElement("div");
  box.id = "ozon-weight-mvp-overlay";
  box.textContent = message;
  box.style.position = "fixed";
  box.style.right = "16px";
  box.style.bottom = "16px";
  box.style.zIndex = "2147483647";
  box.style.maxWidth = "360px";
  box.style.padding = "12px 14px";
  box.style.borderRadius = "10px";
  box.style.background = color;
  box.style.color = "#fff";
  box.style.font = "14px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  box.style.boxShadow = "0 8px 24px rgba(0,0,0,0.22)";
  document.body.appendChild(box);
}

function parseStateElementFromRoot(root, prefix) {
  const element = root.querySelector(`[id^="${prefix}"]`);
  if (!element) {
    return null;
  }

  const raw = element.getAttribute("data-state");
  if (!raw) {
    return null;
  }

  try {
    return {
      id: element.id,
      state: JSON.parse(raw)
    };
  } catch (_error) {
    return null;
  }
}

function extractTextRs(textRs) {
  return normalizeText((textRs || []).map((item) => item?.content || "").join(" "));
}

function extractRichNode(section) {
  const candidates = [section, ...section.querySelectorAll("div, span, p")];
  const scored = candidates
    .map((node) => {
      const text = normalizeMultilineText(node.innerText || node.textContent || "");
      const html = String(node.innerHTML || "");
      return {
        node,
        text,
        html,
        hasBreaks: /<br/i.test(html),
        descendantCount: node.querySelectorAll("*").length
      };
    })
    .filter((item) => item.text.length >= 80);

  const richCandidates = scored.filter((item) => item.hasBreaks);
  if (richCandidates.length) {
    richCandidates.sort((left, right) => {
      if (left.descendantCount !== right.descendantCount) {
        return left.descendantCount - right.descendantCount;
      }
      return right.text.length - left.text.length;
    });
    return richCandidates[0].node;
  }

  scored.sort((left, right) => right.text.length - left.text.length);
  return scored[0]?.node || section;
}

function extractMediaFromNode(root) {
  const images = [];
  const videos = [];

  for (const img of root.querySelectorAll("img")) {
    const src = absoluteUrl(img.currentSrc || img.src || "");
    if (!src || images.some((item) => item.src === src)) {
      continue;
    }

    images.push({
      src,
      alt: normalizeText(img.alt || ""),
      title: normalizeText(img.title || "")
    });
  }

  for (const video of root.querySelectorAll("video")) {
    const source = video.currentSrc || video.src || video.querySelector("source")?.src || "";
    const src = absoluteUrl(source);
    if (!src || videos.some((item) => item.src === src)) {
      continue;
    }

    videos.push({
      src,
      poster: absoluteUrl(video.poster || "")
    });
  }

  return { images, videos };
}

function mergeMediaLists(mediaItems) {
  const images = [];
  const videos = [];
  const seenImage = new Set();
  const seenVideo = new Set();

  for (const item of mediaItems || []) {
    for (const image of item?.images || []) {
      const src = normalizeText(image?.src || "");
      if (!src || seenImage.has(src)) {
        continue;
      }
      seenImage.add(src);
      images.push(image);
    }
    for (const video of item?.videos || []) {
      const src = normalizeText(video?.src || "");
      if (!src || seenVideo.has(src)) {
        continue;
      }
      seenVideo.add(src);
      videos.push(video);
    }
  }

  return { images, videos };
}

function extractDescriptionFromWidgets(root = document) {
  const widgets = [...(root.querySelectorAll?.('[data-widget="webDescription"]') || [])];
  if (!widgets.length) {
    return null;
  }

  const parts = [];
  const mediaItems = [];
  for (const widget of widgets) {
    const heading = normalizeText(widget.querySelector("h2,h3")?.innerText || widget.querySelector("h2,h3")?.textContent || "");
    const richNode = extractRichNode(widget);
    const text = normalizeMultilineText(richNode.innerText || richNode.textContent || "");
    const html = String(richNode.innerHTML || "").trim();
    if (!text) {
      continue;
    }
    parts.push({
      heading,
      text,
      html
    });
    mediaItems.push(extractMediaFromNode(widget));
  }

  if (!parts.length) {
    return null;
  }

  const title = parts[0].heading || "Description";
  const text = parts
    .map((item) => {
      if (!item.heading) {
        return item.text;
      }
      return item.text.startsWith(item.heading) ? item.text : `${item.heading}\n${item.text}`;
    })
    .join("\n\n");
  const html = parts
    .map((item) => (item.heading && !item.html.includes(item.heading) ? `<h3>${item.heading}</h3>${item.html}` : item.html))
    .join("\n");
  const mergedMedia = mergeMediaLists(mediaItems);

  return {
    title,
    html,
    text,
    rawSectionHtml: widgets.map((widget) => String(widget.innerHTML || "").trim()).join("\n\n"),
    images: mergedMedia.images,
    videos: mergedMedia.videos
  };
}

function readJsonLdObjects(root = document) {
  const objects = [];
  const scripts = [...(root.querySelectorAll?.('script[type="application/ld+json"]') || [])];
  for (const script of scripts) {
    const raw = script.textContent || script.innerText || "";
    if (!raw.trim()) {
      continue;
    }
    try {
      objects.push(JSON.parse(raw));
    } catch (_error) {
      // Skip malformed JSON-LD blobs.
    }
  }
  return objects;
}

function collectJsonLdDescriptions(node, bucket) {
  if (!node) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonLdDescriptions(item, bucket);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }

  const description = normalizeMultilineText(node.description || "");
  if (description.length >= 20 && !bucket.includes(description)) {
    bucket.push(description);
  }
  if (node["@graph"]) {
    collectJsonLdDescriptions(node["@graph"], bucket);
  }
}

function extractDescriptionFromJsonLd(root = document) {
  const descriptions = [];
  for (const object of readJsonLdObjects(root)) {
    collectJsonLdDescriptions(object, descriptions);
  }
  if (!descriptions.length) {
    return null;
  }
  return {
    title: "Description",
    html: "",
    text: descriptions.join("\n\n"),
    rawSectionHtml: "",
    images: [],
    videos: []
  };
}

function extractDescriptionFromShortCharacteristics(shortCharacteristics, title = "") {
  const rows = (shortCharacteristics || [])
    .map((item) => {
      const name = normalizeText(item?.name || "");
      const values = (item?.values || []).map((value) => normalizeText(value)).filter(Boolean);
      if (!name || !values.length) {
        return "";
      }
      return `${name}: ${values.join(", ")}`;
    })
    .filter(Boolean)
    .slice(0, 14);
  if (!rows.length) {
    return null;
  }
  const heading = normalizeText(title || "Description");
  return {
    title: heading || "Description",
    html: "",
    text: `${heading}\n${rows.join("; ")}`.trim(),
    rawSectionHtml: "",
    images: [],
    videos: []
  };
}

function extractDescriptionData(root = document) {
  const section = root.getElementById?.("section-description") || root.querySelector?.("#section-description");
  if (section) {
    const richNode = extractRichNode(section);
    const media = extractMediaFromNode(section);
    const text = normalizeMultilineText(richNode.innerText || richNode.textContent || "");
    if (text.length >= 20) {
      return {
        title: normalizeText(section.querySelector("h2")?.innerText || section.querySelector("h2")?.textContent || "Description"),
        html: String(richNode.innerHTML || "").trim(),
        text,
        rawSectionHtml: String(section.innerHTML || "").trim(),
        images: media.images,
        videos: media.videos
      };
    }
  }

  return extractDescriptionFromWidgets(root) || extractDescriptionFromJsonLd(root) || null;
}

function extractHashtags(descriptionText = "", root = document) {
  const titleTags = [...root.querySelectorAll("[title]")]
    .map((element) => normalizeText(element.getAttribute("title") || ""))
    .filter((value) => /^#[^\s]+$/.test(value));

  const inlineTags = descriptionText.match(/#[^\s#]+/g) || [];
  return uniqueStrings([...titleTags, ...inlineTags]);
}

function getCharacteristicsSectionElement(root = document) {
  return (
    root.querySelector?.('[data-widget="webCharacteristics"] #section-characteristics') ||
    root.getElementById?.("section-characteristics") ||
    root.querySelector?.("#section-characteristics")
  );
}

function getDescriptionSectionState(root = document) {
  const section = root.getElementById?.("section-description") || root.querySelector?.("#section-description");
  const extracted = extractDescriptionData(root);
  const textLength = normalizeMultilineText(
    extracted?.text || section?.innerText || section?.textContent || ""
  ).length;
  return {
    section,
    textLength,
    ready: Boolean(textLength > 20)
  };
}

const PRODUCT_DATA_END_MARKER_RE =
  /(\u041f\u043e\u0434\u0431\u043e\u0440\u043a\u0438\s+\u0442\u043e\u0432\u0430\u0440\u043e\u0432|\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0435\u043c\s+\u0442\u0430\u043a\u0436\u0435|\u041f\u043e\u0445\u043e\u0436\u0438\u0435\s+\u0442\u043e\u0432\u0430\u0440\u044b|\u0421\s+\u044d\u0442\u0438\u043c\s+\u0442\u043e\u0432\u0430\u0440\u043e\u043c\s+\u043f\u043e\u043a\u0443\u043f\u0430\u044e\u0442)/i;

function getProductDataEndBoundary(root = document) {
  const candidates = [
    ...(root.querySelectorAll?.("h2,h3,section,[data-widget]") || [])
  ];

  return (
    candidates.find((element) => {
      const text = normalizeText(element.innerText || element.textContent || "");
      return text.length > 0 && text.length < 240 && PRODUCT_DATA_END_MARKER_RE.test(text);
    }) || null
  );
}

function getCharacteristicsSectionState(
  section = getCharacteristicsSectionElement(),
  root = document
) {
  const endBoundary = getProductDataEndBoundary(root);
  const description = getDescriptionSectionState(root);
  if (!section) {
    return {
      section: null,
      endBoundary,
      description,
      dlCount: 0,
      populatedCount: 0,
      textLength: 0,
      ready: false
    };
  }

  const rows = [...section.querySelectorAll("dl")];
  const populatedRows = rows.filter((dl) => {
    const name = normalizeText(dl.querySelector("dt")?.innerText || dl.querySelector("dt")?.textContent || "");
    const value = normalizeText(dl.querySelector("dd")?.innerText || dl.querySelector("dd")?.textContent || "");
    return Boolean(name && value);
  });
  const textLength = normalizeMultilineText(section.innerText || section.textContent || "").length;

  return {
    section,
    endBoundary,
    description,
    dlCount: rows.length,
    populatedCount: populatedRows.length,
    textLength,
    ready: populatedRows.length > 0 && textLength > 20
  };
}

function getProductDomReadiness(root = document) {
  const heading = normalizeText(
    parseStateElementFromRoot(root, "state-webProductHeading-")?.state?.title ||
      root.querySelector?.("h1")?.innerText ||
      root.querySelector?.("h1")?.textContent ||
      ""
  );
  const pricing = extractPricingData(root);
  const hasPrice = Boolean(
    pricing?.uploadPrice || pricing?.priceText || pricing?.cardPriceText || pricing?.regularPriceText
  );
  const characteristicsState = getCharacteristicsSectionState(
    getCharacteristicsSectionElement(root),
    root
  );
  const shortCharacteristicsCount = (extractShortCharacteristics(root) || []).filter(
    (item) => normalizeText(item?.name || "") && (item?.values || []).length > 0
  ).length;
  const characteristicCount = Math.max(
    Number(characteristicsState.populatedCount || 0),
    shortCharacteristicsCount
  );
  const descriptionState = getDescriptionSectionState(root);
  const endBoundaryReady = Boolean(characteristicsState.endBoundary);

  const ready =
    Boolean(heading) &&
    hasPrice &&
    (characteristicCount > 0 || endBoundaryReady) &&
    (descriptionState.ready || endBoundaryReady);

  let reason = "";
  if (!heading) {
    reason = "商品标题未加载完成";
  } else if (!hasPrice) {
    reason = "商品价格未加载完成";
  } else if (!(characteristicCount > 0 || endBoundaryReady)) {
    reason = "商品参数未加载完成";
  } else if (!(descriptionState.ready || endBoundaryReady)) {
    reason = "商品描述未加载完成";
  }

  return {
    ready,
    reason,
    heading,
    hasPrice,
    characteristicCount,
    descriptionTextLength: descriptionState.textLength,
    endBoundaryReady
  };
}

async function waitForProductDomReady(timeoutMs = 14000) {
  const startedAt = Date.now();
  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  let stableHits = 0;
  let lastSignature = "";
  let scrollAttempt = 0;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const state = getProductDomReadiness(document);
      const signature = `${state.heading}:${state.hasPrice}:${state.characteristicCount}:${state.descriptionTextLength}:${state.endBoundaryReady}`;
      if (state.ready) {
        stableHits = signature === lastSignature ? stableHits + 1 : 1;
        lastSignature = signature;
        if (stableHits >= 2) {
          return state;
        }
      } else {
        stableHits = 0;
        lastSignature = signature;
      }

      const scrollHeight = Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );
      const viewportHeight = window.innerHeight || 0;
      const maxScrollableY = Math.max(0, scrollHeight - viewportHeight);
      if (scrollAttempt < 10 && maxScrollableY > 0) {
        const ratio = Math.min(1, (scrollAttempt + 1) / 10);
        const targetY = Math.round(maxScrollableY * ratio);
        window.scrollTo({
          top: targetY,
          left: originalScrollX,
          behavior: "instant"
        });
        scrollAttempt += 1;
      }

      await sleep(350);
    }

    const finalState = getProductDomReadiness(document);
    return {
      ...finalState,
      ready: false,
      timeout: true,
      message: finalState.reason || "商品页面仍在懒加载，请稍后重试"
    };
  } finally {
    if (window.scrollX !== originalScrollX || window.scrollY !== originalScrollY) {
      window.scrollTo({
        top: originalScrollY,
        left: originalScrollX,
        behavior: "instant"
      });
    }
  }
}

function extractCharacteristicsData(root = document, sourceUrl = location.href) {
  const section = getCharacteristicsSectionElement(root);
  const stateItems = extractShortCharacteristics(root).map((item) => ({
    name: item.name,
    valueText: (item.values || []).join(", "),
    values: item.values || []
  }));
  if (!section) {
    return {
      items: stateItems,
      sectionUrl: null
    };
  }

  const items = [...stateItems];
  const seenNames = new Set(stateItems.map((item) => normalizeText(item.name).toLowerCase()));
  for (const dl of section.querySelectorAll("dl")) {
    const name = normalizeText(dl.querySelector("dt")?.innerText || dl.querySelector("dt")?.textContent || "");
    const dd = dl.querySelector("dd");
    if (!name || !dd) {
      continue;
    }

    const rawText = normalizeText(dd.innerText || dd.textContent || "");
    const linkedValues = [...dd.querySelectorAll("a")]
      .map((element) => normalizeValueText(element.innerText || element.textContent || ""))
      .filter(Boolean);
    const values = uniqueStrings(
      linkedValues.length
        ? linkedValues
        : rawText
            .split(/\s*,\s*/g)
            .map((value) => normalizeValueText(value))
            .filter(Boolean)
    );

    const seenKey = name.toLowerCase();
    if (seenNames.has(seenKey)) {
      continue;
    }
    seenNames.add(seenKey);
    items.push({
      name,
      valueText: rawText,
      values
    });
  }

  return {
    items,
    sectionUrl: absoluteUrl(section.querySelector("h2 a")?.getAttribute("href") || "", sourceUrl)
  };
}

function mergeCharacteristicsData(primary, secondary) {
  const merged = [];
  const seen = new Map();

  function addItems(items) {
    for (const item of items || []) {
      const name = normalizeText(item?.name || "");
      if (!name) {
        continue;
      }

      const key = name.toLowerCase();
      const valueText = normalizeText(item?.valueText || "");
      const values = uniqueStrings([
        ...(Array.isArray(item?.values) ? item.values : []),
        ...(valueText ? [valueText] : [])
      ]);
      if (!valueText && !values.length) {
        continue;
      }

      const existing = seen.get(key);
      if (!existing) {
        const next = {
          name,
          valueText: valueText || values.join(", "),
          values
        };
        seen.set(key, next);
        merged.push(next);
        continue;
      }

      const previousValueCount = (existing.values || []).length;
      const nextValues = uniqueStrings([...(existing.values || []), ...values]);
      existing.values = nextValues;
      if (!existing.valueText || nextValues.length > previousValueCount) {
        existing.valueText = valueText || nextValues.join(", ");
      }
    }
  }

  addItems(primary?.items || []);
  addItems(secondary?.items || []);

  return {
    items: merged,
    sectionUrl: primary?.sectionUrl || secondary?.sectionUrl || null
  };
}

async function waitForCharacteristicsSectionReady(timeoutMs = 22000) {
  const startedAt = Date.now();
  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  let stableHits = 0;
  let lastSignature = "";
  let scrollAttempt = 0;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const state = getCharacteristicsSectionState();
      const signature = `${state.dlCount}:${state.populatedCount}:${state.textLength}:${state.description.textLength}:${Boolean(
        state.endBoundary
      )}`;

      if (state.ready && state.endBoundary && state.description.ready) {
        stableHits = signature === lastSignature ? stableHits + 1 : 1;
        lastSignature = signature;
        if (stableHits >= 2) {
          return extractCharacteristicsData();
        }
      } else {
        stableHits = 0;
        lastSignature = signature;
      }

      const scrollHeight = Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );
      const viewportHeight = window.innerHeight || 0;
      const maxScrollableY = Math.max(0, scrollHeight - viewportHeight);
      if (scrollAttempt < 14 && maxScrollableY > 0) {
        const ratio = Math.min(1, (scrollAttempt + 1) / 14);
        const targetY = Math.round(maxScrollableY * ratio);
        window.scrollTo({
          top: targetY,
          left: originalScrollX,
          behavior: "instant"
        });
        scrollAttempt += 1;
      }

      await sleep(state.section ? 350 : 500);
    }

    return extractCharacteristicsData();
  } finally {
    if (window.scrollX !== originalScrollX || window.scrollY !== originalScrollY) {
      window.scrollTo({
        top: originalScrollY,
        left: originalScrollX,
        behavior: "instant"
      });
    }
  }
}

function buildFeaturesUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl, location.href);
    const cleanPath = url.pathname.replace(/\/+$/, "");
    url.pathname = /\/features$/i.test(cleanPath) ? `${cleanPath}/` : `${cleanPath}/features/`;
    return url.href;
  } catch (_error) {
    return null;
  }
}

async function fetchHtmlDocument(url) {
  const targetUrl = absoluteUrl(url, location.href);
  if (!targetUrl) {
    throw new Error("Missing URL for HTML fetch.");
  }

  const response = await fetch(targetUrl, {
    method: "GET",
    credentials: "include",
    redirect: "follow"
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`HTML fetch failed with status ${response.status}.`);
  }

  const sourceUrl = response.url || targetUrl;
  return {
    html,
    root: parseHtml(html),
    sourceUrl
  };
}

async function extractCharacteristicsWithFallback(root, sourceUrl) {
  const direct = extractCharacteristicsData(root, sourceUrl);
  const featuresUrl =
    direct.sectionUrl ||
    absoluteUrl(root.querySelector?.('[data-widget="webCharacteristics"] h2 a')?.getAttribute("href") || "", sourceUrl) ||
    buildFeaturesUrl(sourceUrl);

  if (!featuresUrl || absoluteUrl(featuresUrl, sourceUrl) === absoluteUrl(sourceUrl, sourceUrl)) {
    return direct;
  }

  try {
    const featuresDoc = await fetchHtmlDocument(featuresUrl);
    const features = extractCharacteristicsData(featuresDoc.root, featuresDoc.sourceUrl);
    if (features.items.length) {
      const merged = mergeCharacteristicsData(
        { ...features, sectionUrl: features.sectionUrl || featuresUrl },
        direct
      );
      return merged.items.length >= direct.items.length ? merged : direct;
    }
  } catch (_error) {
    // Ignore fallback fetch failures and keep the direct extraction result.
  }

  return direct;
}

async function resolveProductOriginCountryInfo(productId, productUrl, root = null) {
  const targetUrl = absoluteUrl(productUrl || location.href) || "";
  const key = `${productId || ""}:${targetUrl}`;
  const directItems = root ? extractCharacteristicsData(root, targetUrl || location.href).items : [];
  const directInfo = extractOriginCountryInfoFromCharacteristics(directItems);
  if (directInfo.countryName || directInfo.countryCode) {
    productOriginInfoCache.set(key, directInfo);
    return directInfo;
  }

  if (productOriginInfoCache.has(key)) {
    return productOriginInfoCache.get(key);
  }

  if (productOriginInfoInflight.has(key)) {
    return productOriginInfoInflight.get(key);
  }

  const task = (async () => {
    try {
      const doc =
        root && targetUrl === absoluteUrl(location.href)
          ? { root, sourceUrl: targetUrl || location.href }
          : await fetchHtmlDocument(targetUrl || location.href);
      const characteristics = await extractCharacteristicsWithFallback(doc.root, doc.sourceUrl);
      const info = extractOriginCountryInfoFromCharacteristics(characteristics.items);
      productOriginInfoCache.set(key, info);
      return info;
    } catch (_error) {
      const fallback = { countryName: "", countryCode: "" };
      productOriginInfoCache.set(key, fallback);
      return fallback;
    }
  })().finally(() => {
    productOriginInfoInflight.delete(key);
  });

  productOriginInfoInflight.set(key, task);
  return task;
}

function extractBreadcrumbs(root = document, sourceUrl = location.href) {
  const stateEntry = parseStateElementFromRoot(root, "state-breadCrumbs-");
  const breadcrumbs = stateEntry?.state?.breadcrumbs || [];

  return breadcrumbs.map((item) => ({
    text: normalizeText(item.text || ""),
    url: absoluteUrl(item.link || "", sourceUrl)
  }));
}

function extractBrandData(root = document, sourceUrl = location.href) {
  const stateEntry = parseStateElementFromRoot(root, "state-webBrand-");
  const state = stateEntry?.state;
  if (!state) {
    return null;
  }

  return {
    name: extractTextRs(state.content?.title?.text),
    url: absoluteUrl(state.link || state.content?.title?.text?.[0]?.href || "", sourceUrl),
    image: absoluteUrl(state.avatar?.image || "", sourceUrl)
  };
}

function extractSellerData(root = document, sourceUrl = location.href) {
  const stateEntry = parseStateElementFromRoot(root, "state-webCurrentSeller-");
  const state = stateEntry?.state;
  if (!state) {
    return null;
  }

  return {
    name: normalizeText(state.sellerCell?.centerBlock?.title?.text || ""),
    url: absoluteUrl(state.sellerCell?.common?.action?.link || "", sourceUrl),
    rating: normalizeText(state.rating?.title?.text || ""),
    sellerId: normalizeText(
      state.header?.badge?.unsubscribed?.common?.action?.params?.sellerId || ""
    )
  };
}

function extractOtherSellerCount(root = document) {
  const stateEntry = parseStateElementFromRoot(root, "state-webBestSeller-");
  const state = stateEntry?.state;
  const stateCount = normalizeText(state?.count || "");
  const stateMatch = stateCount.match(/\d+/);
  if (stateMatch?.[0]) {
    return stateMatch[0];
  }

  const offerText = [...root.querySelectorAll("button, a, div, span")]
    .map((element) => normalizeMultilineText(element.innerText || ""))
    .find((text) => /У других продавцов/i.test(text));
  const offerMatch = normalizeText(offerText || "").match(/(\d+)\s*$/);
  return offerMatch?.[1] || "0";
}

function findAboutSellerTooltip(value) {
  const stack = [value];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    const tooltip = current.tooltip;
    if (tooltip?.subtitle && Array.isArray(tooltip.subtitle)) {
      const titleText = normalizeText(tooltip.title?.text || current.title?.text || "");
      const lines = tooltip.subtitle
        .filter((item) => item?.type === "text")
        .map((item) => normalizeText(item.content || ""))
        .filter(Boolean);
      if (titleText.includes("О магазине") || lines.some((line) => /Адрес|ООО|ОГРН/i.test(line))) {
        return tooltip;
      }
    }

    for (const child of Object.values(current)) {
      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }

  return null;
}

function inferSellerCountryFlagFromState(state, fallbackText = "") {
  const source = normalizeText(`${fallbackText} ${JSON.stringify(state || {})}`);
  if (/\bCN\b|China|中国/i.test(source)) {
    return "🇨🇳";
  }
  return "🇷🇺";
}

function inferSellerCountryCodeFromState(state, fallbackText = "") {
  const source = normalizeText(`${fallbackText} ${JSON.stringify(state || {})}`);
  if (/\bCN\b|China|中国/i.test(source)) {
    return "CN";
  }
  return "RU";
}

function inferCountryCodeFromText(text) {
  const value = normalizeText(String(text || ""));
  if (!value) {
    return "";
  }

  const matchers = [
    { code: "CN", re: /\bCN\b|China|\u041a\u0438\u0442\u0430\u0439|\u4e2d\u56fd/i },
    { code: "RU", re: /\bRU\b|Russia|\u0420\u043e\u0441\u0441\u0438\u044f|\u4fc4\u7f57\u65af/i },
    { code: "TR", re: /\bTR\b|Turkey|T\u00fcrkiye|\u0422\u0443\u0440\u0446/i },
    { code: "KZ", re: /\bKZ\b|Kazakhstan|\u041a\u0430\u0437\u0430\u0445\u0441\u0442\u0430\u043d/i },
    { code: "BY", re: /\bBY\b|Belarus|\u0411\u0435\u043b\u0430\u0440\u0443\u0441/i },
    { code: "KR", re: /\bKR\b|Korea|\u041a\u043e\u0440\u0435/i },
    { code: "JP", re: /\bJP\b|Japan|\u042f\u043f\u043e\u043d/i },
    { code: "GB", re: /\bGB\b|\bUK\b|Great Britain|United Kingdom|\u0412\u0435\u043b\u0438\u043a\u043e\u0431\u0440\u0438\u0442\u0430\u043d/i },
    { code: "US", re: /\bUS\b|\bUSA\b|United States|\u0421\u0428\u0410|\u0421\u043e\u0435\u0434\u0438\u043d\u0435\u043d/i },
    { code: "DE", re: /\bDE\b|Germany|\u0413\u0435\u0440\u043c\u0430\u043d/i },
    { code: "FR", re: /\bFR\b|France|\u0424\u0440\u0430\u043d\u0446/i },
    { code: "IT", re: /\bIT\b|Italy|\u0418\u0442\u0430\u043b/i },
    { code: "ES", re: /\bES\b|Spain|\u0418\u0441\u043f\u0430\u043d/i },
    { code: "NL", re: /\bNL\b|Netherlands|\u041d\u0438\u0434\u0435\u0440\u043b\u0430\u043d/i },
    { code: "PL", re: /\bPL\b|Poland|\u041f\u043e\u043b\u044c\u0448/i }
  ];

  return matchers.find((item) => item.re.test(value))?.code || "";
}

function getCountryFlagImageUrl(countryCode) {
  const normalized = normalizeText(countryCode).toUpperCase();
  if (normalized === "CN") {
    return chrome.runtime.getURL("CN.jpg");
  }
  if (normalized === "RU") {
    return chrome.runtime.getURL("RU.png");
  }
  return "";
}

function getCountryFlagEmoji(countryCode) {
  const normalized = normalizeText(countryCode).toUpperCase();
  const flags = {
    CN: "🇨🇳",
    RU: "🇷🇺",
    TR: "🇹🇷",
    KZ: "🇰🇿",
    BY: "🇧🇾",
    KR: "🇰🇷",
    JP: "🇯🇵",
    GB: "🇬🇧",
    US: "🇺🇸",
    DE: "🇩🇪",
    FR: "🇫🇷",
    IT: "🇮🇹",
    ES: "🇪🇸",
    NL: "🇳🇱",
    PL: "🇵🇱"
  };
  return flags[normalized] || "";
}

function buildCountryFlagMarkup(countryCode) {
  const normalized = normalizeText(countryCode).toUpperCase();
  if (!normalized) {
    return "";
  }

  const imageUrl = getCountryFlagImageUrl(normalized);
  if (imageUrl) {
    return `<img class="${PRODUCT_DASHBOARD_CLASS}__chip-flag" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(
      normalized
    )}" />`;
  }

  const emoji = getCountryFlagEmoji(normalized);
  return emoji
    ? `<span class="${PRODUCT_DASHBOARD_CLASS}__chip-flag ${PRODUCT_DASHBOARD_CLASS}__chip-flag--emoji" aria-label="${escapeHtml(
        normalized
      )}">${emoji}</span>`
    : "";
}

function isOriginCountryCharacteristicName(name) {
  const value = normalizeText(String(name || "")).toLowerCase();
  return /страна[\s-]*изготовител|country\s+of\s+origin|origin\s+country|\u539f\u4ea7\u5730|\u539f\u4ea7\u56fd|\u751f\u4ea7\u56fd|\u56fd\u5bb6[-\s]*\u5236\u9020/.test(
    value
  );
}

function extractOriginCountryInfoFromCharacteristics(items) {
  for (const item of items || []) {
    if (!isOriginCountryCharacteristicName(item?.name)) {
      continue;
    }

    const countryName = normalizeText((item.values || []).join(", ") || item.valueText || "");
    if (!countryName) {
      continue;
    }

    return {
      countryName,
      countryCode: inferCountryCodeFromText(countryName)
    };
  }

  return {
    countryName: "",
    countryCode: ""
  };
}

function inferCountryFlagFromText(text) {
  const value = normalizeText(String(text || ""));
  if (!value) {
    return "";
  }

  const matchers = [
    { re: /Россия|РФ|Москва|Санкт-Петербург|Новосибирск|Екатеринбург|Казань/i, flag: "🇷🇺" },
    { re: /Китай|China|中国|Shenzhen|Guangzhou|Yiwu/i, flag: "🇨🇳" },
    { re: /Беларус|Минск/i, flag: "🇧🇾" },
    { re: /Казахстан|Алматы|Астана/i, flag: "🇰🇿" },
    { re: /Турц|Turkey|Türkiye|Стамбул/i, flag: "🇹🇷" },
    { re: /Корея|Seoul|한국|대한민국/i, flag: "🇰🇷" },
    { re: /Япония|Japan|東京|大阪/i, flag: "🇯🇵" }
  ];

  return matchers.find((item) => item.re.test(value))?.flag || "";
}

function extractLocationLabel(text) {
  const value = normalizeText(String(text || ""));
  if (!value) {
    return "";
  }

  const cityMatch =
    value.match(/Адрес\s*-\s*(?:г\.\s*)?([^,]+)/i) ||
    value.match(/Address\s*-\s*([^,]+)/i) ||
    null;
  if (cityMatch?.[1]) {
    return normalizeText(cityMatch[1]);
  }

  return value.replace(/^Адрес\s*-\s*/i, "").slice(0, 32);
}

function extractSellerStoreInfoFromState(state, fallbackName = "") {
  const sellerName = normalizeText(state?.sellerCell?.centerBlock?.title?.text || fallbackName || "");
  const tooltip = findAboutSellerTooltip(state);
  const lines = uniqueStrings(
    (tooltip?.subtitle || [])
      .filter((item) => item?.type === "text")
      .map((item) => normalizeText(item.content || ""))
      .filter(Boolean)
  );
  const legalName =
    lines.find((line) => /(ООО|ИП|LLC|LTD|INC|ОАО|ЗАО)/i.test(line)) || sellerName || fallbackName;
  const addressText = lines.find((line) => /Адрес\s*-/i.test(line)) || "";
  const locationText = extractLocationLabel(addressText);
  const countryFlag = inferSellerCountryCodeFromState(state, `${addressText} ${locationText}`);

  return {
    sellerName: sellerName || fallbackName || legalName,
    legalName,
    addressText,
    locationText,
    countryFlag
  };
}

async function resolveCardSellerInfo(productId, productUrl, fallbackName = "") {
  const key = Number(productId);
  if (!Number.isFinite(key)) {
    return {
      sellerName: fallbackName || "",
      legalName: fallbackName || "",
      addressText: "",
      locationText: "",
      countryFlag: "",
      originCountry: "",
      otherSellerCount: "0"
    };
  }

  if (cardSellerInfoCache.has(key)) {
    return cardSellerInfoCache.get(key);
  }

  if (cardSellerInfoInflight.has(key)) {
    return cardSellerInfoInflight.get(key);
  }

  const task = (async () => {
    const fallback = {
      sellerName: fallbackName || "",
      legalName: fallbackName || "",
      addressText: "",
      locationText: "",
      countryFlag: "",
      originCountry: "",
      otherSellerCount: "0"
    };
    if (!productUrl) {
      cardSellerInfoCache.set(key, fallback);
      return fallback;
    }

    try {
      const response = await fetch(productUrl, {
        method: "GET",
        credentials: "include"
      });
      const html = await response.text();
      if (!response.ok) {
        throw new Error(`seller-meta-${response.status}`);
      }

      const doc = new DOMParser().parseFromString(html, "text/html");
      const stateEntry = parseStateElementFromRoot(doc, "state-webCurrentSeller-");
      const otherSellerCount = extractOtherSellerCount(doc);
      const originInfo = await resolveProductOriginCountryInfo(productId, response.url || productUrl, doc);
      const stateInfo = stateEntry?.state ? extractSellerStoreInfoFromState(stateEntry.state, fallbackName) : fallback;
      const next = {
        ...stateInfo,
        countryFlag:
          originInfo.countryCode ||
          stateInfo.countryFlag ||
          inferCountryCodeFromText(`${originInfo.countryName} ${stateInfo.addressText} ${stateInfo.locationText}`),
        originCountry: originInfo.countryName,
        otherSellerCount
      };
      cardSellerInfoCache.set(key, next);
      return next;
    } catch (_error) {
      cardSellerInfoCache.set(key, fallback);
      return fallback;
    }
  })().finally(() => {
    cardSellerInfoInflight.delete(key);
  });

  cardSellerInfoInflight.set(key, task);
  return task;
}

function extractMarketingLabels(root = document) {
  const stateEntry = parseStateElementFromRoot(root, "state-webMarketingLabels-");
  const labels = stateEntry?.state?.labels || [];
  return uniqueStrings(labels.map((item) => item?.badge?.text || ""));
}

function extractGalleryData(root = document, sourceUrl = location.href) {
  const stateEntry = parseStateElementFromRoot(root, "state-webGallery-");
  const state = stateEntry?.state;
  if (!state) {
    return null;
  }

  return {
    sku: normalizeText(state.sku || ""),
    coverImage: absoluteUrl(state.coverImage || "", sourceUrl),
    images: (state.images || []).map((item) => ({
      src: absoluteUrl(item.src || "", sourceUrl),
      alt: normalizeText(item.alt || "")
    })),
    videos: (state.videos || []).map((item) => ({
      name: normalizeText(item.name || ""),
      url: absoluteUrl(item.url || "", sourceUrl),
      coverUrl: absoluteUrl(item.coverUrl || "", sourceUrl)
    })),
    videoCover: state.videoCover || null
  };
}

function extractShortCharacteristics(root = document) {
  const stateEntry = parseStateElementFromRoot(root, "state-webShortCharacteristics-");
  const characteristics = stateEntry?.state?.characteristics || [];

  return characteristics.map((item) => ({
    id: item.id || null,
    name: extractTextRs(item.title?.textRs),
    values: uniqueStrings(
      (item.values || []).flatMap((value) => {
        const textRs = value?.textRs ? [extractTextRs(value.textRs)] : [];
        return [value?.text || "", ...textRs].map((entry) => normalizeValueText(entry));
      })
    )
  }));
}

function formatWeightText(value, unit) {
  if (value == null || !unit) {
    return null;
  }

  const normalizedValue = Number.isInteger(value) ? String(value) : String(value);
  return `${normalizedValue} ${unit}`;
}

function parseWeightValue(valueText, nameText = "") {
  const source = normalizeText(`${valueText} ${nameText}`.replace(/\u00a0/g, " "));
  const numberMatch = source.match(/(\d+(?:[.,]\d+)?)/);
  if (!numberMatch) {
    return null;
  }

  const rawValue = Number(numberMatch[1].replace(",", "."));
  if (!Number.isFinite(rawValue)) {
    return null;
  }

  const lower = source.toLowerCase();
  let unit = null;
  if (/(^|[^a-zа-я])(кг|kg)([^a-zа-я]|$)/i.test(lower)) {
    unit = "kg";
  } else if (/(^|[^a-zа-я])(г|гр|g)([^a-zа-я]|$)/i.test(lower)) {
    unit = "g";
  }

  return {
    value: rawValue,
    unit,
    grams: unit === "kg" ? rawValue * 1000 : unit === "g" ? rawValue : null,
    weightText: formatWeightText(rawValue, unit)
  };
}

function extractProductWeightFromCharacteristics(items) {
  const candidates = (items || [])
    .map((item) => {
      const nameLower = normalizeText(item?.name || "").toLowerCase();
      const isWeightLike = /(вес|масса|weight)/i.test(nameLower);
      const isPackageLike = /упаков|package|shipping/i.test(nameLower);
      const isProductLike = /товар|издел|without packaging|без упаков/i.test(nameLower);
      return {
        item,
        nameLower,
        isWeightLike,
        isPackageLike,
        isProductLike
      };
    })
    .filter((entry) => entry.isWeightLike && !entry.isPackageLike)
    .sort((left, right) => Number(right.isProductLike) - Number(left.isProductLike));

  for (const candidate of candidates) {
    const parsed = parseWeightValue(candidate.item?.valueText || "", candidate.item?.name || "");
    if (!parsed) {
      continue;
    }

    return {
      source: "characteristics",
      characteristicName: candidate.item.name,
      characteristicValueText: candidate.item.valueText,
      value: parsed.value,
      unit: parsed.unit,
      grams: parsed.grams,
      weightText: parsed.weightText || candidate.item.valueText
    };
  }

  return null;
}

function parsePriceValue(valueText) {
  const source = normalizeText(String(valueText || "").replace(/\u00a0/g, " "));
  if (!source) {
    return null;
  }

  const match = source.replace(/\s+/g, "").match(/(\d+(?:[.,]\d+)?)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function normalizePriceNumber(value) {
  const numericValue = typeof value === "number" ? value : parsePriceValue(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return numericValue.toFixed(2);
}

function extractPricingData(root = document) {
  const stateEntry = parseStateElementFromRoot(root, "state-webPrice-");
  const state = stateEntry?.state || null;
  if (!state) {
    return null;
  }

  const regularPriceText = normalizeText(state.price || "");
  const cardPriceText = normalizeText(state.cardPrice || "");
  const originalPriceText = normalizeText(state.originalPrice || "");
  const regularPriceValue = parsePriceValue(regularPriceText);
  const cardPriceValue = parsePriceValue(cardPriceText);
  const originalPriceValue = parsePriceValue(originalPriceText);
  const uploadPriceValue =
    regularPriceValue ??
    parsePriceValue(state.finalPrice || "") ??
    cardPriceValue ??
    null;

  return {
    source: "state-webPrice",
    priceText: regularPriceText || cardPriceText || null,
    regularPriceText: regularPriceText || null,
    cardPriceText: cardPriceText || null,
    originalPriceText: originalPriceText || null,
    priceValue: regularPriceValue,
    cardPriceValue,
    originalPriceValue,
    uploadPrice: normalizePriceNumber(uploadPriceValue),
    oldPrice: normalizePriceNumber(originalPriceValue),
    currency: /¥|CNY/i.test(
      `${regularPriceText} ${cardPriceText} ${originalPriceText} ${state.disclaimerPriceHeader || ""}`
    )
      ? "CNY"
      : null,
    disclaimerTitle: normalizeText(state.disclaimerPriceHeader || ""),
    disclaimerBody: normalizeText(
      (state.disclaimerPriceBodyRs || []).map((item) => item?.content || "").join(" ")
    ),
  };
}

function extractSelectedAspectText(aspect) {
  const rawText = extractTextRs(aspect?.descriptionRs);
  return normalizeText(rawText.replace(/^[^:：]+[:：]\s*/, ""));
}

function extractProductVariants(root = document, sourceUrl = location.href) {
  const state = parseStateElementFromRoot(root, "state-webAspects-")?.state || null;
  const aspects = Array.isArray(state?.aspects) ? state.aspects : [];
  const currentProductId = extractProductIdFromUrl(sourceUrl);
  const pricing = extractPricingData(root);
  const gallery = extractGalleryData(root, sourceUrl);
  const currentTitle =
    parseStateElementFromRoot(root, "state-webProductHeading-")?.state?.title ||
    extractProductTitle(root);
  const currentSelections = aspects
    .map((aspect) => {
      const aspectName = normalizeText(aspect?.aspectName || "");
      const selectedText = extractSelectedAspectText(aspect);
      if (aspectName && selectedText) {
        return `${aspectName}: ${selectedText}`;
      }
      return selectedText || aspectName;
    })
    .filter(Boolean);

  const variantsByProductId = new Map();

  function appendVariantAxis(target, name, value) {
    const axisName = normalizeText(name || "");
    const axisValue = normalizeText(value || "");
    if (!axisName || !axisValue) {
      return;
    }

    if (!Array.isArray(target.variantAxes)) {
      target.variantAxes = [];
    }

    const existing = target.variantAxes.find(
      (item) =>
        normalizeText(item?.name || "").toLowerCase() === axisName.toLowerCase()
    );
    if (existing) {
      existing.value = axisValue;
      return;
    }

    target.variantAxes.push({
      name: axisName,
      value: axisValue
    });
  }

  function finalizeVariant(target) {
    const variantAxes = Array.isArray(target.variantAxes) ? target.variantAxes : [];
    const variantSummary =
      variantAxes
        .map((item) => {
          const axisName = normalizeText(item?.name || "");
          const axisValue = normalizeText(item?.value || "");
          if (axisName && axisValue) {
            return `${axisName}: ${axisValue}`;
          }
          return axisValue || axisName;
        })
        .filter(Boolean)
        .join(" | ") || normalizeText(target.variantSummary || "");

    return {
      productId: Number(target.productId),
      productUrl: absoluteUrl(target.productUrl || "", sourceUrl),
      title: normalizeText(target.title || ""),
      variantSummary,
      variantAxes,
      imageUrl: absoluteUrl(target.imageUrl || "", sourceUrl),
      currentPriceText: normalizeText(target.currentPriceText || ""),
      originalPriceText: normalizeText(target.originalPriceText || ""),
      availability: normalizeText(target.availability || ""),
      isCurrent: Boolean(target.isCurrent)
    };
  }

  function upsertVariant(candidate, axis = null) {
    const productId = Number(candidate?.productId);
    if (!Number.isFinite(productId)) {
      return;
    }

    const existing = variantsByProductId.get(productId) || {
      productId,
      productUrl: "",
      title: "",
      variantSummary: "",
      variantAxes: [],
      imageUrl: "",
      currentPriceText: "",
      originalPriceText: "",
      availability: "",
      isCurrent: false
    };

    if (candidate?.productUrl) {
      existing.productUrl = candidate.productUrl;
    }
    if (candidate?.title) {
      existing.title = candidate.title;
    }
    if (candidate?.variantSummary) {
      existing.variantSummary = candidate.variantSummary;
    }
    if (candidate?.imageUrl) {
      existing.imageUrl = candidate.imageUrl;
    }
    if (candidate?.currentPriceText) {
      existing.currentPriceText = candidate.currentPriceText;
    }
    if (candidate?.originalPriceText) {
      existing.originalPriceText = candidate.originalPriceText;
    }
    if (candidate?.availability) {
      existing.availability = candidate.availability;
    }
    existing.isCurrent = existing.isCurrent || Boolean(candidate?.isCurrent);

    if (axis) {
      appendVariantAxis(existing, axis.name, axis.value);
    }

    variantsByProductId.set(productId, existing);
  }

  upsertVariant(
    {
      productId: currentProductId,
      productUrl: sourceUrl,
      title: currentTitle,
      variantSummary: currentSelections.join(" | "),
      imageUrl: gallery?.coverImage || gallery?.images?.[0]?.src || "",
      currentPriceText: pricing?.priceText || pricing?.cardPriceText || pricing?.regularPriceText || "",
      originalPriceText: pricing?.originalPriceText || "",
      availability: "inStock",
      isCurrent: true
    },
    null
  );

  currentSelections.forEach((selection) => {
    const parts = normalizeText(selection).split(/\s*:\s*/);
    if (parts.length >= 2) {
      appendVariantAxis(
        variantsByProductId.get(Number(currentProductId)),
        parts.shift(),
        parts.join(": ")
      );
    }
  });

  for (const aspect of aspects) {
    const aspectName = normalizeText(aspect?.aspectName || "");
    for (const variant of aspect?.variants || []) {
      const productUrl = absoluteUrl(variant?.link || "", sourceUrl);
      const productId =
        extractProductIdFromText(productUrl || "") ||
        Number(variant?.sku || "");
      const variantText = normalizeText(
        extractTextRs(variant?.data?.textRs) || variant?.data?.searchableText || ""
      );
      const variantSummary = aspectName && variantText ? `${aspectName}: ${variantText}` : variantText || aspectName;

      upsertVariant(
        {
          productId,
          productUrl,
          title: normalizeText(variant?.data?.title || currentTitle || ""),
          variantSummary,
          imageUrl: variant?.data?.coverImage || "",
          currentPriceText: normalizeText(variant?.data?.price || ""),
          originalPriceText: normalizeText(variant?.data?.originalPrice || ""),
          availability: variant?.availability || "",
          isCurrent: Number(productId) === Number(currentProductId)
        },
        {
          name: aspectName,
          value: variantText
        }
      );
    }
  }

  return [...variantsByProductId.values()]
    .map((item) => finalizeVariant(item))
    .sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent));
}

function buildProductDataResult(job, options = {}) {
  const root = options.root || document;
  const sourceUrl = options.sourceUrl || location.href;
  const shortCharacteristics = extractShortCharacteristics(root);
  const gallery = extractGalleryData(root, sourceUrl);
  const characteristics = options.characteristics || extractCharacteristicsData(root, sourceUrl);
  const marketingLabels = extractMarketingLabels(root);
  const productWeight = extractProductWeightFromCharacteristics(characteristics.items);
  const pricing = extractPricingData(root);
  const title =
    parseStateElementFromRoot(root, "state-webProductHeading-")?.state?.title ||
    extractProductTitle(root);
  const description =
    extractDescriptionData(root) ||
    extractDescriptionFromShortCharacteristics(shortCharacteristics, title);
  const hashtags = extractHashtags(description?.text || "", root);

  return {
    extractionType: "product-data",
    extractedAt: new Date().toISOString(),
    sourceUrl,
    productId:
      job.productId ||
      extractProductIdFromUrl(sourceUrl) ||
      Number(gallery?.sku || "") ||
      null,
    title,
    breadcrumbs: extractBreadcrumbs(root, sourceUrl),
    brand: extractBrandData(root, sourceUrl),
    seller: extractSellerData(root, sourceUrl),
    marketingLabels,
    hashtags,
    description,
    pricing,
    price: pricing?.uploadPrice || null,
    oldPrice: pricing?.oldPrice || null,
    productWeight,
    characteristics: characteristics.items,
    characteristicsUrl: characteristics.sectionUrl,
    shortCharacteristics,
    gallery,
    stats: {
      marketingLabelCount: marketingLabels.length,
      hashtagCount: hashtags.length,
      characteristicCount: characteristics.items.length,
      shortCharacteristicCount: shortCharacteristics.length,
      hasPrice: Boolean(pricing?.uploadPrice),
      galleryImageCount: gallery?.images?.length || 0,
      galleryVideoCount: gallery?.videos?.length || 0,
      descriptionImageCount: description?.images?.length || 0,
      descriptionVideoCount: description?.videos?.length || 0
    }
  };
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeVariantPatchText(value) {
  return normalizeText(String(value || "")).toLowerCase();
}

function tokenizeVariantPatchText(value) {
  return uniqueStrings(
    normalizeVariantPatchText(value)
      .split(/[^\p{L}\p{N}]+/gu)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
  );
}

function characteristicNameMatchScore(characteristicName, axisName) {
  const normalizedCharacteristicName = normalizeVariantPatchText(characteristicName);
  const normalizedAxisName = normalizeVariantPatchText(axisName);
  if (!normalizedCharacteristicName || !normalizedAxisName) {
    return 0;
  }

  if (normalizedCharacteristicName === normalizedAxisName) {
    return 100;
  }

  if (
    normalizedCharacteristicName.includes(normalizedAxisName) ||
    normalizedAxisName.includes(normalizedCharacteristicName)
  ) {
    return 70;
  }

  const characteristicTokens = new Set(tokenizeVariantPatchText(normalizedCharacteristicName));
  const axisTokens = new Set(tokenizeVariantPatchText(normalizedAxisName));
  if (!characteristicTokens.size || !axisTokens.size) {
    return 0;
  }

  let sharedCount = 0;
  for (const token of characteristicTokens) {
    if (axisTokens.has(token)) {
      sharedCount += 1;
    }
  }

  return sharedCount ? sharedCount * 20 : 0;
}

function upsertVariantAxisIntoCharacteristics(items, axis) {
  const axisName = normalizeText(axis?.name || "");
  const axisValue = normalizeText(axis?.value || "");
  if (!axisName || !axisValue) {
    return items;
  }

  const nextItems = Array.isArray(items) ? items : [];
  let bestIndex = -1;
  let bestScore = 0;

  nextItems.forEach((item, index) => {
    const score = characteristicNameMatchScore(item?.name || "", axisName);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestIndex >= 0 && bestScore >= 20) {
    nextItems[bestIndex] = {
      ...nextItems[bestIndex],
      valueText: axisValue,
      values: [axisValue]
    };
    return nextItems;
  }

  nextItems.push({
    name: axisName,
    valueText: axisValue,
    values: [axisValue]
  });
  return nextItems;
}

function upsertVariantAxisIntoShortCharacteristics(items, axis) {
  const axisName = normalizeText(axis?.name || "");
  const axisValue = normalizeText(axis?.value || "");
  if (!axisName || !axisValue) {
    return items;
  }

  const nextItems = Array.isArray(items) ? items : [];
  let bestIndex = -1;
  let bestScore = 0;

  nextItems.forEach((item, index) => {
    const score = characteristicNameMatchScore(item?.name || "", axisName);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestIndex >= 0 && bestScore >= 20) {
    nextItems[bestIndex] = {
      ...nextItems[bestIndex],
      values: [axisValue]
    };
    return nextItems;
  }

  nextItems.push({
    id: null,
    name: axisName,
    values: [axisValue]
  });
  return nextItems;
}

function upsertCharacteristicValue(items, name, value) {
  const targetName = normalizeText(name || "");
  const targetValue = normalizeText(value || "");
  if (!targetName || !targetValue) {
    return items;
  }

  const nextItems = Array.isArray(items) ? items : [];
  const targetKey = normalizeVariantPatchText(targetName);
  const existingIndex = nextItems.findIndex(
    (item) => normalizeVariantPatchText(item?.name || "") === targetKey
  );
  const nextValue = {
    name: targetName,
    valueText: targetValue,
    values: [targetValue]
  };

  if (existingIndex >= 0) {
    nextItems[existingIndex] = {
      ...nextItems[existingIndex],
      ...nextValue
    };
    return nextItems;
  }

  nextItems.push(nextValue);
  return nextItems;
}

function upsertShortCharacteristicValue(items, name, value) {
  const targetName = normalizeText(name || "");
  const targetValue = normalizeText(value || "");
  if (!targetName || !targetValue) {
    return items;
  }

  const nextItems = Array.isArray(items) ? items : [];
  const targetKey = normalizeVariantPatchText(targetName);
  const existingIndex = nextItems.findIndex(
    (item) => normalizeVariantPatchText(item?.name || "") === targetKey
  );
  const nextValue = {
    id: null,
    name: targetName,
    values: [targetValue]
  };

  if (existingIndex >= 0) {
    nextItems[existingIndex] = {
      ...nextItems[existingIndex],
      ...nextValue
    };
    return nextItems;
  }

  nextItems.push(nextValue);
  return nextItems;
}

function variantChangesPhysicalProperties(variantAxes = []) {
  const signal = normalizeVariantPatchText(
    (variantAxes || [])
      .map((item) => `${item?.name || ""} ${item?.value || ""}`)
      .join(" ")
  );

  return /(колич|упаков|шт|piece|pack|qty|quantity|объем|volume|мл|ml|литр|л\b|size|размер|габарит|dimension|длина|ширина|высота|вес|weight|масса|kg|g\b)/i.test(
    signal
  );
}

function buildSyntheticPackageWeight(productData) {
  if (!productData?.productWeight?.grams) {
    return null;
  }

  return {
    productId: productData.productId,
    productTitle: productData.title,
    sourceUrl: productData.sourceUrl,
    method: "characteristics-fallback",
    weightKg: Number((productData.productWeight.grams / 1000).toFixed(6)),
    weightText: productData.productWeight.weightText,
    orderInfo:
      productData.productWeight.characteristicValueText || productData.productWeight.weightText,
    itemCount: null,
    totalStateId: null,
    splitStateId: null,
    deliveryText: null,
    extractedAt: new Date().toISOString(),
    warning: "Weight fallback used characteristics because checkout weight request was unavailable."
  };
}

async function extractCurrentProductDataForUpload() {
  const job = {
    productId: extractProductIdFromUrl(location.href),
    productTitle: extractProductTitle()
  };
  const waitedCharacteristics = await waitForCharacteristicsSectionReady();
  const fallbackCharacteristics = await extractCharacteristicsWithFallback(document, location.href);
  const characteristics = mergeCharacteristicsData(fallbackCharacteristics, waitedCharacteristics);

  const productData = buildProductDataResult(job, { characteristics });

  try {
    const packageWeight = await fetchWeightResultFromProductPage(
      {
        ...job,
        productTitle: productData.title
      },
      {
        root: document,
        sourceUrl: location.href,
        silent: true,
        productTitle: productData.title
      }
    );

    return {
      ...productData,
      extractionType: "upload-product",
      packageWeight
    };
  } catch (error) {
    const packageWeight = buildSyntheticPackageWeight(productData);
    return {
      ...productData,
      extractionType: "upload-product",
      ...(packageWeight ? { packageWeight } : {})
    };
  }
}

function buildVariantProductData(baseProductData, variant = {}) {
  const productData = cloneJson(baseProductData) || {};
  const variantAxes = Array.isArray(variant?.variantAxes) ? cloneJson(variant.variantAxes) : [];
  const characteristics = cloneJson(productData.characteristics || []);
  const shortCharacteristics = cloneJson(productData.shortCharacteristics || []);

  for (const axis of variantAxes) {
    upsertVariantAxisIntoCharacteristics(characteristics, axis);
    upsertVariantAxisIntoShortCharacteristics(shortCharacteristics, axis);
  }

  const productId =
    Number(variant?.productId) ||
    Number(productData.productId) ||
    extractProductIdFromUrl(variant?.productUrl || productData.sourceUrl || location.href);
  const sourceUrl = absoluteUrl(variant?.productUrl || productData.sourceUrl || location.href);
  const title = normalizeText(variant?.title || "") || productData.title || extractProductTitle();
  const priceText =
    normalizeText(variant?.currentPriceText || "") ||
    productData.pricing?.priceText ||
    productData.pricing?.cardPriceText ||
    productData.pricing?.regularPriceText ||
    "";
  const originalPriceText =
    normalizeText(variant?.originalPriceText || "") || productData.pricing?.originalPriceText || "";
  const priceValue = parsePriceValue(priceText);
  const originalPriceValue = parsePriceValue(originalPriceText);
  if (Number.isFinite(productId)) {
    upsertCharacteristicValue(characteristics, "Артикул", String(productId));
    upsertShortCharacteristicValue(shortCharacteristics, "Артикул", String(productId));
  }
  const productWeight = extractProductWeightFromCharacteristics(characteristics);
  const packageWeight =
    variantChangesPhysicalProperties(variantAxes)
      ? buildSyntheticPackageWeight({
          productId,
          title,
          sourceUrl,
          productWeight
        })
      : cloneJson(productData.packageWeight || buildSyntheticPackageWeight(productData));

  const gallery = cloneJson(productData.gallery || {}) || {};
  const variantImageUrl = absoluteUrl(variant?.imageUrl || "", sourceUrl);
  if (variantImageUrl) {
    const existingImages = Array.isArray(gallery.images) ? gallery.images : [];
    const dedupedImages = existingImages.filter((item) => absoluteUrl(item?.src || "", sourceUrl) !== variantImageUrl);
    gallery.coverImage = variantImageUrl;
    gallery.images = [
      { src: variantImageUrl, alt: title },
      ...dedupedImages
    ];
  }
  gallery.sku = productId ? String(productId) : gallery.sku || "";

  const pricing = {
    ...(cloneJson(productData.pricing || {}) || {}),
    priceText: priceText || null,
    regularPriceText: priceText || null,
    cardPriceText: priceText || null,
    originalPriceText: originalPriceText || null,
    priceValue,
    cardPriceValue: priceValue,
    originalPriceValue,
    uploadPrice: normalizePriceNumber(priceValue),
    oldPrice: normalizePriceNumber(originalPriceValue)
  };

  return {
    ...productData,
    extractionType: "upload-product",
    extractedAt: new Date().toISOString(),
    sourceUrl,
    productId: Number.isFinite(productId) ? productId : productData.productId || null,
    title,
    pricing,
    price: pricing.uploadPrice || productData.price || null,
    oldPrice: pricing.oldPrice || productData.oldPrice || null,
    productWeight,
    packageWeight: packageWeight || null,
    characteristics,
    characteristicsUrl: buildFeaturesUrl(sourceUrl) || productData.characteristicsUrl || null,
    shortCharacteristics,
    gallery,
    variantPatch: {
      source: "base-product",
      summary: normalizeText(variant?.variantSummary || ""),
      axes: variantAxes
    },
    stats: {
      ...(productData.stats || {}),
      characteristicCount: characteristics.length,
      shortCharacteristicCount: shortCharacteristics.length,
      hasPrice: Boolean(pricing.uploadPrice),
      galleryImageCount: gallery?.images?.length || 0
    }
  };
}

function parseOzonWidgetStatesFromPayloads(payloads) {
  const states = {};

  for (const payload of payloads || []) {
    if (!payload || typeof payload !== "object") {
      continue;
    }

    const widgetStates = payload.widgetStates;
    if (!widgetStates || typeof widgetStates !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(widgetStates)) {
      if (value && typeof value === "object") {
        states[key] = value;
        continue;
      }

      if (typeof value !== "string") {
        continue;
      }

      try {
        states[key] = JSON.parse(value);
      } catch (_error) {
        // Keep parsing resilient when some widget blobs are malformed.
      }
    }
  }

  return states;
}

function findOzonWidgetState(states, prefix) {
  for (const [key, value] of Object.entries(states || {})) {
    if (key.startsWith(prefix) && value && typeof value === "object") {
      return value;
    }
  }
  return null;
}

function findAllOzonWidgetStates(states, prefix) {
  return Object.entries(states || {})
    .filter(([key, value]) => key.startsWith(prefix) && value && typeof value === "object")
    .map(([, value]) => value);
}

function parseOzonValues(values) {
  const result = [];
  for (const value of values || []) {
    if (typeof value === "string") {
      const text = normalizeValueText(value);
      if (text) {
        result.push(text);
      }
      continue;
    }

    const text = normalizeValueText(
      value?.text ||
        value?.content ||
        extractTextRs(value?.textRs) ||
        value?.value
    );
    if (text) {
      result.push(text);
    }
  }
  return uniqueStrings(result);
}

function buildOzonCharacteristicItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") {
    return null;
  }

  const name = normalizeText(
    rawItem.name ||
      extractTextRs(rawItem?.title?.textRs) ||
      rawItem?.title?.text ||
      rawItem?.title
  );
  if (!name) {
    return null;
  }

  const values = parseOzonValues(rawItem.values || []);
  const valueText = normalizeText(
    rawItem.valueText ||
      rawItem.content ||
      rawItem.copyText ||
      values.join(", ")
  );
  if (!valueText && !values.length) {
    return null;
  }

  return {
    name,
    valueText: valueText || values.join(", "),
    values: values.length ? values : valueText ? [valueText] : []
  };
}

function mergeCharacteristicIntoMap(map, item) {
  if (!item?.name) {
    return;
  }
  const key = item.name.toLowerCase();
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      name: item.name,
      valueText: item.valueText || "",
      values: uniqueStrings(item.values || [])
    });
    return;
  }

  const previousValueCount = (existing.values || []).length;
  const mergedValues = uniqueStrings([...(existing.values || []), ...(item.values || [])]);
  existing.values = mergedValues;
  if (!existing.valueText || mergedValues.length > previousValueCount) {
    existing.valueText = item.valueText || mergedValues.join(", ");
  }
}

function extractOzonShortCharacteristics(states) {
  const shortState = findOzonWidgetState(states, "webShortCharacteristics-");
  const items = (shortState?.characteristics || [])
    .map((item) => buildOzonCharacteristicItem(item))
    .filter(Boolean);

  return items.map((item) => ({
    id: null,
    name: item.name,
    values: item.values
  }));
}

function extractOzonCharacteristics(states, shortCharacteristics = []) {
  const merged = new Map();

  for (const item of shortCharacteristics || []) {
    mergeCharacteristicIntoMap(merged, {
      name: item?.name,
      valueText: (item?.values || []).join(", "),
      values: item?.values || []
    });
  }

  const characteristicsState = findOzonWidgetState(states, "webCharacteristics-");
  for (const group of characteristicsState?.characteristics || []) {
    const candidates = [
      ...(group?.short || []),
      ...(group?.items || []),
      group
    ];
    for (const candidate of candidates) {
      const parsed = buildOzonCharacteristicItem(candidate);
      if (parsed) {
        mergeCharacteristicIntoMap(merged, parsed);
      }
    }
  }

  for (const descriptionState of findAllOzonWidgetStates(states, "webDescription-")) {
    for (const item of descriptionState?.characteristics || []) {
      const parsed = buildOzonCharacteristicItem({
        name: item?.title,
        values: [{ text: item?.content }]
      });
      if (parsed) {
        mergeCharacteristicIntoMap(merged, parsed);
      }
    }
  }

  return [...merged.values()];
}

function collectDescriptionPieces(node, textBucket, imageBucket) {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      collectDescriptionPieces(child, textBucket, imageBucket);
    }
    return;
  }

  if (typeof node === "string") {
    const text = normalizeText(node);
    if (text) {
      textBucket.push(text);
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  const imageSrc = absoluteUrl(node?.img?.src || node?.img?.srcMobile || "");
  if (imageSrc) {
    imageBucket.push(imageSrc);
  }

  if (typeof node.content === "string") {
    const text = normalizeText(node.content);
    if (text) {
      textBucket.push(text);
    }
  } else if (node.content && typeof node.content === "object") {
    collectDescriptionPieces(node.content, textBucket, imageBucket);
  }

  if (typeof node.text === "string") {
    const text = normalizeText(node.text);
    if (text) {
      textBucket.push(text);
    }
  }

  for (const child of Object.values(node)) {
    if (child && typeof child === "object") {
      collectDescriptionPieces(child, textBucket, imageBucket);
    }
  }
}

function extractSeoDescriptionsFromPayload(payload) {
  const descriptions = [];
  for (const script of payload?.seo?.script || []) {
    if (script?.type !== "application/ld+json" || !script?.innerHTML) {
      continue;
    }

    try {
      const parsed = JSON.parse(script.innerHTML);
      const stack = [parsed];
      while (stack.length) {
        const current = stack.pop();
        if (!current) {
          continue;
        }

        if (Array.isArray(current)) {
          stack.push(...current);
          continue;
        }

        if (typeof current !== "object") {
          continue;
        }

        const text = normalizeMultilineText(current.description || "");
        if (text) {
          descriptions.push(text);
        }

        for (const child of Object.values(current)) {
          if (child && typeof child === "object") {
            stack.push(child);
          }
        }
      }
    } catch (_error) {
      // Ignore malformed SEO JSON-LD blobs.
    }
  }
  return uniqueStrings(descriptions);
}

function extractOzonDescription(states, payloads, shortCharacteristics, title = "") {
  const textParts = [];
  const images = [];

  for (const descriptionState of findAllOzonWidgetStates(states, "webDescription-")) {
    collectDescriptionPieces(descriptionState?.richAnnotationJson, textParts, images);
    const plainText = normalizeMultilineText(descriptionState?.text || "");
    if (plainText) {
      textParts.push(plainText);
    }
  }

  for (const payload of payloads || []) {
    textParts.push(...extractSeoDescriptionsFromPayload(payload));
  }

  if (!textParts.length && (shortCharacteristics || []).length) {
    const rows = shortCharacteristics
      .map((item) => {
        const name = normalizeText(item?.name || "");
        const values = (item?.values || []).map((value) => normalizeText(value)).filter(Boolean);
        if (!name || !values.length) {
          return "";
        }
        return `${name}: ${values.join(", ")}`;
      })
      .filter(Boolean)
      .slice(0, 14);
    if (rows.length) {
      const heading = normalizeText(title || "Description");
      textParts.push(`${heading}\n${rows.join("; ")}`.trim());
    }
  }

  return {
    title: normalizeText(title || "Description") || "Description",
    html: "",
    text: normalizeMultilineText(uniqueStrings(textParts).join("\n\n")),
    rawSectionHtml: "",
    images: uniqueStrings(images).map((src) => ({ src })),
    videos: []
  };
}

function extractOzonGallery(states, sourceUrl) {
  const galleryState = findOzonWidgetState(states, "webGallery-");
  if (!galleryState) {
    return {
      sku: "",
      coverImage: "",
      images: [],
      videos: [],
      videoCover: null
    };
  }

  const images = (galleryState.images || [])
    .map((item) => ({
      src: absoluteUrl(item?.src || "", sourceUrl),
      alt: normalizeText(item?.alt || "")
    }))
    .filter((item) => item.src);
  const videos = (galleryState.videos || [])
    .map((item) => ({
      name: normalizeText(item?.name || ""),
      url: absoluteUrl(item?.url || "", sourceUrl),
      coverUrl: absoluteUrl(item?.coverUrl || "", sourceUrl)
    }))
    .filter((item) => item.url);

  return {
    sku: normalizeText(galleryState.sku || ""),
    coverImage:
      absoluteUrl(galleryState.coverImage || "", sourceUrl) ||
      images[0]?.src ||
      "",
    images,
    videos,
    videoCover: absoluteUrl(galleryState.videoCover || "", sourceUrl) || null
  };
}

function extractOzonPricing(states) {
  const priceState = findOzonWidgetState(states, "webPrice-");
  if (!priceState) {
    return {
      source: "entrypoint-api",
      priceText: null,
      regularPriceText: null,
      cardPriceText: null,
      originalPriceText: null,
      priceValue: null,
      cardPriceValue: null,
      originalPriceValue: null,
      uploadPrice: null,
      oldPrice: null,
      currency: null,
      disclaimerTitle: "",
      disclaimerBody: ""
    };
  }

  const regularPriceText = normalizeText(priceState.price || "");
  const cardPriceText = normalizeText(priceState.cardPrice || "");
  const originalPriceText = normalizeText(priceState.originalPrice || "");
  const regularPriceValue = parsePriceValue(regularPriceText);
  const cardPriceValue = parsePriceValue(cardPriceText);
  const originalPriceValue = parsePriceValue(originalPriceText);
  const uploadPriceValue =
    regularPriceValue ??
    parsePriceValue(priceState.finalPrice || "") ??
    cardPriceValue ??
    null;

  return {
    source: "entrypoint-api",
    priceText: regularPriceText || cardPriceText || null,
    regularPriceText: regularPriceText || null,
    cardPriceText: cardPriceText || null,
    originalPriceText: originalPriceText || null,
    priceValue: regularPriceValue,
    cardPriceValue,
    originalPriceValue,
    uploadPrice: normalizePriceNumber(uploadPriceValue),
    oldPrice: normalizePriceNumber(originalPriceValue),
    currency: /CNY|¥|￥|楼/i.test(
      `${regularPriceText} ${cardPriceText} ${originalPriceText} ${priceState.disclaimerPriceHeader || ""}`
    )
      ? "CNY"
      : null,
    disclaimerTitle: normalizeText(priceState.disclaimerPriceHeader || ""),
    disclaimerBody: normalizeText(extractTextRs(priceState.disclaimerPriceBodyRs || []))
  };
}

function extractOzonMarketingLabels(states) {
  const labelsState = findOzonWidgetState(states, "webMarketingLabels-");
  return uniqueStrings(
    (labelsState?.labels || [])
      .map((item) => normalizeText(item?.badge?.text || item?.text || ""))
      .filter(Boolean)
  );
}

function extractOzonBreadcrumbs(states, sourceUrl) {
  const state = findOzonWidgetState(states, "breadCrumbs-");
  return (state?.breadcrumbs || [])
    .map((item) => ({
      text: normalizeText(item?.text || ""),
      url: absoluteUrl(item?.link || "", sourceUrl)
    }))
    .filter((item) => item.text);
}

function extractOzonVariants(states, sourceUrl, productId, title, pricing, gallery) {
  const variantsById = new Map();
  const aspectsState = findOzonWidgetState(states, "webAspects-");

  function upsertVariant(candidate, axis) {
    const variantProductId = Number(candidate?.productId);
    if (!Number.isFinite(variantProductId)) {
      return;
    }

    const existing = variantsById.get(variantProductId) || {
      productId: variantProductId,
      productUrl: "",
      title: "",
      variantSummary: "",
      variantAxes: [],
      imageUrl: "",
      currentPriceText: "",
      originalPriceText: "",
      availability: "",
      isCurrent: false
    };

    if (candidate?.productUrl) {
      existing.productUrl = candidate.productUrl;
    }
    if (candidate?.title) {
      existing.title = candidate.title;
    }
    if (candidate?.variantSummary) {
      existing.variantSummary = candidate.variantSummary;
    }
    if (candidate?.imageUrl) {
      existing.imageUrl = candidate.imageUrl;
    }
    if (candidate?.currentPriceText) {
      existing.currentPriceText = candidate.currentPriceText;
    }
    if (candidate?.originalPriceText) {
      existing.originalPriceText = candidate.originalPriceText;
    }
    if (candidate?.availability) {
      existing.availability = candidate.availability;
    }
    existing.isCurrent = existing.isCurrent || Boolean(candidate?.isCurrent);

    if (axis?.name && axis?.value) {
      existing.variantAxes = (existing.variantAxes || []).filter(
        (item) => normalizeText(item?.name || "").toLowerCase() !== normalizeText(axis.name).toLowerCase()
      );
      existing.variantAxes.push({
        name: normalizeText(axis.name),
        value: normalizeText(axis.value)
      });
    }

    variantsById.set(variantProductId, existing);
  }

  upsertVariant(
    {
      productId,
      productUrl: sourceUrl,
      title,
      variantSummary: "",
      imageUrl: gallery?.coverImage || gallery?.images?.[0]?.src || "",
      currentPriceText: pricing?.priceText || pricing?.cardPriceText || "",
      originalPriceText: pricing?.originalPriceText || "",
      availability: "inStock",
      isCurrent: true
    },
    null
  );

  for (const aspect of aspectsState?.aspects || []) {
    const axisName = normalizeText(aspect?.aspectName || "");
    for (const variant of aspect?.variants || []) {
      const variantUrl = absoluteUrl(variant?.link || "", sourceUrl);
      const variantProductId =
        extractProductIdFromText(variant?.sku || "") ||
        extractProductIdFromText(variantUrl || "") ||
        extractProductIdFromText(variant?.link || "");
      const axisValue = normalizeText(
        extractTextRs(variant?.data?.textRs) || variant?.data?.searchableText || ""
      );
      const variantSummary =
        axisName && axisValue ? `${axisName}: ${axisValue}` : axisValue || axisName;

      upsertVariant(
        {
          productId: variantProductId,
          productUrl: variantUrl,
          title: normalizeText(variant?.data?.title || title || ""),
          variantSummary,
          imageUrl: absoluteUrl(variant?.data?.coverImage || "", sourceUrl),
          currentPriceText: normalizeText(variant?.data?.price || ""),
          originalPriceText: normalizeText(variant?.data?.originalPrice || ""),
          availability: normalizeText(variant?.availability || ""),
          isCurrent: Number(variantProductId) === Number(productId)
        },
        {
          name: axisName,
          value: axisValue
        }
      );
    }
  }

  return [...variantsById.values()]
    .map((item) => ({
      ...item,
      variantAxes: Array.isArray(item.variantAxes) ? item.variantAxes : [],
      variantSummary:
        item.variantSummary ||
        (item.variantAxes || [])
          .map((axis) => `${normalizeText(axis?.name || "")}: ${normalizeText(axis?.value || "")}`)
          .filter(Boolean)
          .join(" | ")
    }))
    .sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent));
}

function extractCanonicalUrlFromPayloads(payloads) {
  for (const payload of payloads || []) {
    for (const item of payload?.seo?.link || []) {
      if (normalizeText(item?.rel || "").toLowerCase() !== "canonical") {
        continue;
      }
      const href = absoluteUrl(item?.href || "");
      if (href) {
        return href;
      }
    }
  }
  return "";
}

async function fetchOzonEntrypointPayload(innerUrl) {
  const normalizedInnerUrl = String(innerUrl || "").trim();
  if (!normalizedInnerUrl) {
    throw new Error("Missing product path.");
  }

  const targetPath = normalizedInnerUrl.startsWith("/") ? normalizedInnerUrl : `/${normalizedInnerUrl}`;
  const endpoint = `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(targetPath)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Ozon API request failed with status ${response.status}.`);
  }

  return response.json();
}

async function fetchOzonProductDataById(productId, productUrl = "") {
  const resolvedProductId =
    Number(productId) ||
    extractProductIdFromText(productUrl || "") ||
    extractProductIdFromUrl(productUrl || "");
  if (!Number.isFinite(resolvedProductId)) {
    throw new Error("Missing Ozon product id.");
  }

  const productPath = `/product/${resolvedProductId}/`;
  const payloads = await Promise.all([
    fetchOzonEntrypointPayload(productPath),
    fetchOzonEntrypointPayload(
      `${productPath}?layout_container=pdpPage2column&layout_page_index=2`
    )
  ]);
  const states = parseOzonWidgetStatesFromPayloads(payloads);
  const headingState = findOzonWidgetState(states, "webProductHeading-");
  const canonicalUrl = extractCanonicalUrlFromPayloads(payloads);
  const sourceUrl = absoluteUrl(productUrl || canonicalUrl || productPath, location.href);
  const title = normalizeText(headingState?.title || "") || `Ozon product ${resolvedProductId}`;
  const shortCharacteristics = extractOzonShortCharacteristics(states);
  const characteristics = extractOzonCharacteristics(states, shortCharacteristics);
  const gallery = extractOzonGallery(states, sourceUrl);
  const pricing = extractOzonPricing(states);
  const description = extractOzonDescription(states, payloads, shortCharacteristics, title);
  const productWeight = extractProductWeightFromCharacteristics(characteristics);

  return {
    extractionType: "upload-product",
    extractedAt: new Date().toISOString(),
    source: "ozon-entrypoint-api",
    sourceUrl,
    productId: Number(resolvedProductId),
    title,
    breadcrumbs: extractOzonBreadcrumbs(states, sourceUrl),
    brand: {},
    seller: {},
    marketingLabels: extractOzonMarketingLabels(states),
    hashtags: extractHashtags(description?.text || "", document),
    description,
    pricing,
    price: pricing?.uploadPrice || null,
    oldPrice: pricing?.oldPrice || null,
    productWeight,
    characteristics,
    characteristicsUrl: buildFeaturesUrl(sourceUrl),
    shortCharacteristics,
    gallery,
    variants: extractOzonVariants(
      states,
      sourceUrl,
      resolvedProductId,
      title,
      pricing,
      gallery
    ),
    stats: {
      characteristicCount: characteristics.length,
      shortCharacteristicCount: shortCharacteristics.length,
      hasPrice: Boolean(pricing?.uploadPrice),
      galleryImageCount: gallery?.images?.length || 0,
      galleryVideoCount: gallery?.videos?.length || 0,
      descriptionImageCount: description?.images?.length || 0,
      descriptionVideoCount: description?.videos?.length || 0
    }
  };
}

function extractWeightFromCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  const source = normalizeText(String(candidate).replace(/\u00a0/g, " "));
  const kilogramMatch = source.match(KG_RE);
  const gramMatch = source.match(GRAM_RE);
  const itemMatch = source.match(ITEM_RE);

  let weightKg = null;
  let weightText = null;

  if (kilogramMatch) {
    const rawValue = kilogramMatch[1].replace(",", ".");
    weightKg = Number(rawValue);
    weightText = `${rawValue} kg`;
  } else if (gramMatch) {
    const rawValue = gramMatch[1].replace(",", ".");
    const weightGrams = Number(rawValue);
    if (Number.isFinite(weightGrams)) {
      weightKg = Number((weightGrams / 1000).toFixed(6));
      weightText = `${rawValue} g`;
    }
  }

  if (!Number.isFinite(weightKg) || !weightText) {
    return null;
  }

  return {
    weightKg,
    weightText,
    orderInfo: source,
    itemCount: itemMatch ? Number(itemMatch[1]) : null
  };
}

function extractWeightFromCheckoutRoot(root) {
  const total = parseStateElementFromRoot(root, "state-total-");
  const split = parseStateElementFromRoot(root, "state-rfbsSplit-");

  const parsed =
    extractWeightFromCandidate(total?.state?.summary?.header?.info) ||
    extractWeightFromCandidate(total?.state?.sticky?.summary?.newAtomInfoText?.text) ||
    extractWeightFromCandidate(split?.state?.subHeader?.text) ||
    extractWeightFromCandidate(root.body?.innerText || "");

  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    totalStateId: total?.id || null,
    splitStateId: split?.id || null,
    deliveryText: split?.state?.dynamicElements?.[0]?.textAtom?.text || null
  };
}

function parseHtml(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

function extractProductIdFromText(text) {
  const match = String(text || "").match(/\b(\d{7,})\b/);
  return match ? Number(match[1]) : null;
}

function normalizeMetricLabel(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[：:]/g, "")
    .replace(/\s+/g, "");
}

function resolveSellerMetricKey(label) {
  const normalizedLabel = normalizeMetricLabel(label);

  for (const metric of SELLER_ANALYTICS_METRICS) {
    if (metric.labels.some((candidate) => normalizeMetricLabel(candidate) === normalizedLabel)) {
      return metric.key;
    }
  }

  return null;
}

function looksLikeMetricLabel(text) {
  return !!resolveSellerMetricKey(text);
}

function extractMetricEntry(label, value) {
  const cleanLabel = normalizeText(label);
  const cleanValue = normalizeText(value);
  if (!cleanLabel || !cleanValue) {
    return null;
  }

  return {
    key: resolveSellerMetricKey(cleanLabel),
    label: cleanLabel,
    value: cleanValue
  };
}

function extractMetricsFromLines(lines) {
  const items = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeText(lines[index]);
    if (!line) {
      continue;
    }

    let entry = null;
    const colonMatch = line.match(/^(.{1,40}?)[：:]\s*(.+)$/);
    if (colonMatch) {
      entry = extractMetricEntry(colonMatch[1], colonMatch[2]);
    } else {
      const compactParts = line.split(/\s{2,}/g).map((part) => normalizeText(part)).filter(Boolean);
      if (compactParts.length >= 2 && looksLikeMetricLabel(compactParts[0])) {
        entry = extractMetricEntry(compactParts[0], compactParts.slice(1).join(" "));
      } else if (
        index + 1 < lines.length &&
        looksLikeMetricLabel(line) &&
        !looksLikeMetricLabel(lines[index + 1])
      ) {
        entry = extractMetricEntry(line, lines[index + 1]);
        index += 1;
      }
    }

    if (!entry) {
      continue;
    }

    const dedupeKey = `${entry.key || entry.label}:${entry.value}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    items.push(entry);
  }

  return items;
}

function countSellerMetricSignals(text) {
  const normalized = normalizeMetricLabel(text);
  let count = 0;

  for (const metric of SELLER_ANALYTICS_METRICS) {
    if (metric.labels.some((label) => normalized.includes(normalizeMetricLabel(label)))) {
      count += 1;
    }
  }

  return count;
}

function extractSellerAnalyticsEntryFromNode(node) {
  const text = normalizeMultilineText(node.innerText || "");
  if (!text || text.length < 80 || text.length > 5000) {
    return null;
  }

  const productId = extractProductIdFromText(text);
  if (!productId) {
    return null;
  }

  const metricSignalCount = countSellerMetricSignals(text);
  if (metricSignalCount < 4) {
    return null;
  }

  const lines = splitNormalizedLines(node.innerText || "");
  const metrics = extractMetricsFromLines(lines);
  if (metrics.length < 4) {
    return null;
  }

  const titleCandidate =
    normalizeText(node.querySelector("a")?.innerText || "") ||
    lines.find(
      (line) =>
        !line.includes(String(productId)) &&
        !looksLikeMetricLabel(line) &&
        line.length >= 6 &&
        line.length <= 140
    ) ||
    null;

  return {
    productId,
    title: titleCandidate,
    sourceUrl: location.href,
    updatedAt: new Date().toISOString(),
    metrics,
    metricSignalCount,
    rawLines: lines.slice(0, 80)
  };
}

function findSellerAnalyticsEntries() {
  const candidates = new Map();
  const nodes = document.querySelectorAll("article, li, tr, [role='row'], section, div");

  for (const node of nodes) {
    const entry = extractSellerAnalyticsEntryFromNode(node);
    if (!entry) {
      continue;
    }

    const score =
      entry.metrics.length * 10 +
      entry.metricSignalCount * 3 +
      (entry.title ? 5 : 0) -
      Math.floor(entry.rawLines.length / 10);
    const existing = candidates.get(entry.productId);

    if (!existing || score > existing.score) {
      candidates.set(entry.productId, {
        score,
        entry: {
          productId: entry.productId,
          title: entry.title,
          sourceUrl: entry.sourceUrl,
          updatedAt: entry.updatedAt,
          metrics: entry.metrics,
          rawLines: entry.rawLines
        }
      });
    }
  }

  return Array.from(candidates.values()).map((item) => item.entry);
}

async function syncSellerAnalyticsFromPage() {
  const items = findSellerAnalyticsEntries();
  if (!items.length) {
    return 0;
  }

  const response = await sendMessage({
    type: "upsert-seller-analytics",
    items
  });

  if (response?.count) {
    showOverlay(`Seller analytics synced: ${response.count} products`, "#475569");
  }

  return response?.count || 0;
}

function scheduleSellerAnalyticsSync() {
  clearTimeout(sellerAnalyticsSyncTimer);
  sellerAnalyticsSyncTimer = setTimeout(() => {
    void syncSellerAnalyticsFromPage();
  }, 800);
}

function ensureSellerAnalyticsObserver() {
  if (sellerAnalyticsSyncObserver) {
    return;
  }

  sellerAnalyticsSyncObserver = new MutationObserver(() => {
    scheduleSellerAnalyticsSync();
  });

  sellerAnalyticsSyncObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function ensureSellerAnalyticsStyles() {
  if (document.getElementById(SELLER_ANALYTICS_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = SELLER_ANALYTICS_STYLE_ID;
  style.textContent = `
    .${SELLER_ANALYTICS_PANEL_CLASS} {
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #d4d4d8;
      color: #111827;
      font: 11px/1.45 "Segoe UI", Arial, sans-serif;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.3);
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}[data-layout="product-page"] {
      max-width: 388px;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}[data-layout="card"] {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      margin-top: 0;
      max-height: 42%;
      overflow: auto;
      border-radius: 12px;
      background: rgba(212, 212, 216, 0.92);
      z-index: 4;
      box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.12);
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}[data-layout="card"]::-webkit-scrollbar {
      width: 6px;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}[data-layout="card"]::-webkit-scrollbar-thumb {
      background: rgba(107, 114, 128, 0.6);
      border-radius: 999px;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}__meta {
      color: #4b5563;
      font-size: 10px;
      font-weight: 500;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}__grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 2px 10px;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}__metric {
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}__label {
      flex: 0 0 auto;
      color: #374151;
      white-space: nowrap;
    }
    .${SELLER_ANALYTICS_PANEL_CLASS}__value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #111827;
    }
    #${PRODUCT_DASHBOARD_SLOT_ID},
    .${PRODUCT_DASHBOARD_SLOT_CLASS} {
      width: 100%;
    }
    #${PRODUCT_DASHBOARD_SLOT_ID} {
      max-width: 396px;
      margin: 0 0 12px;
    }
    .${PRODUCT_DASHBOARD_SLOT_CLASS}[data-layout="card"] {
      margin-top: 10px;
    }
    .${PRODUCT_DASHBOARD_CLASS} {
      box-sizing: border-box;
      width: 100%;
      padding: 14px;
      border-radius: 18px;
      border: 1px solid #e5e7eb;
      background: #f3f4f6;
      color: #111827;
      font: 12px/1.35 "Inter", "Microsoft YaHei", "Segoe UI", sans-serif;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
    }
    .${PRODUCT_DASHBOARD_CLASS}__header {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 8px;
      margin-bottom: 10px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__eyebrow {
      margin-bottom: 3px;
      color: #6b7280;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .${PRODUCT_DASHBOARD_CLASS}__id {
      margin: 0;
      color: #111827;
      font-size: 22px;
      line-height: 1.1;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}__chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      margin-top: 6px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 20px;
      max-width: 100%;
      padding: 0 8px;
      border-radius: 999px;
      background: #dbeafe;
      color: #1d4ed8;
      font-size: 10px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${PRODUCT_DASHBOARD_CLASS}__chip-flag {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      object-fit: cover;
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.08);
    }
    .${PRODUCT_DASHBOARD_CLASS}__chip-flag--emoji {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 0;
      box-shadow: none;
      font-size: 13px;
      line-height: 1;
    }
    .${PRODUCT_DASHBOARD_CLASS}__chip--muted {
      background: #e5e7eb;
      color: #4b5563;
      font-weight: 600;
    }
    .${PRODUCT_DASHBOARD_CLASS}__chip--success {
      background: #dcfce7;
      color: #15803d;
      font-weight: 700;
    }
    .${PRODUCT_DASHBOARD_CLASS}__header-side {
      flex: 0 0 auto;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__rating {
      color: #111827;
      font-size: 16px;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}__rating-sub {
      margin-top: 3px;
      color: #6b7280;
      font-size: 11px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__updated {
      margin-top: 14px;
      color: #9ca3af;
      font-size: 11px;
      white-space: nowrap;
    }
    .${PRODUCT_DASHBOARD_CLASS}__notice {
      margin: 0 0 10px;
      padding: 8px 10px;
      border-radius: 12px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1d4ed8;
      font-size: 11px;
      line-height: 1.45;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__section {
      padding: 10px;
      border-radius: 14px;
      background: #ffffff;
      border: 1px solid #eceff3;
    }
    .${PRODUCT_DASHBOARD_CLASS}__section-title {
      margin: 0 0 8px;
      color: #9ca3af;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .${PRODUCT_DASHBOARD_CLASS}__cards {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(0, 0.75fr);
      align-items: stretch;
      gap: 8px;
      margin-bottom: 6px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 8px 10px;
      min-height: 68px;
      border-radius: 12px;
      border: 1px solid #dbeafe;
      background: #eff6ff;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card--primary {
      min-width: 0;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card--secondary {
      min-width: 0;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card--warm {
      border-color: #fed7aa;
      background: #fff7ed;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card-label {
      width: 100%;
      color: #2563eb;
      font-size: 10px;
      line-height: 1.25;
      margin-bottom: 2px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card--warm .${PRODUCT_DASHBOARD_CLASS}__card-label {
      color: #ea580c;
    }
    .${PRODUCT_DASHBOARD_CLASS}__card-value {
      color: #111827;
      width: 100%;
      font-size: 17px;
      font-weight: 800;
      line-height: 1.15;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__subgrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 10px;
      margin-top: 6px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__subgrid > div {
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__subitem-label {
      margin-bottom: 2px;
      color: #9ca3af;
      font-size: 10px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__subitem-value {
      color: #374151;
      font-size: 12px;
      font-weight: 700;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__funnel-top {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      color: #4b5563;
      font-size: 11px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__progress {
      margin: 8px 0 10px;
      width: 100%;
      height: 5px;
      border-radius: 999px;
      overflow: hidden;
      background: #e5e7eb;
    }
    .${PRODUCT_DASHBOARD_CLASS}__progress-bar {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #3b82f6, #60a5fa);
    }
    .${PRODUCT_DASHBOARD_CLASS}__triple {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__triple-item {
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__triple-item + .${PRODUCT_DASHBOARD_CLASS}__triple-item {
      border-left: 1px solid #eef2f7;
    }
    .${PRODUCT_DASHBOARD_CLASS}__triple-label {
      margin-bottom: 2px;
      color: #9ca3af;
      font-size: 10px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__triple-value {
      color: #111827;
      font-size: 12px;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}__pairs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 10px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__pair {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding-bottom: 4px;
      border-bottom: 1px solid #f3f4f6;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__pair-label {
      color: #6b7280;
      font-size: 11px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__pair-value {
      color: #111827;
      font-size: 11px;
      font-weight: 800;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__pair-value--accent {
      color: #4338ca;
    }
    .${PRODUCT_DASHBOARD_CLASS}__pair-value--danger {
      color: #dc2626;
    }
    .${PRODUCT_DASHBOARD_CLASS}__campaign-box {
      padding: 10px;
      border-radius: 12px;
      background: #f9fafb;
      border: 1px solid #eceff3;
    }
    .${PRODUCT_DASHBOARD_CLASS}__campaign-top {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      margin-bottom: 6px;
      color: #6b7280;
      font-size: 11px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__campaign-value {
      color: #2563eb;
      font-size: 11px;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}__campaign-meta {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-top: 8px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__campaign-meta > div {
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__button {
      min-height: 32px;
      border: 0;
      border-radius: 11px;
      color: #ffffff;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
    }
    .${PRODUCT_DASHBOARD_CLASS}__button:hover:not([disabled]) {
      transform: translateY(-1px);
    }
    .${PRODUCT_DASHBOARD_CLASS}__button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .${PRODUCT_DASHBOARD_CLASS}__button--orange {
      background: #f97316;
      box-shadow: 0 10px 24px rgba(249, 115, 22, 0.22);
    }
    .${PRODUCT_DASHBOARD_CLASS}__button--red {
      background: #ef4444;
      box-shadow: 0 10px 24px rgba(239, 68, 68, 0.22);
    }
    .${PRODUCT_DASHBOARD_CLASS}__button--blue {
      background: #2563eb;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.22);
    }
    .${PRODUCT_DASHBOARD_CLASS}__status {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 16px;
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-main {
      min-width: 0;
      flex: 1 1 auto;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-label {
      color: #6b7280;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-value {
      margin-top: 4px;
      color: #111827;
      font-size: 14px;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-summary {
      margin-top: 6px;
      color: #4b5563;
      font-size: 12px;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-value[data-tone="running"] {
      color: #b45309;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-value[data-tone="done"] {
      color: #0f766e;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-value[data-tone="error"] {
      color: #b91c1c;
    }
    .${PRODUCT_DASHBOARD_CLASS}__status-extra {
      color: #6b7280;
      font-size: 12px;
      text-align: center;
      white-space: normal;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"],
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] {
      padding: 12px;
      border-radius: 14px;
      font-size: 12px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] {
      padding: 14px;
      border-radius: 18px;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      height: 440px;
      border-color: rgba(148, 163, 184, 0.46);
      box-shadow:
        0 24px 48px rgba(15, 23, 42, 0.18),
        0 12px 28px rgba(51, 65, 85, 0.14),
        0 0 0 1px rgba(148, 163, 184, 0.16);
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__id,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__id {
      font-size: 16px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__header,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__grid {
      display: none;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-header {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-header-main {
      min-width: 0;
      flex: 1 1 auto;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-id {
      margin: 0;
      color: #0f172a;
      font-size: 12px;
      line-height: 1.1;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-meta {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: nowrap;
      gap: 4px;
      margin-top: 8px;
      min-width: 0;
      overflow: hidden;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 18px;
      max-width: 100%;
      padding: 0 6px;
      border-radius: 6px;
      background: #3b82f6;
      color: #ffffff;
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-meta > .${PRODUCT_DASHBOARD_CLASS}__card-badge:first-child {
      flex: 0 1 74px;
      max-width: 74px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-badge--success {
      flex: 0 0 auto;
      background: #dcfce7;
      color: #15803d;
      text-transform: none;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-badge--muted {
      align-items: center;
      background: #e5e7eb;
      color: #4b5563;
      justify-content: flex-start;
      width: 82px;
      max-width: 82px;
      flex: 0 0 82px;
      overflow: hidden;
      text-overflow: clip;
      text-transform: none;
      white-space: nowrap;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-seller-name {
      display: block;
      min-width: 0;
      flex: 1 1 auto;
      line-height: 1.1;
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-badge .${PRODUCT_DASHBOARD_CLASS}__chip-flag {
      display: block;
      flex: 0 0 auto;
      width: 12px;
      height: 12px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-badge .${PRODUCT_DASHBOARD_CLASS}__chip-flag--emoji {
      display: inline-flex;
      width: 13px;
      height: 13px;
      font-size: 12px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-meta-text {
      min-width: 0;
      color: #64748b;
      font-size: 10px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpis {
      display: grid;
      grid-template-columns: minmax(0, 0.98fr) minmax(0, 1.02fr);
      gap: 10px;
      min-height: 68px;
      align-items: stretch;
      margin-bottom: 14px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi {
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 68px;
      padding: 2px 0 2px 11px;
      border-left: 3px solid #3b82f6;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi--sales {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 48px;
      align-items: center;
      gap: 4px;
      border-left-color: #f97316;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi-copy {
      min-width: 0;
      flex: 1 1 auto;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi-label {
      color: #94a3b8;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.04em;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi-label--warm {
      color: #f97316;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi-value {
      margin-top: 5px;
      color: #0f172a;
      font-size: 15px;
      line-height: 1.1;
      font-weight: 900;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      word-break: normal;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-kpi-note {
      margin-top: 4px;
      color: #ef4444;
      font-size: 7.5px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      word-break: normal;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-sparkline {
      flex: 0 0 48px;
      width: 48px;
      height: 30px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-sparkline svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion {
      margin-bottom: 14px;
      padding: 11px 12px;
      border-radius: 14px;
      background: #f8fafc;
      border: 1px solid #eef2f7;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion-head {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion-label {
      color: #475569;
      font-size: 10px;
      font-weight: 800;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion-value {
      color: #2563eb;
      font-size: 11px;
      font-weight: 900;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion-track {
      position: relative;
      height: 8px;
      border-radius: 999px;
      overflow: hidden;
      background: #e2e8f0;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion-fill {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 999px;
      background: linear-gradient(90deg, #60a5fa, #3b82f6);
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-conversion-fill--secondary {
      background: linear-gradient(90deg, #4f46e5, #6366f1);
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stats-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px 10px;
      padding-bottom: 14px;
      border-bottom: 1px solid #f1f5f9;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stat {
      min-width: 0;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stat-label {
      color: #94a3b8;
      font-size: 9px;
      font-weight: 800;
      line-height: 1.25;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stat-value {
      margin-top: 4px;
      color: #1e293b;
      font-size: 12px;
      font-weight: 800;
      line-height: 1.2;
      word-break: break-word;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stat-value--blue {
      color: #4338ca;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stat-value--green {
      color: #059669;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-stat-value--red {
      color: #ef4444;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-footer {
      margin-top: auto;
      padding-top: 12px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-footer-row {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-footer-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-width: 0;
      color: #475569;
      font-size: 10px;
      font-weight: 500;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-footer-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #f97316;
      flex: 0 0 auto;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-footer-value {
      color: #1e293b;
      font-size: 12px;
      font-weight: 900;
      white-space: nowrap;
      text-align: center;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__actions {
      margin-top: 0;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__actions--card {
      gap: 8px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__button {
      min-height: 36px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 900;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__button:disabled {
      opacity: 1;
      cursor: default;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__button--card-secondary {
      background: #ffffff;
      color: #334155;
      border: 1px solid #dbe2ea;
      box-shadow: 0 4px 12px rgba(148, 163, 184, 0.15);
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__button--card-primary {
      background: linear-gradient(135deg, #fb7185, #f43f5e);
      box-shadow: 0 12px 24px rgba(244, 63, 94, 0.24);
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__button--card-accent {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      box-shadow: 0 12px 24px rgba(37, 99, 235, 0.24);
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__card {
      justify-content: flex-start;
      min-height: 78px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__card-label {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      min-height: 26px;
      margin-bottom: 4px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__card-value {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1 1 auto;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__cards {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.78fr);
      gap: 6px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card {
      padding: 7px 8px;
      min-height: 60px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-label {
      font-size: 9px;
      line-height: 1.15;
      margin-bottom: 2px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__card-value {
      font-size: 13px;
      line-height: 1.1;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__triple,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__campaign-meta,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__triple,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__campaign-meta {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__header {
      justify-content: flex-start;
      text-align: left;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__chips {
      justify-content: flex-start;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__chips > .${PRODUCT_DASHBOARD_CLASS}__chip:nth-child(2) {
      background: #dcfce7;
      color: #15803d;
      font-weight: 700;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__header-side {
      text-align: left;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__pair,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__pair {
      padding-bottom: 4px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__section,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__section {
      padding: 9px;
      border-radius: 12px;
    }
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="card"] .${PRODUCT_DASHBOARD_CLASS}__button,
    .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"] .${PRODUCT_DASHBOARD_CLASS}__button {
      min-height: 30px;
      font-size: 11px;
    }
    @media (max-width: 900px) {
      #${PRODUCT_DASHBOARD_SLOT_ID} {
        max-width: none;
      }
      .${PRODUCT_DASHBOARD_CLASS} {
        padding: 18px;
        border-radius: 18px;
      }
      .${PRODUCT_DASHBOARD_CLASS}__grid,
      .${PRODUCT_DASHBOARD_CLASS}__cards,
      .${PRODUCT_DASHBOARD_CLASS}__pairs,
      .${PRODUCT_DASHBOARD_CLASS}__actions {
        grid-template-columns: 1fr;
      }
      .${PRODUCT_DASHBOARD_CLASS}__triple,
      .${PRODUCT_DASHBOARD_CLASS}__campaign-meta {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .${PRODUCT_DASHBOARD_CLASS}__header,
      .${PRODUCT_DASHBOARD_CLASS}__status {
        flex-direction: column;
      }
      .${PRODUCT_DASHBOARD_CLASS}__header-side,
      .${PRODUCT_DASHBOARD_CLASS}__status-extra {
        text-align: left;
      }
    }
  `;
  document.head.appendChild(style);
}

function findBuyerMountHost(startNode, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 14;
  const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : 140;
  const maxWidth = Number.isFinite(options.maxWidth) ? options.maxWidth : 760;
  const minTextLength = Number.isFinite(options.minTextLength) ? options.minTextLength : 20;
  const maxTextLength = Number.isFinite(options.maxTextLength) ? options.maxTextLength : 3200;
  const productId = Number(options.productId) || null;
  let fallback = null;
  let current = startNode instanceof Element ? startNode : startNode?.parentElement || null;

  for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
    if (!current || current === document.body || current === document.documentElement) {
      break;
    }

    const rect = current.getBoundingClientRect();
    const textLength = normalizeText(current.innerText || "").length;
    const matchingLinks = productId
      ? current.querySelectorAll(`a[href*="${productId}"]`).length
      : current.querySelectorAll('a[href*="/product/"]').length;
    const hasImage = !!current.querySelector("img");
    const hasAction = !!current.querySelector(
      'button, [role="button"], [data-widget="webAddToCart"], [id^="state-webAddToCart-"]'
    );
    const isStructuredContainer =
      /^(ARTICLE|LI|SECTION|ASIDE)$/i.test(current.tagName) ||
      current.hasAttribute("data-widget") ||
      current.hasAttribute("data-index");

    if (!fallback && rect.width >= minWidth && rect.height >= 40) {
      fallback = current;
    }

    if (
      rect.width >= minWidth &&
      rect.width <= maxWidth &&
      textLength >= minTextLength &&
      textLength <= maxTextLength &&
      (matchingLinks >= 1 || hasAction || isStructuredContainer) &&
      (hasImage || hasAction || isStructuredContainer)
    ) {
      return current;
    }
  }

  return fallback || (startNode instanceof Element ? startNode.parentElement || startNode : null);
}

function findProductPageHost(productId) {
  const candidates = [
    document.querySelector('[data-widget="webSale"]'),
    document.querySelector('[data-widget="webAddToCart"]'),
    document.querySelector('[data-widget="webStickyProducts"]'),
    document.querySelector('[id^="state-webAddToCart-"]'),
    findActionButtonByWidget("webAddToCart"),
    document.querySelector('[data-widget="webPrice"]'),
    document.querySelector('[data-widget="webProductHeading"]'),
    document.querySelector("h1")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const host = findBuyerMountHost(candidate, {
      productId,
      maxDepth: 16,
      minWidth: 220,
      maxWidth: 1600,
      minTextLength: 0,
      maxTextLength: 6000
    });
    if (host) {
      return host;
    }
  }

  return null;
}

function findBuyerCardHost(anchor, productId) {
  return findBuyerMountHost(anchor, {
    productId,
    maxDepth: 14,
    minWidth: 140,
    maxWidth: 760,
    minTextLength: 20,
    maxTextLength: 3200
  });
}

function collectBuyerTargets() {
  const targets = [];

  if (isProductPage()) {
    const productId = extractProductIdFromUrl();
    const host = findProductPageHost(productId);

    if (productId && host) {
      targets.push({ productId, host, layout: "product-page" });
    }

    return targets;
  }

  const seenHosts = new WeakSet();
  const seenProductIds = new Set();
  const anchors = document.querySelectorAll('a[href*="/product/"]');
  for (const anchor of anchors) {
    const productId = extractProductIdFromText(anchor.href || "");
    if (!productId || seenProductIds.has(productId)) {
      continue;
    }

    const host = findBuyerCardHost(anchor, productId);
    if (!host || seenHosts.has(host)) {
      continue;
    }

    seenHosts.add(host);
    seenProductIds.add(productId);
    targets.push({ productId, host, layout: "card" });
  }

  return targets;
}

function pruneDuplicateBuyerDashboardSlots() {
  const seenProductIds = new Set();
  for (const slot of document.querySelectorAll(`.${PRODUCT_DASHBOARD_SLOT_CLASS}[data-product-id]`)) {
    const productId = Number(slot.dataset.productId || 0);
    if (!productId) {
      continue;
    }

    if (seenProductIds.has(productId)) {
      slot.remove();
      continue;
    }

    seenProductIds.add(productId);
  }
}

function buildBuyerAnalyticsFallbackRecord(productId, errorText = "") {
  const message = normalizeText(errorText || "");
  return {
    productId,
    status: message ? "error" : "placeholder",
    notice: message,
    raw: null,
    metrics: message
      ? [
          {
            key: "status",
            label: "Status",
            value: message
          }
        ]
      : []
  };
}

function orderSellerMetrics(metrics) {
  const fallbackIndex = SELLER_ANALYTICS_METRIC_ORDER.length + 100;

  return [...(metrics || [])]
    .map((metric, index) => ({ metric, index }))
    .sort((left, right) => {
      const leftIndex = left.metric.key ? SELLER_ANALYTICS_METRIC_ORDER.indexOf(left.metric.key) : -1;
      const rightIndex = right.metric.key ? SELLER_ANALYTICS_METRIC_ORDER.indexOf(right.metric.key) : -1;
      const safeLeftIndex = leftIndex >= 0 ? leftIndex : fallbackIndex;
      const safeRightIndex = rightIndex >= 0 ? rightIndex : fallbackIndex;

      if (safeLeftIndex !== safeRightIndex) {
        return safeLeftIndex - safeRightIndex;
      }

      return left.index - right.index;
    })
    .map(({ metric }) => metric);
}

function removeLegacyProductPageAnalyticsPanels() {
  for (const panel of document.querySelectorAll(
    `.${SELLER_ANALYTICS_PANEL_CLASS}[data-layout="product-page"]`
  )) {
    panel.remove();
  }
}

function removeLegacyDashboardArtifacts(productId) {
  for (const panel of document.querySelectorAll(
    `.${SELLER_ANALYTICS_PANEL_CLASS}[data-product-id="${productId}"]`
  )) {
    panel.remove();
  }
}

function getBuyerDashboardSlot(host, layout, productId) {
  if (layout === "product-page") {
    const parent = host.parentElement || host;
    let slot = document.getElementById(PRODUCT_DASHBOARD_SLOT_ID);

    if (!slot) {
      slot = document.createElement("section");
      slot.id = PRODUCT_DASHBOARD_SLOT_ID;
    }

    slot.className = `${PRODUCT_DASHBOARD_SLOT_CLASS} notranslate`;
    slot.setAttribute("translate", "no");
    slot.dataset.layout = layout;
    slot.dataset.productId = String(productId);

    if (slot.parentElement !== parent || slot.nextElementSibling !== host) {
      parent.insertBefore(slot, host);
    }

    return slot;
  }

  let slot = host.querySelector(`.${PRODUCT_DASHBOARD_SLOT_CLASS}[data-product-id="${productId}"]`);

  if (!slot) {
    slot = document.createElement("section");
    slot.className = `${PRODUCT_DASHBOARD_SLOT_CLASS} notranslate`;
    slot.setAttribute("translate", "no");
    slot.dataset.productId = String(productId);
    slot.dataset.layout = layout;
  } else {
    slot.classList.add("notranslate");
    slot.setAttribute("translate", "no");
  }

  if (slot.parentElement !== host) {
    host.appendChild(slot);
  }

  return slot;
}

function buildProductDashboardRenderKey(record, layout, productId, cardContext) {
  return JSON.stringify({
    layout,
    productId,
    status: normalizeText(record?.status || ""),
    updatedAt: normalizeText(record?.updatedAt || ""),
    metricCount: Array.isArray(record?.metrics) ? record.metrics.length : 0,
    title: normalizeText(cardContext?.title || record?.title || ""),
    productUrl: normalizeText(cardContext?.productUrl || record?.sourceUrl || "")
  });
}

function buildProductDashboardJobView(job, fallbackProductWeight) {
  if (!job) {
    return {
      tone: "idle",
      statusLabel: "待命",
      statusSummary: "点击“强制跟卖”后会执行 One-Click Extract All，并保留结果用于后续处理。",
      statusExtra: fallbackProductWeight ? `商品重量: ${fallbackProductWeight}` : "尚未采集包装重量",
      buttonLabel: "强制跟卖",
      running: false
    };
  }

  if (job.status === "running") {
    return {
      tone: "running",
      statusLabel: "执行中",
      statusSummary: `当前阶段: ${formatJobStage(job.stage) || "running"}`,
      statusExtra: "正在请求并提取商品数据",
      buttonLabel: "执行中...",
      running: true
    };
  }

  if (job.status === "error") {
    return {
      tone: "error",
      statusLabel: "失败",
      statusSummary: normalizeText(job.error || "未知错误"),
      statusExtra: fallbackProductWeight ? `商品重量: ${fallbackProductWeight}` : "请重试",
      buttonLabel: "重新执行",
      running: false
    };
  }

  if (job.status === "done" && job.result) {
    const packageWeight = normalizeText(job.result.packageWeight?.weightText || job.result.weightText || "");
    const productWeight = normalizeText(
      job.result.productWeight?.weightText || fallbackProductWeight || ""
    );
    return {
      tone: "done",
      statusLabel: "已完成",
      statusSummary:
        packageWeight || productWeight
          ? `包装重量: ${packageWeight || "-"} / 商品重量: ${productWeight || "-"}`
          : "最新任务已完成",
      statusExtra: `完成时间: ${formatLocalDateTime(job.updatedAt)}`,
      buttonLabel: "再次执行",
      running: false
    };
  }

  return {
    tone: "idle",
    statusLabel: normalizeText(job.status || "待命"),
    statusSummary: "当前没有可展示的结果。",
    statusExtra: fallbackProductWeight ? `商品重量: ${fallbackProductWeight}` : "尚未采集包装重量",
    buttonLabel: "强制跟卖",
    running: false
  };
}

function getRelevantJobForProduct(job, productId) {
  if (!job) {
    return null;
  }

  const jobProductId = Number(job.result?.productId || job.productId || 0);
  return jobProductId && Number(productId) === jobProductId ? job : null;
}

function buildUploadDashboardJobView(job, fallbackProductWeight) {
  const fallbackStatusExtra = "等待包装重量与云端任务";

  if (!job) {
    return {
      tone: "idle",
      statusLabel: "待命",
      statusSummary: "点击“一键上货”后会先在本地抓取并清洗商品，再发送到云端上货。",
      statusExtra: fallbackStatusExtra,
      buttonLabel: "一键上货",
      running: false
    };
  }

  const hdUpload = job.result?.hdUpload || job.hdUpload || null;
  const packageWeight = normalizeText(job.result?.packageWeight?.weightText || job.result?.weightText || "");

  if (job.status === "running") {
    const isHdStage = isCloudUploadStage(job.stage);
    return {
      tone: "running",
      statusLabel: "执行中",
      statusSummary: isHdStage
        ? `云端阶段: ${formatJobStage(hdUpload?.status || job.stage) || "running"}`
        : `当前阶段: ${formatJobStage(job.stage) || "running"}`,
      statusExtra: isHdStage
        ? hdUpload?.ozonTaskId
          ? `平台任务: ${hdUpload.ozonTaskId}`
          : "云端正在清洗并提交商品"
        : "正在本地提取商品数据与包装重量",
      buttonLabel: "执行中...",
      running: true
    };
  }

  if (job.status === "error") {
    return {
      tone: "error",
      statusLabel: "失败",
      statusSummary: normalizeText(job.error || hdUpload?.error || "未知错误"),
      statusExtra: fallbackStatusExtra,
      buttonLabel: "重新上货",
      running: false
    };
  }

  if (job.status === "done" && job.result) {
    const uploadTaskId = normalizeText(hdUpload?.ozonTaskId || "");
    return {
      tone: "done",
      statusLabel: "已完成",
      statusSummary: uploadTaskId
        ? `云端上货已完成，Task ID: ${uploadTaskId}`
        : packageWeight
          ? `包装重量: ${packageWeight}`
          : "最新任务已完成",
      statusExtra: [
        packageWeight
          ? `包装重量: ${packageWeight}`
          : null,
        `完成时间: ${formatLocalDateTime(job.updatedAt)}`
      ]
        .filter(Boolean)
        .join(" | "),
      buttonLabel: "再次上货",
      running: false
    };
  }

  return {
    tone: "idle",
    statusLabel: normalizeText(job.status || "待命"),
    statusSummary: "当前没有可展示的结果。",
    statusExtra: fallbackStatusExtra,
    buttonLabel: "一键上货",
    running: false
  };
}

function isCloudUploadStage(stage) {
  return /^(submit_(cloud|hd)|(cloud|hd)_)/.test(normalizeText(stage));
}

function isRemoteUploadStage(stage) {
  return /^(submit_(cloud|hd)|cloud_(pending|queued|draft|cleaning|ready|uploading)|hd_(queued|draft|cleaning|ready|uploading))/.test(
    normalizeText(stage)
  );
}

function shouldAutoResumeJob(job) {
  if (!job || job.status !== "running") {
    return false;
  }

  if (job.jobType !== "upload-product") {
    return true;
  }

  return !isRemoteUploadStage(job.stage) && !job.result?.hdUpload && !job.hdUpload;
}

async function startProductDashboardCloudUpload(productUrl, layout) {
  const startResponse = await sendMessage({
    type: "start-job",
    jobType: "upload-product",
    url: productUrl,
    deferRun: true
  });

  if (!startResponse?.ok) {
    throw new Error(startResponse?.error || "无法启动云端上货任务。");
  }

  await sendMessage({
    type: "job-update",
    patch: {
      stage: "cloud_local_extract",
      error: null
    },
    note: "cloud-local-extract"
  });

  const result =
    layout === "product-page"
      ? await extractCurrentProductDataForUpload()
      : await extractProductDataFromUrl(productUrl);

  const submitResponse = await sendMessage({ type: "job-result", result });
  if (!submitResponse?.ok) {
    throw new Error(submitResponse?.error || "云端上货提交失败。");
  }

  return submitResponse.job || startResponse.job || null;
}

function extractCardDashboardContext(host, record) {
  const anchor = host.querySelector('a[href*="/product/"]');
  const productUrl = absoluteUrl(anchor?.getAttribute("href") || record?.sourceUrl || "");

  return {
    title: normalizeText(anchor?.innerText || record?.title || ""),
    rating: extractVisibleProductRating(host),
    productUrl
  };
}

function buildCardDashboardMarkup(record, template, job, options = {}) {
  const productId = record?.productId || options.productId || "";
  const metricMap = buildMetricMap(record);
  const raw = record?.raw || {};
  const brand = options.brand || getMetricValue(metricMap, "brand");
  const sellerInfo = options.sellerInfo || null;
  const otherSellerCount = normalizeText(sellerInfo?.otherSellerCount || "0") || "0";
  const sellerCountryCode =
    sellerInfo?.countryFlag ||
    inferCountryCodeFromText(`${sellerInfo?.originCountry || ""} ${sellerInfo?.addressText || ""}`);
  const sellerName = normalizeText(sellerInfo?.sellerName || getMetricValue(metricMap, "storeName") || "-");
  const sellerFlagMarkup = buildCountryFlagMarkup(sellerCountryCode);
  const progressRatio = (() => {
    const search = Number(String(raw.sessionCountSearch ?? "").replace(/[^\d.-]/g, ""));
    const views = Number(String(raw.views ?? "").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(search) || !Number.isFinite(views) || views <= 0) {
      return 36;
    }
    return Math.max(12, Math.min(92, Math.round((search / views) * 100)));
  })();
  const cartRateNumber = parseMetricNumber(getMetricValue(metricMap, "cartConversion"));
  const secondaryProgress = Math.max(
    4,
    Math.min(22, Math.round((Number.isFinite(cartRateNumber) ? cartRateNumber : 1) * 2.6))
  );
  const secondaryStart = Math.max(10, Math.min(72, Math.round(progressRatio * 0.56)));
  const promoDays = formatDayMetric(getMetricValue(metricMap, "promoDays"));
  const promoFooterLabel =
    promoDays && promoDays !== "-"
      ? `促销贡献度 (${promoDays}/28天)`
      : "促销贡献度";
  const dashboardJob = buildUploadDashboardJobView(job, null);
  const dashboardNotice = normalizeText(options.notice || record?.notice || "");

  return `
    <div class="${PRODUCT_DASHBOARD_CLASS} notranslate" translate="no" data-product-id="${escapeHtml(productId)}" data-layout="card" data-country-code="${escapeHtml(
      sellerCountryCode
    )}" data-product-url="${escapeHtml(
      options.productUrl || ""
    )}">
      <div class="${PRODUCT_DASHBOARD_CLASS}__card-header">
        <div class="${PRODUCT_DASHBOARD_CLASS}__card-header-main">
          <h2 class="${PRODUCT_DASHBOARD_CLASS}__card-id">${escapeHtml(productId || "-")}</h2>
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-meta">
            <span class="${PRODUCT_DASHBOARD_CLASS}__card-badge">${escapeHtml(brand || "未识别品牌")}</span>
            <span class="${PRODUCT_DASHBOARD_CLASS}__card-badge ${PRODUCT_DASHBOARD_CLASS}__card-badge--success">${escapeHtml(
              `跟卖者 ${otherSellerCount}`
            )}</span>
            <span class="${PRODUCT_DASHBOARD_CLASS}__card-badge ${PRODUCT_DASHBOARD_CLASS}__card-badge--muted">${sellerFlagMarkup}<span class="${PRODUCT_DASHBOARD_CLASS}__card-seller-name">${escapeHtml(sellerName)}</span></span>
          </div>
        </div>
      </div>

      ${
        dashboardNotice
          ? `<div class="${PRODUCT_DASHBOARD_CLASS}__notice">${escapeHtml(dashboardNotice)}</div>`
          : ""
      }

      <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpis">
        <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi ${PRODUCT_DASHBOARD_CLASS}__card-kpi--revenue">
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi-label">月销售额</div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi-value">${escapeHtml(
            formatCompactRubMetric(getMetricValue(metricMap, "monthlyRevenue"))
          )}</div>
        </div>
        <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi ${PRODUCT_DASHBOARD_CLASS}__card-kpi--sales">
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi-copy">
            <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi-label ${PRODUCT_DASHBOARD_CLASS}__card-kpi-label--warm">月销量</div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi-value">${escapeHtml(
              getMetricValue(metricMap, "monthlySales")
            )}</div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__card-kpi-note">${escapeHtml(
              `日均 ${getMetricValue(metricMap, "dailySales")}`
            )}</div>
          </div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-sparkline">${buildCardSparklineSvg(metricMap, productId)}</div>
        </div>
      </div>

      <div class="${PRODUCT_DASHBOARD_CLASS}__card-conversion">
        <div class="${PRODUCT_DASHBOARD_CLASS}__card-conversion-head">
          <span class="${PRODUCT_DASHBOARD_CLASS}__card-conversion-label">全链路转化率</span>
          <span class="${PRODUCT_DASHBOARD_CLASS}__card-conversion-value">${escapeHtml(
            `${getMetricValue(metricMap, "cartConversion")} / ${getMetricValue(metricMap, "searchConversion")}`
          )}</span>
        </div>
        <div class="${PRODUCT_DASHBOARD_CLASS}__card-conversion-track">
          <span class="${PRODUCT_DASHBOARD_CLASS}__card-conversion-fill" style="width:${progressRatio}%"></span>
          <span class="${PRODUCT_DASHBOARD_CLASS}__card-conversion-fill ${PRODUCT_DASHBOARD_CLASS}__card-conversion-fill--secondary" style="left:${secondaryStart}%;width:${secondaryProgress}%"></span>
        </div>
      </div>

      <div class="${PRODUCT_DASHBOARD_CLASS}__card-stats-grid">
        ${buildCardStatMarkup("展示总量", getMetricValue(metricMap, "impressions"))}
        ${buildCardStatMarkup("搜索总量", getMetricValue(metricMap, "searchVolume"))}
        ${buildCardStatMarkup("日均销量", getMetricValue(metricMap, "dailySales"))}
        ${buildCardStatMarkup("配送模式", getMetricValue(metricMap, "fulfillment"), "blue")}
        ${buildCardStatMarkup("退款占比", getMetricValue(metricMap, "refundRate"))}
        ${buildCardStatMarkup("运输时效", getMetricValue(metricMap, "deliveryTime"), "green")}
        ${buildCardStatMarkup("平均价格", getMetricValue(metricMap, "avgPrice"))}
        ${buildCardStatMarkup("跟卖最低", formatMinPriceMetric(getMetricValue(metricMap, "minPrice")), "red")}
        ${buildCardStatMarkup("上架时长", formatListedDuration(getMetricValue(metricMap, "listedAt")))}
      </div>

      <div class="${PRODUCT_DASHBOARD_CLASS}__card-footer">
        <div class="${PRODUCT_DASHBOARD_CLASS}__card-footer-row">
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-footer-label">
            <span class="${PRODUCT_DASHBOARD_CLASS}__card-footer-dot"></span>
            <span>${escapeHtml(promoFooterLabel)}</span>
          </div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__card-footer-value">${escapeHtml(
            getMetricValue(metricMap, "promoConversion")
          )}</div>
        </div>
        <div class="${PRODUCT_DASHBOARD_CLASS}__actions ${PRODUCT_DASHBOARD_CLASS}__actions--card">
          <button class="${PRODUCT_DASHBOARD_CLASS}__button ${PRODUCT_DASHBOARD_CLASS}__button--orange ${PRODUCT_DASHBOARD_CLASS}__button--card-secondary" data-action="noop-source" disabled>${escapeHtml(
            template.buttons.source
          )}</button>
          <button class="${PRODUCT_DASHBOARD_CLASS}__button ${PRODUCT_DASHBOARD_CLASS}__button--red ${PRODUCT_DASHBOARD_CLASS}__button--card-primary" data-action="upload-product" ${
            dashboardJob.running ? "disabled" : ""
          }>${escapeHtml(dashboardJob.buttonLabel)}</button>
          <button class="${PRODUCT_DASHBOARD_CLASS}__button ${PRODUCT_DASHBOARD_CLASS}__button--blue ${PRODUCT_DASHBOARD_CLASS}__button--card-accent" data-action="noop-collect" disabled>${escapeHtml(
            template.buttons.collect
          )}</button>
        </div>
      </div>
    </div>
  `;
}

function buildProductDashboardMarkup(record, template, job, options = {}) {
  const layout = options.layout || "product-page";
  const productId = record?.productId || options.productId || extractProductIdFromUrl() || "";
  const metricMap = buildMetricMap(record);
  const breadcrumbs = layout === "product-page" ? extractBreadcrumbs() : [];
  const sellerState =
    layout === "product-page" ? parseStateElementFromRoot(document, "state-webCurrentSeller-")?.state : null;
  const brand =
    options.brand ||
    (layout === "product-page" ? extractBrandData()?.name : null) ||
    getMetricValue(metricMap, "brand");
  const baseCategory =
    options.category ||
    breadcrumbs.at(-1)?.text ||
    breadcrumbs.at(-2)?.text ||
    getMetricValue(metricMap, "category");
  let seller = options.seller || (layout === "product-page" ? extractSellerData() : null);
  const sellerBase = seller;
  const sellerStoreInfo =
    layout === "product-page" && sellerState
      ? extractSellerStoreInfoFromState(sellerState, seller?.name || "")
      : null;
  const otherSellerCount = layout === "product-page" ? extractOtherSellerCount() : "0";
  const category = layout === "product-page" ? `跟卖者 ${otherSellerCount}` : baseCategory;
  const sellerCountryCode = options.originCountryInfo?.countryCode || "";
  const sellerChipText = normalizeText(sellerStoreInfo?.sellerName || sellerBase?.name || seller?.name || "");
  const sellerFlagMarkup = layout === "product-page" ? buildCountryFlagMarkup(sellerCountryCode) : "";
  const characteristics =
    layout === "product-page" ? extractCharacteristicsData() : { items: [], sectionUrl: null };
  const productWeight =
    options.productWeight ||
    (layout === "product-page" ? extractProductWeightFromCharacteristics(characteristics.items) : null);
  const packageWeight = normalizeText(job?.result?.packageWeight?.weightText || job?.result?.weightText || "");
  const dashboardJob = buildUploadDashboardJobView(job, productWeight?.weightText || null);
  const dashboardNotice = normalizeText(options.notice || record?.notice || "");
  const raw = record?.raw || {};
  const searchVolume = getMetricValue(metricMap, "searchVolume");
  const impressions = getMetricValue(metricMap, "impressions");
  const progressRatio = (() => {
    const search = Number(String(raw.sessionCountSearch ?? "").replace(/[^\d.-]/g, ""));
    const views = Number(String(raw.views ?? "").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(search) || !Number.isFinite(views) || views <= 0) {
      return 18;
    }
    return Math.max(8, Math.min(100, Math.round((search / views) * 100)));
  })();
  const campaignRatio = (() => {
    const promoShare = Number(raw.promoRevenueShare);
    const discount = Number(raw.discount);
    if (Number.isFinite(promoShare)) {
      return Math.max(0, Math.min(100, promoShare));
    }
    if (Number.isFinite(discount)) {
      return Math.max(0, Math.min(100, discount));
    }
    return 0;
  })();

  if (layout === "card") {
    return buildCardDashboardMarkup(record, template, job, options);
  }

  return `
    <div class="${PRODUCT_DASHBOARD_CLASS} notranslate" translate="no" data-product-id="${escapeHtml(productId)}" data-layout="${escapeHtml(
      layout
    )}" data-country-code="${escapeHtml(sellerCountryCode)}" data-product-url="${escapeHtml(options.productUrl || "")}" data-product-weight="${escapeHtml(
      productWeight?.weightText || ""
    )}">
      <div class="${PRODUCT_DASHBOARD_CLASS}__header">
        <div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__eyebrow">${escapeHtml(template.title)}</div>
          <h2 class="${PRODUCT_DASHBOARD_CLASS}__id">${escapeHtml(productId || "-")}</h2>
          <div class="${PRODUCT_DASHBOARD_CLASS}__chips">
            <span class="${PRODUCT_DASHBOARD_CLASS}__chip">${escapeHtml(brand || "未识别品牌")}</span>
            <span class="${PRODUCT_DASHBOARD_CLASS}__chip ${PRODUCT_DASHBOARD_CLASS}__chip--muted">${escapeHtml(
              category || "未识别类目"
            )}</span>
            ${
              sellerChipText
                ? `<span class="${PRODUCT_DASHBOARD_CLASS}__chip ${PRODUCT_DASHBOARD_CLASS}__chip--muted">${sellerFlagMarkup}<span>${escapeHtml(sellerChipText)}</span></span>`
                : ""
              }
          </div>
        </div>
      </div>

      ${
        dashboardNotice
          ? `<div class="${PRODUCT_DASHBOARD_CLASS}__notice">${escapeHtml(dashboardNotice)}</div>`
          : ""
      }

      <div class="${PRODUCT_DASHBOARD_CLASS}__grid">
        <section class="${PRODUCT_DASHBOARD_CLASS}__section">
          <h3 class="${PRODUCT_DASHBOARD_CLASS}__section-title">${escapeHtml(template.sections.sales)}</h3>
          <div class="${PRODUCT_DASHBOARD_CLASS}__cards">
            <div class="${PRODUCT_DASHBOARD_CLASS}__card ${PRODUCT_DASHBOARD_CLASS}__card--primary">
              <div class="${PRODUCT_DASHBOARD_CLASS}__card-label">月销售额</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__card-value">${escapeHtml(
                formatCompactRubMetric(getMetricValue(metricMap, "monthlyRevenue"))
              )}</div>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__card ${PRODUCT_DASHBOARD_CLASS}__card--warm ${PRODUCT_DASHBOARD_CLASS}__card--secondary">
              <div class="${PRODUCT_DASHBOARD_CLASS}__card-label">月销量</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__card-value">${escapeHtml(
                getMetricValue(metricMap, "monthlySales")
              )}</div>
            </div>
          </div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__subgrid">
            <div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-label">日均销售额</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-value">${escapeHtml(
                getMetricValue(metricMap, "dailyRevenue")
              )}</div>
            </div>
            <div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-label">日均销量</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-value">${escapeHtml(
                getMetricValue(metricMap, "dailySales")
              )}</div>
            </div>
          </div>
        </section>

        <section class="${PRODUCT_DASHBOARD_CLASS}__section">
          <h3 class="${PRODUCT_DASHBOARD_CLASS}__section-title">${escapeHtml(template.sections.funnel)}</h3>
          <div class="${PRODUCT_DASHBOARD_CLASS}__funnel-top">
            <span>曝光 / 搜索量</span>
            <span>${escapeHtml(`${impressions} / ${searchVolume}`)}</span>
          </div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__progress">
            <div class="${PRODUCT_DASHBOARD_CLASS}__progress-bar" style="width:${progressRatio}%"></div>
          </div>
          <div class="${PRODUCT_DASHBOARD_CLASS}__triple">
            <div class="${PRODUCT_DASHBOARD_CLASS}__triple-item">
              <div class="${PRODUCT_DASHBOARD_CLASS}__triple-label">商详浏览</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__triple-value">${escapeHtml(
                getMetricValue(metricMap, "clicks")
              )}</div>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__triple-item">
              <div class="${PRODUCT_DASHBOARD_CLASS}__triple-label">搜索转化</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__triple-value">${escapeHtml(
                getMetricValue(metricMap, "searchConversion")
              )}</div>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__triple-item">
              <div class="${PRODUCT_DASHBOARD_CLASS}__triple-label">加购转化</div>
              <div class="${PRODUCT_DASHBOARD_CLASS}__triple-value">${escapeHtml(
                getMetricValue(metricMap, "cartConversion")
              )}</div>
            </div>
          </div>
        </section>

        <section class="${PRODUCT_DASHBOARD_CLASS}__section">
          <h3 class="${PRODUCT_DASHBOARD_CLASS}__section-title">${escapeHtml(template.sections.logistics)}</h3>
          <div class="${PRODUCT_DASHBOARD_CLASS}__pairs">
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">履约方式</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value ${PRODUCT_DASHBOARD_CLASS}__pair-value--accent">${escapeHtml(
                getMetricValue(metricMap, "fulfillment")
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">退款率</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value">${escapeHtml(
                getMetricValue(metricMap, "refundRate")
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">平均价格</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value">${escapeHtml(
                getMetricValue(metricMap, "avgPrice")
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">最低跟卖价</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value ${PRODUCT_DASHBOARD_CLASS}__pair-value--danger">${escapeHtml(
                formatMinPriceMetric(getMetricValue(metricMap, "minPrice"))
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">包装重量</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value" data-role="package-weight">${escapeHtml(
                packageWeight || "-"
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">创建日期</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value">${escapeHtml(
                getMetricValue(metricMap, "listedAt")
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__pair">
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-label">平均配送时间</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__pair-value">${escapeHtml(
                formatDayMetric(getMetricValue(metricMap, "deliveryTime"))
              )}</span>
            </div>
          </div>
        </section>

        <section class="${PRODUCT_DASHBOARD_CLASS}__section">
          <h3 class="${PRODUCT_DASHBOARD_CLASS}__section-title">${escapeHtml(template.sections.campaign)}</h3>
          <div class="${PRODUCT_DASHBOARD_CLASS}__campaign-box">
            <div class="${PRODUCT_DASHBOARD_CLASS}__campaign-top">
              <span>促销贡献度</span>
              <span class="${PRODUCT_DASHBOARD_CLASS}__campaign-value">${escapeHtml(
                getMetricValue(metricMap, "promoConversion")
              )}</span>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__progress">
              <div class="${PRODUCT_DASHBOARD_CLASS}__progress-bar" style="width:${campaignRatio}%"></div>
            </div>
            <div class="${PRODUCT_DASHBOARD_CLASS}__campaign-meta">
              <div>
                <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-label">促销折扣</div>
                <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-value">${escapeHtml(
                  getMetricValue(metricMap, "promoDiscount")
                )}</div>
              </div>
              <div>
                <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-label">促销天数</div>
                <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-value">${escapeHtml(
                  formatDayMetric(getMetricValue(metricMap, "promoDays"))
                )}</div>
              </div>
              <div>
                <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-label">广告天数</div>
                <div class="${PRODUCT_DASHBOARD_CLASS}__subitem-value">${escapeHtml(
                  formatDayMetric(getMetricValue(metricMap, "adDays"))
                )}</div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="${PRODUCT_DASHBOARD_CLASS}__actions">
        <button class="${PRODUCT_DASHBOARD_CLASS}__button ${PRODUCT_DASHBOARD_CLASS}__button--orange" data-action="noop-source" disabled>${escapeHtml(
          template.buttons.source
        )}</button>
        <button class="${PRODUCT_DASHBOARD_CLASS}__button ${PRODUCT_DASHBOARD_CLASS}__button--red" data-action="upload-product" ${
          dashboardJob.running ? "disabled" : ""
        }>${escapeHtml(dashboardJob.buttonLabel || template.buttons.follow)}</button>
        <button class="${PRODUCT_DASHBOARD_CLASS}__button ${PRODUCT_DASHBOARD_CLASS}__button--blue" data-action="noop-collect" disabled>${escapeHtml(
          template.buttons.collect
        )}</button>
      </div>
    </div>
  `;
}

function bindProductDashboardActions(panel) {
  const extractButton = panel.querySelector('[data-action="extract-all"]');
  if (!extractButton || extractButton.dataset.bound === "1") {
    return;
  }

  extractButton.dataset.bound = "1";
  extractButton.addEventListener("click", async () => {
    const layout = panel.dataset.layout || "product-page";
    const productUrl = panel.dataset.productUrl || location.href;
    extractButton.disabled = true;
    extractButton.textContent = "执行中...";

    const response = await sendMessage({
      type: "start-job",
      jobType: "extract-all",
      url: productUrl,
      deferRun: layout !== "product-page"
    });

    if (!response?.ok) {
      const status = panel.querySelector('[data-role="job-status"]');
      const summary = panel.querySelector('[data-role="job-summary"]');
      const extra = panel.querySelector('[data-role="job-extra"]');
      if (status) {
        status.textContent = "启动失败";
        status.dataset.tone = "error";
      }
      if (summary) {
        summary.textContent = normalizeText(response?.error || "Unknown error.");
      }
      if (extra) {
        extra.textContent = "请刷新页面后重试";
      }
      extractButton.disabled = false;
      extractButton.textContent = "重新执行";
      return;
    }

    if (layout !== "product-page" && productUrl) {
      location.assign(productUrl);
      return;
    }

    void refreshProductDashboardJobState();
  });
}

function bindUploadProductDashboardActions(panel) {
  const uploadButton = panel.querySelector('[data-action="upload-product"]');
  if (!uploadButton || uploadButton.dataset.bound === "1") {
    return;
  }

  uploadButton.dataset.bound = "1";
  uploadButton.addEventListener("click", async () => {
    const layout = panel.dataset.layout || "product-page";
    const productUrl = panel.dataset.productUrl || location.href;
    const uploadKey = `${panel.dataset.productId || ""}:${productUrl}`;
    if (productUploadInFlight.has(uploadKey)) {
      return;
    }

    productUploadInFlight.add(uploadKey);
    uploadButton.disabled = true;
    uploadButton.textContent = "执行中...";

    try {
      await startProductDashboardCloudUpload(productUrl, layout);
      void refreshProductDashboardJobState();
    } catch (error) {
      await sendMessage({
        type: "job-error",
        error: error instanceof Error ? error.message : String(error)
      });

      const status = panel.querySelector('[data-role="job-status"]');
      const summary = panel.querySelector('[data-role="job-summary"]');
      const extra = panel.querySelector('[data-role="job-extra"]');
      if (status) {
        status.textContent = "启动失败";
        status.dataset.tone = "error";
      }
      if (summary) {
        summary.textContent = normalizeText(error instanceof Error ? error.message : String(error));
      }
      if (extra) {
        extra.textContent = "请刷新页面后重试";
      }
      uploadButton.disabled = false;
      uploadButton.textContent = "重新上货";
      productUploadInFlight.delete(uploadKey);
      return;
    }

    setTimeout(() => {
      productUploadInFlight.delete(uploadKey);
    }, 30000);
  });
}

async function renderProductDashboard(host, record, layout = "product-page") {
  ensureSellerAnalyticsStyles();
  const productId = record?.productId || extractProductIdFromUrl();
  if (!productId) {
    return;
  }

  if (layout === "product-page") {
    removeLegacyProductPageAnalyticsPanels();
  }
  removeLegacyDashboardArtifacts(productId, host);

  const slot = getBuyerDashboardSlot(host, layout, productId);
  try {
    const template = await loadProductDashboardTemplate();
    const jobResponse = await sendMessage({ type: "get-job" });
    const job = getRelevantJobForProduct(jobResponse?.job || null, productId);
    const cardContext = layout === "card" ? extractCardDashboardContext(host, record) : null;
    const originCountryInfo =
      layout === "product-page"
        ? await resolveProductOriginCountryInfo(productId, location.href, document)
        : null;
    const renderKey = buildProductDashboardRenderKey(record, layout, productId, cardContext);
    const existingPanel = slot.querySelector(`.${PRODUCT_DASHBOARD_CLASS}`);
    if (slot.dataset.renderKey === renderKey && existingPanel) {
      bindUploadProductDashboardActions(existingPanel);
      startProductDashboardJobPolling();
      return;
    }

    const sellerInfo =
      layout === "card"
        ? cardSellerInfoCache.get(Number(productId)) || {
            sellerName: "-",
            legalName: "",
            addressText: "",
            locationText: "",
            countryFlag: "",
            originCountry: "",
            otherSellerCount: "0"
          }
        : null;
    slot.dataset.renderKey = renderKey;
    slot.innerHTML = buildProductDashboardMarkup(record, template, job, {
      layout,
      productId,
      title: cardContext?.title,
      rating: cardContext?.rating,
      productUrl: cardContext?.productUrl || location.href,
      sellerInfo,
      originCountryInfo,
      notice: record?.notice
    });
    const panel = slot.querySelector(`.${PRODUCT_DASHBOARD_CLASS}`);
    if (!panel) {
      return;
    }

    bindUploadProductDashboardActions(panel);
    startProductDashboardJobPolling();

    if (layout === "card" && cardContext?.productUrl) {
      void resolveCardSellerInfo(productId, cardContext.productUrl, "")
        .then((resolvedSellerInfo) => {
          if (slot.dataset.renderKey !== renderKey) {
            return;
          }
          try {
            slot.innerHTML = buildProductDashboardMarkup(record, template, job, {
              layout,
              productId,
            title: cardContext?.title,
            rating: cardContext?.rating,
            productUrl: cardContext?.productUrl || location.href,
            sellerInfo: resolvedSellerInfo,
            originCountryInfo,
            notice: record?.notice
          });
          } catch (error) {
            slot.innerHTML = `
              <div class="${PRODUCT_DASHBOARD_CLASS} ${PRODUCT_DASHBOARD_CLASS}--error notranslate" translate="no" data-product-id="${escapeHtml(
                productId
              )}" data-layout="${escapeHtml(layout)}">
                <div class="${PRODUCT_DASHBOARD_CLASS}__error-text">${escapeHtml(String(error))}</div>
              </div>
            `;
          }
          const refreshedPanel = slot.querySelector(`.${PRODUCT_DASHBOARD_CLASS}`);
          if (!refreshedPanel) {
            return;
          }
          bindUploadProductDashboardActions(refreshedPanel);
          startProductDashboardJobPolling();
        })
        .catch(() => {});
    }
  } catch (error) {
    slot.innerHTML = `
      <div class="${PRODUCT_DASHBOARD_CLASS} ${PRODUCT_DASHBOARD_CLASS}--error notranslate" translate="no" data-product-id="${escapeHtml(
        productId
      )}" data-layout="${escapeHtml(layout)}">
        <div class="${PRODUCT_DASHBOARD_CLASS}__error-text">${escapeHtml(String(error))}</div>
      </div>
    `;
  }
}

async function refreshProductDashboardJobState() {
  const panels = [...document.querySelectorAll(`.${PRODUCT_DASHBOARD_CLASS}`)];
  if (!panels.length) {
    return;
  }

  const response = await sendMessage({ type: "get-job" });
  const job = response?.job || null;

  for (const panel of panels) {
    const panelProductId = Number(panel.dataset.productId || 0);
    const relevantJob = getRelevantJobForProduct(job, panelProductId);
    const productWeightText = normalizeText(panel.dataset.productWeight || "") || null;
    const view = buildUploadDashboardJobView(relevantJob, productWeightText);

    const status = panel.querySelector('[data-role="job-status"]');
    const summary = panel.querySelector('[data-role="job-summary"]');
    const extra = panel.querySelector('[data-role="job-extra"]');
    const button = panel.querySelector('[data-action="upload-product"]');
    const packageWeight = panel.querySelector('[data-role="package-weight"]');
    const productWeight = panel.querySelector('[data-role="product-weight"]');

    if (status) {
      status.textContent = view.statusLabel;
      status.dataset.tone = view.tone;
    }
    if (summary) {
      summary.textContent = view.statusSummary;
    }
    if (extra) {
      extra.textContent = view.statusExtra;
    }
    if (button) {
      button.disabled = view.running;
      button.textContent = view.buttonLabel;
    }
    if (packageWeight && relevantJob?.result?.packageWeight?.weightText) {
      packageWeight.textContent = relevantJob.result.packageWeight.weightText;
    }
    if (productWeight && relevantJob?.result?.productWeight?.weightText) {
      productWeight.textContent = relevantJob.result.productWeight.weightText;
    }
  }
}

function startProductDashboardJobPolling() {
  if (productDashboardJobTimer) {
    return;
  }

  productDashboardJobTimer = setInterval(() => {
    void refreshProductDashboardJobState();
  }, 1000);
}

function renderSellerAnalyticsPanel(host, record, layout) {
  const mountParent =
    layout === "card" && host.parentElement && host.parentElement.children.length <= 3
      ? host.parentElement
      : host;
  const existing =
    mountParent.querySelector(
      `:scope > .${SELLER_ANALYTICS_PANEL_CLASS}[data-product-id="${record.productId}"]`
    ) ||
    host.querySelector(`:scope > .${SELLER_ANALYTICS_PANEL_CLASS}[data-product-id="${record.productId}"]`);
  const panel = existing || document.createElement("div");
  panel.className = SELLER_ANALYTICS_PANEL_CLASS;
  panel.dataset.productId = String(record.productId);
  panel.dataset.layout = layout || "card";

  const staleInHost =
    mountParent !== host
      ? host.querySelector(`:scope > .${SELLER_ANALYTICS_PANEL_CLASS}[data-product-id="${record.productId}"]`)
      : null;
  if (staleInHost && staleInHost !== panel) {
    staleInHost.remove();
  }

  const updatedAt = record.updatedAt ? new Date(record.updatedAt).toLocaleString() : "";
  const metricsHtml = orderSellerMetrics(record.metrics)
    .map(
      (metric) => `
        <div class="${SELLER_ANALYTICS_PANEL_CLASS}__metric">
          <span class="${SELLER_ANALYTICS_PANEL_CLASS}__label">${metric.label}:</span>
          <span class="${SELLER_ANALYTICS_PANEL_CLASS}__value">${metric.value}</span>
        </div>
      `
    )
    .join("");

  panel.innerHTML = `
    <div class="${SELLER_ANALYTICS_PANEL_CLASS}__header">
      <span>Seller Analytics</span>
      <span class="${SELLER_ANALYTICS_PANEL_CLASS}__meta">${updatedAt}</span>
    </div>
    <div class="${SELLER_ANALYTICS_PANEL_CLASS}__grid">${metricsHtml}</div>
  `;

  if (!existing) {
    if (mountParent !== host) {
      host.insertAdjacentElement("afterend", panel);
    } else {
      host.appendChild(panel);
    }
  } else if (mountParent !== host && panel.parentElement !== mountParent) {
    host.insertAdjacentElement("afterend", panel);
  }
}

async function refreshBuyerAnalyticsPanels() {
  ensureSellerAnalyticsStyles();

  const targets = collectBuyerTargets();
  const productIds = [...new Set(targets.map((target) => target.productId).filter(Boolean))];
  if (!productIds.length) {
    return;
  }

  let response = null;
  try {
    response = await sendMessage({
      type: "get-seller-analytics",
      productIds,
      fetchMissing: true
    });
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (!response?.ok) {
    const fallbackError =
      normalizeText(response?.error || "") ||
      "Keep a logged-in seller.ozon.ru tab open to load analytics.";
    console.warn("[ozon-weight-extension] buyer analytics unavailable", fallbackError);
    for (const target of targets) {
      await renderProductDashboard(
        target.host,
        buildBuyerAnalyticsFallbackRecord(target.productId, fallbackError),
        target.layout
      );
    }
    return;
  }

  const records = response?.records || {};
  pruneDuplicateBuyerDashboardSlots();
  for (const target of targets) {
    const record = records[target.productId];
    await renderProductDashboard(target.host, record || { productId: target.productId }, target.layout);
  }
  pruneDuplicateBuyerDashboardSlots();
}

function isBuyerDashboardOwnedNode(node) {
  const element =
    node instanceof Element ? node : node?.parentElement instanceof Element ? node.parentElement : null;
  if (!element) {
    return false;
  }

  return !!element.closest(
    `.${PRODUCT_DASHBOARD_SLOT_CLASS}, .${PRODUCT_DASHBOARD_CLASS}, .${SELLER_ANALYTICS_PANEL_CLASS}`
  );
}

function isBuyerDashboardMutation(mutation) {
  const changedNodes = [...(mutation?.addedNodes || []), ...(mutation?.removedNodes || [])];
  if (changedNodes.length) {
    return changedNodes.every((node) => isBuyerDashboardOwnedNode(node));
  }

  return isBuyerDashboardOwnedNode(mutation?.target || null);
}

async function fetchSellerAnalyticsItemFromSellerPage(productId, context) {
  if (!isSellerPage()) {
    throw new Error("fetch-seller-analytics-item is only supported on seller.ozon.ru pages.");
  }

  const response = await fetch("/api/site/seller-analytics/what_to_sell/data/v3", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "x-o3-app-name": "seller-ui",
      "x-o3-company-id": String(context?.companyId || ""),
      "x-o3-language": context?.language || "zh-Hans",
      "x-o3-page-type": "analytics_platform"
    },
    body: JSON.stringify({
      limit: "50",
      offset: "0",
      filter: {
        stock: "any_stock",
        period: "monthly",
        sku: String(productId)
      },
      sort: {
        key: "sum_gmv_desc"
      }
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`seller-tab-fetch-${response.status}: ${text.slice(0, 240)}`);
  }

  return JSON.parse(text);
}

function scheduleBuyerAnalyticsRefresh() {
  clearTimeout(buyerAnalyticsRefreshTimer);
  buyerAnalyticsRefreshTimer = setTimeout(() => {
    void refreshBuyerAnalyticsPanels();
  }, 500);
}

function ensureBuyerAnalyticsObserver() {
  if (buyerAnalyticsRefreshObserver) {
    return;
  }

  buyerAnalyticsRefreshObserver = new MutationObserver((mutations) => {
    if ((mutations || []).length && mutations.every((mutation) => isBuyerDashboardMutation(mutation))) {
      return;
    }

    scheduleBuyerAnalyticsRefresh();
  });

  buyerAnalyticsRefreshObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function buyerDashboardPanelCount() {
  return document.querySelectorAll(`.${PRODUCT_DASHBOARD_CLASS}[data-layout="card"], .${PRODUCT_DASHBOARD_CLASS}[data-layout="product-page"]`).length;
}

function shouldRecoverBuyerAnalyticsPanels() {
  const targetCount = collectBuyerTargets().length;
  if (!targetCount) {
    return false;
  }

  return buyerDashboardPanelCount() < Math.min(targetCount, 3);
}

function scheduleBuyerAnalyticsRecoveryRefresh(delay) {
  setTimeout(() => {
    if (shouldRecoverBuyerAnalyticsPanels()) {
      void refreshBuyerAnalyticsPanels();
    }
  }, delay);
}

function ensureBuyerAnalyticsRecoveryLoop() {
  [300, 1200, 2600, 5200, 9000].forEach((delay) => scheduleBuyerAnalyticsRecoveryRefresh(delay));

  if (buyerAnalyticsRecoveryTimer) {
    return;
  }

  buyerAnalyticsRecoveryTimer = setInterval(() => {
    if (shouldRecoverBuyerAnalyticsPanels()) {
      void refreshBuyerAnalyticsPanels();
    }
  }, 7000);
}

function findActionButtonByWidget(widgetName) {
  return (
    document.querySelector(`button[data-widget="${widgetName}"]`) ||
    document.querySelector(`[data-widget="${widgetName}"] button`) ||
    document.querySelector(`[data-widget="${widgetName}"]`)
  );
}

function findActionButtonByText(texts) {
  const normalizedTexts = texts.map((text) => normalizeText(text).toLowerCase());
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));

  return (
    candidates.find((element) => {
      const text = normalizeText(element.innerText || element.textContent || "").toLowerCase();
      return text && normalizedTexts.some((expected) => text.includes(expected));
    }) || null
  );
}

function clickElement(element) {
  if (!element) {
    return false;
  }

  element.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "instant"
  });

  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
  return true;
}

async function driveToCheckoutViaDomFallback(job) {
  const buyNowButton =
    findActionButtonByWidget("webOneClickButton") ||
    findActionButtonByText(["Купить сейчас", "Buy now"]);

  if (buyNowButton) {
    await updateJob(
      {
        stage: "dom_click_buy_now",
        domFallbackMethod: "buy-now-dom"
      },
      "dom-click-buy-now"
    );
    showOverlay("Pure request blocked. Switching to Buy Now DOM fallback...", "#b45309");
    clickElement(buyNowButton);

    const reachedRoute = await waitForCondition(() => {
      if (isCheckoutPage()) {
        return "checkout";
      }
      if (isCartPage()) {
        return "cart";
      }
      return null;
    }, 12000, 250);
    if (reachedRoute) {
      return reachedRoute;
    }

    const reachedCheckout = await waitForCondition(() => isCheckoutPage(), 12000, 250);
    if (reachedCheckout) {
      return "checkout";
    }
  }

  const addToCartButton =
    findActionButtonByWidget("webAddToCart") ||
    findActionButtonByText(["В корзину", "Add to cart"]);

  if (!addToCartButton) {
    throw new Error("Cannot find Buy Now or Add to Cart button for DOM fallback.");
  }

  await updateJob(
    {
      stage: "dom_click_add_to_cart",
      domFallbackMethod: "add-to-cart-dom"
    },
    "dom-click-add-to-cart"
  );
  showOverlay("Pure request blocked. Switching to Add to Cart DOM fallback...", "#b45309");
  clickElement(addToCartButton);
  await sleep(1800);

  await updateJob(
    {
      stage: "dom_navigate_checkout",
      domFallbackMethod: "add-to-cart-dom"
    },
    "dom-navigate-to-checkout"
  );
  location.assign("/gocheckout?start=0&snp=false");
  const reachedRoute = await waitForCondition(() => {
    if (isCheckoutPage()) {
      return "checkout";
    }
    if (isCartPage()) {
      return "cart";
    }
    return null;
  }, 12000, 250);
  if (reachedRoute) {
    return reachedRoute;
  }

  await sleep(30000);
  return null;
}

function getOneClickState(root = document) {
  return parseStateElementFromRoot(root, "state-webOneClickButton-");
}

function getAddToCartSkuState(root = document) {
  const nodes = Array.from(root.querySelectorAll('[id^="state-webAddToCart-"]'));
  for (const node of nodes) {
    try {
      const state = JSON.parse(node.getAttribute("data-state") || "{}");
      const sku = state?.firstButton?.sku || state?.firstButton?.action?.params?.sku;
      if (sku) {
        return { id: node.id, sku: Number(sku), state };
      }
    } catch (_error) {
      // ignore broken state blobs
    }
  }
  return null;
}

async function fetchCheckoutHtmlFromOneClick(oneClickState, baseUrl = location.href) {
  const response = await fetch(absoluteUrl(oneClickState.redirectLink, baseUrl), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "content-type": "application/json"
    },
    body: JSON.stringify(oneClickState.payload),
    redirect: "follow"
  });

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`One-click checkout request failed with status ${response.status}.`);
  }

  return { html, finalUrl: response.url };
}

async function fetchCheckoutHtmlFromAddToCart(sku, baseUrl = location.href) {
  const origin = new URL(baseUrl, location.href).origin;
  const addResponse = await fetch(new URL("/api/composer-api.bx/_action/v2/addToCart", origin).href, {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify([{ id: sku, quantity: 1 }])
  });

  if (!addResponse.ok) {
    throw new Error(`addToCart failed with status ${addResponse.status}.`);
  }

  const checkoutResponse = await fetch(new URL("/gocheckout?start=0&snp=false", origin).href, {
    method: "GET",
    credentials: "include",
    redirect: "follow"
  });

  const html = await checkoutResponse.text();
  if (!checkoutResponse.ok) {
    throw new Error(`Checkout fetch failed with status ${checkoutResponse.status}.`);
  }

  return { html, finalUrl: checkoutResponse.url };
}

function buildWeightResult(job, parsed, meta = {}) {
  return {
    productId: meta.productId || job.productId || extractProductIdFromUrl(meta.sourceUrl || location.href),
    productTitle: meta.productTitle || job.productTitle || extractProductTitle(),
    sourceUrl: meta.sourceUrl || location.href,
    method: meta.method || job.domFallbackMethod || "unknown",
    weightKg: parsed.weightKg,
    weightText: parsed.weightText,
    orderInfo: parsed.orderInfo,
    itemCount: parsed.itemCount,
    totalStateId: parsed.totalStateId,
    splitStateId: parsed.splitStateId,
    deliveryText: parsed.deliveryText || null,
    extractedAt: new Date().toISOString(),
    warning:
      meta.warning ||
      (parsed.itemCount && parsed.itemCount !== 1
        ? "Checkout contains more than one item. The weight may be ambiguous."
        : null)
  };
}

async function fetchWeightResultFromProductPage(job, options = {}) {
  const root = options.root || document;
  const sourceUrl = options.sourceUrl || location.href;
  const silent = Boolean(options.silent);
  const productId = job.productId || extractProductIdFromUrl(sourceUrl);
  const productTitle = options.productTitle || job.productTitle || extractProductTitle(root);
  const oneClick = getOneClickState(root);
  if (oneClick?.state?.redirectLink && oneClick?.state?.payload) {
    try {
      if (!silent) {
        await updateJob({ stage: "request_checkout_oneclick" }, "one-click-request");
      }
      const fetched = await fetchCheckoutHtmlFromOneClick(oneClick.state, sourceUrl);
      if (!silent) {
        await updateJob({ stage: "parse_checkout_oneclick" }, "parse-one-click-html");
      }

      const parsed = extractWeightFromCheckoutRoot(parseHtml(fetched.html));
      if (!parsed) {
        throw new Error("One-click checkout HTML did not contain a package weight.");
      }

      return buildWeightResult(job, parsed, {
        sourceUrl: fetched.finalUrl,
        method: "one-click-request",
        productId,
        productTitle
      });
    } catch (error) {
      if (!silent) {
        await updateJob(
          { stage: "oneclick_failed_fallback_addtocart" },
          `one-click-failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  const addToCart = getAddToCartSkuState(root);
  if (!addToCart?.sku) {
    throw new Error("Cannot find one-click or add-to-cart product state on the page.");
  }

  if (!silent) {
    await updateJob({ stage: "request_checkout_addtocart" }, "fallback-add-to-cart-request");
  }
  const fetched = await fetchCheckoutHtmlFromAddToCart(addToCart.sku, sourceUrl);
  if (!silent) {
    await updateJob({ stage: "parse_checkout_addtocart" }, "parse-add-to-cart-html");
  }

  const parsed = extractWeightFromCheckoutRoot(parseHtml(fetched.html));
  if (!parsed) {
    throw new Error("Checkout HTML after add-to-cart did not contain a package weight.");
  }

  return buildWeightResult(job, parsed, {
    sourceUrl: fetched.finalUrl,
    method: "add-to-cart-request",
    productId,
    productTitle,
    warning: "Used add-to-cart request fallback. The item may remain in your cart after extraction."
  });
}

async function extractProductDataFromUrl(url) {
  const targetUrl = absoluteUrl(url, location.href);
  const { root, sourceUrl } = await fetchHtmlDocument(targetUrl);
  const job = {
    productId: extractProductIdFromUrl(sourceUrl) || extractProductIdFromUrl(targetUrl)
  };
  const characteristics = await extractCharacteristicsWithFallback(root, sourceUrl);
  const productData = buildProductDataResult(job, {
    root,
    sourceUrl,
    characteristics
  });

  try {
    const packageWeight = await fetchWeightResultFromProductPage(
      {
        ...job,
        productTitle: productData.title
      },
      {
        root,
        sourceUrl,
        silent: true,
        productTitle: productData.title
      }
    );

    return {
      ...productData,
      extractionType: "upload-product",
      packageWeight
    };
  } catch (error) {
    if (!productData.productWeight?.grams) {
      throw error;
    }

    return {
      ...productData,
      extractionType: "upload-product",
      packageWeight: {
        productId: productData.productId,
        productTitle: productData.title,
        sourceUrl,
        method: "characteristics-fallback",
        weightKg: Number((productData.productWeight.grams / 1000).toFixed(6)),
        weightText: productData.productWeight.weightText,
        orderInfo: productData.productWeight.characteristicValueText || productData.productWeight.weightText,
        itemCount: null,
        totalStateId: null,
        splitStateId: null,
        deliveryText: null,
        extractedAt: new Date().toISOString(),
        warning: "Weight fallback used characteristics because checkout weight request was unavailable."
      }
    };
  }
}

function isStructuredProductJob(job) {
  return job?.jobType === "extract-all" || job?.jobType === "upload-product";
}

async function handleCheckoutPage(job) {
  await updateJob({ stage: "checkout_dom" }, "parse-open-checkout-dom");

  const parsed = await waitForCondition(() => extractWeightFromCheckoutRoot(document), 8000);
  if (!parsed) {
    throw new Error("Cannot find package weight in the open checkout page state.");
  }

  const weightResult = buildWeightResult(job, parsed, {
    sourceUrl: location.href,
    method: job.domFallbackMethod || "checkout-dom"
  });

  if (isStructuredProductJob(job) && job.productData) {
    const result = {
      ...job.productData,
      extractionType: job.jobType === "upload-product" ? "upload-product" : "extract-all",
      packageWeight: weightResult
    };
    showOverlay(
      `Extracted all data: ${result.stats?.characteristicCount || 0} characteristics, ${weightResult.weightText}`,
      "#0f766e"
    );
    await sendMessage({ type: "job-result", result });
    return;
  }

  showOverlay(`Weight: ${weightResult.weightText}`, "#1a73e8");
  await sendMessage({ type: "job-result", result: weightResult });
}

async function handleCartPage(job) {
  await updateJob({ stage: "cart_dom" }, "cart-page-open");

  const checkoutButton =
    findActionButtonByText([
      "Перейти к оформлению",
      "Оформить заказ",
      "Proceed to checkout",
      "Checkout"
    ]) || null;

  if (checkoutButton) {
    await updateJob({ stage: "cart_click_checkout" }, "cart-click-checkout");
    showOverlay("Cart reached. Proceeding to checkout...", "#b45309");
    clickElement(checkoutButton);
  } else {
    await updateJob({ stage: "cart_navigate_checkout" }, "cart-navigate-checkout");
    showOverlay("Cart reached. Navigating to checkout...", "#b45309");
    location.assign("/gocheckout?start=0&snp=false");
  }

  const reachedCheckout = await waitForCondition(() => isCheckoutPage(), 12000, 250);
  if (reachedCheckout) {
    await handleCheckoutPage(job);
    return;
  }

  throw new Error("Cart fallback did not reach checkout.");
}

async function handleProductPage(job) {
  if (isStructuredProductJob(job)) {
    await updateJob(
      {
        stage: "extract_product_data",
        productId: job.productId || extractProductIdFromUrl(),
        productTitle: extractProductTitle() || job.productTitle || null
      },
      "extract-all-product-data"
    );

    await updateJob(
      {
        stage: "load_full_characteristics"
      },
      "load-full-characteristics"
    );
    await updateJob(
      {
        stage: "wait_characteristics_section"
      },
      "wait-section-characteristics"
    );
    const waitedCharacteristics = await waitForCharacteristicsSectionReady();
    const fallbackCharacteristics = await extractCharacteristicsWithFallback(document, location.href);
    const characteristics = mergeCharacteristicsData(fallbackCharacteristics, waitedCharacteristics);
    const productData = buildProductDataResult(job, { characteristics });
    try {
      const packageWeight = await fetchWeightResultFromProductPage(job);
      const result = {
        ...productData,
        extractionType: job.jobType === "upload-product" ? "upload-product" : "extract-all",
        packageWeight
      };

      showOverlay(
        `Extracted all data: ${result.stats.characteristicCount} characteristics, ${packageWeight.weightText}`,
        "#0f766e"
      );
      await sendMessage({ type: "job-result", result });
    } catch (error) {
      await updateJob(
        {
          stage: "extract_request_failed_dom_fallback",
          productData
        },
        `extract-request-failed: ${error instanceof Error ? error.message : String(error)}`
      );
      const domRoute = await driveToCheckoutViaDomFallback({ ...job, productData });
      if (domRoute === "checkout") {
        await handleCheckoutPage({ ...job, productData });
        return;
      }
      if (domRoute === "cart") {
        await handleCartPage({ ...job, productData });
        return;
      }
    }
    return;
  }

  await updateJob(
    {
      stage: "product",
      productId: job.productId || extractProductIdFromUrl(),
      productTitle: extractProductTitle() || job.productTitle || null
    },
    "on-product-page"
  );

  try {
    const result = await fetchWeightResultFromProductPage(job);
    showOverlay(`Weight: ${result.weightText}`, "#1a73e8");
    await sendMessage({ type: "job-result", result });
  } catch (error) {
    await updateJob(
      {
        stage: "weight_request_failed_dom_fallback"
      },
      `weight-request-failed: ${error instanceof Error ? error.message : String(error)}`
    );
    const domRoute = await driveToCheckoutViaDomFallback(job);
    if (domRoute === "checkout") {
      await handleCheckoutPage(job);
      return;
    }
    if (domRoute === "cart") {
      await handleCartPage(job);
      return;
    }
  }
}

async function runJob(job) {
  if (isStructuredProductJob(job)) {
    if (isCheckoutPage()) {
      await handleCheckoutPage(job);
      return;
    }

    if (isCartPage()) {
      await handleCartPage(job);
      return;
    }

    if (!isProductPage()) {
      throw new Error("Open an Ozon product page, cart page, or checkout page before starting this extraction.");
    }

    await handleProductPage(job);
    return;
  }

  if (isCheckoutPage()) {
    await handleCheckoutPage(job);
    return;
  }

  if (isCartPage()) {
    await handleCartPage(job);
    return;
  }

  if (isProductPage()) {
    await handleProductPage(job);
    return;
  }

  throw new Error("Open an Ozon product page, cart page, or checkout page before starting.");
}

async function ensureRun(job) {
  const runKey = `${job.jobType || "weight"}:${job.stage}:${location.href}`;
  if (activeRun && activeRunKey === runKey) {
    return activeRun;
  }

  activeRunKey = runKey;
  activeRun = runJob(job)
    .catch(async (error) => {
      showOverlay(`Error: ${error.message || String(error)}`, "#d93025");
      await failJob(error);
    })
    .finally(() => {
      activeRun = null;
      activeRunKey = null;
    });

  return activeRun;
}

async function ensureOperationBot() {
  if (isSellerPage()) {
    return;
  }

  if (!operationBotModulePromise) {
    operationBotModulePromise = import(chrome.runtime.getURL("operation_bot.js"));
  }

  const module = await operationBotModulePromise;
  module.initOperationBot({
    absoluteUrl,
    buildMetricMap,
    buildVariantProductData,
    collectBuyerTargets,
    escapeHtml,
    extractCharacteristicsData,
    extractCurrentProductDataForUpload,
    fetchOzonProductDataById,
    extractProductDataFromUrl,
    extractProductVariants,
    extractGalleryData,
    extractPricingData,
    extractProductTitle,
    extractProductWeightFromCharacteristics,
    formatMinPriceMetric,
    getMetricValue,
    isSellerPage,
    normalizeText,
    refreshBuyerAnalyticsPanels,
    sendMessage,
    showOverlay,
    sleep,
    splitNormalizedLines,
    waitForProductDomReady,
    uniqueStrings
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "fetch-seller-analytics-item") {
    fetchSellerAnalyticsItemFromSellerPage(message.productId, message.context)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }

  if (message.type === "fetch-ozon-product-data") {
    (async () => {
      const baseProductId =
        Number(message.productId) ||
        extractProductIdFromText(message.productUrl || "") ||
        extractProductIdFromUrl(message.productUrl || location.href);
      const base = await fetchOzonProductDataById(baseProductId, message.productUrl || "");
      const productDataList = [base];

      if (message.includeVariants) {
        const maxVariants = Math.max(1, Math.min(100, Number(message.maxVariants || 20)));
        const seen = new Set([String(base.productId || baseProductId)]);
        const variants = Array.isArray(base.variants) ? base.variants : [];
        for (const variant of variants) {
          if (productDataList.length >= maxVariants) {
            break;
          }
          if (!variant || typeof variant !== "object") {
            continue;
          }
          const variantUrl = String(variant.productUrl || variant.url || "");
          const variantId =
            Number(variant.productId) ||
            extractProductIdFromText(variantUrl) ||
            extractProductIdFromUrl(variantUrl);
          if (!Number.isFinite(variantId)) {
            continue;
          }
          const dedupeKey = String(variantId);
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);
          try {
            productDataList.push(await fetchOzonProductDataById(variantId, variantUrl));
          } catch (error) {
            console.warn(
              "[ozon-weight-extension] variant fetch failed",
              variantId,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      sendResponse({ ok: true, productData: base, productDataList });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

    return true;
  }

  if (message.type !== "run-job") {
    return false;
  }

  ensureRun(message.job)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true;
});

(async () => {
  if (isSellerPage()) {
    // Seller pages only provide authenticated context for background fetches.
  } else {
    try {
      await ensureOperationBot();
    } catch (error) {
      console.warn(
        "[ozon-weight-extension] operation bot init failed",
        error instanceof Error ? error.message : String(error)
      );
    }
    scheduleBuyerAnalyticsRefresh();
    ensureBuyerAnalyticsObserver();
    ensureBuyerAnalyticsRecoveryLoop();
  }

  const response = await sendMessage({ type: "page-ready", url: location.href });
  if (shouldAutoResumeJob(response?.job)) {
    await ensureRun(response.job);
  }
})();

})();
