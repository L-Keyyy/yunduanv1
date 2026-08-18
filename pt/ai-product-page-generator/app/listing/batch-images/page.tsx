import { ImageBatchCenter } from "@/components/projects/image-batch-center";
import { PageHeader } from "@/components/shared/page-header";

export const dynamic = "force-dynamic";

export default function ListingBatchImagesPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="商品工作流"
        title="批量图片队列"
        description="按商品拆分图片任务，豆包浏览器按固定并发逐张处理；任务状态和结果持久化，页面刷新后继续执行。"
      />
      <ImageBatchCenter />
    </div>
  );
}
