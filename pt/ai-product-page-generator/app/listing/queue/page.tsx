import { ListingQueueWorkspace } from "@/components/projects/listing-queue-workspace";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingQueuePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="等待队列"
        description="查看主图重新生成、Ozon 上传、等待任务与失败记录。"
      />
      <ListingQueueWorkspace />
    </div>
  );
}
