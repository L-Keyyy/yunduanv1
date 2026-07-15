import { ListingStageWorkspace } from "@/components/projects/listing-stage-workspace";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingCollectionPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="采集阶段"
        description="采集链接时同步完成 AI 类目匹配；确认 SKU 和待翻译图片后启动三线加工。"
      />
      <ListingStageWorkspace stage="COLLECTED" />
    </div>
  );
}
