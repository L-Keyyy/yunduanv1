import type { OzonMappedAttribute } from "@/lib/ozon/ai-response-mapper";
import type { OzonAttributeSnapshot } from "@/lib/ozon/snapshot";

const attributeConceptAliases: Record<string, string[]> = {
  brand: ["brand", "品牌", "бренд"],
  color: ["color", "colour", "颜色", "色", "цвет", "расцветка"],
  material: ["material", "材质", "材料", "материал", "состав"],
  model: ["model", "型号", "модель", "модел"],
  size: ["size", "尺寸", "尺码", "размер"],
  gender: ["gender", "性别", "пол"],
  country: ["country", "产地", "国家", "страна"],
  quantity: ["quantity", "count", "数量", "件数", "количество"],
  volume: ["volume", "容量", "体积", "объем", "объём"],
  weight: ["weight", "重量", "вес"],
  warranty: ["warranty", "保修", "质保", "гарантия", "гарант"],
  length: ["length", "长度", "长", "длина"],
  width: ["width", "宽度", "宽", "ширина"],
  height: ["height", "高度", "高", "высота"],
};

const preferredAttributeNames: Record<string, string[]> = {
  color: ["цветтовара"],
  model: ["названиемодели"],
  warranty: ["гарантия"],
  weight: ["вессупаковкой"],
};

export function normalizeOzonAttributeMatchKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^ai:/, "")
    .replace(/[\s\-_/\\()[\]（）【】.:：]+/g, "");
}

function attributeConcept(value: string) {
  const normalized = normalizeOzonAttributeMatchKey(value);
  if (!normalized) return null;
  for (const [concept, aliases] of Object.entries(attributeConceptAliases)) {
    if (
      aliases.some((alias) => {
        const normalizedAlias = normalizeOzonAttributeMatchKey(alias);
        const minimumLength = /[\u4e00-\u9fff]/.test(normalizedAlias) ? 2 : 3;
        return (
          normalized === normalizedAlias ||
          (normalizedAlias.length >= minimumLength &&
            normalized.includes(normalizedAlias))
        );
      })
    ) {
      return concept;
    }
  }
  return null;
}

export function findOzonCategoryAttribute(
  mapped: OzonMappedAttribute,
  attributes: OzonAttributeSnapshot[],
) {
  const direct = attributes.find(
    (attribute) => attribute.ozonAttributeId === mapped.attributeId,
  );
  if (direct) return direct;

  const candidateKeys = [
    mapped.label,
    mapped.jsonKey ?? "",
    mapped.jsonPath?.split(".").at(-1) ?? "",
    mapped.attributeId.replace(/^ai:/, ""),
  ]
    .map(normalizeOzonAttributeMatchKey)
    .filter(Boolean);
  const exactMatches = attributes.filter((attribute) =>
    candidateKeys.includes(normalizeOzonAttributeMatchKey(attribute.name)),
  );
  if (exactMatches.length === 1) return exactMatches[0];

  const containedMatches = attributes.filter((attribute) => {
    const attributeKey = normalizeOzonAttributeMatchKey(attribute.name);
    if (attributeKey.length < 4) return false;
    return candidateKeys.some(
      (candidate) =>
        candidate.length >= 4 &&
        (candidate.includes(attributeKey) || attributeKey.includes(candidate)),
    );
  });
  if (containedMatches.length === 1) return containedMatches[0];

  const mappedConcepts = new Set(
    [mapped.label, mapped.jsonKey ?? "", mapped.jsonPath ?? "", mapped.attributeId]
      .map(attributeConcept)
      .filter((value): value is string => Boolean(value)),
  );
  if (!mappedConcepts.size) return null;
  const conceptMatches = attributes.filter((attribute) => {
    const concept = attributeConcept(attribute.name);
    return concept ? mappedConcepts.has(concept) : false;
  });
  if (conceptMatches.length === 1) return conceptMatches[0];

  for (const concept of mappedConcepts) {
    const preferredNames = preferredAttributeNames[concept] ?? [];
    const preferredMatches = conceptMatches.filter((attribute) => {
      const normalizedName = normalizeOzonAttributeMatchKey(attribute.name);
      return preferredNames.some((name) => normalizedName.includes(name));
    });
    if (preferredMatches.length === 1) return preferredMatches[0];
  }
  return null;
}
