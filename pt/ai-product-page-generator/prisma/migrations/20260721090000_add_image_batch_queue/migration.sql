CREATE TABLE "ImageBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "providerId" TEXT,
  "model" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "aspectRatio" TEXT NOT NULL DEFAULT '1:1',
  "requestOrigin" TEXT NOT NULL DEFAULT 'http://127.0.0.1:3000',
  "maxConcurrency" INTEGER NOT NULL DEFAULT 2,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "totalProducts" INTEGER NOT NULL DEFAULT 0,
  "totalTasks" INTEGER NOT NULL DEFAULT 0,
  "succeededTasks" INTEGER NOT NULL DEFAULT 0,
  "failedTasks" INTEGER NOT NULL DEFAULT 0,
  "settings" JSONB,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ImageBatchProduct" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batchId" TEXT NOT NULL,
  "listingWorkflowItemId" TEXT,
  "offerId" TEXT,
  "title" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "sourceImageUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "totalTasks" INTEGER NOT NULL DEFAULT 0,
  "succeededTasks" INTEGER NOT NULL DEFAULT 0,
  "failedTasks" INTEGER NOT NULL DEFAULT 0,
  "inputPayload" JSONB,
  "outputPayload" JSONB,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageBatchProduct_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImageBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ImageBatchProduct_listingWorkflowItemId_fkey" FOREIGN KEY ("listingWorkflowItemId") REFERENCES "ListingWorkflowItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ImageQueueTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productTaskId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'GENERATE_MAIN',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "providerId" TEXT,
  "model" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "aspectRatio" TEXT NOT NULL DEFAULT '1:1',
  "sourceImageUrl" TEXT,
  "referenceImages" JSONB NOT NULL,
  "resultImageUrl" TEXT,
  "resultFilePath" TEXT,
  "resultPayload" JSONB,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" DATETIME,
  "heartbeatAt" DATETIME,
  "workerId" TEXT,
  "errorMessage" TEXT,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageQueueTask_productTaskId_fkey" FOREIGN KEY ("productTaskId") REFERENCES "ImageBatchProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ImageBatch_status_createdAt_idx" ON "ImageBatch"("status", "createdAt");
CREATE INDEX "ImageBatchProduct_batchId_status_idx" ON "ImageBatchProduct"("batchId", "status");
CREATE INDEX "ImageBatchProduct_listingWorkflowItemId_idx" ON "ImageBatchProduct"("listingWorkflowItemId");
CREATE INDEX "ImageBatchProduct_offerId_idx" ON "ImageBatchProduct"("offerId");
CREATE INDEX "ImageQueueTask_status_availableAt_priority_idx" ON "ImageQueueTask"("status", "availableAt", "priority");
CREATE INDEX "ImageQueueTask_productTaskId_status_idx" ON "ImageQueueTask"("productTaskId", "status");
CREATE INDEX "ImageQueueTask_workerId_lockedAt_idx" ON "ImageQueueTask"("workerId", "lockedAt");
