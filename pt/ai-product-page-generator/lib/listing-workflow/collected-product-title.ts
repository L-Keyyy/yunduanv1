type VariantRecord = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function looksLikeSellerName(value: string, sellerName: string) {
  return (
    value === sellerName ||
    /(?:有限责任公司|股份有限公司|有限公司|商行|店铺|旗舰店|专营店|专卖店)$/.test(
      value,
    )
  );
}

function variantBaseTitle(variant: VariantRecord) {
  const title = text(variant.title) || text(variant.name);
  const specText = text(variant.specText);
  if (!title) return "";
  if (specText && title.endsWith(specText)) {
    return title.slice(0, -specText.length).trim();
  }
  return title;
}

export function resolveCollectedProductTitle(options: {
  cardTitle?: unknown;
  detailTitle?: unknown;
  sellerName?: unknown;
  variants?: VariantRecord[];
  existingTitle?: unknown;
  fallback: string;
}) {
  const sellerName = text(options.sellerName);
  const candidates = [
    text(options.cardTitle),
    ...(options.variants || []).map(variantBaseTitle),
    text(options.detailTitle),
    text(options.existingTitle),
  ];
  return (
    candidates.find(
      (candidate) =>
        candidate.length >= 4 &&
        candidate.length <= 500 &&
        !looksLikeSellerName(candidate, sellerName),
    ) || options.fallback
  );
}
