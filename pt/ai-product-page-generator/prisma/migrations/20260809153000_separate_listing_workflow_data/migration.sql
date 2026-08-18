ALTER TABLE "ListingWorkflowItem" ADD COLUMN "workflowData" JSONB;

UPDATE "ListingWorkflowItem"
SET "workflowData" = json_patch(
  json_patch(
    json_patch(
      json_patch(
        json_patch(
          '{}',
          CASE WHEN json_type("scrapedData", '$.workflowImages') IS NOT NULL
            THEN json_object('workflowImages', json_extract("scrapedData", '$.workflowImages'))
            ELSE '{}' END
        ),
        CASE WHEN json_type("scrapedData", '$.imageWorkflow') IS NOT NULL
          THEN json_object('imageWorkflow', json_extract("scrapedData", '$.imageWorkflow'))
          ELSE '{}' END
      ),
      CASE WHEN json_type("scrapedData", '$.skuFeatureDrafts') IS NOT NULL
        THEN json_object('skuFeatureDrafts', json_extract("scrapedData", '$.skuFeatureDrafts'))
        ELSE '{}' END
    ),
    CASE WHEN json_type("scrapedData", '$.skuSelection') IS NOT NULL
      THEN json_object('skuSelection', json_extract("scrapedData", '$.skuSelection'))
      ELSE '{}' END
  ),
  CASE WHEN json_type("scrapedData", '$.ozonPublish') IS NOT NULL
    THEN json_object('ozonPublish', json_extract("scrapedData", '$.ozonPublish'))
    ELSE '{}' END
)
WHERE
  json_type("scrapedData", '$.workflowImages') IS NOT NULL OR
  json_type("scrapedData", '$.imageWorkflow') IS NOT NULL OR
  json_type("scrapedData", '$.skuFeatureDrafts') IS NOT NULL OR
  json_type("scrapedData", '$.skuSelection') IS NOT NULL OR
  json_type("scrapedData", '$.ozonPublish') IS NOT NULL;

UPDATE "ListingWorkflowItem"
SET "scrapedData" = json_remove(
  "scrapedData",
  '$.stageAiPrompts',
  '$.collectionSourceImages',
  '$.workflowImages',
  '$.imageWorkflow',
  '$.skuFeatureDrafts',
  '$.skuFeatureDraftsUpdatedAt',
  '$.skuSelection',
  '$.ozonPublish',
  '$.petToyBatch',
  '$.featureFill',
  '$.featureFillMode',
  '$.imageGeneration',
  '$.quickMode',
  '$.promptAudit',
  '$.selectedVariant',
  '$.collectionRepair',
  '$.extensionCard.detailFetch',
  '$.extensionCard.collectedAt',
  '$.extensionCard.captureMode',
  '$.detailCapture.fetched',
  '$.detailCapture.captureMode'
);
