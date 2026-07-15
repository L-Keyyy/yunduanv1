import { ListingStageWorkspace } from "@/components/projects/listing-stage-workspace";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingProcessingPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="加工阶段"
        description="主图生图、Ozon 特征匹配、选中图片图集翻译并行执行，完成后进入全屏编辑复核。"
      />
      <ListingStageWorkspace stage="PROCESSING" />
    </div>
  );
}
