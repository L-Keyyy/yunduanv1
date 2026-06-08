import { OZON_COMMISSION_ROWS, SHIPPING_RATE_ROWS } from "./pricing_data.js";

let initialized = false;

const POSITION_STORAGE_KEY = "ozon-operation-bot-position";
const STORE_STORAGE_KEY = "ozon-operation-bot-store-id";
const LOGISTICS_STORAGE_KEY = "ozon-operation-bot-logistics-code";
const DOM_UPLOAD_FLOW_KEY = "ozon-operation-bot-dom-upload-flow";
const FILTER_RULE_STORAGE_KEY = "ozon-operation-bot-filter-rule";
const FILTER_TARGET_COUNT_STORAGE_KEY = "ozon-operation-bot-filter-target-count";
const SKU_DRAFT_STORAGE_KEY = "ozon-operation-bot-sku-draft";
const DEFAULT_MIN_FOLLOW_PRICE_RATIO = 0.95;
const DEFAULT_OLD_PRICE_RATIO = 1.75;
const DEFAULT_LOGISTICS_CODE = "GUOO";
const FIRST_BATCH_RECHECK_COUNT = 100;
const DEFAULT_COMMISSION_RATE = 0.12;
const LAST_MILE_RATE = 0.02;
const LAST_MILE_MIN_RUB = 15;
const LAST_MILE_MAX_RUB = 200;
const RUB_TO_CNY_RATE = 0.092;
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const LOGISTICS_OPTIONS = Array.from(new Set(SHIPPING_RATE_ROWS.map((row) => row.carrier).filter(Boolean))).sort(
  (left, right) => left.localeCompare(right)
);

const FILTER_NUMBER_FIELDS = [
  { key: "followersCount", label: "跟卖人数", suffix: "人" },
  { key: "monthlySales", label: "月销量" },
  { key: "monthlyRevenue", label: "月销售额", suffix: "¥" },
  { key: "price", label: "价格", suffix: "¥" },
  { key: "weight", label: "重量", suffix: "g" },
  { key: "listedDays", label: "上架时间", suffix: "天" },
  { key: "promoConversion", label: "促销活动转化率", suffix: "%" },
  { key: "adDays", label: "付费推广天数", suffix: "天" },
  { key: "clicks", label: "商品卡浏览量" },
  { key: "cartConversion", label: "商品卡加购率", suffix: "%" },
  { key: "searchVolume", label: "搜索目录浏览量" },
  { key: "searchConversion", label: "搜索目录加购率", suffix: "%" },
  { key: "impressionConversion", label: "展示转化率", suffix: "%" },
  { key: "refundRate", label: "退货取消率", suffix: "%" },
  { key: "minPrice", label: "跟卖最低价", suffix: "¥" },
  { key: "deliveryTime", label: "运输时效", suffix: "天" }
];

const FILTER_TEXT_FIELDS = [
  { key: "brand", label: "品牌" },
  { key: "fulfillment", label: "发货模式" },
  { key: "country", label: "国家" }
];

const FILTER_COUNTRY_OPTIONS = [
  { value: "CN", label: "中国" },
  { value: "RU", label: "俄罗斯" },
  { value: "TR", label: "土耳其" },
  { value: "KZ", label: "哈萨克斯坦" },
  { value: "BY", label: "白俄罗斯" },
  { value: "KR", label: "韩国" },
  { value: "JP", label: "日本" },
  { value: "GB", label: "英国" },
  { value: "US", label: "美国" },
  { value: "DE", label: "德国" },
  { value: "FR", label: "法国" },
  { value: "IT", label: "意大利" },
  { value: "ES", label: "西班牙" },
  { value: "NL", label: "荷兰" },
  { value: "PL", label: "波兰" }
];

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
    sourcingLoading: false,
    sourcingError: "",
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
    selectedLogisticsCode: loadStoredLogisticsCode(),
    filterOpen: false,
    filterRule: loadFilterRule(),
    filterTargetCount: loadFilterTargetCount(),
    filterSourceItems: [],
    autoFilterRunning: false,
    autoFilterPaused: false,
    skuDraft: loadSkuDraft(),
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
  const checkoutWeightCache = new Map();

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
      .obot-menu__field{margin:8px;padding:10px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0}
      .obot-menu__field label{display:block;margin-bottom:6px;font-size:11px;font-weight:800;color:#64748b}
      .obot-menu__input{width:100%;height:36px;padding:0 10px;border-radius:10px;border:1px solid #dbe4f0;background:#fff;color:#0f172a;font-size:13px;font-weight:800;outline:none}
      .obot-menu__input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.14)}
      .obot-menu__hint{margin-top:6px;font-size:10px;line-height:1.35;color:#94a3b8}
      .obot-divider{height:1px;margin:10px 8px;background:#e2e8f0}
      .obot-panel{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto;background:rgba(15,23,42,.24);backdrop-filter:blur(6px)}
      .obot-dialog{width:min(1540px,97vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;border-radius:22px;background:#fff;border:1px solid #dbe4f0;box-shadow:0 32px 86px rgba(15,23,42,.22);color:#0f172a}
      .obot-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 22px 14px;border-bottom:1px solid #e2e8f0;background:linear-gradient(180deg,#fbfdff,#f8fafc)}
      .obot-title{font-size:20px;font-weight:800;line-height:1.2}
      .obot-sub{margin-top:6px;font-size:13px;color:#64748b}
      .obot-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
      .obot-toolbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;padding:16px 22px;border-bottom:1px solid #e2e8f0}
      .obot-field{display:flex;flex-direction:column;gap:6px}
      .obot-field label{font-size:12px;font-weight:700;color:#64748b}
      .obot-input,.obot-select{height:40px;padding:0 12px;border-radius:12px;border:1px solid #dbe4f0;background:#fff;color:#0f172a;font-size:13px;outline:none}
      .obot-input:focus,.obot-select:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.14)}
      .obot-input[disabled]{background:#f8fafc;color:#94a3b8}
      .obot-select[disabled]{background:#f8fafc;color:#94a3b8}
      .obot-chiprow{display:flex;gap:8px;flex-wrap:wrap}
      .obot-chip{height:38px;padding:0 14px;border-radius:12px;border:1px solid #dbe4f0;background:#fff;color:#1e40af;font-size:13px;font-weight:800;cursor:pointer}
      .obot-chip:hover{background:#eff6ff;border-color:#bfdbfe}
      .obot-chip:disabled{opacity:.58;cursor:not-allowed}
      .obot-filter{max-height:46vh;margin:0 22px 14px;padding:16px;overflow:auto;border:1px solid #dbe4f0;border-radius:18px;background:linear-gradient(180deg,#f8fbff,#fff)}
      .obot-filter__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
      .obot-filter__title{font-size:14px;font-weight:900;color:#0f172a}
      .obot-filter__sub{margin-top:4px;font-size:11px;color:#64748b}
      .obot-filter__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px 14px}
      .obot-filter__field{display:grid;grid-template-columns:minmax(118px,150px) minmax(0,1fr) minmax(0,1fr);align-items:center;gap:8px;min-width:0}
      .obot-filter__field label{font-size:12px;font-weight:800;color:#64748b;text-align:right;line-height:1.25;white-space:normal;overflow-wrap:anywhere}
      .obot-filter__range{display:flex;align-items:center;gap:4px;min-width:0}
      .obot-filter__range .obot-input{height:34px;padding:0 8px;border-radius:10px}
      .obot-filter__range .obot-input{width:100%;min-width:0}
      .obot-filter__unit{flex:0 0 24px;min-width:24px;font-size:11px;color:#94a3b8}
      .obot-filter__selects{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px 14px;margin-top:14px}
      .obot-filter__select{display:grid;grid-template-columns:minmax(118px,150px) minmax(0,1fr);align-items:center;gap:8px;min-width:0}
      .obot-filter__select label{font-size:12px;font-weight:800;color:#64748b;text-align:right;line-height:1.25;white-space:normal;overflow-wrap:anywhere}
      .obot-filter__summary{margin-top:10px;font-size:12px;font-weight:800;color:#2563eb}
      .obot-filter__target{margin-bottom:12px;padding:12px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe}
      .obot-filter__target label{display:block;margin-bottom:6px;font-size:12px;font-weight:900;color:#1d4ed8}
      .obot-filter__target .obot-input{max-width:240px}
      .obot-filter__target .obot-caption{margin-top:6px;color:#3b82f6}
      .obot-filter-settings-wrap{flex:1;overflow:auto;padding-top:14px}
      .obot-filter-settings-wrap .obot-filter{max-height:none}
      .obot-banner{margin:0 22px 14px;padding:12px 14px;border-radius:14px;background:#eff6ff;color:#1d4ed8;font-size:13px;font-weight:700}
      .obot-banner--warn{background:#fff7ed;color:#c2410c}
      .obot-banner--error{background:#fef2f2;color:#dc2626}
      .obot-caption{font-size:11px;color:#94a3b8}
      .obot-tablewrap{padding:0 22px 18px;overflow:auto;min-height:240px}
      .obot-table{width:100%;min-width:1680px;border-collapse:collapse}
      .obot-table th,.obot-table td{padding:12px 10px;border-bottom:1px solid #edf2f7;font-size:13px;vertical-align:middle;text-align:left}
      .obot-table th{position:sticky;top:0;z-index:1;background:#f8fafc;color:#64748b;font-size:12px;font-weight:800;white-space:nowrap}
      .obot-sku{font-weight:800;color:#0f172a}
      .obot-titleline{margin-top:4px;max-width:220px;font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .obot-thumb{width:44px;height:44px;border-radius:12px;object-fit:cover;background:#f1f5f9;border:1px solid #e2e8f0}
      .obot-metric{font-weight:700;color:#0f172a;white-space:nowrap}
      .obot-metric--ok{color:#16a34a}
      .obot-metric--bad{color:#ef4444}
      .obot-source{min-width:260px;max-width:330px}
      .obot-source__price{font-size:13px;font-weight:900;color:#0f172a}
      .obot-source__title{margin-top:3px;font-size:12px;font-weight:700;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .obot-source__meta{margin-top:3px;font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .obot-source__cost{margin-top:3px;font-size:11px;color:#64748b;line-height:1.35}
      .obot-source__profit{margin-top:6px;font-size:12px;font-weight:900;line-height:1.35}
      .obot-source__profit--good{color:#16a34a}
      .obot-source__profit--bad{color:#dc2626}
      .obot-source__profit--warn{color:#ea580c}
      .obot-source__link{margin-top:4px;display:inline-flex;font-size:12px;font-weight:800;color:#2563eb;text-decoration:none}
      .obot-source__link:hover{text-decoration:underline}
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
        .obot-filter__grid,.obot-filter__selects{grid-template-columns:1fr}
        .obot-filter__field,.obot-filter__select{grid-template-columns:1fr}
        .obot-filter__field label,.obot-filter__select label{text-align:left}
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

  function normalizeLogisticsCode(value) {
    const normalized = String(value || "").trim();
    return LOGISTICS_OPTIONS.includes(normalized) ? normalized : DEFAULT_LOGISTICS_CODE;
  }

  function loadStoredLogisticsCode() {
    try {
      return normalizeLogisticsCode(localStorage.getItem(LOGISTICS_STORAGE_KEY));
    } catch (_error) {
      return DEFAULT_LOGISTICS_CODE;
    }
  }

  function saveStoredLogisticsCode(value) {
    const normalized = normalizeLogisticsCode(value);
    try {
      localStorage.setItem(LOGISTICS_STORAGE_KEY, normalized);
    } catch (_error) {}
    return normalized;
  }

  function emptyFilterRule() {
    return {
      numbers: {},
      brandMode: "any",
      fulfillment: "any",
      country: "any"
    };
  }

  function loadFilterRule() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FILTER_RULE_STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") {
        return emptyFilterRule();
      }
      return {
        ...emptyFilterRule(),
        ...parsed,
        numbers: parsed.numbers && typeof parsed.numbers === "object" ? parsed.numbers : {}
      };
    } catch (_error) {
      return emptyFilterRule();
    }
  }

  function saveFilterRule() {
    try {
      localStorage.setItem(FILTER_RULE_STORAGE_KEY, JSON.stringify(state.filterRule || emptyFilterRule()));
    } catch (_error) {}
  }

  function normalizeTargetCount(value) {
    const numericValue = Number(String(value || "").replace(/[^\d]/g, ""));
    return Number.isFinite(numericValue) && numericValue > 0 ? String(Math.floor(numericValue)) : "";
  }

  function loadFilterTargetCount() {
    try {
      return normalizeTargetCount(localStorage.getItem(FILTER_TARGET_COUNT_STORAGE_KEY) || "");
    } catch (_error) {
      return "";
    }
  }

  function saveFilterTargetCount(value = state.filterTargetCount) {
    const normalizedValue = normalizeTargetCount(value);
    state.filterTargetCount = normalizedValue;
    try {
      if (normalizedValue) {
        localStorage.setItem(FILTER_TARGET_COUNT_STORAGE_KEY, normalizedValue);
      } else {
        localStorage.removeItem(FILTER_TARGET_COUNT_STORAGE_KEY);
      }
    } catch (_error) {}
    return normalizedValue;
  }

  function filterTargetCountNumber() {
    const normalizedValue = normalizeTargetCount(state.filterTargetCount);
    const numericValue = Number(normalizedValue);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
  }

  function extractProductIdFromUrl(url) {
    const match = String(url || "").match(/-([0-9]{6,})(?:[/?#]|$)/);
    return match ? Number(match[1]) : null;
  }

  function cloneItems(items) {
    return (items || []).map((item) => ({ ...item }));
  }

  function normalizeSkuDraft(parsed) {
    if (!parsed || !Array.isArray(parsed.items)) {
      return null;
    }

    const items = parsed.items
      .filter((item) => item && item.productId)
      .map((item) => ({
        ...item,
        selected: item.selected !== false
      }));

    if (!items.length) {
      return null;
    }

    return {
      ...parsed,
      items,
      count: items.length
    };
  }

  function loadSkuDraft() {
    try {
      const raw = sessionStorage.getItem(SKU_DRAFT_STORAGE_KEY);
      return normalizeSkuDraft(JSON.parse(raw || "null"));
    } catch (_error) {
      return null;
    }
  }

  function saveSkuDraft(items, extra = {}) {
    const draftItems = cloneItems(items)
      .filter((item) => item && item.productId)
      .map((item) => ({
        ...item,
        selected: true,
        uploadState: "",
        uploadMessage: "",
        uploadTaskId: ""
      }));

    if (!draftItems.length) {
      clearSkuDraft();
      return 0;
    }

    const draft = {
      version: 1,
      items: draftItems,
      count: draftItems.length,
      sourceUrl: location.href,
      pageTitle: document.title,
      rule: state.filterRule,
      targetCount: state.filterTargetCount,
      updatedAt: new Date().toISOString(),
      ...extra
    };

    state.skuDraft = draft;
    try {
      sessionStorage.setItem(SKU_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (_error) {}
    return draftItems.length;
  }

  function clearSkuDraft() {
    state.skuDraft = null;
    try {
      sessionStorage.removeItem(SKU_DRAFT_STORAGE_KEY);
    } catch (_error) {}
  }

  function saveMatchedSkuDraft(items, extra = {}) {
    const matchedItems = (items || []).filter((item) => matchesFilterRule(item));
    return saveSkuDraft(matchedItems, extra);
  }

  function saveAutoFilterProgressDraft(items, extra = {}) {
    const matchedItems = matchingFilterItems(items);
    if (!matchedItems.length) {
      return 0;
    }

    const count = saveSkuDraft(matchedItems, {
      source: "auto-filter-progress",
      ...extra
    });
    renderMenu();
    return count;
  }

  function skuDraftItems() {
    return cloneItems(state.skuDraft?.items || []).map((item) => ({
      ...item,
      selected: item.selected !== false
    }));
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

  function parsePanelNumber(value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    const raw = String(value).trim();
    if (!raw || raw === "-") {
      return null;
    }

    const compact = raw.replace(/\s+/g, "").toLowerCase();
    const amount = parseAmount(raw);
    if (amount === null) {
      return null;
    }

    if (/[w万]/i.test(compact)) {
      return amount * 10000;
    }
    if (/(?:млн|million|m\b)/i.test(compact)) {
      return amount * 1000000;
    }
    if (/(?:тыс|k\b)/i.test(compact)) {
      return amount * 1000;
    }

    return amount;
  }

  function isCnyMoneyText(value) {
    return /(?:¥|￥|CNY|RMB|人民币|元)/i.test(String(value || ""));
  }

  function rubToCny(value) {
    return Number.isFinite(value) ? value * RUB_TO_CNY_RATE : value;
  }

  function cnyToRub(value) {
    return Number.isFinite(value) && RUB_TO_CNY_RATE > 0 ? value / RUB_TO_CNY_RATE : value;
  }

  function moneyFilterValue(value, fallbackCurrencyText = "") {
    const amount = parsePanelNumber(value);
    if (!Number.isFinite(amount)) {
      return null;
    }

    return isCnyMoneyText(value) || isCnyMoneyText(fallbackCurrencyText) ? amount : rubToCny(amount);
  }

  function numericMoneyFilterValue(value, sourceText = "") {
    if (!Number.isFinite(value)) {
      return null;
    }

    return isCnyMoneyText(sourceText) ? value : rubToCny(value);
  }

  function parseWeightGrams(value) {
    const raw = String(value || "").trim().toLowerCase();
    const numericValue = parsePanelNumber(raw);
    if (numericValue === null) {
      return null;
    }
    if (/кг|kg/.test(raw)) {
      return numericValue * 1000;
    }
    return numericValue;
  }

  function parseListedDays(value) {
    const raw = String(value || "").trim();
    if (!raw || raw === "-") {
      return null;
    }

    const parsedDate = new Date(raw);
    if (!Number.isNaN(parsedDate.getTime())) {
      const diffMs = Date.now() - parsedDate.getTime();
      if (Number.isFinite(diffMs) && diffMs >= 0) {
        return Math.max(1, Math.round(diffMs / 86400000));
      }
    }

    return parsePanelNumber(raw);
  }

  function extractFollowersCount(target, record) {
    const dashboardText =
      document.querySelector(`.ozon-seller-dashboard[data-product-id="${target?.productId || ""}"]`)?.innerText ||
      "";
    const visibleText = `${target?.host?.innerText || ""}\n${dashboardText}\n${(record?.rawLines || []).join("\n")}`;
    const match =
      visibleText.match(/跟卖者\s*(\d+)/i) ||
      visibleText.match(/跟卖(?:人数|人)?\s*(\d+)/i) ||
      visibleText.match(/followers?\s*(\d+)/i) ||
      visibleText.match(/(\d+)\s*(?:seller|продавц)/i);
    return match ? Number(match[1] || match[2]) : null;
  }

  function inferCountryCodeFromText(value) {
    const textValue = h.normalizeText(String(value || ""));
    if (!textValue) {
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
      { code: "US", re: /\bUS\b|\bUSA\b|United States|\u0421\u0428\u0410|\u0421\u043e\u0435\u0434\u0438\u043d/i },
      { code: "DE", re: /\bDE\b|Germany|\u0413\u0435\u0440\u043c\u0430\u043d/i },
      { code: "FR", re: /\bFR\b|France|\u0424\u0440\u0430\u043d\u0446/i },
      { code: "IT", re: /\bIT\b|Italy|\u0418\u0442\u0430\u043b/i },
      { code: "ES", re: /\bES\b|Spain|\u0418\u0441\u043f\u0430\u043d/i },
      { code: "NL", re: /\bNL\b|Netherlands|\u041d\u0438\u0434\u0435\u0440\u043b\u0430\u043d/i },
      { code: "PL", re: /\bPL\b|Poland|\u041f\u043e\u043b\u044c\u0448/i }
    ];

    return matchers.find((item) => item.re.test(textValue))?.code || "";
  }

  function normalizeCountryCode(value) {
    const raw = h.normalizeText(String(value || "")).toUpperCase();
    if (!raw || raw === "-" || raw === "ANY") {
      return "";
    }

    const directOption = FILTER_COUNTRY_OPTIONS.find((item) => item.value === raw);
    if (directOption) {
      return directOption.value;
    }

    return inferCountryCodeFromText(value);
  }

  function extractCountryCode(target, record) {
    const productId = target?.productId || record?.productId || "";
    const dashboard =
      document.querySelector(`.ozon-seller-dashboard[data-product-id="${productId}"]`) ||
      target?.host?.querySelector?.(".ozon-seller-dashboard") ||
      null;
    const flagElement = dashboard?.querySelector?.(".ozon-seller-dashboard__chip-flag");
    const sources = [
      dashboard?.getAttribute?.("data-country-code"),
      target?.host?.querySelector?.("[data-country-code]")?.getAttribute("data-country-code"),
      flagElement?.getAttribute?.("alt"),
      flagElement?.getAttribute?.("aria-label"),
      getMetric(record, ["country", "originCountry", "sellerCountry", "storeCountry"], ""),
      record?.countryCode,
      record?.countryFlag,
      record?.originCountry,
      dashboard?.innerText,
      target?.host?.innerText,
      ...(record?.rawLines || [])
    ];

    return normalizeCountryCode(sources.filter(Boolean).join("\n"));
  }

  function isBrandless(value) {
    const normalized = h.normalizeText(String(value || "")).toLowerCase();
    return (
      !normalized ||
      normalized === "-" ||
      /无品牌|未识别品牌|不限|без\s*бренда|no\s*brand|unknown/.test(normalized)
    );
  }

  function itemMetricText(item, key, fallback = "-") {
    const values = item?.metricValues || {};
    const directValue = values[key];
    if (directValue !== undefined && directValue !== null && String(directValue).trim()) {
      return directValue;
    }
    return getMetric(item, key, fallback);
  }

  function dashboardForItem(target, record) {
    const productId = target?.productId || record?.productId || "";
    return (
      (productId ? document.querySelector(`.ozon-seller-dashboard[data-product-id="${productId}"]`) : null) ||
      target?.host?.querySelector?.(".ozon-seller-dashboard") ||
      null
    );
  }

  function dashboardMetricAliases(key) {
    const aliases = {
      brand: ["品牌"],
      category: ["类目", "分类", "品类"],
      fulfillment: ["配送模式", "履约方式"],
      monthlyRevenue: ["月销售额"],
      monthlySales: ["月销量"],
      dailySales: ["日均销量"],
      avgPrice: ["平均价格"],
      minPrice: ["跟卖最低", "最低跟卖价", "市场最低价"],
      weight: ["包装重量", "重量"],
      listedAt: ["上架时长", "创建日期", "上架时间"],
      promoConversion: ["促销贡献度", "促销活动转化率"],
      adDays: ["付费推广天数"],
      clicks: ["商品卡浏览量", "点击量"],
      cartConversion: ["商品卡加购率", "加购转化", "全链路转化率"],
      searchVolume: ["搜索总量", "搜索目录浏览量"],
      searchConversion: ["搜索目录加购率", "全链路转化率"],
      impressionConversion: ["展示转化率"],
      refundRate: ["退款占比", "退款率", "退货取消率"],
      deliveryTime: ["运输时效", "平均配送时间"],
      country: ["国家"]
    };
    return aliases[key] || [key];
  }

  function valueNearDashboardLabel(labelElement) {
    const container =
      labelElement.closest(
        [
          ".ozon-seller-dashboard__card-kpi",
          ".ozon-seller-dashboard__card-stat",
          ".ozon-seller-dashboard__pair",
          ".ozon-seller-dashboard__card-footer-row",
          ".ozon-seller-dashboard__card-conversion-head"
        ].join(",")
      ) || labelElement.parentElement;

    const valueElement = container?.querySelector?.(
      [
        ".ozon-seller-dashboard__card-kpi-value",
        ".ozon-seller-dashboard__card-stat-value",
        ".ozon-seller-dashboard__pair-value",
        ".ozon-seller-dashboard__card-footer-value",
        ".ozon-seller-dashboard__card-conversion-value"
      ].join(",")
    );

    return h.normalizeText(valueElement?.innerText || valueElement?.textContent || "");
  }

  function dashboardMetricText(target, record, key, fallback = "") {
    const dashboard = dashboardForItem(target, record);
    if (!dashboard) {
      return fallback;
    }

    const aliases = dashboardMetricAliases(key).map((item) => h.normalizeText(item).toLowerCase());
    const labelElements = [
      ...dashboard.querySelectorAll(
        [
          ".ozon-seller-dashboard__card-kpi-label",
          ".ozon-seller-dashboard__card-stat-label",
          ".ozon-seller-dashboard__pair-label",
          ".ozon-seller-dashboard__card-footer-label",
          ".ozon-seller-dashboard__card-conversion-label"
        ].join(",")
      )
    ];

    for (const labelElement of labelElements) {
      const labelText = h.normalizeText(labelElement.innerText || labelElement.textContent || "").toLowerCase();
      if (!labelText || !aliases.some((alias) => labelText.includes(alias))) {
        continue;
      }

      const valueText = valueNearDashboardLabel(labelElement);
      if (valueText && valueText !== "-") {
        if (key === "cartConversion" && valueText.includes("/")) {
          return h.normalizeText(valueText.split("/")[0]);
        }
        if (key === "searchConversion" && valueText.includes("/")) {
          return h.normalizeText(valueText.split("/")[1]);
        }
        return valueText;
      }
    }

    return fallback;
  }

  function buildItemFilterValues(target, record, display, marketPriceNumeric) {
    const avgPriceText = dashboardMetricText(target, record, "avgPrice", getMetric(record, "avgPrice"));
    const currentPriceText = display.currentPriceText || "";
    const rawPrice = Number.isFinite(marketPriceNumeric) ? marketPriceNumeric : parsePanelNumber(avgPriceText);
    const priceSourceText = currentPriceText || avgPriceText;
    const values = {
      brand: dashboardMetricText(target, record, "brand", getMetric(record, "brand", "")),
      category: dashboardMetricText(target, record, "category", getMetric(record, "category", "")),
      fulfillment: dashboardMetricText(target, record, "fulfillment", getMetric(record, "fulfillment", "")),
      country: extractCountryCode(target, record),
      followersCount: extractFollowersCount(target, record),
      monthlySales: parsePanelNumber(dashboardMetricText(target, record, "monthlySales", getMetric(record, "monthlySales"))),
      monthlyRevenue: moneyFilterValue(dashboardMetricText(target, record, "monthlyRevenue", getMetric(record, "monthlyRevenue"))),
      price: numericMoneyFilterValue(rawPrice, priceSourceText),
      weight: parseWeightGrams(
        dashboardMetricText(target, record, "weight", getMetric(record, "weight", display.productWeightText || ""))
      ),
      listedDays: parseListedDays(dashboardMetricText(target, record, "listedAt", getMetric(record, "listedAt"))),
      promoConversion: parsePanelNumber(dashboardMetricText(target, record, "promoConversion", getMetric(record, "promoConversion"))),
      adDays: parsePanelNumber(dashboardMetricText(target, record, "adDays", getMetric(record, "adDays"))),
      clicks: parsePanelNumber(dashboardMetricText(target, record, "clicks", getMetric(record, "clicks"))),
      cartConversion: parsePanelNumber(dashboardMetricText(target, record, "cartConversion", getMetric(record, "cartConversion"))),
      searchVolume: parsePanelNumber(dashboardMetricText(target, record, "searchVolume", getMetric(record, "searchVolume"))),
      searchConversion: parsePanelNumber(dashboardMetricText(target, record, "searchConversion", getMetric(record, "searchConversion"))),
      impressionConversion: parsePanelNumber(dashboardMetricText(target, record, "impressionConversion", getMetric(record, "impressionConversion"))),
      refundRate: parsePanelNumber(dashboardMetricText(target, record, "refundRate", getMetric(record, "refundRate"))),
      minPrice: moneyFilterValue(dashboardMetricText(target, record, "minPrice", getMetric(record, "minPrice"))),
      deliveryTime: parsePanelNumber(dashboardMetricText(target, record, "deliveryTime", getMetric(record, "deliveryTime")))
    };

    return values;
  }

  function filterRange(rule, key) {
    const range = rule?.numbers?.[key] || {};
    return {
      min: String(range.min || "").trim(),
      max: String(range.max || "").trim()
    };
  }

  function hasActiveFilterRule(rule = state.filterRule) {
    if (!rule) {
      return false;
    }
    if (rule.brandMode && rule.brandMode !== "any") {
      return true;
    }
    if (rule.fulfillment && rule.fulfillment !== "any") {
      return true;
    }
    if (rule.country && rule.country !== "any") {
      return true;
    }
    return FILTER_NUMBER_FIELDS.some((field) => {
      const range = filterRange(rule, field.key);
      return range.min || range.max;
    });
  }

  function hasCountryFilterRule(rule = state.filterRule) {
    return Boolean(rule?.country && rule.country !== "any");
  }

  function activeNumberFilterFields(rule = state.filterRule) {
    return FILTER_NUMBER_FIELDS.filter((field) => {
      const range = filterRange(rule, field.key);
      return Boolean(range.min || range.max);
    });
  }

  function hasDashboardForItem(item) {
    return Boolean(
      item?.productId &&
        document.querySelector(`.ozon-seller-dashboard[data-product-id="${item.productId}"]`)
    );
  }

  function itemMissingActiveFilterData(item, rule = state.filterRule) {
    if (!hasActiveFilterRule(rule)) {
      return false;
    }

    const metricsLoaded = Array.isArray(item?.metrics) && item.metrics.length >= 4;
    const dashboardLoaded = hasDashboardForItem(item);

    for (const field of activeNumberFilterFields(rule)) {
      if (!Number.isFinite(item?.filterValues?.[field.key])) {
        return true;
      }
    }

    if (rule.fulfillment && rule.fulfillment !== "any") {
      const fulfillment = h.normalizeText(item?.filterValues?.fulfillment || itemMetricText(item, "fulfillment", ""));
      if (!fulfillment) {
        return true;
      }
    }

    if (rule.country && rule.country !== "any") {
      const country = normalizeCountryCode(item?.filterValues?.country || itemMetricText(item, "country", ""));
      if (!country) {
        return true;
      }
    }

    if (rule.brandMode && rule.brandMode !== "any") {
      const brand = h.normalizeText(item?.filterValues?.brand || itemMetricText(item, "brand", ""));
      if (!brand && !metricsLoaded && !dashboardLoaded) {
        return true;
      }
    }

    return false;
  }

  function missingActiveFilterDataCount(items, rule = state.filterRule) {
    return (items || []).filter((item) => itemMissingActiveFilterData(item, rule)).length;
  }

  function matchesNumberRange(item, rule, field) {
    const range = filterRange(rule, field.key);
    if (!range.min && !range.max) {
      return true;
    }

    const value = item?.filterValues?.[field.key];
    if (!Number.isFinite(value)) {
      return false;
    }

    const minValue = range.min ? parsePanelNumber(range.min) : null;
    const maxValue = range.max ? parsePanelNumber(range.max) : null;

    if (Number.isFinite(minValue) && value < minValue) {
      return false;
    }
    if (Number.isFinite(maxValue) && value > maxValue) {
      return false;
    }
    return true;
  }

  function matchesFilterRule(item, rule = state.filterRule) {
    if (!hasActiveFilterRule(rule)) {
      return true;
    }

    const brand = item?.filterValues?.brand || itemMetricText(item, "brand", "");
    if (rule.brandMode === "branded" && isBrandless(brand)) {
      return false;
    }
    if (rule.brandMode === "brandless" && !isBrandless(brand)) {
      return false;
    }

    const fulfillment = h.normalizeText(item?.filterValues?.fulfillment || itemMetricText(item, "fulfillment", ""));
    if (rule.fulfillment && rule.fulfillment !== "any") {
      if (!fulfillment || !fulfillment.toLowerCase().includes(String(rule.fulfillment).toLowerCase())) {
        return false;
      }
    }

    const country = normalizeCountryCode(item?.filterValues?.country || itemMetricText(item, "country", ""));
    if (rule.country && rule.country !== "any" && country !== rule.country) {
      return false;
    }

    return FILTER_NUMBER_FIELDS.every((field) => matchesNumberRange(item, rule, field));
  }

  function applyFilterToItems(items, rule = state.filterRule) {
    const active = hasActiveFilterRule(rule);
    return (items || []).map((item) => ({
      ...item,
      selected: active ? matchesFilterRule(item, rule) : true
    }));
  }

  function matchingFilterItems(items, rule = state.filterRule) {
    const active = hasActiveFilterRule(rule);
    const sourceItems = active ? (items || []).filter((item) => matchesFilterRule(item, rule)) : items || [];
    return sourceItems.map((item) => ({
      ...item,
      selected: true
    }));
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
    const rect = image?.getBoundingClientRect?.();
    const width = image?.naturalWidth || rect?.width || image?.width || 0;
    const height = image?.naturalHeight || rect?.height || image?.height || 0;
    return width * height;
  }

  function isProductImageCandidate(image) {
    const src = h.absoluteUrl(image?.currentSrc || image?.src || "");
    if (!src || image?.closest?.(".ozon-seller-dashboard")) {
      return false;
    }

    const rect = image?.getBoundingClientRect?.();
    const width = image?.naturalWidth || rect?.width || image?.width || 0;
    const height = image?.naturalHeight || rect?.height || image?.height || 0;
    const signature = [
      src,
      image?.alt || "",
      image?.title || "",
      image?.id || "",
      typeof image?.className === "string" ? image.className : ""
    ]
      .join(" ")
      .toLowerCase();

    if (/(?:flag|country|logo|avatar|icon|badge|sprite|seller|store|brand|placeholder)/i.test(signature)) {
      return false;
    }

    return width >= 90 && height >= 90;
  }

  function pickBestImage(host) {
    const images = [...(host?.querySelectorAll("img") || [])].filter(
      (image) => isProductImageCandidate(image)
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
    const preliminaryWeightText = dashboardMetricText(
      target,
      record,
      "weight",
      getMetric(record, "weight", display.productWeightText || "")
    );
    const metricValues = Object.fromEntries(
      (record?.metrics || [])
        .filter((metric) => metric?.key)
        .map((metric) => [metric.key, h.normalizeText(metric.value || "")])
    );

    return {
      key: `${target.productId}:${target.layout}`,
      productId: target.productId,
      productUrl: display.productUrl || record?.sourceUrl || "",
      variantData: target?.layout === "variant" ? target.variant || null : null,
      metrics: Array.isArray(record?.metrics) ? record.metrics : [],
      metricValues,
      filterValues: buildItemFilterValues(target, record, display, marketPriceNumeric),
      title: display.title,
      subtitle: display.subtitle || display.title,
      imageUrl: display.imageUrl || "",
      basePrice: marketPriceNumeric,
      marketPriceText,
      marketMinPriceText: text(marketMinPriceText, "-"),
      packageWeightText: text(preliminaryWeightText, "待比价抓取"),
      checkoutWeightState: "idle",
      checkoutWeightMessage: "",
      checkoutWeight: null,
      checkoutWeightG: null,
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

  function checkoutWeightCacheKey(item) {
    return item?.productUrl || (item?.productId ? `sku:${item.productId}` : "");
  }

  function normalizeCheckoutWeightResult(result) {
    const weightKg = Number(result?.weightKg);
    const parsedFromText = parseWeightGrams(result?.weightText);
    const grams = Number.isFinite(weightKg) && weightKg > 0 ? weightKg * 1000 : parsedFromText;
    if (!Number.isFinite(grams) || grams <= 0) {
      return null;
    }
    return {
      grams,
      weightText: h.normalizeText(result?.weightText || `${Math.round(grams)} g`),
      raw: result
    };
  }

  function applyCheckoutWeightResult(item, result) {
    const normalized = normalizeCheckoutWeightResult(result);
    if (!normalized) {
      return {
        ...item,
        packageWeightText: "获取失败",
        checkoutWeightState: "error",
        checkoutWeightMessage: "结算页没有返回包装重量",
        checkoutWeight: null,
        checkoutWeightG: null,
        filterValues: {
          ...(item.filterValues || {}),
          weight: null
        }
      };
    }

    return {
      ...item,
      packageWeightText: normalized.weightText,
      checkoutWeightState: "done",
      checkoutWeightMessage: "",
      checkoutWeight: normalized.raw,
      checkoutWeightG: normalized.grams,
      filterValues: {
        ...(item.filterValues || {}),
        weight: normalized.grams
      },
      profitInputs: item.profitInputs
        ? {
            ...item.profitInputs,
            weightG: normalized.grams
          }
        : item.profitInputs
    };
  }

  function applyCheckoutWeightError(item, message) {
    return {
      ...item,
      packageWeightText: "获取失败",
      checkoutWeightState: "error",
      checkoutWeightMessage: message || "真实包装重量抓取失败",
      checkoutWeight: null,
      checkoutWeightG: null,
      filterValues: {
        ...(item.filterValues || {}),
        weight: null
      }
    };
  }

  async function fetchCheckoutWeightForItem(item) {
    const key = checkoutWeightCacheKey(item);
    if (!key || !item?.productUrl) {
      return { ok: false, error: "缺少商品链接" };
    }
    if (typeof h.fetchOzonPackageWeightFromUrl !== "function") {
      return { ok: false, error: "结算页重量抓取能力不可用" };
    }

    const cached = checkoutWeightCache.get(key);
    if (cached) {
      return typeof cached.then === "function" ? cached : cached;
    }

    const request = h
      .fetchOzonPackageWeightFromUrl(item.productUrl)
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    checkoutWeightCache.set(key, request);
    const response = await request;
    checkoutWeightCache.set(key, response);
    return response;
  }

  async function enrichCheckoutWeights(items, options = {}) {
    const nextItems = cloneItems(items);
    const queue = nextItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item?.productId && item?.productUrl);

    if (!queue.length) {
      return nextItems;
    }

    const total = queue.length;
    let completed = 0;
    const concurrency = Math.min(4, total);

    async function worker() {
      while (queue.length) {
        const entry = queue.shift();
        if (!entry) {
          continue;
        }
        const response = await fetchCheckoutWeightForItem(entry.item);
        nextItems[entry.index] = response.ok
          ? applyCheckoutWeightResult(entry.item, response.result)
          : applyCheckoutWeightError(entry.item, response.error);
        completed += 1;
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return nextItems;
  }

  async function fetchRecords(productIds, options = {}) {
    try {
      const response = await h.sendMessage({
        type: "get-seller-analytics",
        productIds,
        fetchMissing: true,
        forceRefresh: Boolean(options.forceRefresh)
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

  function firstCollectedProductIds(collected, count = FIRST_BATCH_RECHECK_COUNT) {
    return Array.from(collected.values())
      .slice(0, count)
      .map((item) => Number(item?.productId))
      .filter(Number.isFinite);
  }

  async function recheckFirstLoadedProductCards(collected, targetCount) {
    const productIds = firstCollectedProductIds(collected);
    if (productIds.length < FIRST_BATCH_RECHECK_COUNT) {
      return 0;
    }

    h.showOverlay(`已加载 ${FIRST_BATCH_RECHECK_COUNT} 个商品卡，正在复查跟卖人数和国籍...`, "#2563eb");
    await h.sleep(2500);
    await refreshBuyerAnalyticsPanelsForFilter(6000);
    await h.sleep(1500);

    const records = await fetchRecords(productIds, { forceRefresh: true });
    const targetMap = new Map(
      h.collectBuyerTargets()
        .filter((target) => productIds.includes(Number(target.productId)))
        .map((target) => [Number(target.productId), target])
    );

    const recheckedItems = [];
    for (const productId of productIds) {
      const target = targetMap.get(productId);
      const existing = collected.get(productId);
      if (target) {
        recheckedItems.push(buildItem(target, records[productId] || existing || { productId }));
      } else if (existing) {
        recheckedItems.push({
          ...existing,
          metrics: Array.isArray(records[productId]?.metrics) ? records[productId].metrics : existing.metrics,
          metricValues: mergeTextMaps(existing.metricValues, records[productId]?.metricValues),
          filterValues: mergeFilterValues(existing.filterValues, {
            ...existing.filterValues,
            country: normalizeCountryCode(
              [
                records[productId]?.countryCode,
                records[productId]?.countryFlag,
                records[productId]?.originCountry,
                ...(records[productId]?.rawLines || [])
              ].filter(Boolean).join("\n")
            )
          })
        });
      }
    }

    mergeCollectedFilterItems(collected, recheckedItems);
    const matchedCount = targetMatchedCount(Array.from(collected.values()));
    const missingCount = missingActiveFilterDataCount(Array.from(collected.values()).slice(0, FIRST_BATCH_RECHECK_COUNT));
    h.showOverlay(
      `前 ${FIRST_BATCH_RECHECK_COUNT} 个商品卡复查完成：命中 ${matchedCount}${targetCount ? ` / ${targetCount}` : ""}，仍缺字段 ${missingCount} 个`,
      missingCount ? "#ea580c" : "#16a34a"
    );
    return recheckedItems.length;
  }

  function targetMatchedCount(items) {
    const list = items || [];
    if (!hasActiveFilterRule()) {
      return list.length;
    }
    return list.filter((item) => matchesFilterRule(item)).length;
  }

  function maxScrollY() {
    return Math.max(
      0,
      (document.documentElement?.scrollHeight || 0) - window.innerHeight,
      (document.body?.scrollHeight || 0) - window.innerHeight
    );
  }

  function visibleRectArea(element) {
    if (!(element instanceof Element)) {
      return 0;
    }

    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function findFilterScrollContainer() {
    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main, [role='main'], [data-widget], div")
    ].filter((element) => element instanceof Element && !element.closest?.(`#${rootId}`));

    return candidates
      .filter((element) => element.scrollHeight - element.clientHeight > 160 && visibleRectArea(element) > 90000)
      .sort((left, right) => {
        const leftScore = (left.scrollHeight - left.clientHeight) * Math.max(1, visibleRectArea(left));
        const rightScore = (right.scrollHeight - right.clientHeight) * Math.max(1, visibleRectArea(right));
        return rightScore - leftScore;
      })[0] || document.scrollingElement || document.documentElement;
  }

  function filterScrollSnapshot() {
    const root = document.scrollingElement || document.documentElement;
    const container = findFilterScrollContainer();
    const rootGap = root
      ? Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
      : maxScrollY() - window.scrollY;
    const containerGap = container
      ? Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop)
      : rootGap;

    return {
      root,
      container,
      windowY: window.scrollY,
      rootTop: root?.scrollTop || 0,
      containerTop: container?.scrollTop || 0,
      rootGap,
      containerGap
    };
  }

  async function clickVisibleLoadMoreButton() {
    const candidates = [...document.querySelectorAll("button, a, [role='button']")].filter((element) => {
      if (!(element instanceof HTMLElement) || element.closest(`#${rootId}`)) {
        return false;
      }

      const label = h.normalizeText(element.innerText || element.textContent || element.getAttribute("aria-label") || "");
      if (!/(?:показать|ещ[её]|загруз|load\s*more|更多|加载更多|下一页)/i.test(label)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width > 20 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight;
    });

    const button = candidates[0];
    if (!button) {
      return false;
    }

    button.click();
    await h.sleep(1000);
    return true;
  }

  async function scrollFilterPageDown() {
    const before = filterScrollSnapshot();
    const delta = Math.max(window.innerHeight * 0.85, 620);

    window.scrollBy({ top: delta, behavior: "auto" });
    if (before.root) {
      before.root.scrollTop += delta;
    }
    if (
      before.container &&
      before.container !== before.root &&
      before.container !== document.body &&
      before.container !== document.documentElement
    ) {
      before.container.scrollTop += delta;
    }

    await h.sleep(1400);
    const after = filterScrollSnapshot();
    const moved =
      Math.abs(after.windowY - before.windowY) > 24 ||
      Math.abs(after.rootTop - before.rootTop) > 24 ||
      Math.abs(after.containerTop - before.containerTop) > 24;
    const nearBottom = Math.min(after.rootGap, after.containerGap) < 160;

    return {
      moved,
      nearBottom,
      rootGap: after.rootGap,
      containerGap: after.containerGap
    };
  }

  function mergeTextMaps(existing = {}, incoming = {}) {
    const result = { ...(existing || {}), ...(incoming || {}) };
    for (const [key, value] of Object.entries(existing || {})) {
      if (!h.normalizeText(incoming?.[key] || "") && h.normalizeText(value || "")) {
        result[key] = value;
      }
    }
    return result;
  }

  function mergeFilterValues(existing = {}, incoming = {}) {
    const result = { ...(existing || {}), ...(incoming || {}) };
    for (const field of FILTER_NUMBER_FIELDS) {
      const key = field.key;
      const existingValue = Number(existing?.[key]);
      const incomingValue = Number(incoming?.[key]);
      if (Number.isFinite(existingValue) && !Number.isFinite(incomingValue)) {
        result[key] = existingValue;
      }
    }

    for (const key of ["brand", "category", "fulfillment", "country"]) {
      const existingText = h.normalizeText(existing?.[key] || "");
      const incomingText = h.normalizeText(incoming?.[key] || "");
      if (existingText && !incomingText) {
        result[key] = existing?.[key];
      }
    }
    return result;
  }

  function mergeCollectedFilterItems(collected, items) {
    for (const item of items || []) {
      if (!item?.productId) {
        continue;
      }

      const existing = collected.get(item.productId);
      const existingMetrics = Array.isArray(existing?.metrics) ? existing.metrics : [];
      const incomingMetrics = Array.isArray(item?.metrics) ? item.metrics : [];
      collected.set(item.productId, {
        ...(existing || {}),
        ...item,
        metrics: incomingMetrics.length >= existingMetrics.length ? incomingMetrics : existingMetrics,
        metricValues: mergeTextMaps(existing?.metricValues, item?.metricValues),
        filterValues: mergeFilterValues(existing?.filterValues, item?.filterValues),
        selected: existing?.selected ?? item.selected
      });
    }
  }

  async function waitWhileAutoFilterPaused() {
    while (state.autoFilterRunning && state.autoFilterPaused) {
      h.showOverlay("自动筛选已暂停，点击 OB 菜单继续", "#ea580c");
      renderMenu();
      await h.sleep(600);
    }
  }

  async function refreshBuyerAnalyticsPanelsForFilter(timeoutMs = 4500) {
    if (typeof h.refreshBuyerAnalyticsPanels !== "function") {
      return;
    }

    try {
      await Promise.race([
        h.refreshBuyerAnalyticsPanels(),
        h.sleep(timeoutMs)
      ]);
    } catch (_error) {
      // 自动筛选不能被数据面板刷新卡死；下一轮滚动会继续尝试刷新。
    }
  }

  async function waitForCurrentFilterDataReady(items, targetCount) {
    if (!hasActiveFilterRule()) {
      return items;
    }

    let currentItems = items || [];
    const maxAttempts = currentItems.length > 20 ? 6 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await waitWhileAutoFilterPaused();
      const missingCount = missingActiveFilterDataCount(currentItems);
      if (!missingCount) {
        return currentItems;
      }

      h.showOverlay(
        `等待数据面板加载：${Math.max(0, currentItems.length - missingCount)} / ${currentItems.length} 已就绪${
          targetCount ? `，目标 ${targetCount} 个` : ""
        }`,
        "#2563eb"
      );

      await refreshBuyerAnalyticsPanelsForFilter();
      await h.sleep(1000);
      currentItems = await collectItems("current-page");
    }

    const remainingMissingCount = missingActiveFilterDataCount(currentItems);
    if (remainingMissingCount) {
      h.showOverlay(
        `部分数据面板仍未加载：还有 ${remainingMissingCount} 个 SKU 缺少筛选字段，本轮不会把这些空字段算作命中`,
        "#ea580c"
      );
    }
    return currentItems;
  }

  async function collectCurrentPageItemsUntilTarget() {
    const targetCount = filterTargetCountNumber();
    if (!targetCount) {
      return collectItems("current-page");
    }

    const collected = new Map();
    let bestMatchedCount = 0;
    let lastDraftCount = 0;
    let stableRounds = 0;
    let bottomRounds = 0;
    let firstBatchRechecked = false;
    const maxSteps = Math.min(Math.max(targetCount * 10, 80), 260);

    for (let step = 0; step < maxSteps && stableRounds < 10 && bottomRounds < 4; step += 1) {
      await waitWhileAutoFilterPaused();
      if (hasActiveFilterRule()) {
        await refreshBuyerAnalyticsPanelsForFilter();
      }

      const beforeCollectedSize = collected.size;
      const currentItems = await waitForCurrentFilterDataReady(await collectItems("current-page"), targetCount);
      mergeCollectedFilterItems(collected, currentItems);
      if (!firstBatchRechecked && collected.size >= FIRST_BATCH_RECHECK_COUNT) {
        firstBatchRechecked = true;
        await recheckFirstLoadedProductCards(collected, targetCount);
      }
      const items = Array.from(collected.values());
      const matchedCount = targetMatchedCount(items);
      h.showOverlay(
        `自动筛选中：已累计 ${items.length} 个，命中 ${matchedCount} / ${targetCount} 个 SKU`,
        "#2563eb"
      );

      if (matchedCount >= bestMatchedCount) {
        bestMatchedCount = matchedCount;
      }

      if (matchedCount > 0 && matchedCount !== lastDraftCount) {
        lastDraftCount = saveAutoFilterProgressDraft(items, {
          matchedCount,
          targetCount,
          step
        });
      }

      if (matchedCount >= targetCount) {
        h.showOverlay(`自动筛选完成：已命中 ${matchedCount} / ${targetCount} 个 SKU`, "#16a34a");
        return items;
      }

      await waitWhileAutoFilterPaused();
      const scrollResult = await scrollFilterPageDown();
      const clickedMore = scrollResult.nearBottom || !scrollResult.moved ? await clickVisibleLoadMoreButton() : false;
      const hasNewItems = collected.size > beforeCollectedSize;
      const hardBottom = scrollResult.nearBottom && !clickedMore && !hasNewItems;
      bottomRounds = hardBottom ? bottomRounds + 1 : 0;
      stableRounds = hasNewItems || scrollResult.moved || clickedMore ? 0 : stableRounds + 1;
    }

    h.showOverlay(`自动筛选结束：当前页共命中 ${bestMatchedCount} / ${targetCount} 个 SKU`, "#ea580c");
    return Array.from(collected.values());
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
        uploadTaskId: existing.uploadTaskId,
        packageWeightText: existing.packageWeightText || item.packageWeightText,
        checkoutWeightState: existing.checkoutWeightState || item.checkoutWeightState,
        checkoutWeightMessage: existing.checkoutWeightMessage || item.checkoutWeightMessage,
        checkoutWeight: existing.checkoutWeight || item.checkoutWeight,
        checkoutWeightG: existing.checkoutWeightG || item.checkoutWeightG,
        metrics:
          Array.isArray(existing.metrics) && existing.metrics.length > (Array.isArray(item.metrics) ? item.metrics.length : 0)
            ? existing.metrics
            : item.metrics,
        metricValues: mergeTextMaps(existing.metricValues, item.metricValues),
        filterValues: {
          ...mergeFilterValues(existing.filterValues, item.filterValues),
          ...(Number.isFinite(Number(existing.checkoutWeightG))
            ? { weight: Number(existing.checkoutWeightG) }
            : {})
        },
        sourcingState: existing.sourcingState,
        sourcingMessage: existing.sourcingMessage,
        sourcingCandidates: existing.sourcingCandidates,
        sourcingBest: existing.sourcingBest,
        profitInputs: existing.profitInputs
      };
    });
  }

  function selectedItems() {
    return state.items.filter((item) => item.selected);
  }

  function finishedItems() {
    return state.items.filter((item) => item.uploadState === "done");
  }

  function replaceItems(items, preserveExisting = false, options = {}) {
    const nextItems = preserveExisting ? mergeIncomingItems(items) : [...(items || [])];
    if (options.applyFilter) {
      state.filterSourceItems = cloneItems(nextItems);
      state.items = options.onlyMatches ? matchingFilterItems(nextItems) : applyFilterToItems(nextItems);
    } else {
      state.items = nextItems;
    }
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
      const items =
        mode === "current-page" && filterTargetCountNumber()
          ? await collectCurrentPageItemsUntilTarget()
          : await collectItems(mode);
      const shouldShowOnlyMatches = mode === "current-page" && filterTargetCountNumber();
      state.filterSourceItems = shouldShowOnlyMatches ? cloneItems(items) : [];
      state.items = shouldShowOnlyMatches ? matchingFilterItems(items) : applyFilterToItems(items);
      if (mode === "current-page" && filterTargetCountNumber()) {
        const draftCount = saveMatchedSkuDraft(state.items, { source: "open-current-page-filter" });
        renderMenu();
        h.showOverlay(
          draftCount ? `已写入 sku草稿：${draftCount} 个 SKU` : "本次筛选没有命中 SKU，sku草稿已清空",
          draftCount ? "#16a34a" : "#ea580c"
        );
      }
      await storeTask;
    } finally {
      state.loading = false;
      renderPanel();
    }
  }

  async function openSkuDraftPanel() {
    const draftItems = skuDraftItems();
    if (!draftItems.length) {
      clearSkuDraft();
      renderMenu();
      h.showOverlay("暂无 sku草稿，请先运行筛选规则", "#ea580c");
      return;
    }

    state.menuOpen = false;
    state.panelOpen = true;
    state.panelMode = "sku-draft";
    state.filterOpen = false;
    state.loading = false;
    state.items = draftItems;
    renderMenu();
    renderPanel();

    await ensureStoresLoaded();
    renderPanel();
    h.showOverlay(`已打开 sku草稿：${draftItems.length} 个 SKU`, "#2563eb");
  }

  async function loadMore() {
    const targetCount = filterTargetCountNumber();
    if (targetCount) {
      const items = await collectCurrentPageItemsUntilTarget();
      const matchedCount = targetMatchedCount(items);
      const draftCount = saveMatchedSkuDraft(items, { source: "load-more-filter" });
      h.showOverlay(`已加载 ${matchedCount} / ${targetCount} 个 SKU`, "#2563eb");
      await refreshBuyerAnalyticsPanelsForFilter();
      if (state.panelOpen && state.panelMode === "current-page") {
        replaceItems(items, true, { applyFilter: hasActiveFilterRule(), onlyMatches: true });
      }
      renderMenu();
      if (draftCount) {
        h.showOverlay(`sku草稿已更新：${draftCount} 个 SKU`, "#16a34a");
      }
      return;
    }

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
    await refreshBuyerAnalyticsPanelsForFilter();

    if (state.panelOpen && state.panelMode === "current-page") {
      replaceItems(await collectItems("current-page"), true, {
        applyFilter: hasActiveFilterRule(),
        onlyMatches: hasActiveFilterRule()
      });
    }
  }

  async function startCurrentPageAutoFilter() {
    if (state.autoFilterRunning) {
      state.autoFilterPaused = false;
      renderMenu();
      h.showOverlay("自动筛选已继续", "#2563eb");
      return;
    }

    saveFilterTargetCount(state.filterTargetCount);
    saveFilterRule();

    const targetCount = filterTargetCountNumber();
    if (!targetCount) {
      h.showOverlay("请先填写筛选目标数量", "#dc2626");
      return;
    }

    state.menuOpen = false;
    state.panelOpen = false;
    state.panelMode = "current-page";
    state.filterOpen = true;
    state.loading = true;
    state.autoFilterRunning = true;
    state.autoFilterPaused = false;
    clearSkuDraft();
    renderMenu();
    renderPanel();
    h.showOverlay(`开始自动筛选：目标 ${targetCount} 个 SKU`, "#2563eb");

    const storeTask = ensureStoresLoaded();
    try {
      const items = await collectCurrentPageItemsUntilTarget();
      state.filterSourceItems = cloneItems(items);
      state.items = matchingFilterItems(items);
      const draftCount = saveMatchedSkuDraft(state.items, { source: "auto-filter" });
      await storeTask;
      state.panelOpen = true;
      persistStateToDomUploadFlow();
      h.showOverlay(
        draftCount ? `已写入 sku草稿：${draftCount} 个 SKU` : "本次筛选没有命中 SKU，sku草稿已清空",
        draftCount ? "#16a34a" : "#ea580c"
      );
    } finally {
      state.loading = false;
      state.autoFilterRunning = false;
      state.autoFilterPaused = false;
      renderMenu();
      renderPanel();
    }
  }

  function applyFilterRule() {
    const sourceItems = state.filterSourceItems.length ? state.filterSourceItems : state.items;
    state.filterSourceItems = cloneItems(sourceItems);
    state.items = matchingFilterItems(sourceItems);
    const draftCount = saveMatchedSkuDraft(state.items, { source: "apply-filter-rule" });
    saveFilterRule();
    persistStateToDomUploadFlow();
    renderMenu();
    renderPanel();
    h.showOverlay(
      `${filterRuleSummary()} ${draftCount ? `已写入 sku草稿 ${draftCount} 个。` : "sku草稿已清空。"}`,
      draftCount ? "#2563eb" : "#ea580c"
    );
  }

  function resetFilterRule() {
    const sourceItems = state.filterSourceItems.length ? state.filterSourceItems : state.items;
    state.filterRule = emptyFilterRule();
    saveFilterRule();
    state.items = applyFilterToItems(sourceItems);
    clearSkuDraft();
    persistStateToDomUploadFlow();
    renderMenu();
    renderPanel();
    h.showOverlay("筛选规则已清空，已全选当前 SKU", "#2563eb");
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

  function finiteParsedNumber(value) {
    const parsed = parseAmount(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatSourcingCurrency(value) {
    const parsed = finiteParsedNumber(value);
    return parsed === null ? "-" : `¥${parsed.toFixed(2)}`;
  }

  function formatCny(value) {
    return Number.isFinite(value) ? `¥${value.toFixed(2)}` : "¥-";
  }

  function formatRub(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)} ₽` : "- ₽";
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "-";
  }

  function normalizePricingText(value) {
    return h
      .normalizeText(String(value || ""))
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function selectedLogisticsCode() {
    return normalizeLogisticsCode(state.selectedLogisticsCode || DEFAULT_LOGISTICS_CODE);
  }

  function logisticsOptionsHtml() {
    return LOGISTICS_OPTIONS.map(
      (code) =>
        `<option value="${h.escapeHtml(code)}" ${selectedLogisticsCode() === code ? "selected" : ""}>${h.escapeHtml(
          code
        )}</option>`
    ).join("");
  }

  function parseShippingFeeFormula(feeText) {
    const normalized = String(feeText || "").replace(/,/g, ".");
    const numbers = normalized.match(/\d+(?:\.\d+)?/g) || [];
    if (numbers.length < 2) {
      return null;
    }

    const base = Number(numbers[0]);
    const perUnit = Number(numbers[1]);
    const unitG = Number(numbers[2] || 1);
    if (!Number.isFinite(base) || !Number.isFinite(perUnit) || !Number.isFinite(unitG) || unitG <= 0) {
      return null;
    }

    return {
      base,
      perGram: perUnit / unitG
    };
  }

  function rowMatchesSaleValue(row, salePriceRub) {
    if (!Number.isFinite(salePriceRub)) {
      return false;
    }
    const min = Number(row.valueRubMin);
    const max = Number(row.valueRubMax);
    return (!Number.isFinite(min) || salePriceRub >= min) && (!Number.isFinite(max) || salePriceRub <= max);
  }

  function rowMatchesWeight(row, weightG) {
    if (!Number.isFinite(weightG)) {
      return false;
    }
    const min = Number(row.minG);
    const max = Number(row.maxG);
    return (!Number.isFinite(min) || weightG >= min) && (!Number.isFinite(max) || weightG <= max);
  }

  function chooseShippingRateRow(logisticsCode, weightG, salePriceRub) {
    const rows = SHIPPING_RATE_ROWS.filter((row) => row.carrier === logisticsCode);
    const valueRows = rows.filter((row) => rowMatchesSaleValue(row, salePriceRub));
    const candidateRows = (valueRows.length ? valueRows : rows).filter((row) => rowMatchesWeight(row, weightG));
    if (!candidateRows.length) {
      return null;
    }

    return [...candidateRows].sort((left, right) => {
      const leftWeightSpan = (Number(left.maxG) || 0) - (Number(left.minG) || 0);
      const rightWeightSpan = (Number(right.maxG) || 0) - (Number(right.minG) || 0);
      if (leftWeightSpan !== rightWeightSpan) {
        return leftWeightSpan - rightWeightSpan;
      }
      const leftValueSpan = (Number(left.valueRubMax) || 0) - (Number(left.valueRubMin) || 0);
      const rightValueSpan = (Number(right.valueRubMax) || 0) - (Number(right.valueRubMin) || 0);
      return leftValueSpan - rightValueSpan;
    })[0];
  }

  function calculateShippingCostCny(logisticsCode, weightG, salePriceRub) {
    if (!Number.isFinite(weightG) || weightG <= 0) {
      return {
        ok: false,
        reason: "缺少 Ozon 重量"
      };
    }

    const row = chooseShippingRateRow(logisticsCode, weightG, salePriceRub);
    if (!row) {
      return {
        ok: false,
        reason: `${logisticsCode} 没有命中 ${Math.round(weightG)}g 的运费区间`
      };
    }

    const formula = parseShippingFeeFormula(row.fee);
    if (!formula) {
      return {
        ok: false,
        reason: `运费公式无法解析：${row.fee}`
      };
    }

    return {
      ok: true,
      row,
      costCny: formula.base + formula.perGram * weightG,
      formula
    };
  }

  function saleTierKey(salePriceRub) {
    if (!Number.isFinite(salePriceRub) || salePriceRub <= 1500) {
      return "t1";
    }
    return salePriceRub <= 5000 ? "t2" : "t3";
  }

  function commissionSchemaSuffix(item) {
    const fulfillmentText = normalizePricingText(
      item?.filterValues?.fulfillment || itemMetricText(item, "fulfillment", "")
    );
    return fulfillmentText.includes("fbp") ? "f" : "r";
  }

  function commissionCategoryText(item) {
    return (
      item?.filterValues?.category ||
      itemMetricText(item, "category", "") ||
      item?.category ||
      item?.categoryText ||
      ""
    );
  }

  function findCommissionRate(item, salePriceRub) {
    const categoryText = normalizePricingText(commissionCategoryText(item));
    const tier = saleTierKey(salePriceRub);
    const schemaSuffix = commissionSchemaSuffix(item);
    const rateKey = `${tier}${schemaSuffix}`;

    const matchedRow = categoryText
      ? OZON_COMMISSION_ROWS.find((row) => {
          const category = normalizePricingText(row.category);
          const group = normalizePricingText(row.group);
          return Boolean(
            category &&
              (categoryText.includes(category) ||
                category.includes(categoryText) ||
                (group && categoryText.includes(group)))
          );
        })
      : null;

    const rate = Number(matchedRow?.[rateKey]);
    if (Number.isFinite(rate)) {
      const effectiveRate = Math.max(rate, DEFAULT_COMMISSION_RATE);
      return {
        rate: effectiveRate,
        rawRate: rate,
        rateFloored: effectiveRate > rate,
        tier,
        schema: schemaSuffix === "f" ? "FBP" : "rFBS",
        category: matchedRow.category,
        fallback: false
      };
    }

    return {
      rate: DEFAULT_COMMISSION_RATE,
      rawRate: DEFAULT_COMMISSION_RATE,
      rateFloored: false,
      tier,
      schema: schemaSuffix === "f" ? "FBP" : "rFBS",
      category: "默认费率",
      fallback: true
    };
  }

  function itemWeightGrams(item) {
    const values = [
      Number(item?.checkoutWeightG),
      Number(item?.profitInputs?.weightG),
      item?.checkoutWeightState === "done" ? parseWeightGrams(item?.packageWeightText) : null
    ];
    return values.find((value) => Number.isFinite(value) && value > 0) ?? null;
  }

  function calculateProfitBreakdown(item, candidate) {
    const purchasePriceCny = finiteParsedNumber(candidate?.priceFrom ?? candidate?.priceTo);
    const salePriceCny =
      finiteParsedNumber(item?.followPrice) ??
      finiteParsedNumber(item?.profitInputs?.ozonFollowPrice) ??
      finiteParsedNumber(item?.marketPriceText);
    const salePriceRubEquivalent = cnyToRub(salePriceCny);
    const weightG = itemWeightGrams(item);
    const logisticsCode = selectedLogisticsCode();

    if (!Number.isFinite(purchasePriceCny)) {
      return { ok: false, reason: "缺少 1688 采购价" };
    }
    if (!Number.isFinite(salePriceCny) || salePriceCny <= 0) {
      return { ok: false, reason: "缺少 Ozon 跟卖售价" };
    }

    const shipping = calculateShippingCostCny(logisticsCode, weightG, salePriceRubEquivalent);
    if (!shipping.ok) {
      return { ok: false, reason: shipping.reason };
    }

    const commission = findCommissionRate(item, salePriceRubEquivalent);
    const commissionCny = salePriceCny * commission.rate;
    const lastMileRub = Math.min(
      Math.max(salePriceRubEquivalent * LAST_MILE_RATE, LAST_MILE_MIN_RUB),
      LAST_MILE_MAX_RUB
    );
    const lastMileCny = rubToCny(lastMileRub);
    const totalCostCny = purchasePriceCny + shipping.costCny + commissionCny + lastMileCny;
    const profitCny = salePriceCny - totalCostCny;

    return {
      ok: true,
      logisticsCode,
      salePriceRub: salePriceRubEquivalent,
      salePriceCny,
      weightG,
      purchasePriceCny,
      shippingCostCny: shipping.costCny,
      shippingRow: shipping.row,
      commission,
      commissionCny,
      lastMileRub,
      lastMileCny,
      totalCostCny,
      profitCny,
      margin: salePriceCny > 0 ? profitCny / salePriceCny : null
    };
  }

  function profitBreakdownHtml(item, candidate) {
    const breakdown = calculateProfitBreakdown(item, candidate);
    if (!breakdown.ok) {
      return `<div class="obot-source__profit obot-source__profit--warn">利润待算：${h.escapeHtml(
        breakdown.reason
      )}</div>`;
    }

    const profitClass = breakdown.profitCny >= 0 ? "obot-source__profit--good" : "obot-source__profit--bad";
    const commissionText = `${formatPercent(breakdown.commission.rate)} ${
      breakdown.commission.fallback
        ? "默认"
        : `${h.escapeHtml(breakdown.commission.category)}${breakdown.commission.rateFloored ? " · 12%下限" : ""}`
    }`;
    return `
      <div class="obot-source__profit ${profitClass}">
        利润 ${formatCny(breakdown.profitCny)} · 利润率 ${formatPercent(breakdown.margin)}
      </div>
      <div class="obot-source__cost">
        成本 ${formatCny(breakdown.totalCostCny)} = 货源 ${formatCny(breakdown.purchasePriceCny)}
        + 运费 ${formatCny(breakdown.shippingCostCny)}
        + 抽佣 ${formatCny(breakdown.commissionCny)}
        + 尾程 ${formatCny(breakdown.lastMileCny)}
      </div>
      <div class="obot-source__meta" title="${h.escapeHtml(breakdown.shippingRow?.fee || "")}">
        ${h.escapeHtml(breakdown.logisticsCode)} · ${h.escapeHtml(breakdown.shippingRow?.group || "")}
        · ${Math.round(breakdown.weightG)}g · 跟卖价 ${formatCny(breakdown.salePriceCny)}
      </div>
      <div class="obot-source__meta">抽佣 ${commissionText} · 尾程 ${formatRub(breakdown.lastMileRub)}</div>
    `;
  }

  function sourcingCandidatePriceText(candidate) {
    const priceFrom = finiteParsedNumber(candidate?.priceFrom);
    const priceTo = finiteParsedNumber(candidate?.priceTo);
    if (priceFrom === null && priceTo === null) {
      return "采购价 -";
    }
    if (priceFrom !== null && priceTo !== null && Math.abs(priceFrom - priceTo) > 0.01) {
      return `${formatSourcingCurrency(priceFrom)} - ${formatSourcingCurrency(priceTo)}`;
    }
    return formatSourcingCurrency(priceFrom ?? priceTo);
  }

  function sourcingCandidateScoreText(candidate) {
    const score = Number(candidate?.matchScore);
    if (!Number.isFinite(score)) {
      return "匹配待确认";
    }
    return `匹配 ${Math.round(Math.max(0, Math.min(score, 1)) * 100)}分`;
  }

  function bestSourcingCandidate(item) {
    if (item?.sourcingBest) {
      return item.sourcingBest;
    }
    return Array.isArray(item?.sourcingCandidates) ? item.sourcingCandidates[0] || null : null;
  }

  function sourcingCellHtml(item) {
    const stateText = item.sourcingState || "idle";
    if (stateText === "running") {
      return `<div class="obot-source"><span class="obot-status" data-s="running">AI正在计算利润</span></div>`;
    }
    if (stateText === "error") {
      return `<div class="obot-source"><span class="obot-status" data-s="error">${h.escapeHtml(item.sourcingMessage || "AI计算失败")}</span></div>`;
    }

    const candidate = bestSourcingCandidate(item);
    if (!candidate) {
      const message = stateText === "not_found" ? item.sourcingMessage || "未找到货源" : "未计算";
      return `<div class="obot-source"><span class="obot-status" data-s="${stateText === "not_found" ? "error" : "idle"}">${h.escapeHtml(message)}</span></div>`;
    }

    const candidatesCount = Array.isArray(item.sourcingCandidates) ? item.sourcingCandidates.length : 1;
    const sellerText = [candidate.seller, candidate.location].filter(Boolean).join(" / ");
    return `
      <div class="obot-source">
        <div class="obot-source__price">${h.escapeHtml(sourcingCandidatePriceText(candidate))}</div>
        <div class="obot-source__title" title="${h.escapeHtml(candidate.title || "")}">${h.escapeHtml(candidate.title || "AI候选货源")}</div>
        <div class="obot-source__meta">${h.escapeHtml(`${sourcingCandidateScoreText(candidate)} · 候选 ${candidatesCount} 个`)}</div>
        ${sellerText ? `<div class="obot-source__meta">${h.escapeHtml(sellerText)}</div>` : ""}
        ${profitBreakdownHtml(item, candidate)}
        ${candidate.url ? `<a class="obot-source__link" href="${h.escapeHtml(candidate.url)}" target="_blank" rel="noreferrer">打开1688</a>` : ""}
      </div>
    `;
  }

  function build1688PayloadItem(item) {
    const monthlySalesFromFilter = Number(item?.filterValues?.monthlySales);
    return {
      product_id: Number(item.productId),
      title: h.normalizeText(item.title || item.subtitle || `SKU ${item.productId}`),
      subtitle: h.normalizeText(item.subtitle || item.title || ""),
      image_url: item.imageUrl || "",
      product_url: item.productUrl || "",
      follow_price: finiteParsedNumber(item.followPrice),
      market_price: Number.isFinite(item.basePrice)
        ? item.basePrice
        : finiteParsedNumber(item.marketPriceText),
      min_follow_price: finiteParsedNumber(item.minFollowPrice),
      category: commissionCategoryText(item),
      fulfillment: item?.filterValues?.fulfillment || itemMetricText(item, "fulfillment", ""),
      logistics_code: selectedLogisticsCode(),
      weight_g: itemWeightGrams(item),
      monthly_sales: Number.isFinite(monthlySalesFromFilter)
        ? monthlySalesFromFilter
        : parsePanelNumber(item.monthlySalesText)
    };
  }

  function markSourcingQueue(queue, patch) {
    const ids = new Set(queue.map((item) => Number(item.productId)));
    state.items = state.items.map((item) =>
      ids.has(Number(item.productId)) ? { ...item, ...patch } : item
    );
    persistStateToDomUploadFlow();
  }

  function saveSourcingDraftState() {
    if (state.panelMode !== "sku-draft" || !state.items.length) {
      return;
    }
    saveSkuDraft(state.items, { source: "sku-draft-sourcing" });
    renderMenu();
  }

  async function ensureCheckoutWeightsForSourcing(queue) {
    const ids = new Set(queue.map((item) => Number(item.productId)));
    state.items = state.items.map((item) => {
      if (!ids.has(Number(item.productId)) || Number.isFinite(Number(item.checkoutWeightG))) {
        return item;
      }
      return {
        ...item,
        packageWeightText: "抓取中",
        checkoutWeightState: "running",
        checkoutWeightMessage: "AI正在计算利润"
      };
    });
    persistStateToDomUploadFlow();
    renderPanel();

    const enrichedItems = await enrichCheckoutWeights(queue);
    const enrichedMap = new Map(enrichedItems.map((item) => [Number(item.productId), item]));
    state.items = state.items.map((item) => {
      const enriched = enrichedMap.get(Number(item.productId));
      return enriched ? { ...item, ...enriched } : item;
    });
    persistStateToDomUploadFlow();
    saveSourcingDraftState();
    renderPanel();
    return state.items.filter((item) => ids.has(Number(item.productId)));
  }

  async function compareSelected1688Sources() {
    if (state.sourcingLoading) {
      return;
    }

    const queue = selectedItems().filter((item) => item.productId);
    if (!queue.length) {
      h.showOverlay("请先勾选要比价的 SKU", "#dc2626");
      return;
    }

    state.sourcingLoading = true;
    state.sourcingError = "";
    markSourcingQueue(queue, {
      sourcingState: "running",
      sourcingMessage: "AI正在计算利润",
      sourcingCandidates: [],
      sourcingBest: null,
      profitInputs: null
    });
    renderPanel();

    try {
      const weightedQueue = await ensureCheckoutWeightsForSourcing(queue);
      markSourcingQueue(weightedQueue, {
        sourcingState: "running",
        sourcingMessage: "AI正在计算利润"
      });
      renderPanel();

      const response = await h.sendMessage({
        type: "compare-1688-sourcing",
        items: weightedQueue.map((item) => build1688PayloadItem(item)),
        maxCandidates: 5
      });
      if (!response?.ok) {
        throw new Error(response?.error || "AI计算利润失败");
      }

      const resultItems = Array.isArray(response.result?.items) ? response.result.items : [];
      const resultMap = new Map(resultItems.map((item) => [Number(item.productId), item]));
      const queueIds = new Set(queue.map((item) => Number(item.productId)));
      let foundCount = 0;

      state.items = state.items.map((item) => {
        if (!queueIds.has(Number(item.productId))) {
          return item;
        }
        const result = resultMap.get(Number(item.productId));
        const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        const best = result?.bestCandidate || candidates[0] || null;
        if (best) {
          foundCount += 1;
          return {
            ...item,
            sourcingState: "done",
            sourcingMessage: `找到 ${candidates.length || 1} 个候选`,
            sourcingCandidates: candidates,
            sourcingBest: best,
            profitInputs: result?.profitInputs || null
          };
        }
        return {
          ...item,
          sourcingState: "not_found",
          sourcingMessage: result?.errors?.[0] || "未找到可用货源",
          sourcingCandidates: [],
          sourcingBest: null,
          profitInputs: result?.profitInputs || null
        };
      });

      persistStateToDomUploadFlow();
      saveSourcingDraftState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.sourcingError = message;
      markSourcingQueue(queue, {
        sourcingState: "error",
        sourcingMessage: message,
        sourcingCandidates: [],
        sourcingBest: null,
        profitInputs: null
      });
      h.showOverlay(message, "#dc2626");
    } finally {
      state.sourcingLoading = false;
      renderPanel();
    }
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

  function autoFilterControlHtml() {
    if (!state.autoFilterRunning) {
      return "";
    }

    return state.autoFilterPaused
      ? `
        <button class="obot-menu__item obot-menu__item--primary" data-action="resume-auto-filter">继续自动筛选</button>
        <div class="obot-menu__hint">当前自动筛选已暂停，会保留已累计的 SKU，继续后从当前位置往下跑。</div>
      `
      : `
        <button class="obot-menu__item" data-action="pause-auto-filter">暂停自动筛选</button>
        <div class="obot-menu__hint">暂停后不会继续下滑，已累计的 SKU 会保留。</div>
      `;
  }

  function skuDraftMenuHtml() {
    const count = state.skuDraft?.items?.length || 0;
    if (!count) {
      return `<div class="obot-menu__hint">设置筛选条件和目标数量后，扩展会自动向下滚动加载，直到命中足够商品或页面没有更多数据。</div>`;
    }

    return `
      <button class="obot-menu__item obot-menu__item--primary" data-action="open-sku-draft">sku草稿 · ${h.escapeHtml(count)} 个</button>
      <div class="obot-menu__hint">这里记录刚刚筛选命中的商品，点击后进入跟卖面板。</div>
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
        <button class="obot-menu__item" data-action="open-filter-settings">筛选规则${state.filterTargetCount ? ` · ${h.escapeHtml(state.filterTargetCount)} 个` : ""}</button>
        ${skuDraftMenuHtml()}
        ${autoFilterControlHtml()}
        <button class="obot-menu__item" data-action="refresh-data-panels">刷新数据面板</button>
        <button class="obot-menu__item" data-action="load-more">加载更多数据</button>
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

  function filterRuleMatchCount() {
    return state.items.filter((item) => matchesFilterRule(item)).length;
  }

  function filterRuleSummary() {
    if (!hasActiveFilterRule()) {
      return "未启用条件，默认全选。";
    }
    return `当前规则命中 ${filterRuleMatchCount()} / ${state.items.length} 个 SKU。`;
  }

  function filterNumberFieldHtml(field) {
    const range = filterRange(state.filterRule, field.key);
    const unit = field.suffix || "";

    return `
      <div class="obot-filter__field">
        <label>${h.escapeHtml(field.label)}</label>
        <div class="obot-filter__range">
          <input class="obot-input" data-filter-number="${h.escapeHtml(field.key)}" data-filter-bound="min" value="${h.escapeHtml(range.min)}" placeholder="最小" ${state.uploading ? "disabled" : ""} />
          <span class="obot-filter__unit">${h.escapeHtml(unit)}</span>
        </div>
        <div class="obot-filter__range">
          <input class="obot-input" data-filter-number="${h.escapeHtml(field.key)}" data-filter-bound="max" value="${h.escapeHtml(range.max)}" placeholder="最大" ${state.uploading ? "disabled" : ""} />
          <span class="obot-filter__unit">${h.escapeHtml(unit)}</span>
        </div>
      </div>
    `;
  }

  function countryOptionsHtml(selectedCountry) {
    return FILTER_COUNTRY_OPTIONS.map(
      (item) =>
        `<option value="${h.escapeHtml(item.value)}" ${selectedCountry === item.value ? "selected" : ""}>${h.escapeHtml(
          item.label
        )}</option>`
    ).join("");
  }

  function filterPanelHtml() {
    if (!state.filterOpen) {
      return "";
    }

    const brandMode = state.filterRule?.brandMode || "any";
    const fulfillment = state.filterRule?.fulfillment || "any";
    const country = state.filterRule?.country || "any";

    return `
      <div class="obot-filter">
        <div class="obot-filter__head">
          <div>
            <div class="obot-filter__title">条件筛选规则</div>
            <div class="obot-filter__sub">字段来自当前商品面板/卡片：为空表示不限；填写目标数量后点击“应用规则”会收起面板并自动滚动筛选。</div>
          </div>
          <div class="obot-chiprow">
            <button class="obot-chip" data-action="apply-filter-rule" ${state.uploading ? "disabled" : ""}>应用规则</button>
            <button class="obot-chip" data-action="reset-filter-rule" ${state.uploading ? "disabled" : ""}>清空规则</button>
          </div>
        </div>
        <div class="obot-filter__target">
          <label>筛选目标数量</label>
          <input class="obot-input" data-filter-target-count="1" value="${h.escapeHtml(state.filterTargetCount || "")}" placeholder="例如 50" inputmode="numeric" ${state.uploading ? "disabled" : ""} />
          <div class="obot-caption">扩展会持续向下滚动加载和筛选；达到这个数量后自动停止。留空时只筛选当前已加载商品。</div>
        </div>
        <div class="obot-filter__grid">
          ${FILTER_NUMBER_FIELDS.map((field) => filterNumberFieldHtml(field)).join("")}
        </div>
        <div class="obot-filter__selects">
          <div class="obot-filter__select">
            <label>${h.escapeHtml(FILTER_TEXT_FIELDS[0].label)}</label>
            <select class="obot-select" data-filter-brand="1" ${state.uploading ? "disabled" : ""}>
              <option value="any" ${brandMode === "any" ? "selected" : ""}>不限</option>
              <option value="branded" ${brandMode === "branded" ? "selected" : ""}>有品牌</option>
              <option value="brandless" ${brandMode === "brandless" ? "selected" : ""}>无品牌</option>
            </select>
          </div>
          <div class="obot-filter__select">
            <label>${h.escapeHtml(FILTER_TEXT_FIELDS[1].label)}</label>
            <select class="obot-select" data-filter-fulfillment="1" ${state.uploading ? "disabled" : ""}>
              <option value="any" ${fulfillment === "any" ? "selected" : ""}>不限</option>
              <option value="FBO" ${fulfillment === "FBO" ? "selected" : ""}>FBO</option>
              <option value="FBS" ${fulfillment === "FBS" ? "selected" : ""}>FBS</option>
            </select>
          </div>
          <div class="obot-filter__select">
            <label>${h.escapeHtml(FILTER_TEXT_FIELDS[2].label)}</label>
            <select class="obot-select" data-filter-country="1" ${state.uploading ? "disabled" : ""}>
              <option value="any" ${country === "any" ? "selected" : ""}>不限</option>
              ${countryOptionsHtml(country)}
            </select>
          </div>
        </div>
        <div class="obot-filter__summary">${h.escapeHtml(filterRuleSummary())}</div>
      </div>
    `;
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
            <td>${sourcingCellHtml(item)}</td>
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

  function filterSettingsPanelHtml() {
    return `
      <div class="obot-dialog">
        <div class="obot-head">
          <div>
            <div class="obot-title">筛选规则</div>
            <div class="obot-sub">所有字段都来自商品分析面板。设置目标数量后，会自动向下滚动加载并筛选。</div>
          </div>
          <div class="obot-actions">
            <button class="obot-btn obot-btn--g" data-action="close-panel">关闭</button>
          </div>
        </div>
        <div class="obot-filter-settings-wrap">${filterPanelHtml()}</div>
        <div class="obot-foot">
          <div class="obot-summary">规则会保存在当前浏览器中，下次打开扩展仍会保留。</div>
          <div class="obot-actions">
            <button class="obot-btn obot-btn--g" data-action="reset-filter-rule">清空规则</button>
            <button class="obot-btn obot-btn--p" data-action="start-filter-page">开始自动筛选</button>
          </div>
        </div>
      </div>
    `;
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
    if (state.panelMode === "filter-settings") {
      return filterSettingsPanelHtml();
    }

    const selectedCount = selectedItems().length;
    const totalCount = state.items.length;
    const finishedCount = finishedItems().length;
    const title =
      state.panelMode === "single"
        ? "当前商品跟卖面板"
        : state.panelMode === "variants"
          ? "当前商品全部变体"
          : state.panelMode === "sku-draft"
            ? "sku草稿跟卖面板"
            : "当前页跟卖面板";
    const subtitle =
      state.panelMode === "single"
        ? "当前商品已采集，可直接设置价格、最低价、型号并铺货。"
        : state.panelMode === "variants"
          ? "当前商品的全部颜色/规格变体已收集，可批量一起铺货到店铺。"
          : state.panelMode === "sku-draft"
            ? "这里是刚刚筛选命中的商品，可按普通跟卖页面继续设置价格、最低价、型号并铺货。"
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
            <button class="obot-btn obot-btn--g" data-action="toggle-filter-rule" ${state.uploading ? "disabled" : ""}>${state.filterOpen ? "收起筛选规则" : "筛选规则"}</button>
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
          <div class="obot-field">
            <label>AI利润</label>
            <div class="obot-chiprow">
              <button class="obot-chip" data-action="compare-1688" ${state.uploading || state.sourcingLoading || !selectedCount ? "disabled" : ""}>${state.sourcingLoading ? "AI正在计算利润" : "AI自动计算利润"}</button>
            </div>
            <div class="obot-caption">自动匹配货源、重量、运费和佣金并计算利润</div>
          </div>
          <div class="obot-field">
            <label>物流线路</label>
            <select class="obot-select" data-logistics-select="1" ${state.uploading ? "disabled" : ""}>
              ${logisticsOptionsHtml()}
            </select>
            <div class="obot-caption">未选择时默认 GUOO；运费按 Ozon 重量命中阶梯公式计算</div>
          </div>
        </div>
        ${panelBannerHtml()}
        ${filterPanelHtml()}
        <div class="obot-tablewrap">
          ${
            totalCount
              ? `<table class="obot-table"><thead><tr><th><input type="checkbox" data-action="toggle-all" ${
                  selectedCount === totalCount && totalCount ? "checked" : ""
                } ${state.uploading ? "disabled" : ""} /></th><th>图片</th><th>SKU</th><th>跟卖价格</th><th>跟卖最低价</th><th>型号</th><th>产品价格</th><th>市场最低价</th><th>AI利润</th><th>重量</th><th>月销量</th><th>加购转化</th><th>状态</th><th>操作</th></tr></thead><tbody>${tableRows()}</tbody></table>`
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
        if (
          typeof h.fetchOzonProductDataForUpload !== "function" &&
          typeof h.fetchOzonProductDataById !== "function"
        ) {
          throw new Error("变体商品页抓取能力不可用");
        }

        async function extractVariantUploadData(item) {
          if (typeof h.fetchOzonProductDataForUpload === "function") {
            return h.fetchOzonProductDataForUpload(item.productId, item.productUrl);
          }
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
              uploadMessage: "正在静默抓取该变体商品..."
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
        if (typeof h.fetchOzonProductDataForUpload === "function") {
          return h.fetchOzonProductDataForUpload(item.productId, item.productUrl);
        }
        if (typeof h.fetchOzonProductDataById === "function") {
          return h.fetchOzonProductDataById(item.productId, item.productUrl);
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
            uploadMessage: "正在静默抓取并上传到 SaaS..."
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

    if (action === "open-filter-settings") {
      state.menuOpen = false;
      state.panelOpen = true;
      state.panelMode = "filter-settings";
      state.loading = false;
      state.filterOpen = true;
      renderMenu();
      renderPanel();
      return;
    }

    if (action === "start-filter-page") {
      await startCurrentPageAutoFilter();
      return;
    }

    if (action === "open-sku-draft") {
      await openSkuDraftPanel();
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
      if (filterTargetCountNumber()) {
        await startCurrentPageAutoFilter();
        return;
      }
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

    if (action === "pause-auto-filter") {
      if (state.autoFilterRunning) {
        state.autoFilterPaused = true;
        renderMenu();
        h.showOverlay("自动筛选已暂停", "#ea580c");
      }
      return;
    }

    if (action === "resume-auto-filter") {
      if (state.autoFilterRunning) {
        state.autoFilterPaused = false;
        renderMenu();
        h.showOverlay("继续自动筛选", "#2563eb");
      }
      return;
    }

    if (action === "refresh-data-panels") {
      if (typeof h.refreshBuyerAnalyticsPanels === "function") {
        await h.refreshBuyerAnalyticsPanels();
        h.showOverlay("数据面板已刷新", "#2563eb");
      }
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

    if (action === "compare-1688") {
      await compareSelected1688Sources();
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

    if (action === "toggle-filter-rule") {
      state.filterOpen = !state.filterOpen;
      renderPanel();
      return;
    }

    if (action === "apply-filter-rule") {
      if (filterTargetCountNumber()) {
        await startCurrentPageAutoFilter();
        return;
      }
      applyFilterRule();
      return;
    }

    if (action === "reset-filter-rule") {
      resetFilterRule();
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
    const targetCountElement =
      event.target instanceof HTMLInputElement ? event.target.closest("[data-filter-target-count]") : null;
    if (targetCountElement instanceof HTMLInputElement) {
      state.filterTargetCount = targetCountElement.value.replace(/[^\d]/g, "");
      saveFilterTargetCount(state.filterTargetCount);
      return;
    }

    const filterNumberElement =
      event.target instanceof HTMLInputElement ? event.target.closest("[data-filter-number]") : null;
    if (filterNumberElement instanceof HTMLInputElement) {
      const key = filterNumberElement.getAttribute("data-filter-number");
      const bound = filterNumberElement.getAttribute("data-filter-bound");
      if (key && (bound === "min" || bound === "max")) {
        const currentNumbers = state.filterRule.numbers || {};
        state.filterRule = {
          ...state.filterRule,
          numbers: {
            ...currentNumbers,
            [key]: {
              ...(currentNumbers[key] || {}),
              [bound]: filterNumberElement.value
            }
          }
        };
        saveFilterRule();
      }
      return;
    }

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

    const targetCountElement = target.closest("[data-filter-target-count]");
    if (targetCountElement instanceof HTMLInputElement) {
      saveFilterTargetCount(targetCountElement.value);
      renderMenu();
      return;
    }

    const filterNumberElement = target.closest("[data-filter-number]");
    if (filterNumberElement instanceof HTMLInputElement) {
      const key = filterNumberElement.getAttribute("data-filter-number");
      const bound = filterNumberElement.getAttribute("data-filter-bound");
      if (key && (bound === "min" || bound === "max")) {
        const currentNumbers = state.filterRule.numbers || {};
        state.filterRule = {
          ...state.filterRule,
          numbers: {
            ...currentNumbers,
            [key]: {
              ...(currentNumbers[key] || {}),
              [bound]: filterNumberElement.value
            }
          }
        };
        saveFilterRule();
        renderPanel();
      }
      return;
    }

    const filterBrandElement = target.closest("[data-filter-brand]");
    if (filterBrandElement instanceof HTMLSelectElement) {
      state.filterRule = {
        ...state.filterRule,
        brandMode: filterBrandElement.value || "any"
      };
      saveFilterRule();
      renderPanel();
      return;
    }

    const filterFulfillmentElement = target.closest("[data-filter-fulfillment]");
    if (filterFulfillmentElement instanceof HTMLSelectElement) {
      state.filterRule = {
        ...state.filterRule,
        fulfillment: filterFulfillmentElement.value || "any"
      };
      saveFilterRule();
      renderPanel();
      return;
    }

    const filterCountryElement = target.closest("[data-filter-country]");
    if (filterCountryElement instanceof HTMLSelectElement) {
      state.filterRule = {
        ...state.filterRule,
        country: filterCountryElement.value || "any"
      };
      saveFilterRule();
      renderPanel();
      return;
    }

    const selectElement = target.closest("[data-select]");
    if (selectElement) {
      void runAction("", selectElement.dataset);
      return;
    }

    const logisticsElement = target.closest("[data-logistics-select]");
    if (logisticsElement instanceof HTMLSelectElement) {
      state.selectedLogisticsCode = saveStoredLogisticsCode(logisticsElement.value);
      renderPanel();
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
