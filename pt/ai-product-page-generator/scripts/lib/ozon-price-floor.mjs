export function money(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

export function requiredOldPriceGap(price) {
  const current = money(price);
  if (current < 400) return 20;
  if (current <= 10_000) return money(current * 0.05);
  return 500;
}

export function isOldPriceCompliant(price, oldPrice) {
  const current = money(price);
  const old = money(oldPrice);
  if (old <= 0) return true;
  return old - current + 0.0001 >= requiredOldPriceGap(current);
}

export function compliantOldPrice(price) {
  const current = money(price);
  return money(current + requiredOldPriceGap(current) + 0.01);
}

export function buildPriceFloorRepair(priceState, options = {}) {
  const floor = Math.max(0.01, money(options.floor ?? 15));
  const currentPrice = money(priceState?.price);
  const currentMinPrice = money(priceState?.min_price);
  const currentOldPrice = money(priceState?.old_price);
  const hasDiscountError = options.hasDiscountError === true;
  const targetPrice = Math.max(floor, currentPrice);
  const targetMinPrice = Math.max(floor, Math.min(targetPrice, currentMinPrice));
  const oldPriceNeedsRepair = !isOldPriceCompliant(
    targetPrice,
    currentOldPrice,
  );
  const targetOldPrice = currentOldPrice > 0 || hasDiscountError
    ? oldPriceNeedsRepair || currentOldPrice <= targetPrice
      ? compliantOldPrice(targetPrice)
      : currentOldPrice
    : 0;
  const reasons = [];
  if (currentPrice < floor) reasons.push("price_below_floor");
  if (currentMinPrice < floor) reasons.push("min_price_below_floor");
  if (hasDiscountError) reasons.push("discount_validation_error");
  if (oldPriceNeedsRepair) reasons.push("old_price_gap_too_small");
  if (priceState?.auto_action_enabled === true) reasons.push("auto_action_enabled");
  return {
    floor,
    currentPrice,
    currentMinPrice,
    currentOldPrice,
    targetPrice,
    targetMinPrice,
    targetOldPrice,
    reasons,
    needsRepair: reasons.length > 0,
  };
}
