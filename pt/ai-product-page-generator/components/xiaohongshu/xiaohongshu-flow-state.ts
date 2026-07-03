"use client";

import type { XiaohongshuPlan } from "@/lib/ai/schemas/xiaohongshu";

export type XiaohongshuGeneratedImage = {
  pageNumber: number;
  title: string;
  prompt: string;
  model: string;
  imageUrl: string;
  revisedPrompt?: string;
  updatedAt: string;
};

export type XiaohongshuReferenceImage = {
  fileName: string;
  mimeType: string;
  dataUrl: string;
};

export type XiaohongshuDraft = {
  topic: string;
  referenceImages: XiaohongshuReferenceImage[];
  plan: XiaohongshuPlan | null;
  images: XiaohongshuGeneratedImage[];
  updatedAt: string;
};

const storageKey = "banana-mall:xiaohongshu-flow:v1";

export function createEmptyXiaohongshuDraft(): XiaohongshuDraft {
  return {
    topic: "",
    referenceImages: [],
    plan: null,
    images: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadXiaohongshuDraft(): XiaohongshuDraft {
  if (typeof window === "undefined") {
    return createEmptyXiaohongshuDraft();
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return createEmptyXiaohongshuDraft();
  }

  try {
    return {
      ...createEmptyXiaohongshuDraft(),
      ...(JSON.parse(raw) as Partial<XiaohongshuDraft>),
    };
  } catch {
    return createEmptyXiaohongshuDraft();
  }
}

export function saveXiaohongshuDraft(draft: XiaohongshuDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    storageKey,
    JSON.stringify({
      ...draft,
      updatedAt: new Date().toISOString(),
    }),
  );
}

export function buildDefaultImagePrompt(plan: XiaohongshuPlan, page: XiaohongshuPlan["pages"][number]) {
  return [
    `小红书 3:4 图文第 ${page.pageNumber} 页。`,
    `整组选题：${plan.topic}`,
    `页面标题：${page.title}`,
    page.subtitle ? `副标题：${page.subtitle}` : "",
    `正文要点：${page.body}`,
    `画面描述：${page.visualDirection}`,
    `版式：${page.layout}`,
    page.negativePrompt ? `禁止出现：${page.negativePrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildXiaohongshuMarkdown(plan: XiaohongshuPlan) {
  return [
    `# ${plan.coverTitle}`,
    plan.coverSubtitle,
    "",
    `选题：${plan.topic}`,
    `人群：${plan.audience}`,
    `洞察：${plan.coreInsight}`,
    "",
    "## 标题备选",
    ...plan.titleOptions.map((title, index) => `${index + 1}. ${title}`),
    "",
    "## 分页脚本",
    ...plan.pages.flatMap((page) => [
      `### ${page.pageNumber}. ${page.title}`,
      page.subtitle ? `副标题：${page.subtitle}` : "",
      `正文：${page.body}`,
      `提示词：${page.imagePrompt || buildDefaultImagePrompt(plan, page)}`,
      page.negativePrompt ? `避免：${page.negativePrompt}` : "",
      "",
    ]),
    "## 发布文案",
    plan.caption,
    "",
    plan.hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" "),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function downloadTextFile(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
