import { ListingStageWorkspace } from "@/components/projects/listing-stage-workspace";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingProcessingPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="加工阶段"
        description="查看等待 AI 匹配或已经生成 Ozon 类目特征的商品，并进入全屏编辑核对 value。"
      />
      <ListingStageWorkspace stage="PROCESSING" />
    </div>
  );
}
