ALTER TABLE "OzonAttribute" ADD COLUMN "nameZh" TEXT;

CREATE INDEX "OzonAttribute_nameZh_idx" ON "OzonAttribute"("nameZh");
