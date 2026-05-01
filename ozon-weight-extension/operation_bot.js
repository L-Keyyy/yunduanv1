let initialized = false;

const POSITION_STORAGE_KEY = "ozon-operation-bot-position";
const STORE_STORAGE_KEY = "ozon-operation-bot-store-id";
const DOM_UPLOAD_FLOW_KEY = "ozon-operation-bot-dom-upload-flow";
const DEFAULT_MIN_FOLLOW_PRICE_RATIO = 0.95;
const DEFAULT_OLD_PRICE_RATIO = 1.75;
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export function initOperationBot(h) {
  if (initialized || h.isSellerPage()) {
    return;
  }

  initialized = true;

  const state = {
    menuOpen: false,
    panelOpen: false,
    panelMode: "single",
    loading: false,
    uploading: false,
    items: [],
    stores: [],
    storesLoaded: false,
    storesLoading: false,
    storesError: "",
    cloudSession: null,
    cloudSessionLoaded: false,
    cloudSessionLoading: false,
    cloudSessionError: "",
    cloudAuthRequired: false,
    selectedStoreId: "",
    pos: loadPos()
  };

  const rootId = "ozon-operation-bot-root";
  const ballId = "ozon-operation-bot-ball";
  const styleId = "ozon-operation-bot-style";
  let storesPromise = null;
  let domUploadResumePromise = null;

  ensureStyle();

  const root = document.createElement("div");
  root.id = rootId;
  root.className = "notranslate";
  root.setAttribute("translate", "no");
  root.innerHTML = `
    <button id="${ballId}" type="button" data-role="ball" aria-label="Operation Bot">OB</button>
    <section data-role="menu" hidden></section>
    <section data-role="panel" hidden></section>
  `;
  document.body.appendChild(root);

  const ball = root.querySelector('[data-role="ball"]');
  const menu = root.querySelector('[data-role="menu"]');
  const panel = root.querySelector('[data-role="panel"]');
  let drag = null;

  function ensureStyle() {
    if (document.getElementById(styleId)) {
      return;
    }

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${rootId}{position:fixed;inset:0;pointer-events:none;z-index:2147483643;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #${rootId} *{box-sizing:border-box}
      #${ballId}{position:fixed;width:56px;height:56px;border:0;border-radius:999px;background:linear-gradient(180deg,#2f6bff,#1d4ed8);color:#fff;box-shadow:0 14px 36px rgba(29,78,216,.34);cursor:grab;pointer-events:auto;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;letter-spacing:.04em;user-select:none;touch-action:none}
      #${ballId}[data-dragging="1"]{cursor:grabbing}
      .obot-menu{position:fixed;width:272px;border-radius:20px;overflow:hidden;background:rgba(255,255,255,.98);border:1px solid rgba(226,232,240,.92);box-shadow:0 28px 70px rgba(15,23,42,.22);pointer-events:auto;color:#0f172a}
      .obot-menu[hidden],.obot-panel[hidden]{display:none!important}
      .obot-menu__header{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(180deg,#f8fbff,#f1f5f9);border-bottom:1px solid #e2e8f0}
      .obot-menu__icon{width:34px;height:34px;border-radius:12px;background:linear-gradient(180deg,#2f6bff,#2563eb);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:800;box-shadow:0 10px 24px rgba(37,99,235,.24)}
      .obot-menu__title{font-size:15px;font-weight:800;line-height:1.1}
      .obot-menu__sub{margin-top:2px;font-size:11px;color:#64748b}
      .obot-menu__body{padding:12px;max-height:min(72vh,640px);overflow:auto}
      .obot-menu__label{margin:12px 8px 8px;font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.08em;text-transform:uppercase}
      .obot-menu__item{width:100%;border:0;background:transparent;display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;color:#334155;font-size:14px;font-weight:700;text-align:left;pointer-events:auto;cursor:pointer}
      .obot-menu__item:hover{background:#f8fafc}
      .obot-menu__item--primary{background:linear-gradient(180deg,#2f6bff,#2563eb);color:#fff;box-shadow:0 10px 26px rgba(37,99,235,.18)}
      .obot-menu__item[disabled]{opacity:.48;cursor:not-allowed}
      .obot-menu__item[disabled]:hover{background:transparent}
      .obot-divider{height:1px;margin:10px 8px;background:#e2e8f0}
      .obot-panel{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto;background:rgba(15,23,42,.24);backdrop-filter:blur(6px)}
      .obot-dialog{width:min(1380px,97vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;border-radius:22px;background:#fff;border:1px solid #dbe4f0;box-shadow:0 32px 86px rgba(15,23,42,.22);color:#0f172a}
      .obot-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 22px 14px;border-bottom:1px solid #e2e8f0;background:linear-gradient(180deg,#fbfdff,#f8fafc)}
      .obot-title{font-size:20px;font-weight:800;line-height:1.2}
      .obot-sub{margin-top:6px;font-size:13px;color:#64748b}
      .obot-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
      .obot-toolbar{display:grid;grid-template-columns:minmax(240px,.9fr) minmax(320px,1.5fr) minmax(260px,1fr) minmax(260px,1fr);gap:12px;padding:16px 22px;border-bottom:1px solid #e2e8f0}
      .obot-field{display:flex;flex-direction:column;gap:6px}
      .obot-field label{font-size:12px;font-weight:700;color:#64748b}
      .obot-input,.obot-select{height:40px;padding:0 12px;border-radius:12px;border:1px solid #dbe4f0;background:#fff;color:#0f172a;font-size:13px;outline:none}
      .obot-input:focus,.obot-select:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.14)}
      .obot-input[disabled]{background:#f8fafc;color:#94a3b8}
      .obot-select[disabled]{background:#f8fafc;color:#94a3b8}
      .obot-chiprow{display:flex;gap:8px;flex-wrap:wrap}
      .obot-chip{height:38px;padding:0 14px;border-radius:12px;border:1px solid #dbe4f0;background:#fff;color:#1e40af;font-size:13px;font-weight:800;cursor:pointer}
      .obot-chip:hover{background:#eff6ff;border-color:#bfdbfe}
      .obot-banner{margin:0 22px 14px;padding:12px 14px;border-radius:14px;background:#eff6ff;color:#1d4ed8;font-size:13px;font-weight:700}
      .obot-banner--warn{background:#fff7ed;color:#c2410c}
      .obot-banner--error{background:#fef2f2;color:#dc2626}
      .obot-caption{font-size:11px;color:#94a3b8}
      .obot-tablewrap{padding:0 22px 18px;overflow:auto;min-height:240px}
      .obot-table{width:100%;min-width:1360px;border-collapse:collapse}
      .obot-table th,.obot-table td{padding:12px 10px;border-bottom:1px solid #edf2f7;font-size:13px;vertical-align:middle;text-align:left}
      .obot-table th{position:sticky;top:0;z-index:1;background:#f8fafc;color:#64748b;font-size:12px;font-weight:800;white-space:nowrap}
      .obot-sku{font-weight:800;color:#0f172a}
      .obot-titleline{margin-top:4px;max-width:220px;font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .obot-thumb{width:44px;height:44px;border-radius:12px;object-fit:cover;background:#f1f5f9;border:1px solid #e2e8f0}
      .obot-metric{font-weight:700;color:#0f172a;white-space:nowrap}
      .obot-metric--ok{color:#16a34a}
      .obot-metric--bad{color:#ef4444}
      .obot-status{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap;background:#f1f5f9;color:#475569}
      .obot-status[data-s="running"]{background:#dbeafe;color:#1d4ed8}
      .obot-status[data-s="done"]{background:#dcfce7;color:#15803d}
      .obot-status[data-s="error"]{background:#fee2e2;color:#dc2626}
      .obot-inline{display:flex;align-items:center;gap:8px}
      .obot-inline .obot-input{min-width:0}
      .obot-btn{height:42px;padding:0 16px;border-radius:12px;border:1px solid transparent;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap}
      .obot-btn:disabled{cursor:not-allowed;opacity:.58}
      .obot-btn--p{background:linear-gradient(180deg,#2f6bff,#1d4ed8);color:#fff;box-shadow:0 12px 28px rgba(37,99,235,.18)}
      .obot-btn--g{background:#fff;color:#334155;border-color:#dbe4f0}
      .obot-btn--row{height:36px;padding:0 14px;border-radius:10px;background:linear-gradient(180deg,#2f6bff,#1d4ed8);color:#fff}
      .obot-btn--mini{height:34px;padding:0 12px;border-radius:10px}
      .obot-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 22px 20px;border-top:1px solid #e2e8f0;background:linear-gradient(180deg,#fff,#f8fafc)}
      .obot-summary{font-size:13px;color:#475569;font-weight:700}
      .obot-empty{padding:48px 18px;text-align:center;color:#64748b;font-size:14px;font-weight:700}
      .obot-loading{display:inline-flex;align-items:center;gap:10px;font-size:14px;font-weight:700;color:#334155}
      .obot-spin{width:18px;height:18px;border-radius:999px;border:2px solid rgba(37,99,235,.18);border-top-color:#2563eb;animation:obotspin .9s linear infinite}
      @keyframes obotspin{to{transform:rotate(360deg)}}
      @media (max-width:1100px){
        .obot-dialog{width:min(100vw - 16px,100vw);max-height:calc(100vh - 16px)}
        .obot-toolbar{grid-template-columns:1fr 1fr}
        .obot-panel{padding:8px}
      }
      @media (max-width:780px){
        .obot-toolbar{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function loadPos() {
    try {
      const raw = localStorage.getItem(POSITION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
          return clampPos(parsed);
        }
      }
    } catch (_error) {}

    return clampPos({
      x: window.innerWidth - 84,
      y: window.innerHeight - 180
    });
  }

  function savePos() {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(state.pos));
  }

  function cloudAccountKey(session = state.cloudSession) {
    return String(session?.accountKey || session?.user?.id || session?.user?.username || "").trim();
  }

  function storeStorageKey(session = state.cloudSession) {
    const accountKey = cloudAccountKey(session);
    return accountKey ? `${STORE_STORAGE_KEY}:${accountKey}` : STORE_STORAGE_KEY;
  }

  function loadStoredStoreId(session = state.cloudSession) {
    try {
      const scopedKey = storeStorageKey(session);
      const scopedValue = String(localStorage.getItem(scopedKey) || "").trim();
      if (scopedValue) {
        return scopedValue;
      }
      return scopedKey === STORE_STORAGE_KEY ? "" : String(localStorage.getItem(STORE_STORAGE_KEY) || "").trim();
    } catch (_error) {
      return "";
    }
  }

  function saveStoredStoreId(storeId, session = state.cloudSession) {
    try {
      const scopedKey = storeStorageKey(session);
      if (storeId) {
        localStorage.setItem(scopedKey, storeId);
        if (scopedKey !== STORE_STORAGE_KEY) {
          localStorage.removeItem(STORE_STORAGE_KEY);
        }
      } else {
        localStorage.removeItem(scopedKey);
      }
    } catch (_error) {}
  }

  function extractProductIdFromUrl(url) {
    const match = String(url || "").match(/-([0-9]{6,})(?:[/?#]|$)/);
    return match ? Number(match[1]) : null;
  }

  function cloneItems(items) {
    return (items || []).map((item) => ({ ...item }));
  }

  function loadDomUploadFlow() {
    try {
      const raw = sessionStorage.getItem(DOM_UPLOAD_FLOW_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items) || !Array.isArray(parsed.queueProductIds)) {
        return null;
      }

      return {
        ...parsed,
        items: cloneItems(parsed.items),
        queueProductIds: [...parsed.queueProductIds]
      };
    } catch (_error) {
      return null;
    }
  }

  function saveDomUploadFlow(flow) {
    try {
      if (!flow) {
        sessionStorage.removeItem(DOM_UPLOAD_FLOW_KEY);
        return;
      }

      sessionStorage.setItem(
        DOM_UPLOAD_FLOW_KEY,
        JSON.stringify({
          ...flow,
          items: cloneItems(flow.items),
          queueProductIds: [...(flow.queueProductIds || [])],
          updatedAt: new Date().toISOString()
        })
      );
    } catch (_error) {}
  }

  function clearDomUploadFlow() {
    try {
      sessionStorage.removeItem(DOM_UPLOAD_FLOW_KEY);
    } catch (_error) {}
  }

  function updateDomUploadFlow(updater) {
    const current = loadDomUploadFlow();
    if (!current) {
      return null;
    }

    const next = updater({
      ...current,
      items: cloneItems(current.items),
      queueProductIds: [...(current.queueProductIds || [])]
    });

    if (!next) {
      clearDomUploadFlow();
      return null;
    }

    saveDomUploadFlow(next);
    return next;
  }

  function persistStateToDomUploadFlow(extra = {}) {
    return updateDomUploadFlow((flow) => ({
      ...flow,
      ...extra,
      items: cloneItems(state.items),
      selectedStoreId: state.selectedStoreId,
      panelMode: state.panelMode,
      panelOpen: state.panelOpen
    }));
  }

  function syncStateFromDomUploadFlow(flow) {
    if (!flow) {
      return false;
    }

    state.panelMode = flow.panelMode || state.panelMode;
    state.panelOpen = flow.panelOpen !== false;
    state.selectedStoreId = flow.selectedStoreId || state.selectedStoreId;
    state.items = cloneItems(flow.items);
    state.uploading = Boolean(flow.active);
    return true;
  }

  function getCurrentFlowItem(flow) {
    const currentProductId = Number(flow?.queueProductIds?.[flow.index]);
    if (!Number.isFinite(currentProductId)) {
      return null;
    }

    return flow.items.find((item) => Number(item.productId) === currentProductId) || null;
  }

  function isCurrentFlowItemPage(item) {
    const currentProductId = extractProductIdFromUrl(location.href);
    return Number.isFinite(currentProductId) && Number(item?.productId) === currentProductId;
  }

  function buildDomUploadJobPayload(item, flow) {
    const followPrice = formatInputPrice(item.followPrice);
    return {
      storeId: flow.selectedStoreId || state.selectedStoreId,
      followPrice,
      minPrice: formatInputPrice(item.minFollowPrice) || null,
      oldPrice: buildDefaultOldPrice(followPrice) || null,
      model: normalizeModel(item.model) || buildRandomModel(item.productId)
    };
  }

  function clampPos(pos) {
    return {
      x: Math.min(Math.max(12, Number(pos?.x) || 0), Math.max(12, window.innerWidth - 68)),
      y: Math.min(Math.max(12, Number(pos?.y) || 0), Math.max(12, window.innerHeight - 68))
    };
  }

  function text(value, fallback = "-") {
    const normalized = h.normalizeText(String(value || ""));
    return normalized || fallback;
  }

  function metricMap(record) {
    return h.buildMetricMap(record || {});
  }

  function getMetric(record, keys, fallback = "-") {
    return h.getMetricValue(metricMap(record), keys, fallback);
  }

  function parseAmount(value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    const raw = String(value).trim();
    if (!raw) {
      return null;
    }

    const compact = raw.replace(/\s+/g, "").replace(/[^\d,.-]/g, "");
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
    }

    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }

    const numericValue = Number(match[0]);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function formatInputPrice(value) {
    const numericValue = parseAmount(value);
    return numericValue === null ? "" : numericValue.toFixed(2);
  }

  function buildDefaultMinFollowPrice(value) {
    const numericValue = parseAmount(value);
    if (numericValue === null) {
      return "";
    }

    return (numericValue * DEFAULT_MIN_FOLLOW_PRICE_RATIO).toFixed(2);
  }

  function buildDefaultOldPrice(value) {
    const numericValue = parseAmount(value);
    if (numericValue === null) {
      return "";
    }

    return (numericValue * DEFAULT_OLD_PRICE_RATIO).toFixed(2);
  }

  function isAutoMinFollowPrice(minValue, followValue) {
    const normalizedMinValue = formatInputPrice(minValue);
    if (!normalizedMinValue) {
      return true;
    }

    return normalizedMinValue === buildDefaultMinFollowPrice(followValue);
  }

  function normalizeModel(value) {
    return String(value || "").trim().slice(0, 120);
  }

  function randomCode(length = 4) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";

    for (let index = 0; index < length; index += 1) {
      result += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return result;
  }

  function buildRandomModel(productId) {
    const skuText = String(productId || "SKU").replace(/\D+/g, "").slice(-6) || "SKU";
    return `M${skuText}-${randomCode(4)}`;
  }

  function extractVariantTargets() {
    const variants =
      typeof h.extractProductVariants === "function" ? h.extractProductVariants() : [];

    return (variants || [])
      .filter((item) => item?.productId && item?.productUrl)
      .map((item) => ({
        productId: Number(item.productId),
        layout: "variant",
        host: document.body,
        variant: item
      }));
  }

  function cardPriceTexts(host) {
    const lines = h.splitNormalizedLines(host?.innerText || "");
    const matches = [];

    for (const line of lines) {
      if (!/[\u00A5\u20BD\uFFE5]/.test(line) || line.length > 32) {
        continue;
      }
      matches.push(line);
    }

    const unique = h.uniqueStrings(matches);
    return {
      currentPriceText: unique[0] || "-",
      originalPriceText: unique[1] || "-"
    };
  }

  function anchorScore(anchor) {
    const label = h.normalizeText(
      anchor?.innerText || anchor?.getAttribute("aria-label") || anchor?.title || ""
    );

    if (!label) {
      return -1;
    }

    const keywordPenalty = /(sale|sale price|распродажа|скидк|вау|отзыв)/i.test(label) ? 200 : 0;
    return label.length - keywordPenalty;
  }

  function pickProductAnchor(host) {
    const anchors = [...(host?.querySelectorAll('a[href*="/product/"]') || [])];
    if (!anchors.length) {
      return null;
    }

    return anchors.sort((left, right) => anchorScore(right) - anchorScore(left))[0] || anchors[0];
  }

  function imageScore(image) {
    return (image?.naturalWidth || image?.width || 0) * (image?.naturalHeight || image?.height || 0);
  }

  function pickBestImage(host) {
    const images = [...(host?.querySelectorAll("img") || [])].filter(
      (image) => h.absoluteUrl(image?.currentSrc || image?.src || "") !== ""
    );
    if (!images.length) {
      return null;
    }

    return images.sort((left, right) => imageScore(right) - imageScore(left))[0] || images[0];
  }

  function visibleArea(target) {
    if (!(target?.host instanceof Element)) {
      return -1;
    }

    const rect = target.host.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function pickSingleTarget(targets) {
    const productPageTarget = targets.find((item) => item.layout === "product-page");
    if (productPageTarget) {
      return productPageTarget;
    }

    return [...targets].sort((left, right) => visibleArea(right) - visibleArea(left))[0] || targets[0];
  }

  function targetDisplay(target, record) {
    if (target?.layout === "variant" && target?.variant) {
      return {
        title: text(target.variant.title || record?.title || "", `SKU ${target?.productId || "-"}`),
        subtitle: text(target.variant.variantSummary || "", record?.title || "-"),
        imageUrl: h.absoluteUrl(target.variant.imageUrl || ""),
        productUrl: h.absoluteUrl(target.variant.productUrl || record?.sourceUrl || ""),
        currentPriceText: text(target.variant.currentPriceText || "", "-"),
        originalPriceText: text(target.variant.originalPriceText || "", "-"),
        productWeightText: "-"
      };
    }

    if (target?.layout === "product-page") {
      const pricing = h.extractPricingData();
      const gallery = h.extractGalleryData();
      const characteristics = h.extractCharacteristicsData();
      const productWeight = h.extractProductWeightFromCharacteristics(characteristics.items);

      return {
        title: h.extractProductTitle() || record?.title || "-",
        subtitle: record?.title || "-",
        imageUrl: h.absoluteUrl(gallery?.coverImage || gallery?.images?.[0]?.src || ""),
        productUrl: location.href,
        currentPriceText: text(
          pricing?.priceText || pricing?.cardPriceText || pricing?.regularPriceText || "",
          "-"
        ),
        originalPriceText: text(pricing?.originalPriceText || "", "-"),
        productWeightText: text(productWeight?.weightText || "", "-")
      };
    }

    const anchor = pickProductAnchor(target?.host);
    const image = pickBestImage(target?.host);
    const prices = cardPriceTexts(target?.host);

    return {
      title: text(anchor?.innerText || record?.title || "", `SKU ${target?.productId || "-"}`),
      subtitle: text(record?.title || "", `SKU ${target?.productId || "-"}`),
      imageUrl: h.absoluteUrl(image?.currentSrc || image?.src || ""),
      productUrl: h.absoluteUrl(anchor?.getAttribute("href") || record?.sourceUrl || ""),
      currentPriceText: prices.currentPriceText,
      originalPriceText: prices.originalPriceText,
      productWeightText: "-"
    };
  }

  function buildItem(target, record) {
    const display = targetDisplay(target, record);
    const marketPriceText = text(display.currentPriceText || getMetric(record, "avgPrice"), "-");
    const marketMinPriceText = h.formatMinPriceMetric(getMetric(record, "minPrice"));
    const marketPriceNumeric =
      parseAmount(display.currentPriceText) || parseAmount(getMetric(record, "avgPrice"));

    return {
      key: `${target.productId}:${target.layout}`,
      productId: target.productId,
      productUrl: display.productUrl || record?.sourceUrl || "",
      variantData: target?.layout === "variant" ? target.variant || null : null,
      title: display.title,
      subtitle: display.subtitle || display.title,
      imageUrl: display.imageUrl || "",
      basePrice: marketPriceNumeric,
      marketPriceText,
      marketMinPriceText: text(marketMinPriceText, "-"),
      packageWeightText: text(
        getMetric(record, ["weight", "volume"], display.productWeightText || "-"),
        "-"
      ),
      monthlySalesText: getMetric(record, "monthlySales"),
      cartConversionText: getMetric(record, "cartConversion"),
      followPrice: formatInputPrice(marketPriceNumeric),
      minFollowPrice: buildDefaultMinFollowPrice(marketPriceNumeric),
      model: buildRandomModel(target.productId),
      selected: true,
      uploadState: "idle",
      uploadMessage: "",
      uploadTaskId: ""
    };
  }

  async function fetchRecords(productIds) {
    try {
      const response = await h.sendMessage({
        type: "get-seller-analytics",
        productIds,
        fetchMissing: true
      });
      return response?.ok ? response.records || {} : {};
    } catch (_error) {
      return {};
    }
  }

  function uniqueTargets(targets) {
    const seen = new Set();
    const result = [];

    for (const item of targets || []) {
      if (!item?.productId || seen.has(item.productId)) {
        continue;
      }
      seen.add(item.productId);
      result.push(item);
    }

    return result;
  }

  async function collectItems(mode) {
    if (mode === "variants") {
      const targets = extractVariantTargets();
      if (!targets.length) {
        return [];
      }

      const productIds = [...new Set(targets.map((item) => item.productId).filter(Boolean))];
      const records = await fetchRecords(productIds);
      return targets.map((item) => buildItem(item, records[item.productId] || { productId: item.productId }));
    }

    const targets = h.collectBuyerTargets();
    if (!targets.length) {
      return [];
    }

    const scoped = mode === "single" ? [pickSingleTarget(targets)].filter(Boolean) : uniqueTargets(targets);
    const productIds = [...new Set(scoped.map((item) => item.productId).filter(Boolean))];
    const records = await fetchRecords(productIds);

    return scoped.map((item) => buildItem(item, records[item.productId] || { productId: item.productId }));
  }

  function mergeIncomingItems(items) {
    const previous = new Map(state.items.map((item) => [item.productId, item]));
    return (items || []).map((item) => {
      const existing = previous.get(item.productId);
      if (!existing) {
        return item;
      }

      return {
        ...item,
        selected: existing.selected,
        followPrice: existing.followPrice || item.followPrice,
        minFollowPrice: existing.minFollowPrice || item.minFollowPrice,
        model: existing.model || item.model,
        uploadState: existing.uploadState,
        uploadMessage: existing.uploadMessage,
        uploadTaskId: existing.uploadTaskId
      };
    });
  }

  function selectedItems() {
    return state.items.filter((item) => item.selected);
  }

  function finishedItems() {
    return state.items.filter((item) => item.uploadState === "done");
  }

  function replaceItems(items, preserveExisting = false) {
    state.items = preserveExisting ? mergeIncomingItems(items) : [...(items || [])];
    persistStateToDomUploadFlow();
    renderPanel();
  }

  function patchItem(productId, patch, render = true) {
    state.items = state.items.map((item) =>
      item.productId === productId ? { ...item, ...patch } : item
    );
    persistStateToDomUploadFlow();
    if (render) {
      renderPanel();
    }
  }

  function getJobHdUpload(job) {
    return job?.hdUpload || job?.result?.hdUpload || null;
  }

  function isHdUploadFailed(hdUpload) {
    const statusText = String(hdUpload?.status || "").toLowerCase();
    const jobStatusText = String(hdUpload?.jobStatus || "").toLowerCase();
    return statusText === "failed" || jobStatusText === "failed";
  }

  function isHdUploadAccepted(hdUpload) {
    if (!hdUpload || (!hdUpload.productId && !hdUpload.jobId)) {
      return false;
    }
    return !isHdUploadFailed(hdUpload);
  }

  async function resumeDomUploadFlow() {
    if (domUploadResumePromise) {
      return domUploadResumePromise;
    }

    domUploadResumePromise = (async () => {
      let flow = loadDomUploadFlow();
      if (!flow) {
        return;
      }

      syncStateFromDomUploadFlow(flow);
      renderPanel();

      if (!flow.active) {
        return;
      }

      const currentItem = getCurrentFlowItem(flow);
      if (!currentItem) {
        flow = updateDomUploadFlow((current) => ({
          ...current,
          active: false,
          panelOpen: true,
          completedAt: new Date().toISOString()
        }));
        if (flow) {
          syncStateFromDomUploadFlow(flow);
          renderPanel();
        }
        return;
      }

      if (!isCurrentFlowItemPage(currentItem)) {
        location.assign(currentItem.productUrl);
        return;
      }

      patchItem(currentItem.productId, {
        uploadState: "running",
        uploadMessage: "正在等待当前变体页面特征加载..."
      });

      let jobResponse = await h.sendMessage({ type: "get-job" });
      let job = jobResponse?.job || null;
      const hasMatchingRunningJob =
        job &&
        job.jobType === "upload-product" &&
        Number(job.productId) === Number(currentItem.productId) &&
        job.status === "running";

      if (!hasMatchingRunningJob) {
        const startResponse = await h.sendMessage({
          type: "start-job",
          jobType: "upload-product",
          url: currentItem.productUrl || location.href,
          customUpload: buildDomUploadJobPayload(currentItem, flow)
        });

        if (!startResponse?.ok) {
          throw new Error(startResponse?.error || "无法启动当前变体 DOM 抓取任务。");
        }

        job = startResponse.job || null;
      }

      while (true) {
        await h.sleep(1000);
        jobResponse = await h.sendMessage({ type: "get-job" });
        job = jobResponse?.job || job;

        if (!job || Number(job.productId) !== Number(currentItem.productId)) {
          continue;
        }

        const hdUpload = getJobHdUpload(job);
        if (isHdUploadAccepted(hdUpload)) {
          break;
        }

        if (isHdUploadFailed(hdUpload)) {
          break;
        }

        if (job.status === "running") {
          const stageText = h.normalizeText(String(job.stage || "").replace(/[_-]+/g, " "));
          patchItem(currentItem.productId, {
            uploadState: "running",
            uploadMessage: stageText || "正在抓取并上传当前变体..."
          });
          continue;
        }

        if (job.status === "done" || job.status === "error") {
          break;
        }
      }

      const hdUpload = getJobHdUpload(job);
      if (job?.status === "done" || isHdUploadAccepted(hdUpload)) {
        const uploadStatusText = String(hdUpload?.status || "").toLowerCase();
        const isPendingUpload = uploadStatusText !== "uploaded";
        patchItem(currentItem.productId, {
          uploadState: "done",
          uploadMessage: isPendingUpload ? "已提交云端，处理中" : "已完成",
          uploadTaskId: text(hdUpload?.ozonTaskId || "", "")
        });
      } else {
        patchItem(currentItem.productId, {
          uploadState: "error",
          uploadMessage: hdUpload?.error || job?.error || "变体铺货失败"
        });
      }

      flow = updateDomUploadFlow((current) => ({
        ...current,
        index: Number(current.index || 0) + 1,
        active: Number(current.index || 0) + 1 < (current.queueProductIds || []).length,
        panelOpen: true,
        items: cloneItems(state.items),
        selectedStoreId: state.selectedStoreId
      }));

      if (!flow) {
        return;
      }

      syncStateFromDomUploadFlow(flow);
      renderPanel();

      const nextItem = getCurrentFlowItem(flow);
      if (flow.active && nextItem?.productUrl) {
        location.assign(nextItem.productUrl);
        return;
      }

      h.showOverlay("变体铺货已完成", "#16a34a");
      if (flow.returnUrl && h.absoluteUrl(flow.returnUrl) !== h.absoluteUrl(location.href)) {
        location.assign(flow.returnUrl);
      }
    })()
      .catch((error) => {
        const flow = updateDomUploadFlow((current) => {
          const failedItem = getCurrentFlowItem(current);
          const nextItems = cloneItems(current.items).map((item) =>
            Number(item.productId) === Number(failedItem?.productId)
              ? {
                  ...item,
                  uploadState: "error",
                  uploadMessage: error instanceof Error ? error.message : String(error)
                }
              : item
          );

          return {
            ...current,
            active: false,
            panelOpen: true,
            items: nextItems,
            failedAt: new Date().toISOString()
          };
        });

        if (flow) {
          syncStateFromDomUploadFlow(flow);
          renderPanel();
        }
        h.showOverlay(error instanceof Error ? error.message : String(error), "#dc2626");
      })
      .finally(() => {
        domUploadResumePromise = null;
      });

    return domUploadResumePromise;
  }

  async function startDomUploadFlow(queue) {
    const queueProductIds = queue.map((item) => item.productId);
    const flow = {
      version: 1,
      active: true,
      panelOpen: true,
      panelMode: state.panelMode,
      selectedStoreId: state.selectedStoreId,
      returnUrl: location.href,
      queueProductIds,
      index: 0,
      items: cloneItems(state.items),
      startedAt: new Date().toISOString()
    };

    saveDomUploadFlow(flow);
    syncStateFromDomUploadFlow(flow);
    renderPanel();
    await resumeDomUploadFlow();
  }

  function selectedStore() {
    return state.stores.find((item) => String(item.id) === String(state.selectedStoreId)) || null;
  }

  function cloudAccountLabel() {
    const session = state.cloudSession;
    if (!session?.user) {
      return "";
    }

    const name = session.user.display_name || session.user.username || "SaaS 用户";
    const tenant = session.user.tenant_name ? ` / ${session.user.tenant_name}` : "";
    return `${name}${tenant}`;
  }

  async function ensureCloudSessionLoaded(force = false) {
    if (!force && state.cloudSessionLoaded) {
      return state.cloudSession;
    }

    state.cloudSessionLoading = true;
    state.cloudSessionError = "";
    renderMenu();
    renderPanel();

    try {
      const response = await h.sendMessage({ type: "get-hd-session", force });
      if (!response?.ok) {
        state.cloudSession = null;
        state.cloudAuthRequired = response?.code === "cloud_auth_required";
        state.cloudSessionError = response?.error || "请先登录 SaaS 后台";
        state.cloudSessionLoaded = true;
        return null;
      }

      state.cloudSession = response.session || null;
      state.cloudAuthRequired = !state.cloudSession;
      state.cloudSessionLoaded = true;
      if (state.cloudSession && !state.selectedStoreId) {
        state.selectedStoreId = loadStoredStoreId(state.cloudSession);
      }
      return state.cloudSession;
    } catch (error) {
      state.cloudSession = null;
      state.cloudAuthRequired = true;
      state.cloudSessionLoaded = true;
      state.cloudSessionError = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      state.cloudSessionLoading = false;
      renderMenu();
      renderPanel();
    }
  }

  async function connectCloudAccount() {
    state.cloudSessionLoading = true;
    state.cloudSessionError = "";
    renderMenu();
    renderPanel();

    try {
      const response = await h.sendMessage({ type: "connect-hd-account" });
      if (response?.ok && response.session) {
        state.cloudSession = response.session;
        state.cloudSessionLoaded = true;
        state.cloudAuthRequired = false;
        state.selectedStoreId = loadStoredStoreId(state.cloudSession);
        const stores = await ensureStoresLoaded(true);
        if (!state.cloudSession) {
          h.showOverlay(state.storesError || state.cloudSessionError || "请重新登录 SaaS 后台", "#dc2626");
        } else {
          h.showOverlay(stores.length ? "云端账号已连接" : "云端账号已连接，但没有可用店铺", "#16a34a");
        }
        return;
      }

      state.cloudSession = null;
      state.cloudSessionLoaded = true;
      state.cloudAuthRequired = true;
      state.cloudSessionError = response?.error || "请先登录 SaaS 后台";
      h.showOverlay(state.cloudSessionError, "#2563eb");
    } catch (error) {
      state.cloudSession = null;
      state.cloudSessionLoaded = true;
      state.cloudAuthRequired = true;
      state.cloudSessionError = error instanceof Error ? error.message : String(error);
      h.showOverlay(state.cloudSessionError, "#dc2626");
    } finally {
      state.cloudSessionLoading = false;
      renderMenu();
      renderPanel();
    }
  }

  async function ensureStoresLoaded(force = false) {
    if (!force && state.storesLoaded) {
      return state.stores;
    }

    if (storesPromise) {
      return storesPromise;
    }

    state.storesLoading = true;
    state.storesError = "";
    renderPanel();

    storesPromise = (async () => {
      try {
        const session = await ensureCloudSessionLoaded(force);
        if (!session) {
          state.stores = [];
          state.storesLoaded = false;
          state.selectedStoreId = "";
          state.storesError = state.cloudSessionError || "请先登录 SaaS 后台";
          return [];
        }

        const response = await h.sendMessage({ type: "get-hd-stores" });
        if (!response?.ok) {
          if (response?.code === "cloud_auth_required") {
            state.cloudSession = null;
            state.cloudAuthRequired = true;
            state.cloudSessionLoaded = true;
          }
          throw new Error(response?.error || "无法获取店铺列表");
        }

        state.cloudSession = response.session || session;
        state.cloudSessionLoaded = true;
        state.cloudAuthRequired = false;

        const stores = [...(response.stores || [])].sort(
          (left, right) => Number(Boolean(right.is_default)) - Number(Boolean(left.is_default))
        );

        state.stores = stores;
        state.storesLoaded = true;

        const preferredStoreId = state.selectedStoreId || loadStoredStoreId(state.cloudSession);
        state.selectedStoreId =
          stores.find((item) => String(item.id) === String(preferredStoreId))?.id ||
          stores.find((item) => item.is_default)?.id ||
          stores[0]?.id ||
          "";
        saveStoredStoreId(state.selectedStoreId, state.cloudSession);
        return stores;
      } catch (error) {
        state.stores = [];
        state.storesLoaded = false;
        state.selectedStoreId = "";
        state.storesError = error instanceof Error ? error.message : String(error);
        return [];
      } finally {
        state.storesLoading = false;
        storesPromise = null;
        renderPanel();
      }
    })();

    return storesPromise;
  }

  async function openPanel(mode) {
    if (
      mode !== "current-page" &&
      typeof h.waitForProductDomReady === "function"
    ) {
      const readiness = await h.waitForProductDomReady(15000);
      if (!readiness?.ready) {
        h.showOverlay(readiness?.message || readiness?.reason || "商品未加载完成，请稍后重试", "#dc2626");
        state.panelOpen = false;
        state.loading = false;
        renderPanel();
        return;
      }
    }

    state.loading = true;
    state.panelOpen = true;
    state.panelMode = mode;
    renderPanel();

    const storeTask = ensureStoresLoaded();
    try {
      state.items = await collectItems(mode);
      await storeTask;
    } finally {
      state.loading = false;
      renderPanel();
    }
  }

  async function loadMore() {
    let bestCount = h.collectBuyerTargets().length;
    let stableRounds = 0;

    for (let step = 0; step < 12 && stableRounds < 3; step += 1) {
      window.scrollBy({
        top: Math.max(window.innerHeight * 0.9, 620),
        behavior: "smooth"
      });

      await h.sleep(1100);

      const nextCount = h.collectBuyerTargets().length;
      if (nextCount > bestCount) {
        bestCount = nextCount;
        stableRounds = 0;
      } else {
        stableRounds += 1;
      }
    }

    h.showOverlay(`已加载 ${bestCount} 个 SKU`, "#2563eb");
    await h.refreshBuyerAnalyticsPanels();

    if (state.panelOpen && state.panelMode === "current-page") {
      replaceItems(await collectItems("current-page"), true);
    }
  }

  function applyMultiplier(multiplier) {
    state.items = state.items.map((item) => {
      const numericBase = item.basePrice || parseAmount(item.followPrice);
      if (numericBase === null) {
        return item;
      }

      const nextFollowPrice = numericBase ? (numericBase * multiplier).toFixed(2) : item.followPrice;
      const nextPatch = {
        ...item,
        followPrice: nextFollowPrice
      };

      if (isAutoMinFollowPrice(item.minFollowPrice, item.followPrice)) {
        nextPatch.minFollowPrice = buildDefaultMinFollowPrice(nextFollowPrice);
      }

      return nextPatch;
    });
    renderPanel();
  }

  function randomizeModels(productId = null) {
    state.items = state.items.map((item) => {
      if (productId && item.productId !== productId) {
        return item;
      }

      return {
        ...item,
        model: buildRandomModel(item.productId)
      };
    });
    renderPanel();
  }

  function cloudMenuHtml() {
    if (state.cloudSessionLoading) {
      return `
        <div class="obot-menu__label">云端账号</div>
        <button class="obot-menu__item" disabled>正在检测 SaaS 登录状态...</button>
      `;
    }

    if (state.cloudSession?.user) {
      return `
        <div class="obot-menu__label">云端账号</div>
        <button class="obot-menu__item" data-action="reload-stores">
          已连接：${h.escapeHtml(cloudAccountLabel())}
        </button>
      `;
    }

    return `
      <div class="obot-menu__label">云端账号</div>
      <button class="obot-menu__item obot-menu__item--primary" data-action="connect-cloud">登录 / 连接 SaaS</button>
      ${
        state.cloudSessionError
          ? `<button class="obot-menu__item" disabled>${h.escapeHtml(state.cloudSessionError)}</button>`
          : ""
      }
    `;
  }

  function menuHtml() {
    const variantCount =
      typeof h.extractProductVariants === "function" ? h.extractProductVariants().length : 0;

    return `
      <div class="obot-menu__header">
        <div class="obot-menu__icon">OB</div>
        <div>
          <div class="obot-menu__title">Operation Bot</div>
          <div class="obot-menu__sub">当前状态: 已就绪</div>
        </div>
      </div>
      <div class="obot-menu__body">
        ${cloudMenuHtml()}
        <div class="obot-divider"></div>
        <div class="obot-menu__label">当前页采集与处理</div>
        <button class="obot-menu__item obot-menu__item--primary" data-action="follow-single">跟卖</button>
        <button class="obot-menu__item" data-action="follow-variants" ${variantCount > 1 ? "" : "disabled"}>跟卖所有变体</button>
        <button class="obot-menu__item" data-action="follow-page">跟卖当前页</button>
        <button class="obot-menu__item" data-action="load-more">加载更多数据</button>
        <button class="obot-menu__item" disabled>加入 SKU 草稿箱</button>
      </div>
    `;
  }

  function statusText(item) {
    if (item.uploadState === "done") {
      return item.uploadTaskId ? `已完成 ${item.uploadTaskId}` : "已完成";
    }

    if (item.uploadState === "error") {
      return item.uploadMessage || "铺货失败";
    }

    if (item.uploadState === "running") {
      return item.uploadMessage || "铺货中...";
    }

    return "待铺货";
  }

  function rowButtonText(item) {
    return item.uploadState === "running" ? "铺货中..." : "铺货";
  }

  function storeOptionsHtml() {
    if (!state.stores.length) {
      return `<option value="">未绑定店铺</option>`;
    }

    return state.stores
      .map(
        (store) =>
          `<option value="${h.escapeHtml(store.id)}" ${
            String(store.id) === String(state.selectedStoreId) ? "selected" : ""
          }>${h.escapeHtml(store.store_name)}${store.is_default ? "（默认）" : ""}</option>`
      )
      .join("");
  }

  function tableRows() {
    return state.items
      .map((item) => {
        const imageUrl = h.escapeHtml(item.imageUrl || TRANSPARENT_PIXEL);

        return `
          <tr>
            <td><input type="checkbox" data-select="${item.productId}" ${item.selected ? "checked" : ""} ${state.uploading ? "disabled" : ""} /></td>
            <td><img class="obot-thumb" src="${imageUrl}" alt="" /></td>
            <td><div class="obot-sku">${h.escapeHtml(item.productId)}</div><div class="obot-titleline">${h.escapeHtml(item.subtitle || item.title || "-")}</div></td>
            <td><input class="obot-input" data-field="followPrice" data-product="${item.productId}" value="${h.escapeHtml(item.followPrice || "")}" placeholder="填写跟卖价格" ${state.uploading ? "disabled" : ""} /></td>
            <td><input class="obot-input" data-field="minFollowPrice" data-product="${item.productId}" value="${h.escapeHtml(item.minFollowPrice || "")}" placeholder="填写最低价" ${state.uploading ? "disabled" : ""} /></td>
            <td>
              <div class="obot-inline">
                <input class="obot-input" data-field="model" data-product="${item.productId}" value="${h.escapeHtml(item.model || "")}" placeholder="必填型号" ${state.uploading ? "disabled" : ""} />
                <button class="obot-btn obot-btn--g obot-btn--mini" data-action="random-model" data-product="${item.productId}" ${state.uploading ? "disabled" : ""}>随机</button>
              </div>
            </td>
            <td><span class="obot-metric">${h.escapeHtml(item.marketPriceText || "-")}</span></td>
            <td><span class="obot-metric obot-metric--bad">${h.escapeHtml(item.marketMinPriceText || "-")}</span></td>
            <td><span class="obot-metric">${h.escapeHtml(item.packageWeightText || "-")}</span></td>
            <td><span class="obot-metric">${h.escapeHtml(item.monthlySalesText || "-")}</span></td>
            <td><span class="obot-metric obot-metric--ok">${h.escapeHtml(item.cartConversionText || "-")}</span></td>
            <td><span class="obot-status" data-s="${h.escapeHtml(item.uploadState || "idle")}">${h.escapeHtml(statusText(item))}</span></td>
            <td><button class="obot-btn obot-btn--row" data-upload="${item.productId}" ${
              state.uploading || !item.productUrl || !state.selectedStoreId ? "disabled" : ""
            }>${rowButtonText(item)}</button></td>
          </tr>
        `;
      })
      .join("");
  }

  function panelBannerHtml() {
    if (state.cloudSessionLoading) {
      return `<div class="obot-banner">正在检测 SaaS 登录状态...</div>`;
    }

    if (!state.cloudSession) {
      return `
        <div class="obot-banner obot-banner--warn">
          还没有连接云端账号。请先登录 SaaS，扩展只会读取当前账号可访问的店铺。
          <button class="obot-btn obot-btn--p obot-btn--mini" data-action="connect-cloud" ${state.uploading ? "disabled" : ""}>登录 SaaS</button>
        </div>
      `;
    }

    if (state.storesLoading) {
      return `<div class="obot-banner">正在从 SaaS 加载店铺列表...</div>`;
    }

    if (state.storesError) {
      return `
        <div class="obot-banner obot-banner--error">
          店铺列表加载失败：${h.escapeHtml(state.storesError)}
          <button class="obot-btn obot-btn--g obot-btn--mini" data-action="reload-stores" ${state.uploading ? "disabled" : ""}>重试</button>
        </div>
      `;
    }

    if (!state.stores.length) {
      return `<div class="obot-banner obot-banner--warn">SaaS 后台还没有绑定店铺，当前只能查看 SKU，不能铺货。</div>`;
    }

    return "";
  }

  function panelHtml() {
    const selectedCount = selectedItems().length;
    const totalCount = state.items.length;
    const finishedCount = finishedItems().length;
    const title =
      state.panelMode === "single"
        ? "当前商品跟卖面板"
        : state.panelMode === "variants"
          ? "当前商品全部变体"
          : "当前页跟卖面板";
    const subtitle =
      state.panelMode === "single"
        ? "当前商品已采集，可直接设置价格、最低价、型号并铺货。"
        : state.panelMode === "variants"
          ? "当前商品的全部颜色/规格变体已收集，可批量一起铺货到店铺。"
          : "当前页已加载 SKU，可批量设置价格、最低价、型号并铺货。";
    const store = selectedStore();

    if (state.loading) {
      return `
        <div class="obot-dialog">
          <div class="obot-head">
            <div>
              <div class="obot-title">${title}</div>
              <div class="obot-sub">${subtitle}</div>
            </div>
            <div class="obot-actions">
              <button class="obot-btn obot-btn--g" data-action="close-panel">关闭</button>
            </div>
          </div>
          <div class="obot-empty">
            <span class="obot-loading"><span class="obot-spin"></span>${state.panelMode === "variants" ? "正在收集当前商品全部变体..." : "正在收集当前页 SKU..."}</span>
          </div>
        </div>
      `;
    }

    return `
      <div class="obot-dialog">
        <div class="obot-head">
          <div>
            <div class="obot-title">${title}</div>
            <div class="obot-sub">${subtitle}</div>
          </div>
          <div class="obot-actions">
            <button class="obot-btn obot-btn--g" data-action="load-more" ${state.uploading ? "disabled" : ""}>加载更多</button>
            <button class="obot-btn obot-btn--g" data-action="close-panel">关闭</button>
          </div>
        </div>
        <div class="obot-toolbar">
          <div class="obot-field">
            <label>店铺</label>
            <select class="obot-select" data-store-select="1" ${state.uploading ? "disabled" : ""}>
              ${storeOptionsHtml()}
            </select>
            <div class="obot-caption">${h.escapeHtml(store?.store_name || "请选择 SaaS 已绑定店铺")}</div>
          </div>
          <div class="obot-field">
            <label>采集链接</label>
            <input class="obot-input" value="${h.escapeHtml(location.href)}" disabled />
            <div class="obot-caption">当前页面链接，仅作展示</div>
          </div>
          <div class="obot-field">
            <label>跟卖价格倍率</label>
            <div class="obot-chiprow">
              <button class="obot-chip" data-action="apply-multiplier" data-factor="2" ${state.uploading ? "disabled" : ""}>x2 价格</button>
              <button class="obot-chip" data-action="apply-multiplier" data-factor="2.5" ${state.uploading ? "disabled" : ""}>x2.5 价格</button>
              <button class="obot-chip" data-action="apply-multiplier" data-factor="3" ${state.uploading ? "disabled" : ""}>x3 价格</button>
            </div>
            <div class="obot-caption">按当前商品价格批量计算所有跟卖价</div>
          </div>
          <div class="obot-field">
            <label>型号操作</label>
            <div class="obot-chiprow">
              <button class="obot-chip" data-action="randomize-models" ${state.uploading ? "disabled" : ""}>随机所有型号</button>
              <button class="obot-chip" data-action="reload-stores" ${state.uploading ? "disabled" : ""}>刷新店铺</button>
            </div>
            <div class="obot-caption">型号是必填上传特征，可手填，也可随机</div>
          </div>
        </div>
        ${panelBannerHtml()}
        <div class="obot-tablewrap">
          ${
            totalCount
              ? `<table class="obot-table"><thead><tr><th><input type="checkbox" data-action="toggle-all" ${
                  selectedCount === totalCount && totalCount ? "checked" : ""
                } ${state.uploading ? "disabled" : ""} /></th><th>图片</th><th>SKU</th><th>跟卖价格</th><th>跟卖最低价</th><th>型号</th><th>产品价格</th><th>市场最低价</th><th>重量</th><th>月销量</th><th>加购转化</th><th>状态</th><th>操作</th></tr></thead><tbody>${tableRows()}</tbody></table>`
              : `<div class="obot-empty">当前页没有找到 SKU。</div>`
          }
        </div>
        <div class="obot-foot">
          <div class="obot-summary">共 ${totalCount} 个，选中 ${selectedCount} 个，完成 ${finishedCount} 个${store ? `，当前店铺 ${h.escapeHtml(store.store_name)}` : ""}</div>
          <div class="obot-actions">
            <button class="obot-btn obot-btn--g" data-action="close-panel">关闭</button>
            <button class="obot-btn obot-btn--p" data-action="upload-selected" ${
              state.uploading || !selectedCount || !state.selectedStoreId ? "disabled" : ""
            }>${state.uploading ? "铺货中..." : "铺货选中"}</button>
          </div>
        </div>
      </div>
    `;
  }

  function positionBall() {
    state.pos = clampPos(state.pos);
    ball.style.left = `${state.pos.x}px`;
    ball.style.top = `${state.pos.y}px`;
  }

  function positionMenu() {
    if (!state.menuOpen) {
      return;
    }

    const menuWidth = 272;
    const menuHeight = menu.offsetHeight || 480;
    const left =
      state.pos.x + 72 + menuWidth <= window.innerWidth - 12
        ? state.pos.x + 72
        : Math.max(12, state.pos.x - menuWidth - 14);
    const top = Math.min(
      Math.max(12, state.pos.y - 18),
      Math.max(12, window.innerHeight - menuHeight - 12)
    );

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function renderMenu() {
    menu.hidden = !state.menuOpen;
    menu.className = "obot-menu";
    menu.innerHTML = state.menuOpen ? menuHtml() : "";

    if (state.menuOpen) {
      positionMenu();
    }
  }

  function renderPanel() {
    panel.hidden = !state.panelOpen;
    panel.className = "obot-panel";
    panel.innerHTML = state.panelOpen ? panelHtml() : "";
  }

  function render() {
    positionBall();
    renderMenu();
    renderPanel();
  }

  async function uploadItems(productIds) {
    if (state.uploading) {
      return;
    }

    if (!state.selectedStoreId) {
      h.showOverlay("请先选择店铺", "#dc2626");
      return;
    }

    const queue = state.items.filter(
      (item) => productIds.includes(item.productId) && item.productUrl
    );
    if (!queue.length) {
      return;
    }

    const validQueue = [];
    for (const item of queue) {
      const followPrice = formatInputPrice(item.followPrice);
      const minFollowPrice = formatInputPrice(item.minFollowPrice);
      const model = normalizeModel(item.model) || buildRandomModel(item.productId);

      if (!followPrice) {
        patchItem(item.productId, {
          uploadState: "error",
          uploadMessage: "请填写跟卖价格"
        });
        continue;
      }

      if (minFollowPrice && Number(minFollowPrice) > Number(followPrice)) {
        patchItem(item.productId, {
          uploadState: "error",
          uploadMessage: "最低价不能高于跟卖价"
        });
        continue;
      }

      patchItem(
        item.productId,
        {
          followPrice,
          minFollowPrice,
          model,
          uploadState: "idle",
          uploadMessage: ""
        },
        false
      );

      validQueue.push({
        ...item,
        followPrice,
        minFollowPrice,
        model
      });
    }

    if (!validQueue.length) {
      renderPanel();
      return;
    }

    if (state.panelMode === "variants") {
      state.uploading = true;
      clearDomUploadFlow();
      renderPanel();

      try {
        if (typeof h.fetchOzonProductDataById !== "function") {
          throw new Error("变体商品页抓取能力不可用");
        }

        async function extractVariantUploadData(item) {
          return h.fetchOzonProductDataById(item.productId, item.productUrl);
        }

        for (const item of validQueue) {
          patchItem(
            item.productId,
            {
              followPrice: item.followPrice,
              minFollowPrice: item.minFollowPrice,
              model: item.model,
              uploadState: "running",
              uploadMessage: "正在抓取该变体商品页..."
            },
            true
          );

          try {
            const extractedJson = await extractVariantUploadData(item);
            const scrapedJson =
              typeof h.buildVariantProductData === "function"
                ? h.buildVariantProductData(extractedJson, item.variantData || item)
                : extractedJson;
            const response = await h.sendMessage({
              type: "upload-scraped-product",
              scrapedJson,
              storeId: state.selectedStoreId,
              followPrice: item.followPrice,
              minPrice: item.minFollowPrice || null,
              oldPrice: buildDefaultOldPrice(item.followPrice) || null,
              model: item.model
            });

            if (!response?.ok) {
              throw new Error(response?.error || "变体铺货失败");
            }

            const uploadStatusText = String(
              response?.status || response?.hdUpload?.status || ""
            ).toLowerCase();
            const isPendingUpload = Boolean(response?.pending) || uploadStatusText !== "uploaded";

            patchItem(item.productId, {
              uploadState: "done",
              uploadMessage: isPendingUpload ? "已提交云端，处理中" : "已完成",
              uploadTaskId: text(response?.hdUpload?.ozonTaskId || "", "")
            });
          } catch (error) {
            patchItem(item.productId, {
              uploadState: "error",
              uploadMessage: error instanceof Error ? error.message : String(error)
            });
          }
        }
      } finally {
        state.uploading = false;
        renderPanel();
      }
      return;
    }

    state.uploading = true;
    renderPanel();

    try {
      const currentProductId = extractProductIdFromUrl(location.href);
      let currentProductDataPromise = null;

      async function extractUploadData(item) {
        if (
          Number(item.productId) === Number(currentProductId) &&
          typeof h.extractCurrentProductDataForUpload === "function"
        ) {
          if (!currentProductDataPromise) {
            currentProductDataPromise = h.extractCurrentProductDataForUpload();
          }
          return currentProductDataPromise;
        }
        return h.extractProductDataFromUrl(item.productUrl);
      }

      for (const item of queue) {
        const followPrice = formatInputPrice(item.followPrice);
        const minFollowPrice = formatInputPrice(item.minFollowPrice);
        const model = normalizeModel(item.model) || buildRandomModel(item.productId);

        if (!followPrice) {
          patchItem(item.productId, {
            uploadState: "error",
            uploadMessage: "请填写跟卖价格"
          });
          continue;
        }

        if (minFollowPrice && Number(minFollowPrice) > Number(followPrice)) {
          patchItem(item.productId, {
            uploadState: "error",
            uploadMessage: "最低价不能高于跟卖价"
          });
          continue;
        }

        patchItem(
          item.productId,
          {
            followPrice,
            minFollowPrice,
            model,
            uploadState: "running",
            uploadMessage: "正在上传到 SaaS..."
          },
          true
        );

        try {
          const scrapedJson = await extractUploadData(item);
          const response = await h.sendMessage({
            type: "upload-scraped-product",
            scrapedJson,
            storeId: state.selectedStoreId,
            followPrice,
            minPrice: minFollowPrice || null,
            oldPrice: buildDefaultOldPrice(followPrice) || null,
            model
          });

          if (!response?.ok) {
            throw new Error(response?.error || "铺货失败");
          }

          const uploadStatusText = String(
            response?.status || response?.hdUpload?.status || ""
          ).toLowerCase();
          const isPendingUpload = Boolean(response?.pending) || uploadStatusText !== "uploaded";

          patchItem(item.productId, {
            uploadState: "done",
            uploadMessage: isPendingUpload ? "已提交云端，处理中" : "已完成",
            uploadTaskId: text(
              response?.hdUpload?.ozonTaskId || response?.job?.result?.hdUpload?.ozonTaskId || "",
              ""
            )
          });
        } catch (error) {
          patchItem(item.productId, {
            uploadState: "error",
            uploadMessage: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      state.uploading = false;
      renderPanel();
    }
  }

  async function runAction(action, dataset = {}) {
    if (action === "connect-cloud") {
      await connectCloudAccount();
      return;
    }

    if (action === "follow-single") {
      state.menuOpen = false;
      renderMenu();
      await openPanel("single");
      return;
    }

    if (action === "follow-variants") {
      state.menuOpen = false;
      renderMenu();
      await openPanel("variants");
      return;
    }

    if (action === "follow-page") {
      state.menuOpen = false;
      renderMenu();
      await openPanel("current-page");
      return;
    }

    if (action === "load-more") {
      if (state.menuOpen) {
        state.menuOpen = false;
        renderMenu();
      }
      await loadMore();
      return;
    }

    if (action === "close-panel") {
      state.panelOpen = false;
      renderPanel();
      const flow = loadDomUploadFlow();
      if (flow?.active) {
        persistStateToDomUploadFlow({ panelOpen: false });
      } else if (flow) {
        clearDomUploadFlow();
      }
      return;
    }

    if (action === "toggle-all") {
      const nextSelected = !(selectedItems().length === state.items.length);
      replaceItems(
        state.items.map((item) => ({
          ...item,
          selected: nextSelected
        }))
      );
      return;
    }

    if (action === "upload-selected") {
      await uploadItems(selectedItems().map((item) => item.productId));
      return;
    }

    if (action === "apply-multiplier") {
      const factor = Number(dataset.factor);
      if (Number.isFinite(factor) && factor > 0) {
        applyMultiplier(factor);
      }
      return;
    }

    if (action === "randomize-models") {
      randomizeModels();
      return;
    }

    if (action === "random-model") {
      const productId = Number(dataset.product);
      if (Number.isFinite(productId)) {
        randomizeModels(productId);
      }
      return;
    }

    if (action === "reload-stores") {
      await ensureStoresLoaded(true);
      return;
    }

    if (dataset.select) {
      const productId = Number(dataset.select);
      replaceItems(
        state.items.map((item) =>
          item.productId === productId ? { ...item, selected: !item.selected } : item
        )
      );
      return;
    }

    if (dataset.upload) {
      await uploadItems([Number(dataset.upload)]);
    }
  }

  root.addEventListener("click", (event) => {
    const actionElement =
      event.target instanceof Element ? event.target.closest("[data-action]") : null;
    const uploadElement =
      event.target instanceof Element ? event.target.closest("[data-upload]") : null;

    if (actionElement) {
      event.preventDefault();
      event.stopPropagation();
      void runAction(actionElement.getAttribute("data-action"), actionElement.dataset);
      return;
    }

    if (uploadElement) {
      event.preventDefault();
      event.stopPropagation();
      void runAction("", uploadElement.dataset);
    }
  });

  root.addEventListener("input", (event) => {
    const fieldElement =
      event.target instanceof HTMLInputElement ? event.target.closest("[data-field]") : null;
    if (!fieldElement) {
      return;
    }

    const productId = Number(fieldElement.getAttribute("data-product"));
    const field = fieldElement.getAttribute("data-field");
    if (!Number.isFinite(productId) || !field) {
      return;
    }

    const value = event.target.value;
    if (field === "model") {
      patchItem(productId, { model: value }, false);
      return;
    }

    const currentItem = state.items.find((item) => item.productId === productId);
    if (field === "followPrice") {
      const nextPatch = { followPrice: value };
      if (currentItem && isAutoMinFollowPrice(currentItem.minFollowPrice, currentItem.followPrice)) {
        nextPatch.minFollowPrice = buildDefaultMinFollowPrice(value);
      }
      patchItem(productId, nextPatch, false);
      return;
    }

    if (field === "minFollowPrice") {
      patchItem(productId, { minFollowPrice: value }, false);
    }
  });

  root.addEventListener("change", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const selectElement = target.closest("[data-select]");
    if (selectElement) {
      void runAction("", selectElement.dataset);
      return;
    }

    const storeElement = target.closest("[data-store-select]");
    if (storeElement instanceof HTMLSelectElement) {
      state.selectedStoreId = storeElement.value;
      saveStoredStoreId(state.selectedStoreId, state.cloudSession);
      persistStateToDomUploadFlow({ selectedStoreId: state.selectedStoreId });
      renderPanel();
      return;
    }

    const fieldElement = target.closest("[data-field]");
    if (!(fieldElement instanceof HTMLInputElement)) {
      return;
    }

    const productId = Number(fieldElement.getAttribute("data-product"));
    const field = fieldElement.getAttribute("data-field");
    if (!Number.isFinite(productId) || !field) {
      return;
    }

    if (field === "model") {
      patchItem(productId, { model: normalizeModel(fieldElement.value) });
      return;
    }

    const currentItem = state.items.find((item) => item.productId === productId);
    if (field === "followPrice") {
      const formattedFollowPrice = formatInputPrice(fieldElement.value);
      const nextPatch = { followPrice: formattedFollowPrice };
      if (currentItem && isAutoMinFollowPrice(currentItem.minFollowPrice, currentItem.followPrice)) {
        nextPatch.minFollowPrice = buildDefaultMinFollowPrice(formattedFollowPrice);
      }
      patchItem(productId, nextPatch);
      return;
    }

    if (field === "minFollowPrice") {
      patchItem(productId, { minFollowPrice: formatInputPrice(fieldElement.value) });
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(`#${rootId}`)) {
        return;
      }

      if (state.menuOpen) {
        state.menuOpen = false;
        renderMenu();
      }
    },
    true
  );

  ball.addEventListener("pointerdown", (event) => {
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.pos.x,
      originY: state.pos.y,
      moved: false
    };
    ball.dataset.dragging = "1";
    ball.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  ball.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }

    state.pos = clampPos({
      x: drag.originX + dx,
      y: drag.originY + dy
    });
    positionBall();
    positionMenu();
  });

  ball.addEventListener("pointerup", (event) => {
    if (!drag || drag.id !== event.pointerId) {
      return;
    }

    ball.releasePointerCapture(event.pointerId);
    ball.dataset.dragging = "0";

    const moved = drag.moved;
    drag = null;
    savePos();

    if (!moved) {
      state.menuOpen = !state.menuOpen;
      renderMenu();
      if (state.menuOpen) {
        void ensureCloudSessionLoaded();
      }
    }
  });

  ball.addEventListener("pointercancel", () => {
    drag = null;
    ball.dataset.dragging = "0";
  });

  window.addEventListener("resize", () => {
    state.pos = clampPos(state.pos);
    positionBall();
    positionMenu();
  });

  const pendingFlow = loadDomUploadFlow();
  if (pendingFlow) {
    clearDomUploadFlow();
  }

  render();
}
