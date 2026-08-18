const IGNORED_OZON_ATTRIBUTE_IDS = new Set(["22232"]);

export function isIgnoredOzonAttributeId(value: unknown) {
  return IGNORED_OZON_ATTRIBUTE_IDS.has(String(value ?? "").trim());
}

export function isIgnoredOzonAttribute(attribute: {
  ozonAttributeId?: unknown;
  name?: unknown;
}) {
  if (isIgnoredOzonAttributeId(attribute.ozonAttributeId)) return true;

  const name = String(attribute.name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return /тн\s*вэд.*еаэс/u.test(name);
}
