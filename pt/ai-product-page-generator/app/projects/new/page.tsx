import { Suspense } from "react";

import { ProjectCreator } from "@/components/projects/project-creator";
import { PageHeader } from "@/components/shared/page-header";

export default function NewProjectPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="主页面 · Ozon 上架"
        title="链接到上架工作流"
        description="从淘宝、京东、1688 商品链接开始，完成商品数据采集、AI 特征匹配、图片处理和 Ozon 上传。"
      />
      <Suspense fallback={<div className="rounded-3xl border bg-white/70 p-6 text-sm text-slate-500">正在载入电商工作流...</div>}>
        <ProjectCreator />
      </Suspense>
    </div>
  );
}
