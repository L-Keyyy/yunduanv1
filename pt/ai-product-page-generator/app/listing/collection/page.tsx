import { ListingStageWorkspace } from "@/components/projects/listing-stage-workspace";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingCollectionPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="采集阶段"
        description="集中查看已抓取的商品卡，校对图片、货号和价格后送入加工阶段。"
      />
      <ListingStageWorkspace stage="COLLECTED" />
    </div>
  );
}
