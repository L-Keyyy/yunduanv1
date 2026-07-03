import { OzonFeatureMapper } from "@/components/ozon/ozon-feature-mapper";
import { getOzonFeatureSnapshot } from "@/lib/ozon/snapshot";

export const dynamic = "force-dynamic";

export default async function OzonFeaturesPage() {
  const snapshot = await getOzonFeatureSnapshot();
  return <OzonFeatureMapper initialSnapshot={snapshot} />;
}
