ALTER TABLE "OzonAttributeValue" ADD COLUMN "valueZh" TEXT;

CREATE INDEX "OzonAttributeValue_valueZh_idx" ON "OzonAttributeValue"("valueZh");
