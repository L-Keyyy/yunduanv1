-- CreateTable
CREATE TABLE "OzonSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "language" TEXT NOT NULL DEFAULT 'DEFAULT',
    "categoriesSynced" INTEGER NOT NULL DEFAULT 0,
    "attributesSynced" INTEGER NOT NULL DEFAULT 0,
    "valuesSynced" INTEGER NOT NULL DEFAULT 0,
    "inputPayload" JSONB,
    "outputPayload" JSONB,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OzonCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKey" TEXT NOT NULL,
    "descriptionCategoryId" INTEGER,
    "typeId" INTEGER,
    "label" TEXT NOT NULL,
    "categoryName" TEXT,
    "typeName" TEXT,
    "path" JSONB NOT NULL,
    "parentSourceKey" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "isLeaf" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OzonAttribute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "ozonAttributeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT,
    "groupId" TEXT,
    "groupName" TEXT,
    "dictionaryId" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isCollection" BOOLEAN NOT NULL DEFAULT false,
    "isAspect" BOOLEAN NOT NULL DEFAULT false,
    "maxValueCount" INTEGER,
    "categoryDependent" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OzonAttribute_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "OzonCategory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OzonAttributeValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attributeId" TEXT NOT NULL,
    "ozonValueId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "info" TEXT,
    "picture" TEXT,
    "raw" JSONB,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OzonAttributeValue_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "OzonAttribute" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OzonSyncRun_action_createdAt_idx" ON "OzonSyncRun"("action", "createdAt");

-- CreateIndex
CREATE INDEX "OzonSyncRun_status_createdAt_idx" ON "OzonSyncRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OzonCategory_sourceKey_key" ON "OzonCategory"("sourceKey");

-- CreateIndex
CREATE INDEX "OzonCategory_descriptionCategoryId_typeId_idx" ON "OzonCategory"("descriptionCategoryId", "typeId");

-- CreateIndex
CREATE INDEX "OzonCategory_label_idx" ON "OzonCategory"("label");

-- CreateIndex
CREATE INDEX "OzonCategory_parentSourceKey_idx" ON "OzonCategory"("parentSourceKey");

-- CreateIndex
CREATE INDEX "OzonCategory_isLeaf_disabled_idx" ON "OzonCategory"("isLeaf", "disabled");

-- CreateIndex
CREATE UNIQUE INDEX "OzonAttribute_categoryId_ozonAttributeId_key" ON "OzonAttribute"("categoryId", "ozonAttributeId");

-- CreateIndex
CREATE INDEX "OzonAttribute_categoryId_isRequired_idx" ON "OzonAttribute"("categoryId", "isRequired");

-- CreateIndex
CREATE INDEX "OzonAttribute_dictionaryId_idx" ON "OzonAttribute"("dictionaryId");

-- CreateIndex
CREATE INDEX "OzonAttribute_groupName_idx" ON "OzonAttribute"("groupName");

-- CreateIndex
CREATE UNIQUE INDEX "OzonAttributeValue_attributeId_ozonValueId_key" ON "OzonAttributeValue"("attributeId", "ozonValueId");

-- CreateIndex
CREATE INDEX "OzonAttributeValue_attributeId_idx" ON "OzonAttributeValue"("attributeId");

-- CreateIndex
CREATE INDEX "OzonAttributeValue_value_idx" ON "OzonAttributeValue"("value");
