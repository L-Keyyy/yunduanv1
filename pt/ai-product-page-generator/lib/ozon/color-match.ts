export type OzonColorCandidate = {
  label?: string | null;
  value?: string | null;
  valueZh?: string | null;
  dictionaryValueId?: number | null;
  ozonValueId?: string | number | null;
};

export type OzonMatchedColorValue = {
  dictionary_value_id: number;
  value: string;
  label?: string;
  sourceText: string;
};

type ColorFamily = {
  id: string;
  aliases: string[];
  preferred: string[];
};

const COLOR_FAMILIES: ColorFamily[] = [
  {
    id: "black",
    aliases: ["黑色", "黑", "black", "черный", "чёрный", "черн", "чёрн"],
    preferred: ["черный", "чёрный", "黑色"],
  },
  {
    id: "white",
    aliases: ["白色", "白", "white", "белый", "белая", "белое", "белые"],
    preferred: ["белый", "白色"],
  },
  {
    id: "beige",
    aliases: ["米色", "米", "杏色", "beige", "бежев", "беж", "экрю", "кремов", "сливоч"],
    preferred: ["бежевый", "米色"],
  },
  {
    id: "gray",
    aliases: ["灰色", "灰", "grey", "gray", "серый", "серая", "серое", "серые", "графит"],
    preferred: ["серый", "灰色"],
  },
  {
    id: "blue",
    aliases: ["蓝色", "蓝", "blue", "синий", "синяя", "синее", "голубой", "голубая"],
    preferred: ["синий", "蓝色"],
  },
  {
    id: "green",
    aliases: ["绿色", "绿", "green", "зелен", "зелён", "салат"],
    preferred: ["зеленый", "зелёный", "绿色"],
  },
  {
    id: "brown",
    aliases: ["棕色", "棕", "咖色", "咖", "褐色", "褐", "brown", "коричнев", "шоколад"],
    preferred: ["коричневый", "棕色"],
  },
  {
    id: "red",
    aliases: ["红色", "红", "red", "красн", "алый", "бордов"],
    preferred: ["красный", "红色"],
  },
  {
    id: "pink",
    aliases: ["粉色", "粉", "pink", "розов"],
    preferred: ["розовый", "粉色"],
  },
  {
    id: "yellow",
    aliases: ["黄色", "黄", "yellow", "желт", "жёлт"],
    preferred: ["желтый", "жёлтый", "黄色"],
  },
  {
    id: "orange",
    aliases: ["橙色", "橙", "orange", "оранж"],
    preferred: ["оранжевый", "橙色"],
  },
  {
    id: "purple",
    aliases: ["紫色", "紫", "purple", "violet", "фиолет", "сирен"],
    preferred: ["фиолетовый", "紫色"],
  },
  {
    id: "silver",
    aliases: ["银色", "银", "silver", "серебрист", "серебро"],
    preferred: ["серебристый", "银色"],
  },
  {
    id: "gold",
    aliases: ["金色", "金", "gold", "золот"],
    preferred: ["золотой", "金色"],
  },
  {
    id: "transparent",
    aliases: ["透明", "transparent", "clear", "прозрач"],
    preferred: ["прозрачный", "透明"],
  },
  {
    id: "multicolor",
    aliases: ["多色", "彩色", "花色", "multicolor", "multi", "разноцвет", "мульти", "цветной"],
    preferred: ["разноцветный", "多色"],
  },
];

function textFrom(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim()
    : "";
}

export function isOzonColorAttributeId(value: unknown) {
  return String(value ?? "").trim() === "10096";
}

function normalizeColorText(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s\-_/\\()[\]（）【】.,，;；:："'“”‘’]+/g, "");
}

function candidateTexts(candidate: OzonColorCandidate) {
  return [candidate.value, candidate.valueZh, candidate.label]
    .map(textFrom)
    .filter(Boolean);
}

function dictionaryValueId(candidate: OzonColorCandidate) {
  const raw = candidate.dictionaryValueId ?? candidate.ozonValueId;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function detectFamilies(value: string) {
  const compact = normalizeColorText(value);
  if (!compact) return new Set<string>();
  const families = new Set<string>();
  for (const family of COLOR_FAMILIES) {
    if (
      family.aliases.some((alias) => {
        const normalizedAlias = normalizeColorText(alias);
        return normalizedAlias && compact.includes(normalizedAlias);
      })
    ) {
      families.add(family.id);
    }
  }
  return families;
}

function hasListSeparator(value: string) {
  return /[,，;；/、|]/.test(value);
}

function exactScore(candidate: OzonColorCandidate, raw: string) {
  const normalizedRaw = normalizeColorText(raw);
  if (!normalizedRaw) return 0;
  const texts = candidateTexts(candidate);
  if (texts.some((text) => normalizeColorText(text) === normalizedRaw)) {
    return 120;
  }
  if (
    texts.some((text) => {
      const normalizedText = normalizeColorText(text);
      return (
        normalizedText.length >= 2 &&
        (normalizedRaw.includes(normalizedText) || normalizedText.includes(normalizedRaw))
      );
    })
  ) {
    return 90;
  }
  return 0;
}

function preferredScore(candidate: OzonColorCandidate, familyId: string) {
  const family = COLOR_FAMILIES.find((item) => item.id === familyId);
  if (!family) return 0;
  const texts = candidateTexts(candidate).map(normalizeColorText);
  if (family.preferred.some((value) => texts.includes(normalizeColorText(value)))) {
    return 24;
  }
  const shortest = Math.min(...texts.map((value) => value.length).filter(Boolean));
  return Number.isFinite(shortest) ? Math.max(0, 16 - shortest / 2) : 0;
}

function familyScore(candidate: OzonColorCandidate, raw: string) {
  const rawFamilies = detectFamilies(raw);
  if (rawFamilies.size !== 1) return 0;
  const [rawFamily] = Array.from(rawFamilies);
  const candidateFamilies = new Set(
    candidateTexts(candidate).flatMap((text) => Array.from(detectFamilies(text))),
  );
  if (!candidateFamilies.has(rawFamily)) return 0;
  return 60 + preferredScore(candidate, rawFamily) - Math.max(0, candidateFamilies.size - 1) * 10;
}

function rawTextList(values: unknown[]) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(textFrom)
    .filter(Boolean);
}

export function findOzonColorValue(
  candidates: OzonColorCandidate[],
  rawValues: unknown[],
): OzonMatchedColorValue | null {
  const usableCandidates = candidates.filter(
    (candidate) => dictionaryValueId(candidate) && textFrom(candidate.value),
  );
  if (!usableCandidates.length) return null;

  for (const raw of rawTextList(rawValues)) {
    const rawFamilies = detectFamilies(raw);
    if (hasListSeparator(raw) && rawFamilies.size > 1) continue;

    const ranked = usableCandidates
      .map((candidate) => ({
        candidate,
        score: Math.max(exactScore(candidate, raw), familyScore(candidate, raw)),
      }))
      .filter((item) => item.score >= 55)
      .sort((left, right) => right.score - left.score);

    const winner = ranked[0]?.candidate;
    const winnerId = dictionaryValueId(winner ?? {});
    const winnerValue = textFrom(winner?.value);
    if (winner && winnerId && winnerValue) {
      return {
        dictionary_value_id: winnerId,
        value: winnerValue,
        label: textFrom(winner.valueZh) || textFrom(winner.label),
        sourceText: raw,
      };
    }
  }

  return null;
}
