import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { z } from "zod";

import { parseStructuredJson } from "@/lib/ai/parse-structured-json";
import { generateBrowserText, isBrowserAiProvider } from "@/lib/browser-ai/client";
import { prisma } from "@/lib/db/prisma";
import {
  auditProductFacts,
  prepareProductFacts,
} from "@/lib/listing-workflow/product-facts";
import {
  DEFAULT_CATEGORY_MATCH_SYSTEM_PROMPT,
  DEFAULT_CATEGORY_MATCH_TASK_PROMPT,
} from "@/lib/listing-workflow/text-prompts";
import { getOzonConnectionState } from "@/lib/ozon/config-service";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const categoryMatchRequestSchema = z.object({
  scrapedData: z.record(z.string(), z.unknown()),
  providerId: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional().nullable(),
  customPrompt: z.string().trim().max(4000).optional().nullable(),
  systemPrompt: z.string().trim().max(8000).optional().nullable(),
  // 由采集列表发起时带上这两个字段，让服务端在 AI 返回后直接落库。
  // 这样即使页面切换或请求窗口被关闭，商品也会结束“匹配中”状态。
  workflowItemId: z.string().trim().min(1).max(200).optional().nullable(),
  workflowRunId: z.string().trim().min(1).max(300).optional().nullable(),
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

type CategoryMatchResult = {
  category: ReturnType<typeof serializeCandidate> | null;
  preparedProduct?: Record<string, unknown>;
  aiDecision?: unknown;
  categoryCorrection?: unknown;
  confidence?: number;
  reason?: string;
  rawResponse?: string;
  aiStatus: {
    ok: boolean;
    message: string;
  };
  [key: string]: unknown;
};

type WorkflowMatchContext = {
  itemId: string;
  runId: string;
  providerId: string;
  model: string;
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

function storedJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function storedStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
}

function workflowCategoryNotes(value: Prisma.JsonValue, message: string) {
  return [
    ...storedStringArray(value).filter(
      (note) => !note.startsWith("类目匹配："),
    ),
    `类目匹配：${message}`,
  ].slice(0, 100);
}

async function persistWorkflowCategoryResult(
  context: WorkflowMatchContext | null,
  result: CategoryMatchResult,
) {
  if (!context) return;
  const current = await prisma.listingWorkflowItem.findUnique({
    where: { id: context.itemId },
  });
  if (!current || current.stage !== "COLLECTED") return;

  const aiResponse = storedJsonObject(current.aiResponse);
  const savedCategoryMatch =
    aiResponse.categoryMatch &&
    typeof aiResponse.categoryMatch === "object" &&
    !Array.isArray(aiResponse.categoryMatch)
      ? (aiResponse.categoryMatch as Record<string, unknown>)
      : {};
  // 旧请求迟到时不覆盖用户后来发起的新任务。
  if (savedCategoryMatch.runId !== context.runId) return;

  const matchedCategory = result.category;
  const message = matchedCategory
    ? `已匹配 ${matchedCategory.label}`
    : result.aiStatus.message || "AI 没有返回匹配类目";
  await prisma.listingWorkflowItem.update({
    where: { id: context.itemId },
    data: {
      status: matchedCategory ? "PENDING_AI" : "AI_FAILED",
      categoryId: matchedCategory?.id ?? null,
      categoryLabel: matchedCategory?.label ?? null,
      categoryPath: matchedCategory
        ? (matchedCategory.path as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      aiResponse: {
        ...aiResponse,
        categoryMatch: matchedCategory
          ? {
              ...savedCategoryMatch,
              providerId: context.providerId,
              model: context.model,
              runId: context.runId,
              status: "matched",
              error: null,
              preparedProduct: result.preparedProduct ?? {},
              aiDecision: result.aiDecision ?? null,
              categoryCorrection: result.categoryCorrection ?? null,
              confidence: result.confidence ?? 0,
              reason: result.reason ?? "",
              completedAt: new Date().toISOString(),
            }
          : {
              ...savedCategoryMatch,
              providerId: context.providerId,
              model: context.model,
              runId: context.runId,
              status: "failed",
              error: message,
              rawResponse: result.rawResponse ?? null,
              completedAt: new Date().toISOString(),
            },
      } as Prisma.InputJsonValue,
      notes: workflowCategoryNotes(
        current.notes,
        matchedCategory ? `已匹配 ${matchedCategory.label}` : message,
      ) as Prisma.InputJsonValue,
    },
  });
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
    if (normalizedAi.length >= 6 && normalizedCandidate.includes(normalizedAi)) {
      score += 600;
    }
    const normalizedLabel = normalizeText(candidate.label);
    if (
      normalizedLabel.length >= 6 &&
      normalizedAi.includes(normalizedLabel)
    ) {
      score += Math.min(120, normalizedLabel.length * 8);
    }
  }
  const stopWords = new Set([
    "для",
    "или",
    "при",
    "под",
    "над",
    "без",
    "the",
    "and",
    "for",
    "with",
  ]);
  const stemToken = (token: string) => {
    const normalized = token.toLowerCase();
    if (normalized.length < 5) return normalized;
    return normalized.replace(
      /(иями|ями|ами|ого|ему|ому|ыми|ими|ей|ой|ий|ый|ая|яя|ое|ее|ов|ев|ам|ям|ах|ях|ом|ем|ы|и|а|я|у|ю|е|о)$/u,
      "",
    );
  };
  const semanticTokens = (value: string) =>
    new Set(
      (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .map(stemToken)
        .filter((token) => token.length >= 3 && !stopWords.has(token)),
    );
  const candidateTokens = semanticTokens(candidateText);
  const candidateLabelTokens = semanticTokens(candidate.label);
  const aiTokenSet = semanticTokens(aiTerms.join(" "));
  let semanticOverlap = 0;
  for (const token of candidateTokens) {
    if (aiTokenSet.has(token)) semanticOverlap += 1;
  }
  let labelOverlap = 0;
  for (const token of candidateLabelTokens) {
    if (aiTokenSet.has(token)) labelOverlap += 1;
  }
  score += semanticOverlap * 90 + labelOverlap * 220;
  if (labelOverlap === 0) score -= 180;

  const hasToken = (values: string[]) =>
    values.some((value) =>
      [...aiTokenSet].some(
        (token) => token === value || token.startsWith(value),
      ),
    );
  const candidateHasToken = (values: string[]) =>
    values.some((value) =>
      [...candidateTokens].some(
        (token) => token === value || token.startsWith(value),
      ),
    );
  const aiIsFaceCare = hasToken(["лиц", "альгинат", "facial", "face"]);
  const aiIsHairCare = hasToken(["волос", "hair"]);
  if (
    aiIsFaceCare &&
    candidateHasToken(["волос", "голов", "hair", "зуб", "полост"])
  ) {
    score -= 900;
  }
  if (aiIsHairCare && candidateHasToken(["лиц", "facial", "face"])) {
    score -= 900;
  }
  if (hasToken(["маск"]) && candidateLabelTokens.has("маск")) {
    score += 260;
  } else if (hasToken(["маск"]) && !candidateTokens.has("маск")) {
    score -= 180;
  }
  const candidateTerms = [candidate.label, ...candidate.path];
  const fuzzyScore = Math.max(
    0,
    ...candidateTerms.flatMap((candidateTerm) =>
      aiTerms.map((term) => trigramSimilarity(candidateTerm, term)),
    ),
  );
  if (fuzzyScore >= 0.25) score += Math.round(fuzzyScore * 240);
  return score;
}

function explicitTitleCategory(
  title: string,
  candidates: CategoryCandidate[],
) {
  const normalizedTitle = title.toLowerCase();
  const bottleExcluded =
    /开瓶器|启瓶器|瓶盖|瓶塞|瓶刷|bottle\s*opener|bottle\s*cap|bottle\s*stopper/i.test(
      normalizedTitle,
    );
  const bottleExplicit =
    !bottleExcluded &&
    (/酒瓶|水瓶|饮料瓶|玻璃瓶|空瓶|瓶子/.test(normalizedTitle) ||
      /\b(?:vodka|wine|water|drink|glass)\s+bottle\b/i.test(
        normalizedTitle,
      ) ||
      /\bbottle\b/i.test(normalizedTitle));
  if (bottleExplicit) {
    const category = candidates.find(
      (candidate) => normalizeText(candidate.label) === "бутылка",
    );
    if (category) {
      return {
        category,
        reason:
          "商品标题明确包含“酒瓶/Bottle”这一商品主体；用途、食品包装或礼品包装只能作为属性依据，不能把商品改判为食品储存罐。",
      };
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  let workflowContext: WorkflowMatchContext | null = null;
  try {
    const parsed = categoryMatchRequestSchema.parse(await request.json());
    if (parsed.workflowItemId && parsed.workflowRunId && parsed.model) {
      workflowContext = {
        itemId: parsed.workflowItemId,
        runId: parsed.workflowRunId,
        providerId: parsed.providerId?.trim() || "",
        model: parsed.model.trim(),
      };
    }
    const respond = async (result: CategoryMatchResult) => {
      await persistWorkflowCategoryResult(workflowContext, result);
      return ok(result);
    };
    const preparedProduct = prepareProductFacts(parsed.scrapedData);
    const promptAudit = auditProductFacts(parsed.scrapedData, preparedProduct);
    const facts = extractSourceFacts({
      title: preparedProduct.title,
      source: preparedProduct.source,
      price: preparedProduct.price,
      description: preparedProduct.description,
      characteristics: preparedProduct.facts,
    });
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
      return respond({
        category: null,
        candidates: [],
        preparedProduct,
        promptAudit: { ...promptAudit, jsonRepaired: false },
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
      return respond({
        category: null,
        candidates: candidates.slice(0, 8).map(serializeCandidate),
        preparedProduct,
        promptAudit: { ...promptAudit, jsonRepaired: false },
        aiStatus: {
          ok: false,
          message: "请先选择用于类目匹配的文本/结构化模型。",
        },
        confidence: 0,
        reason: "",
      });
    }

    const systemPrompt =
      parsed.systemPrompt || DEFAULT_CATEGORY_MATCH_SYSTEM_PROMPT;
    const taskPrompt =
      parsed.customPrompt || DEFAULT_CATEGORY_MATCH_TASK_PROMPT;
    const userPrompt = [
      taskPrompt,
      `商品事实 JSON：\n${JSON.stringify(preparedProduct, null, 2)}`,
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
        return respond({
          category: null,
          candidates: candidates.slice(0, 8).map(serializeCandidate),
          preparedProduct,
          promptAudit: { ...promptAudit, jsonRepaired: false },
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

    let structured: ReturnType<typeof parseStructuredJson>;
    let aiParsed: z.infer<typeof aiCategoryMatchSchema>;
    try {
      structured = parseStructuredJson(completionText);
      aiParsed = aiCategoryMatchSchema.parse(structured.value);
    } catch (error) {
      return respond({
        category: null,
        candidates: candidates.slice(0, 8).map(serializeCandidate),
        preparedProduct,
        promptAudit: { ...promptAudit, jsonRepaired: false },
        rawResponse: completionText,
        aiStatus: {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "AI 返回类目内容无法解析为 JSON。",
        },
        confidence: 0,
        reason: "",
      });
    }
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
    const aiMatchedCategory =
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
    const titleCategory = explicitTitleCategory(
      preparedProduct.title,
      scoredCandidates,
    );
    const matchedCategory = titleCategory?.category ?? aiMatchedCategory;
    const categoryCorrected = Boolean(
      titleCategory &&
        (!aiMatchedCategory || titleCategory.category.id !== aiMatchedCategory.id),
    );
    const responseCandidates = aiScoredCandidates.some((candidate) => candidate.score > 0)
      ? aiScoredCandidates
      : candidates;

    return respond({
      category: matchedCategory ? serializeCandidate(matchedCategory) : null,
      candidates: responseCandidates.slice(0, 8).map(serializeCandidate),
      preparedProduct,
      promptAudit: {
        ...promptAudit,
        jsonRepaired: structured.repaired,
      },
      aiDecision: aiParsed,
      categoryCorrection: categoryCorrected
        ? {
            from: aiMatchedCategory
              ? serializeCandidate(aiMatchedCategory)
              : null,
            to: serializeCandidate(titleCategory!.category),
            reason: titleCategory!.reason,
          }
        : null,
      aiStatus: {
        ok: Boolean(matchedCategory),
        message: matchedCategory
          ? `已使用 ${modelId} 匹配 Ozon 类目，下一步会读取该类目的特殊字段。`
          : "AI 没有返回有效的候选类目，请人工选择或同步更完整的类目树。",
      },
      confidence: categoryCorrected
        ? Math.max(aiParsed.confidence ?? 0, 0.94)
        : aiParsed.confidence ?? (matchedCategory ? 0.7 : 0),
      reason: categoryCorrected
        ? `${titleCategory!.reason}${
            aiParsed.reason ? ` AI 原始判断：${aiParsed.reason}` : ""
          }`
        : aiParsed.reason ?? "",
    });
  } catch (error) {
    if (workflowContext) {
      const message =
        error instanceof Error ? error.message : "AI 类目匹配请求异常";
      await persistWorkflowCategoryResult(workflowContext, {
        category: null,
        aiStatus: { ok: false, message },
      }).catch(() => undefined);
    }
    return handleRouteError(error);
  }
}
