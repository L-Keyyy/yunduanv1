export const LISTING_QUICK_MODE_PROVIDER_ID = "browser-webai";
export const LISTING_QUICK_MODE_MODEL_ID = "gpt-thinking";
export const LISTING_QUICK_MODE_PROMPT =
  "@China Product to Ozon 快速模式。读取附件 JSON 和最新 dev.db，只返回严格 JSON，不要过程说明。";

export const LISTING_MAX_INFO_PROMPT =
  "@Ozon Max Info 读取上传的商品 JSON，使用当前有效的 Ozon 分片数据库和缓存，尽最大程度填写 Ozon 商品属性，只返回严格 JSON。";

export const LISTING_FEATURE_FILL_MODES = [
  {
    id: "normal",
    label: "普通填写特征",
    prompt: LISTING_QUICK_MODE_PROMPT,
  },
  {
    id: "max",
    label: "最大可能填写",
    prompt: LISTING_MAX_INFO_PROMPT,
  },
] as const;

export type ListingFeatureFillMode =
  (typeof LISTING_FEATURE_FILL_MODES)[number]["id"];

export const DEFAULT_LISTING_FEATURE_FILL_MODE: ListingFeatureFillMode =
  "max";

export function normalizeListingFeatureFillMode(
  value: unknown,
): ListingFeatureFillMode {
  return value === "normal" || value === "max"
    ? value
    : DEFAULT_LISTING_FEATURE_FILL_MODE;
}

export function listingFeatureFillModeConfig(value: unknown) {
  const mode = normalizeListingFeatureFillMode(value);
  return (
    LISTING_FEATURE_FILL_MODES.find((candidate) => candidate.id === mode) ??
    LISTING_FEATURE_FILL_MODES[1]
  );
}
