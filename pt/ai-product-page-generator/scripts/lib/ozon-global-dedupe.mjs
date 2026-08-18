function numericStoreNumber(name) {
  return Number(String(name || "").match(/店铺\s*(\d+)/)?.[1] || 0);
}

export function storePriority(name) {
  if (String(name || "").trim() === "Ozon Seller API") return 0;
  const number = numericStoreNumber(name);
  return number > 0 ? number - 1 : 10_000;
}

export function chooseGlobalKeepers(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.identityKey || row.isArchived) continue;
    const group = groups.get(row.identityKey) || [];
    group.push(row);
    groups.set(row.identityKey, group);
  }

  const keep = [];
  const archive = [];
  const duplicateGroups = [];
  for (const [identityKey, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((left, right) =>
      storePriority(left.storeName) - storePriority(right.storeName)
      || Number(right.isCreated) - Number(left.isCreated)
      || Number(left.errorCount || 0) - Number(right.errorCount || 0)
      || Number(right.imageCount || 0) - Number(left.imageCount || 0)
      || String(left.offerId).localeCompare(String(right.offerId)),
    );
    const winner = sorted[0];
    keep.push(winner);
    archive.push(...sorted.slice(1));
    duplicateGroups.push({
      identityKey,
      kept: winner,
      removed: sorted.slice(1),
    });
  }
  return { keep, archive, duplicateGroups };
}

