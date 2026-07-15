CREATE TABLE "ListingWorkflowItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "stage" TEXT NOT NULL DEFAULT 'COLLECTED',
  "status" TEXT NOT NULL DEFAULT 'READY',
  "sourceUrl" TEXT,
  "sourcePlatform" TEXT,
  "title" TEXT NOT NULL,
  "offerId" TEXT NOT NULL,
  "imageUrl" TEXT,
  "currentPrice" TEXT,
  "oldPrice" TEXT,
  "minPrice" TEXT,
  "costPrice" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "categoryId" TEXT,
  "categoryLabel" TEXT,
  "categoryPath" JSONB,
  "scrapedData" JSONB NOT NULL,
  "features" JSONB,
  "aiResponse" JSONB,
  "notes" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ListingWorkflowItem_offerId_key"
ON "ListingWorkflowItem"("offerId");

CREATE INDEX "ListingWorkflowItem_stage_updatedAt_idx"
ON "ListingWorkflowItem"("stage", "updatedAt");

CREATE INDEX "ListingWorkflowItem_status_updatedAt_idx"
ON "ListingWorkflowItem"("status", "updatedAt");

CREATE INDEX "ListingWorkflowItem_categoryId_idx"
ON "ListingWorkflowItem"("categoryId");
