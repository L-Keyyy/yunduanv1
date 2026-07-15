export const DEFAULT_LISTING_TEXT_SYSTEM_PROMPT = [
  "你是电商商品信息处理助手。",
  "必须基于用户提供的爬虫 JSON 回答，不要编造 JSON 中不存在的商品事实。",
  "直接输出回答内容，不要复述任务说明。",
].join("\n");

export const LISTING_STAGE_AI_PROMPT_STORAGE_KEY =
  "banana-mall:listing-workflow:stage-ai-prompts";

export type ListingImageAspectRatio = "1:1" | "3:4" | "9:16";

export function buildDefaultListingImagePrompt(title: string) {
  const productName = title.trim() || "当前商品";
  return [
    `为 Ozon 商品卡生成一张高质感 1:1 主图，商品是：${productName}。`,
    "画面要求：纯白或浅灰背景，商品居中，真实电商摄影质感，主体清晰，边缘干净，有自然柔和阴影。",
    "不要添加文字、Logo、水印、边框、促销贴纸或多余装饰；不要改变商品核心形态。",
  ].join("\n");
}

export const DEFAULT_CATEGORY_MATCH_SYSTEM_PROMPT =
  "你是电商商品信息处理助手，只依据用户提供的数据回答，不得编造商品事实。";

export const DEFAULT_CATEGORY_MATCH_TASK_PROMPT = [
  "第一阶段任务：根据已清洗的商品事实判断最合适的 Ozon 商品类目和具体 type。",
  "输入已经由程序移除图片、视频、URL、HTML、埋点和重复字段，只能依据剩余商品事实判断。",
  "categoryName 与 categoryPath 请优先使用 Ozon 官方俄文名称，已知 ID 时同时返回；不知道 ID 不要猜。",
  "categoryName 必须是最具体的商品类型，不要只返回材质、形态或宽泛上级类目。",
  "先判断用户实际购买的商品主体，商品标题中的明确品类词优先级最高；用途、适用场景、包装用途和收纳方式只能用于辅助判断，不能覆盖明确商品类型。例如标题明确为酒瓶/Bottle时应选择Бутылка，不能因为用途包含食品包装而选择Банка для продуктов。",
  '只返回严格 JSON：{"categoryName":"具体商品类型","categoryPath":["上级类目","具体类型"],"descriptionCategoryId":null,"typeId":null,"searchTerms":["3-8个俄文精准同义词"],"confidence":0.0,"reason":"简短中文原因"}。',
].join("\n");

export const DEFAULT_FEATURE_FILL_SYSTEM_PROMPT =
  "你是电商商品信息处理助手，只依据用户提供的数据回答，不得编造商品事实。";

const FEATURE_FILL_DUAL_JSON_CONTRACT = [
  "返回结构约束：一个字段必须同时出现在 displayFeatures 和 uploadFeatures 中，并使用完全相同的 attributeId；两组字段数量、attributeId 集合和顺序必须一致。",
  "displayFeatures 和 uploadFeatures 必须都是 JSON 数组，必须分别使用方括号 [] 包裹；禁止把 uploadFeatures 写成单个对象。",
  "根 JSON 必须先输出 uploadFeatures，再输出 displayFeatures，最后才输出 notes；如果模板存在名称和简介字段（常见 attributeId 为 4180、4191），必须把它们放在 uploadFeatures 最前面，确保俄文上架名称和俄文描述完整返回。",
  "为避免回答截断，uploadFeatures 每项只返回 attributeId、value 和有依据时的 dictionary_value_id；不要返回 confidence、status、source、reason。使用紧凑 JSON，不要为了说明原因占用输出长度。",
  "displayFeatures 面向中文用户：keyZh 使用字段中文名，valueZh 使用准确、简洁的中文值。",
  "uploadFeatures 面向 Ozon 上架：有 allowedValues 时，value 必须精确复制某个 allowedValues.value；同时复制对应 dictionary_value_id。没有允许值可选时省略该字段，并在 notes 说明。",
  "没有 allowedValues 的自由文本字段，uploadFeatures.value 使用适合 Ozon 商品卡的俄文；不得把中文展示值直接当作俄文上架值。",
  "图片由程序单独处理；不要返回视频、PDF、富媒体链接或其他媒体字段。",
  "返回所有在商品事实中有明确依据的字段，不限制字段数量。不要使用 Markdown，不要解释，不要在最后一项后加逗号。",
  '只返回一个严格根 JSON，根内包含两段：{"uploadFeatures":[{"attributeId":"同一个Ozon属性ID","value":"Ozon标准俄文值","dictionary_value_id":123}],"displayFeatures":[{"attributeId":"Ozon属性ID","keyZh":"中文字段名","valueZh":"中文值"}],"notes":["人工注意事项"]}。',
];

export const DEFAULT_FEATURE_FILL_TASK_PROMPT = [
  "第二阶段任务：把第一阶段清洗后的同一份商品事实匹配到已确定类目的 Ozon 字段模板。",
  "只处理 attributeTemplate；只能返回其中存在的 attributeId，不得创建字段。",
  "只返回商品事实中有明确依据的非空字段；没有依据的字段直接省略，不要输出空值或 missing 项。",
  ...FEATURE_FILL_DUAL_JSON_CONTRACT,
].join("\n");

export function ensureFeatureFillDualJsonContract(value: string) {
  const taskPrompt = value.trim();
  const alreadyCompatible =
    taskPrompt.includes("displayFeatures") &&
    taskPrompt.includes("uploadFeatures") &&
    taskPrompt.includes("attributeId");
  const withDualContract = alreadyCompatible
    ? taskPrompt
    : [taskPrompt, ...FEATURE_FILL_DUAL_JSON_CONTRACT]
        .filter(Boolean)
        .join("\n");
  return withDualContract.includes("必须都是 JSON 数组")
    ? withDualContract.includes("必须先输出 uploadFeatures")
      ? withDualContract
      : [
          withDualContract,
          "根 JSON 必须先输出 uploadFeatures，再输出 displayFeatures，最后才输出 notes；名称和简介字段（常见 attributeId 4180、4191）必须放在 uploadFeatures 最前面。为避免截断，uploadFeatures 每项只返回 attributeId、value 和有依据时的 dictionary_value_id，不要返回 confidence、status、source、reason。",
        ].join("\n")
    : [
        withDualContract,
        "displayFeatures 和 uploadFeatures 必须都是 JSON 数组，必须分别使用方括号 [] 包裹；禁止把 uploadFeatures 写成单个对象。",
        "根 JSON 必须先输出 uploadFeatures，再输出 displayFeatures，最后才输出 notes；名称和简介字段（常见 attributeId 4180、4191）必须放在 uploadFeatures 最前面。为避免截断，uploadFeatures 每项只返回 attributeId、value 和有依据时的 dictionary_value_id，不要返回 confidence、status、source、reason。",
      ].join("\n");
}

export type ListingStageAiPromptConfig = {
  categoryMatch: {
    systemPrompt: string;
    taskPrompt: string;
  };
  featureFill: {
    systemPrompt: string;
    taskPrompt: string;
  };
  imageGeneration: {
    prompt: string;
    aspectRatio: ListingImageAspectRatio;
    useReference: boolean;
  };
};

export const DEFAULT_LISTING_STAGE_AI_PROMPTS: ListingStageAiPromptConfig = {
  categoryMatch: {
    systemPrompt: DEFAULT_CATEGORY_MATCH_SYSTEM_PROMPT,
    taskPrompt: DEFAULT_CATEGORY_MATCH_TASK_PROMPT,
  },
  featureFill: {
    systemPrompt: DEFAULT_FEATURE_FILL_SYSTEM_PROMPT,
    taskPrompt: DEFAULT_FEATURE_FILL_TASK_PROMPT,
  },
  imageGeneration: {
    prompt: buildDefaultListingImagePrompt(""),
    aspectRatio: "1:1",
    useReference: true,
  },
};

function stringFrom(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeListingStageAiPrompts(
  value: unknown,
): ListingStageAiPromptConfig {
  const root = recordFrom(value);
  const categoryMatch = recordFrom(root.categoryMatch);
  const featureFill = recordFrom(root.featureFill);
  const imageGeneration = recordFrom(root.imageGeneration);
  const rawAspectRatio = stringFrom(imageGeneration.aspectRatio);
  const aspectRatio: ListingImageAspectRatio =
    rawAspectRatio === "3:4" || rawAspectRatio === "9:16"
      ? rawAspectRatio
      : "1:1";

  return {
    categoryMatch: {
      systemPrompt:
        stringFrom(categoryMatch.systemPrompt) ||
        DEFAULT_LISTING_STAGE_AI_PROMPTS.categoryMatch.systemPrompt,
      taskPrompt:
        stringFrom(categoryMatch.taskPrompt) ||
        DEFAULT_LISTING_STAGE_AI_PROMPTS.categoryMatch.taskPrompt,
    },
    featureFill: {
      systemPrompt:
        stringFrom(featureFill.systemPrompt) ||
        DEFAULT_LISTING_STAGE_AI_PROMPTS.featureFill.systemPrompt,
      taskPrompt:
        ensureFeatureFillDualJsonContract(
          stringFrom(featureFill.taskPrompt) ||
            DEFAULT_LISTING_STAGE_AI_PROMPTS.featureFill.taskPrompt,
        ),
    },
    imageGeneration: {
      prompt:
        stringFrom(imageGeneration.prompt) ||
        DEFAULT_LISTING_STAGE_AI_PROMPTS.imageGeneration.prompt,
      aspectRatio,
      useReference:
        typeof imageGeneration.useReference === "boolean"
          ? imageGeneration.useReference
          : DEFAULT_LISTING_STAGE_AI_PROMPTS.imageGeneration.useReference,
    },
  };
}
