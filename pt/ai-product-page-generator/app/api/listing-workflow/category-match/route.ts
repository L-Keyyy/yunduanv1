import { NextRequest } from "next/server";
import { z } from "zod";

import { generateBrowserText, isBrowserAiProvider } from "@/lib/browser-ai/client";
import { prisma } from "@/lib/db/prisma";
import { getOzonConnectionState } from "@/lib/ozon/config-service";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const categoryMatchRequestSchema = z.object({
  scrapedData: z.record(z.string(), z.unknown()),
  providerId: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional().nullable(),
  customPrompt: z.string().trim().max(4000).optional().nullable(),
  systemPrompt: z.string().trim().max(8000).optional().nullable(),
});

const aiCategoryMatchSchema = z.object({
  categoryRecordId: z.string().min(1).optional().nullable(),
  categoryName: z.string().min(1).optional().nullable(),
  categoryPath: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  descriptionCategoryId: z.union([z.number(), z.string()]).optional().nullable(),
  typeId: z.union([z.number(), z.string()]).optional().nullable(),
  searchTerms: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});

type SourceFact = {
  key: string;
  value: string;
};

type CategoryCandidate = {
  id: string;
  label: string;
  path: string[];
  descriptionCategoryId: number | null;
  typeId: number | null;
  score: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function compactText(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function joinTextList(value: unknown) {
  if (!Array.isArray(value)) return textValue(value);
  return value
    .map((item) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return textValue(item);
      const record = asRecord(item);
      return textValue(record.text) || textValue(record.name) || textValue(record.label) || textValue(record.value) || textValue(record.title);
    })
    .filter(Boolean)
    .join(", ");
}

function descriptionText(value: unknown) {
  const record = asRecord(value);
  return (
    compactText(textValue(record.text)) ||
    compactText(textValue(record.html)) ||
    compactText(textValue(record.rawSectionHtml)) ||
    compactText(textValue(value))
  );
}

function addFact(facts: SourceFact[], key: string, value: unknown) {
  const text = textValue(value);
  if (!key.trim() || !text) return;
  if (text.length > 500) return;
  facts.push({ key: key.trim(), value: text });
}

function addObjectFacts(facts: SourceFact[], value: unknown) {
  const record = asRecord(value);
  for (const [key, entry] of Object.entries(record)) {
    addFact(facts, key, entry);
  }
}

function addArrayFacts(facts: SourceFact[], value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value.slice(0, 80)) {
    const record = asRecord(item);
    const key =
      textValue(record.name) ||
      textValue(record.key) ||
      textValue(record.label) ||
      textValue(record.title) ||
      textValue(record.attrName) ||
      textValue(record.attributeName);
    const valueText =
      textValue(record.value) ||
      textValue(record.valueText) ||
      textValue(record.text) ||
      textValue(record.content) ||
      textValue(record.attrValue) ||
      textValue(record.attributeValue);

    if (key && valueText) {
      addFact(facts, key, valueText);
    }
  }
}

function extractSourceFacts(data: Record<string, unknown>) {
  const facts: SourceFact[] = [];
  addFact(facts, "商品标题", data.title ?? data.name ?? data.item_name ?? data.productName ?? data.goods_name ?? data.subject);
  addFact(facts, "平台", data.platform ?? data.source ?? data.site);
  addFact(facts, "价格", data.price ?? data.salePrice ?? data.min_price ?? data.priceRange);
  addFact(facts, "商品简述", data.summary ?? data.shortDescription ?? data.descriptionText ?? descriptionText(data.description));
  addFact(facts, "标签", joinTextList(data.hashtags) || joinTextList(data.tags) || joinTextList(data.keywords) || joinTextList(data.marketingLabels));
  addObjectFacts(facts, data.characteristics);
  addArrayFacts(facts, data.characteristics);
  addObjectFacts(facts, data.attributes);
  addArrayFacts(facts, data.attributes);
  addObjectFacts(facts, data.props);
  addArrayFacts(facts, data.props);
  addObjectFacts(facts, data.specs);
  addArrayFacts(facts, data.specs);
  addObjectFacts(facts, data.parameters);
  addArrayFacts(facts, data.parameters);

  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.key.toLowerCase()}:${fact.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jsonPathToStrings(path: unknown) {
  return Array.isArray(path) ? path.map((item) => String(item)) : [];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function productTokens(facts: SourceFact[]) {
  const text = facts.map((fact) => `${fact.key} ${fact.value}`).join(" ");
  const tokens = text
    .toLowerCase()
    .match(/[\p{Script=Han}]{2,}|[a-zа-яё0-9]{3,}/giu);
  return [...new Set(tokens ?? [])].slice(0, 80);
}

function scoreCategory(candidateText: string, tokens: string[]) {
  const normalized = normalizeText(candidateText);
  return tokens.reduce((score, token) => {
    const normalizedToken = normalizeText(token);
    if (!normalizedToken) return score;
    if (normalized.includes(normalizedToken)) return score + Math.min(8, normalizedToken.length);
    return score;
  }, 0);
}

function modelCanMatchCategory(model: { capabilities: Record<string, unknown>; isAvailable?: boolean }) {
  const capabilities = model.capabilities ?? {};
  const isImageOnly = Boolean(capabilities.image_gen || capabilities.image_edit) && !capabilities.text;
  return model.isAvailable !== false && Boolean(capabilities.text || capabilities.structured_output || capabilities.vision) && !isImageOnly;
}

function parseJsonBlock(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }
  return candidate;
}

function serializeCandidate(category: CategoryCandidate) {
  return {
    id: category.id,
    label: category.label,
    path: category.path,
    descriptionCategoryId: category.descriptionCategoryId,
    typeId: category.typeId,
    score: category.score,
  };
}

function integerValue(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function aiCategoryTerms(aiResult: z.infer<typeof aiCategoryMatchSchema>) {
  return [
    aiResult.categoryName ?? "",
    ...(Array.isArray(aiResult.categoryPath)
      ? aiResult.categoryPath
      : [aiResult.categoryPath ?? ""]),
    ...(aiResult.searchTerms ?? []),
  ].filter(Boolean);
}

function trigramSimilarity(left: string, right: string) {
  const ngrams = (value: string) => {
    const normalized = normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, "");
    if (normalized.length < 3) return new Set(normalized ? [normalized] : []);
    return new Set(
      Array.from(
        { length: normalized.length - 2 },
        (_, index) => normalized.slice(index, index + 3),
      ),
    );
  };
  const leftGrams = ngrams(left);
  const rightGrams = ngrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let overlap = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) overlap += 1;
  }
  return overlap / Math.max(leftGrams.size, rightGrams.size);
}

function scoreAiCategory(candidate: CategoryCandidate, aiTerms: string[], tokens: string[]) {
  const candidateText = [candidate.label, ...candidate.path].filter(Boolean).join(" ");
  const normalizedCandidate = normalizeText(candidateText);
  let score = scoreCategory(candidateText, tokens);
  for (const term of aiTerms) {
    const normalizedAi = normalizeText(term);
    if (normalizedAi && normalizedCandidate === normalizedAi) score += 2000;
    if (normalizedAi && normalizedCandidate.includes(normalizedAi)) score += 1000;
    if (normalizedAi && normalizedAi.includes(normalizeText(candidate.label))) score += 500;
  }
  const candidateTerms = [candidate.label, ...candidate.path];
  const fuzzyScore = Math.max(
    0,
    ...candidateTerms.flatMap((candidateTerm) =>
      aiTerms.map((term) => trigramSimilarity(candidateTerm, term)),
    ),
  );
  if (fuzzyScore >= 0.35) score += Math.round(fuzzyScore * 400);
  return score;
}

export async function POST(request: NextRequest) {
  try {
    const parsed = categoryMatchRequestSchema.parse(await request.json());
    const facts = extractSourceFacts(parsed.scrapedData);
    const categories = await prisma.ozonCategory.findMany({
      where: {
        disabled: false,
        typeId: { not: null },
      },
      select: {
        id: true,
        label: true,
        categoryName: true,
        typeName: true,
        path: true,
        descriptionCategoryId: true,
        typeId: true,
        depth: true,
      },
      orderBy: [{ depth: "desc" }, { label: "asc" }],
    });

    if (categories.length === 0) {
      const ozonConnection = await getOzonConnectionState();
      return ok({
        category: null,
        candidates: [],
        aiStatus: {
          ok: false,
          message: ozonConnection.ready
            ? "本地还没有 Ozon 类目树，请先同步 /v1/description-category/tree。"
            : "本地还没有 Ozon 类目树。请先在 Ozon API 配置里填写 Client-Id 和 Api-Key，再同步类目树。",
        },
        confidence: 0,
        reason: "",
      });
    }

    const tokens = productTokens(facts);
    const scoredCandidates = categories
      .map<CategoryCandidate>((category) => {
        const path = jsonPathToStrings(category.path);
        const candidateText = [category.label, category.categoryName, category.typeName, ...path].filter(Boolean).join(" ");
        return {
          id: category.id,
          label: category.label,
          path,
          descriptionCategoryId: category.descriptionCategoryId,
          typeId: category.typeId,
          score: scoreCategory(candidateText, tokens),
        };
      })
      .sort((left, right) => right.score - left.score || right.path.length - left.path.length || left.label.localeCompare(right.label));

    const candidates = (scoredCandidates.some((candidate) => candidate.score > 0)
      ? scoredCandidates.filter((candidate) => candidate.score > 0)
      : scoredCandidates
    ).slice(0, 160);

    const modelId = parsed.model?.trim();
    if (!modelId) {
      return ok({
        category: null,
        candidates: candidates.slice(0, 8).map(serializeCandidate),
        aiStatus: {
          ok: false,
          message: "请先选择用于类目匹配的文本/结构化模型。",
        },
        confidence: 0,
        reason: "",
      });
    }

    const systemPrompt =
      parsed.systemPrompt ||
      "你是电商商品信息处理助手，只依据用户提供的数据回答，不得编造商品事实。";
    const userPrompt = [
      [
        "第一阶段任务：根据商品 JSON 判断最合适的 Ozon 商品类目和具体 type。",
        "categoryName 与 categoryPath 请优先使用 Ozon 官方俄文名称，已知 ID 时同时返回；不知道 ID 不要猜。",
        '只返回严格 JSON：{"categoryName":"具体商品类型","categoryPath":["上级类目","具体类型"],"descriptionCategoryId":null,"typeId":null,"searchTerms":["俄文同义词"],"confidence":0.0,"reason":"简短中文原因"}。',
        parsed.customPrompt ? `用户任务提示词：${parsed.customPrompt}` : "",
      ].filter(Boolean).join("\n"),
      `商品 JSON：\n${JSON.stringify(parsed.scrapedData, null, 2)}`,
    ].filter(Boolean).join("\n\n");

    let completionText: string;
    if (isBrowserAiProvider(parsed.providerId)) {
      completionText = await generateBrowserText({
        model: modelId,
        systemPrompt,
        userPrompt,
      });
    } else {
      const { provider, adapter } = await getProviderAdapter(parsed.providerId ?? undefined);
      const selectedModel = provider.models.find((model) => model.modelId === modelId);
      if (!selectedModel || !modelCanMatchCategory(selectedModel)) {
        return ok({
          category: null,
          candidates: candidates.slice(0, 8).map(serializeCandidate),
          aiStatus: {
            ok: false,
            message: selectedModel
              ? "当前选择的模型不适合做 Ozon 类目匹配，请切换到文本/结构化模型。"
              : "当前 Provider 里没有找到这个模型，请重新扫描或保存 AI 配置。",
          },
          confidence: 0,
          reason: "",
        });
      }

      const completion = await adapter.generateText({
        model: modelId,
        timeoutMs: 90000,
        systemPrompt,
        userPrompt,
        monitor: { operation: "ozon_category_match" },
      });
      completionText = completion.text;
    }

    const aiParsed = aiCategoryMatchSchema.parse(JSON.parse(parseJsonBlock(completionText)));
    const descriptionCategoryId = integerValue(aiParsed.descriptionCategoryId);
    const typeId = integerValue(aiParsed.typeId);
    const aiTerms = aiCategoryTerms(aiParsed);
    const aiText = aiTerms.join(" ");
    const aiTokens = productTokens([{ key: "AI Ozon 类目", value: aiText }]);
    const aiScoredCandidates = scoredCandidates
      .map((candidate) => ({
        ...candidate,
        score: scoreAiCategory(candidate, aiTerms, aiTokens),
      }))
      .sort((left, right) => right.score - left.score || right.path.length - left.path.length || left.label.localeCompare(right.label));
    const matchedCategory =
      (aiParsed.categoryRecordId
        ? scoredCandidates.find((candidate) => candidate.id === aiParsed.categoryRecordId)
        : null) ||
      (typeId !== null
        ? scoredCandidates.find(
            (candidate) =>
              candidate.typeId === typeId &&
              (descriptionCategoryId === null || candidate.descriptionCategoryId === descriptionCategoryId),
          )
        : null) ||
      (aiScoredCandidates[0]?.score > 0 ? aiScoredCandidates[0] : null);
    const responseCandidates = aiScoredCandidates.some((candidate) => candidate.score > 0)
      ? aiScoredCandidates
      : candidates;

    return ok({
      category: matchedCategory ? serializeCandidate(matchedCategory) : null,
      candidates: responseCandidates.slice(0, 8).map(serializeCandidate),
      aiStatus: {
        ok: Boolean(matchedCategory),
        message: matchedCategory
          ? `已使用 ${modelId} 匹配 Ozon 类目，下一步会读取该类目的特殊字段。`
          : "AI 没有返回有效的候选类目，请人工选择或同步更完整的类目树。",
      },
      confidence: aiParsed.confidence ?? (matchedCategory ? 0.7 : 0),
      reason: aiParsed.reason ?? "",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
