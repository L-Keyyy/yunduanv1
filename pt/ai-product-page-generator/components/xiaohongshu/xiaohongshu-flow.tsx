"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  ImagePlus,
  Loader2,
  PenLine,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { fileToBase64Payload } from "@/lib/utils/base64-upload";
import type { XiaohongshuPlan } from "@/lib/ai/schemas/xiaohongshu";
import {
  buildDefaultImagePrompt,
  buildXiaohongshuMarkdown,
  createEmptyXiaohongshuDraft,
  downloadTextFile,
  loadXiaohongshuDraft,
  saveXiaohongshuDraft,
  type XiaohongshuDraft,
  type XiaohongshuGeneratedImage,
  type XiaohongshuReferenceImage,
} from "@/components/xiaohongshu/xiaohongshu-flow-state";

const steps = [
  { href: "/xiaohongshu/plan", label: "1 规划", description: "文本生成" },
  { href: "/xiaohongshu/review", label: "2 调整", description: "编辑提示词" },
  { href: "/xiaohongshu/generate", label: "3 生成", description: "图像生成" },
  { href: "/xiaohongshu/edit", label: "4 修改", description: "图像编辑" },
];

function FlowNav({ current }: { current: string }) {
  return (
    <div className="grid gap-2 md:grid-cols-4">
      {steps.map((step) => {
        const active = step.href.endsWith(current);
        return (
          <Link
            key={step.href}
            href={step.href}
            className={cn(
              "rounded-2xl border px-4 py-3 transition",
              active
                ? "border-slate-950 bg-slate-950 text-white dark:border-white dark:bg-white dark:text-slate-950"
                : "border-border bg-background hover:bg-muted dark:bg-black/20",
            )}
          >
            <p className="text-sm font-medium">{step.label}</p>
            <p className={cn("mt-1 text-xs", active ? "opacity-75" : "text-muted-foreground")}>{step.description}</p>
          </Link>
        );
      })}
    </div>
  );
}

function EmptyState({ message, actionHref, actionLabel }: { message: string; actionHref: string; actionLabel: string }) {
  return (
    <Card>
      <CardContent className="flex min-h-[280px] flex-col items-center justify-center text-center">
        <Sparkles className="h-10 w-10 text-muted-foreground" />
        <p className="mt-4 text-base font-medium">{message}</p>
        <Link href={actionHref} className={cn(buttonVariants({ variant: "default" }), "mt-5")}>
          {actionLabel}
        </Link>
      </CardContent>
    </Card>
  );
}

function PhonePlanPreview({
  plan,
  selectedIndex,
  imageUrl,
}: {
  plan: XiaohongshuPlan | null;
  selectedIndex: number;
  imageUrl?: string | null;
}) {
  const page = plan?.pages[selectedIndex] ?? null;

  return (
    <div className="mx-auto w-full max-w-[390px] rounded-[2.25rem] border-[10px] border-slate-950 bg-slate-950 shadow-[0_28px_80px_-42px_rgba(15,23,42,0.8)] dark:border-black">
      <div className="overflow-hidden rounded-[1.45rem] bg-[#f7f3ea]">
        <div className="aspect-[3/4] p-5">
          {imageUrl ? (
            <img src={imageUrl} alt={page?.title ?? "小红书图文"} className="h-full w-full rounded-[1.25rem] object-cover" />
          ) : page ? (
            <div className="flex h-full flex-col justify-between rounded-[1.25rem] bg-[linear-gradient(145deg,#fffaf0,#eaf3ff_54%,#fff)] p-5 text-slate-950 shadow-inner">
              <div className="space-y-3">
                <Badge className="rounded-full">P{page.pageNumber}</Badge>
                <h2 className="text-3xl font-semibold leading-tight tracking-normal">{page.title}</h2>
                {page.subtitle ? <p className="text-base font-medium leading-6 text-slate-600">{page.subtitle}</p> : null}
              </div>
              <div className="rounded-2xl bg-white/78 p-4 shadow-sm">
                <p className="text-sm leading-7 text-slate-700">{page.body}</p>
              </div>
              <div className="space-y-2 text-xs leading-5 text-slate-500">
                <p>{page.visualDirection}</p>
                <p>{page.layout}</p>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-[1.25rem] border border-dashed border-slate-300 bg-white/70 p-6 text-center text-sm text-slate-500">
              还没有图文规划
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PageSelector({
  plan,
  selectedIndex,
  onSelect,
  images,
}: {
  plan: XiaohongshuPlan;
  selectedIndex: number;
  onSelect: (index: number) => void;
  images?: XiaohongshuGeneratedImage[];
}) {
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 xl:grid-cols-4 2xl:grid-cols-8">
      {plan.pages.map((page, index) => {
        const generated = images?.find((item) => item.pageNumber === page.pageNumber);
        return (
          <button
            key={`${page.pageNumber}-${page.title}`}
            type="button"
            onClick={() => onSelect(index)}
            className={cn(
              "aspect-[3/4] rounded-xl border p-2 text-left text-xs transition",
              selectedIndex === index
                ? "border-slate-950 bg-slate-950 text-white dark:border-white dark:bg-white dark:text-slate-950"
                : "border-border bg-background hover:bg-muted dark:bg-black/20",
            )}
          >
            <span className="flex items-center justify-between gap-1 text-[10px] opacity-70">
              P{page.pageNumber}
              {generated ? <CheckCircle2 className="h-3 w-3" /> : null}
            </span>
            <span className="mt-1 line-clamp-3 block leading-4">{page.title}</span>
          </button>
        );
      })}
    </div>
  );
}

export function XiaohongshuPlanStep() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [referenceImages, setReferenceImages] = useState<XiaohongshuReferenceImage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const draft = loadXiaohongshuDraft();
    setTopic(draft.topic);
    setReferenceImages(draft.referenceImages ?? []);
  }, []);

  async function handleReferenceUpload(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []).slice(0, 4);
    if (selectedFiles.length === 0) return;

    try {
      const converted = await Promise.all(
        selectedFiles.map(async (file) => {
          const payload = await fileToBase64Payload(file);
          return {
            fileName: payload.fileName,
            mimeType: payload.mimeType,
            dataUrl: `data:${payload.mimeType};base64,${payload.base64Data}`,
          };
        }),
      );
      setReferenceImages(converted);
      toast.success(`已添加 ${converted.length} 张参考图`);
    } catch {
      toast.error("参考图读取失败，请换一张图片重试。");
    }
  }

  async function handlePlan() {
    if (topic.trim().length < 2) {
      toast.error("请输入一个更明确的选题。");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/xiaohongshu/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          images: referenceImages.map((image) => image.dataUrl),
        }),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "小红书图文规划失败");
      }
      saveXiaohongshuDraft({
        topic,
        referenceImages,
        plan: payload.data,
        images: [],
        updatedAt: new Date().toISOString(),
      });
      toast.success("文本规划完成，进入提示词调整。");
      router.push("/xiaohongshu/review");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "小红书图文规划失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <FlowNav current="plan" />
      <Card>
        <CardHeader>
          <CardTitle>1. 规划选题</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：小户型桌面收纳盒怎么拍出高级感 / 吹风机选购避坑 / 通勤包一周搭配"
            className="min-h-[180px] text-base leading-7"
          />
          <div className="space-y-3 rounded-2xl border border-border bg-muted/35 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">参考图</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  可上传产品图、参考风格图或场景图，最多 4 张；规划和生成都会参考这些图片。
                </p>
              </div>
              <label className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer rounded-2xl")}>
                <ImagePlus className="mr-2 h-4 w-4" />
                上传图像
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => handleReferenceUpload(event.target.files)}
                />
              </label>
            </div>

            {referenceImages.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {referenceImages.map((image, index) => (
                  <div key={`${image.fileName}-${index}`} className="relative overflow-hidden rounded-2xl border border-border bg-background">
                    <div className="aspect-square">
                      <img src={image.dataUrl} alt={image.fileName} className="h-full w-full object-cover" />
                    </div>
                    <button
                      type="button"
                      onClick={() => setReferenceImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      className="absolute right-2 top-2 rounded-full bg-black/70 p-1 text-white"
                      aria-label="移除参考图"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <p className="truncate px-3 py-2 text-xs text-muted-foreground">{image.fileName}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                未上传参考图时，Agent 会只根据选题做文字规划。
              </div>
            )}
          </div>
          <Button type="button" onClick={handlePlan} disabled={loading} className="rounded-2xl">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {loading ? "正在做图文规划..." : "生成图文规划"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function XiaohongshuReviewStep() {
  const router = useRouter();
  const [draft, setDraft] = useState<XiaohongshuDraft>(createEmptyXiaohongshuDraft());
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const loaded = loadXiaohongshuDraft();
    if (loaded.plan) {
      loaded.plan.pages = loaded.plan.pages.map((page) => ({
        ...page,
        imagePrompt: page.imagePrompt || buildDefaultImagePrompt(loaded.plan as XiaohongshuPlan, page),
      }));
    }
    setDraft(loaded);
  }, []);

  if (!draft.plan) {
    return <EmptyState message="还没有文本规划，请先完成第一步。" actionHref="/xiaohongshu/plan" actionLabel="去规划" />;
  }

  const page = draft.plan.pages[selectedIndex];

  function updatePage(patch: Partial<XiaohongshuPlan["pages"][number]>) {
    if (!draft.plan) return;
    const nextPlan = {
      ...draft.plan,
      pages: draft.plan.pages.map((item, index) => (index === selectedIndex ? { ...item, ...patch } : item)),
    };
    setDraft({ ...draft, plan: nextPlan });
  }

  function handleSaveAndNext() {
    saveXiaohongshuDraft(draft);
    toast.success("提示词已保存。");
    router.push("/xiaohongshu/generate");
  }

  return (
    <div className="space-y-6">
      <FlowNav current="review" />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader>
            <CardTitle>2. 用户调整提示词</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PageSelector plan={draft.plan} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium">页面标题</span>
                <Textarea value={page.title} onChange={(event) => updatePage({ title: event.target.value })} />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">正文要点</span>
                <Textarea value={page.body} onChange={(event) => updatePage({ body: event.target.value })} />
              </label>
            </div>
            <label className="space-y-2 block">
              <span className="text-sm font-medium">图像生成提示词</span>
              <Textarea
                value={page.imagePrompt}
                onChange={(event) => updatePage({ imagePrompt: event.target.value })}
                className="min-h-[260px] font-mono text-sm leading-6"
              />
            </label>
            <label className="space-y-2 block">
              <span className="text-sm font-medium">负面约束</span>
              <Textarea
                value={page.negativePrompt}
                onChange={(event) => updatePage({ negativePrompt: event.target.value })}
                className="min-h-[90px]"
              />
            </label>
            <Button type="button" onClick={handleSaveAndNext} className="rounded-2xl">
              <Save className="mr-2 h-4 w-4" />
              保存并进入生成
            </Button>
          </CardContent>
        </Card>

        <Card className="xl:sticky xl:top-6 xl:self-start">
          <CardHeader>
            <CardTitle>手机预览</CardTitle>
          </CardHeader>
          <CardContent>
            <PhonePlanPreview plan={draft.plan} selectedIndex={selectedIndex} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function XiaohongshuGenerateStep() {
  const router = useRouter();
  const [draft, setDraft] = useState<XiaohongshuDraft>(createEmptyXiaohongshuDraft());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraft(loadXiaohongshuDraft());
  }, []);

  if (!draft.plan) {
    return <EmptyState message="还没有可生成的提示词，请先完成规划和调整。" actionHref="/xiaohongshu/plan" actionLabel="去规划" />;
  }

  const selectedImage = draft.images.find((item) => item.pageNumber === draft.plan?.pages[selectedIndex]?.pageNumber);

  async function handleGenerate() {
    if (!draft.plan) return;
    saveXiaohongshuDraft(draft);
    setLoading(true);
    try {
      const response = await fetch("/api/xiaohongshu/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: draft.plan,
          referenceImages: draft.referenceImages.map((image) => image.dataUrl),
        }),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "小红书图像生成失败");
      }
      const nextDraft = { ...draft, images: payload.data as XiaohongshuGeneratedImage[] };
      setDraft(nextDraft);
      saveXiaohongshuDraft(nextDraft);
      toast.success("图像生成完成，可以进入修改。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "小红书图像生成失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <FlowNav current="generate" />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader>
            <CardTitle>3. 图像生成</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <PageSelector plan={draft.plan} selectedIndex={selectedIndex} onSelect={setSelectedIndex} images={draft.images} />
            <div className="rounded-2xl border border-border bg-muted/40 p-4 text-sm leading-7 text-muted-foreground">
              将使用“图像生成模型”按每页提示词生成 3:4 小红书图文。生成前请确认第二步的提示词已经调整完毕。
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={handleGenerate} disabled={loading} className="rounded-2xl">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
                {loading ? "正在生成整组图片..." : draft.images.length > 0 ? "重新生成整组图片" : "生成整组图片"}
              </Button>
              <Link href="/xiaohongshu/edit" className={cn(buttonVariants({ variant: "secondary" }), "rounded-2xl")}>
                进入修改
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:sticky xl:top-6 xl:self-start">
          <CardHeader>
            <CardTitle>生成预览</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PhonePlanPreview plan={draft.plan} selectedIndex={selectedIndex} imageUrl={selectedImage?.imageUrl} />
            {selectedImage ? (
              <p className="text-xs leading-5 text-muted-foreground">模型：{selectedImage.model}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function XiaohongshuEditStep() {
  const [draft, setDraft] = useState<XiaohongshuDraft>(createEmptyXiaohongshuDraft());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editPrompt, setEditPrompt] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraft(loadXiaohongshuDraft());
  }, []);

  const selectedPage = draft.plan?.pages[selectedIndex] ?? null;
  const selectedImage = useMemo(
    () => draft.images.find((item) => item.pageNumber === selectedPage?.pageNumber) ?? null,
    [draft.images, selectedPage],
  );

  if (!draft.plan) {
    return <EmptyState message="还没有小红书图文规划。" actionHref="/xiaohongshu/plan" actionLabel="去规划" />;
  }

  if (draft.images.length === 0) {
    return <EmptyState message="还没有生成图片，请先完成第三步。" actionHref="/xiaohongshu/generate" actionLabel="去生成" />;
  }

  async function handleEdit() {
    if (!selectedImage || !selectedPage) return;
    if (editPrompt.trim().length < 2) {
      toast.error("请写清楚你想修改哪里。");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/xiaohongshu/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: selectedImage.imageUrl,
          prompt: editPrompt,
          page: selectedPage,
        }),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "图片修改失败");
      }
      const nextImages = draft.images.map((image) =>
        image.pageNumber === selectedImage.pageNumber
          ? {
              ...image,
              imageUrl: payload.data.imageUrl,
              model: payload.data.model,
              revisedPrompt: payload.data.revisedPrompt,
              updatedAt: payload.data.updatedAt,
            }
          : image,
      );
      const nextDraft = { ...draft, images: nextImages };
      setDraft(nextDraft);
      saveXiaohongshuDraft(nextDraft);
      toast.success("当前页已修改。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片修改失败");
    } finally {
      setLoading(false);
    }
  }

  function handleExport() {
    if (!draft.plan) return;
    const plan = draft.plan;
    downloadTextFile(
      "xiaohongshu-final.json",
      JSON.stringify({ plan, images: draft.images }, null, 2),
      "application/json;charset=utf-8",
    );
    downloadTextFile("xiaohongshu-final.md", buildXiaohongshuMarkdown(plan), "text/markdown;charset=utf-8");
  }

  return (
    <div className="space-y-6">
      <FlowNav current="edit" />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader>
            <CardTitle>4. 用户修改不满意的地方</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <PageSelector plan={draft.plan} selectedIndex={selectedIndex} onSelect={setSelectedIndex} images={draft.images} />
            <Textarea
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              placeholder="例如：第 2 页标题太靠边，改成上方居中；背景更干净一点；保留主体，不要改动产品结构。"
              className="min-h-[150px] text-base leading-7"
            />
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={handleEdit} disabled={loading || !selectedImage} className="rounded-2xl">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PenLine className="mr-2 h-4 w-4" />}
                {loading ? "正在修改当前页..." : "修改当前页"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditPrompt("")} className="rounded-2xl">
                <RefreshCw className="mr-2 h-4 w-4" />
                清空修改意见
              </Button>
              <Button type="button" variant="secondary" onClick={handleExport} className="rounded-2xl">
                <Download className="mr-2 h-4 w-4" />
                一键导出
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:sticky xl:top-6 xl:self-start">
          <CardHeader>
            <CardTitle>当前页</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PhonePlanPreview plan={draft.plan} selectedIndex={selectedIndex} imageUrl={selectedImage?.imageUrl} />
            <p className="text-sm font-medium">{selectedPage?.title}</p>
            <p className="text-xs leading-5 text-muted-foreground">模型：{selectedImage?.model ?? "未生成"}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
