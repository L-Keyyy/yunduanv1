export type ListingWarehouseRule = {
  id: string;
  logisticsGroup: string;
  minWeightGrams: number;
  maxWeightGrams: number;
  minPriceCny: number;
  maxPriceCny: number;
  warehouseName: string;
  warehouseId: string | null;
};

export const DEFAULT_LISTING_PRODUCT_QUANTITY = 100;

export const DEFAULT_LISTING_WAREHOUSE_RULES: ListingWarehouseRule[] = [
  {
    id: "extra-small",
    logisticsGroup: "Extra Small 超级轻小件",
    minWeightGrams: 0,
    maxWeightGrams: 500,
    minPriceCny: 0,
    maxPriceCny: 135,
    warehouseName: "A",
    warehouseId: null,
  },
  {
    id: "budget",
    logisticsGroup: "Budget 经济件",
    minWeightGrams: 501,
    maxWeightGrams: 30_000,
    minPriceCny: 0,
    maxPriceCny: 135,
    warehouseName: "B",
    warehouseId: null,
  },
  {
    id: "small",
    logisticsGroup: "Small 小件",
    minWeightGrams: 0,
    maxWeightGrams: 2_000,
    minPriceCny: 135.01,
    maxPriceCny: 635,
    warehouseName: "C",
    warehouseId: null,
  },
  {
    id: "big",
    logisticsGroup: "Big 大件",
    minWeightGrams: 2_001,
    maxWeightGrams: 30_000,
    minPriceCny: 135.01,
    maxPriceCny: 635,
    warehouseName: "D",
    warehouseId: null,
  },
  {
    id: "premium-small",
    logisticsGroup: "Premium Small 高货值小件",
    minWeightGrams: 0,
    maxWeightGrams: 5_000,
    minPriceCny: 635.01,
    maxPriceCny: 22_525,
    warehouseName: "F",
    warehouseId: null,
  },
  {
    id: "premium-big",
    logisticsGroup: "Premium Big 高货值大件",
    minWeightGrams: 5_001,
    maxWeightGrams: 30_000,
    minPriceCny: 635.01,
    maxPriceCny: 22_525,
    warehouseName: "E",
    warehouseId: null,
  },
];

export function normalizeListingProductQuantity(value: unknown) {
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= 999_999
    ? quantity
    : DEFAULT_LISTING_PRODUCT_QUANTITY;
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeListingWarehouseRules(
  value: unknown,
): ListingWarehouseRule[] {
  if (!Array.isArray(value) || !value.length) {
    return DEFAULT_LISTING_WAREHOUSE_RULES.map((rule) => ({ ...rule }));
  }
  const byId = new Map(
    value.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      return id ? [[id, record] as const] : [];
    }),
  );
  return DEFAULT_LISTING_WAREHOUSE_RULES.map((fallback) => {
    const record = byId.get(fallback.id);
    if (!record) return { ...fallback };
    const warehouseName =
      typeof record.warehouseName === "string"
        ? record.warehouseName.trim()
        : fallback.warehouseName;
    const warehouseId =
      typeof record.warehouseId === "string" && record.warehouseId.trim()
        ? record.warehouseId.trim()
        : null;
    return {
      id: fallback.id,
      logisticsGroup:
        typeof record.logisticsGroup === "string" && record.logisticsGroup.trim()
          ? record.logisticsGroup.trim()
          : fallback.logisticsGroup,
      minWeightGrams: finiteNumber(record.minWeightGrams, fallback.minWeightGrams),
      maxWeightGrams: finiteNumber(record.maxWeightGrams, fallback.maxWeightGrams),
      minPriceCny: finiteNumber(record.minPriceCny, fallback.minPriceCny),
      maxPriceCny: finiteNumber(record.maxPriceCny, fallback.maxPriceCny),
      warehouseName,
      warehouseId,
    };
  });
}

