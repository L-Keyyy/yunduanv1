#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const floor = Math.max(0.01, Number(process.argv[2] || 15));
const auditPath = path.resolve(
  process.argv[3] || "storage/listing-workflow-price-floor-audit.json",
);

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function repairFeatures(value) {
  if (!Array.isArray(value)) return value;
  return value.map((feature) => {
    if (!feature || typeof feature !== "object") return feature;
    const id = String(feature.attributeId || "").replace(/^base:/, "");
    if (id === "price" && numeric(feature.value) < floor) {
      return { ...feature, value: floor.toFixed(2) };
    }
    if (id === "min_price" && numeric(feature.value) < floor) {
      return { ...feature, value: floor.toFixed(2) };
    }
    return feature;
  });
}

try {
  const items = await prisma.listingWorkflowItem.findMany({
    orderBy: { updatedAt: "asc" },
  });
  const targets = items.filter((item) =>
    numeric(item.currentPrice) > 0 && numeric(item.currentPrice) < floor,
  );
  const rows = [];
  for (const item of targets) {
    const before = {
      currentPrice: item.currentPrice,
      oldPrice: item.oldPrice,
      minPrice: item.minPrice,
    };
    const oldPrice = numeric(item.oldPrice);
    const targetOldPrice = oldPrice > 0 && oldPrice <= floor
      ? (floor + 20.01).toFixed(2)
      : item.oldPrice;
    const updated = await prisma.listingWorkflowItem.update({
      where: { id: item.id },
      data: {
        currentPrice: floor.toFixed(2),
        minPrice: floor.toFixed(2),
        oldPrice: targetOldPrice,
        features: item.features === null ? undefined : repairFeatures(item.features),
      },
      select: {
        id: true,
        offerId: true,
        currentPrice: true,
        oldPrice: true,
        minPrice: true,
      },
    });
    rows.push({ before, after: updated });
  }
  const remaining = await prisma.listingWorkflowItem.findMany({
    select: { id: true, offerId: true, currentPrice: true },
  }).then((all) => all.filter((item) =>
    numeric(item.currentPrice) > 0 && numeric(item.currentPrice) < floor,
  ));
  const audit = {
    completedAt: new Date().toISOString(),
    floor,
    scanned: items.length,
    updated: rows.length,
    remainingBelowFloor: remaining.length,
    rows,
  };
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    completedAt: audit.completedAt,
    floor,
    scanned: audit.scanned,
    updated: audit.updated,
    remainingBelowFloor: audit.remainingBelowFloor,
    auditPath,
  }, null, 2));
  if (remaining.length) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
