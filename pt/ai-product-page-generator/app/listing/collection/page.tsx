import { ListingStageWorkspace } from "@/components/projects/listing-stage-workspace";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingCollectionPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="采集阶段"
        description="采集阶段只保存商品信息；先选择主图、待翻译图片和 SKU，点击开始加工后再按所选 Skill 模式发送给 AI。"
      />
      <ListingStageWorkspace stage="COLLECTED" />
    </div>
  );
}
