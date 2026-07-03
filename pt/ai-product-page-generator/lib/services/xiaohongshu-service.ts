import { xiaohongshuPlanSchema, type XiaohongshuPlan } from "@/lib/ai/schemas/xiaohongshu";
import type { ImageGenerationResult } from "@/lib/ai/provider-client";
import { getProviderAdapter } from "@/lib/services/provider-service";

export type XiaohongshuPlanInput = {
  topic: string;
  images?: string[];
};

function buildXiaohongshuPrompt(input: XiaohongshuPlanInput) {
  return [
    "You are a senior Xiaohongshu content strategist and visual director.",
    "Return strict JSON only. Do not wrap the response in markdown.",
    "Create a complete carousel graphic post plan for a mobile 3:4 Xiaohongshu layout.",
    "The result must be immediately usable by a designer or image generation agent.",
    "",
    "Requirements:",
    "- Write in Simplified Chinese.",
    "- Create 5 to 8 pages including cover, insight/value pages, practical steps, and a final summary or CTA page.",
    "- Every page needs a concrete visual direction, layout, text hierarchy, and negativePrompt.",
    "- Every page also needs imagePrompt: a complete prompt that can be sent directly to an image generation model after the user edits it.",
    "- Avoid vague image directions. Mention foreground, background, key objects, crop, color atmosphere, and text placement.",
    "- Include realistic constraints when the topic involves products, bodies, tools, food, appliances, wires, airflow, liquids, heat, light, weight, or motion.",
    "- Do not make impossible physical phenomena: reversed airflow, cables disappearing into furniture, floating unsupported objects, liquid flowing upward, handles/doors opening through solid parts, or hands passing through objects.",
    "- Avoid absolute medical, legal, financial, or guaranteed-result claims.",
    "- Caption should feel native to Xiaohongshu: useful, lightly conversational, and skimmable.",
    "- Hashtags should be Chinese, without spaces.",
    input.images?.length
      ? "- The user uploaded reference images. Analyze the product/object/style shown in those images and reflect them in page strategy, visualDirection, imagePrompt, and negativePrompt."
      : "- No reference image was uploaded; infer the visual plan from the topic only.",
    "",
    `Topic: ${input.topic}`,
  ].join("\n");
}

function imageResultToUrl(result: ImageGenerationResult) {
  if (result.b64Json) {
    return `data:image/png;base64,${result.b64Json}`;
  }

  if (result.url) {
    return result.url;
  }

  throw new Error("图像模型没有返回可用图片。");
}

function unique(values: Array<string | null | undefined>) {
  return values.filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
}

function getImageGenerationModels(provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"]) {
  return unique([
    provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
    provider.models.find((item) => item.isDefaultDetailImage)?.modelId,
    provider.models.find((item) => Boolean((item.capabilities as Record<string, boolean>).image_gen))?.modelId,
  ]);
}

function getImageEditModels(provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"]) {
  return unique([
    provider.models.find((item) => item.isDefaultImageEdit)?.modelId,
    provider.models.find((item) => Boolean((item.capabilities as Record<string, boolean>).image_edit))?.modelId,
    provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
  ]);
}

function buildPageImagePrompt(plan: XiaohongshuPlan, page: XiaohongshuPlan["pages"][number]) {
  const basePrompt =
    page.imagePrompt.trim() ||
    [
      `小红书 3:4 图文第 ${page.pageNumber} 页。`,
      `页面标题：${page.title}`,
      page.subtitle ? `副标题：${page.subtitle}` : "",
      `正文要点：${page.body}`,
      `画面描述：${page.visualDirection}`,
      `版式：${page.layout}`,
      page.negativePrompt ? `禁止：${page.negativePrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  return [
    basePrompt,
    "",
    "生成一张适合小红书图文轮播的竖版 3:4 图片。",
    "图内必须包含中文标题、核心短句和必要的视觉信息层级，文字要清晰、不要乱码、不要挤压。",
    "整体要像真实可发布的小红书图文页，而不是网页截图或空白海报。",
    `整组内容主题：${plan.topic}`,
    `目标人群：${plan.audience}`,
    `核心洞察：${plan.coreInsight}`,
  ].join("\n");
}

async function runImageModel<T>(
  models: string[],
  runner: (model: string) => Promise<T>,
  emptyMessage: string,
) {
  const errors: string[] = [];

  for (const model of models) {
    try {
      return { model, result: await runner(model) };
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  throw new Error(models.length === 0 ? emptyMessage : errors.join(" | "));
}

export async function planXiaohongshuPost(input: XiaohongshuPlanInput) {
  const topic = input.topic.trim();
  if (!topic) {
    throw new Error("请输入小红书图文选题。");
  }

  const { provider, adapter } = await getProviderAdapter();
  const model =
    provider.models.find((item) => item.isDefaultPlanning)?.modelId ??
    provider.models.find((item) => (item.capabilities as Record<string, boolean>).structured_output)?.modelId ??
    provider.models.find((item) => (item.capabilities as Record<string, boolean>).text)?.modelId;

  if (!model) {
    throw new Error("当前没有可用的小红书图文规划模型。");
  }

  const result = await adapter.generateStructured({
    model,
    systemPrompt: "Return strict JSON only.",
    userPrompt: buildXiaohongshuPrompt({ topic, images: input.images }),
    images: input.images,
    schema: xiaohongshuPlanSchema,
    timeoutMs: 90000,
    monitor: {
      operation: "xiaohongshu_planning",
    },
  });

  return result.parsed;
}

export async function generateXiaohongshuImages(plan: XiaohongshuPlan, referenceImages: string[] = []) {
  const { provider, adapter } = await getProviderAdapter();
  const models = getImageGenerationModels(provider);

  const images = [];
  for (const page of plan.pages) {
    const prompt = buildPageImagePrompt(plan, page);
    const generated = await runImageModel(
      models,
      (model) =>
        adapter.generateImage({
          model,
          prompt,
          aspectRatio: "3:4",
          referenceImages,
          monitor: {
            operation: "xiaohongshu_image_generate",
          },
        }),
      "当前没有可用的小红书图像生成模型。",
    );

    images.push({
      pageNumber: page.pageNumber,
      title: page.title,
      prompt,
      model: generated.model,
      imageUrl: imageResultToUrl(generated.result),
      revisedPrompt: generated.result.revisedPrompt ?? "",
      updatedAt: new Date().toISOString(),
    });
  }

  return images;
}

export async function editXiaohongshuImage(input: {
  imageUrl: string;
  prompt: string;
  page?: XiaohongshuPlan["pages"][number] | null;
}) {
  const { provider, adapter } = await getProviderAdapter();
  const models = getImageEditModels(provider);
  const prompt = [
    input.prompt,
    "",
    input.page ? `当前页标题：${input.page.title}` : "",
    input.page ? `当前页正文：${input.page.body}` : "",
    "保留原图的小红书 3:4 图文风格和主体结构，只修改用户指出的问题。",
    "中文文字必须清晰，不要产生乱码，不要把文字压到边缘。",
  ]
    .filter(Boolean)
    .join("\n");

  const edited = await runImageModel(
    models,
    (model) =>
      adapter.editImage({
        model,
        image: input.imageUrl,
        prompt,
        aspectRatio: "3:4",
        monitor: {
          operation: "xiaohongshu_image_edit",
        },
      }),
    "当前没有可用的小红书图像编辑模型。",
  );

  return {
    imageUrl: imageResultToUrl(edited.result),
    model: edited.model,
    revisedPrompt: edited.result.revisedPrompt ?? "",
    updatedAt: new Date().toISOString(),
  };
}
