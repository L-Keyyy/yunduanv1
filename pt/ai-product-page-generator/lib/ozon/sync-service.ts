import { access, readdir, readFile } from "fs/promises";
import path from "path";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { ozonSellerRequest } from "@/lib/ozon/client";
import { env } from "@/lib/utils/env";

type UnknownRecord = Record<string, unknown>;

type FlattenedCategory = {
  sourceKey: string;
  descriptionCategoryId: number | null;
  typeId: number | null;
  label: string;
  categoryName: string | null;
  typeName: string | null;
  path: string[];
  parentSourceKey: string | null;
  depth: number;
  isLeaf: boolean;
  disabled: boolean;
  raw: UnknownRecord;
};

type AttributeSyncOptions = {
  categoryRecordId: string;
  includeValues?: boolean;
  language?: string;
  maxValuesPerAttribute?: number;
};

type AttributeValueSearchOptions = {
  categoryRecordId: string;
  attributeRecordId?: string;
  ozonAttributeId?: string;
  value: string;
  language?: string;
  limit?: number;
};

export class OzonHdCacheMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OzonHdCacheMissingError";
  }
}

export type OzonHdCacheState = {
  candidates: string[];
  cacheDir: string | null;
  categoryTreeExists: boolean;
  attributeCacheFiles: number;
  dictionaryCacheFiles: number;
};

function toRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringFrom(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function nullableStringFrom(value: unknown) {
  const text = stringFrom(value);
  return text ? text : null;
}

function numberFrom(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanFrom(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "yes"].includes(value.toLowerCase());
  return false;
}

function uniqueList(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getOzonHdCacheCandidates() {
  return uniqueList([
    env.OZON_HD_CACHE_DIR ? path.resolve(env.OZON_HD_CACHE_DIR) : "",
    path.resolve(process.cwd(), "../../OZON_HD/cache"),
    path.resolve(process.cwd(), "../OZON_HD/cache"),
    path.resolve(process.cwd(), "OZON_HD/cache"),
    path.resolve(process.cwd(), "cache"),
    path.resolve(process.cwd(), "../../cache"),
  ]);
}

async function resolveOzonHdCacheDir() {
  for (const candidate of getOzonHdCacheCandidates()) {
    if (await pathExists(path.join(candidate, "category_tree.json"))) {
      return candidate;
    }
  }

  return null;
}

async function readJsonFile(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
}

export async function getOzonHdCacheState(): Promise<OzonHdCacheState> {
  const candidates = getOzonHdCacheCandidates();
  const cacheDir = await resolveOzonHdCacheDir();

  if (!cacheDir) {
    return {
      candidates,
      cacheDir: null,
      categoryTreeExists: false,
      attributeCacheFiles: 0,
      dictionaryCacheFiles: 0,
    };
  }

  const files = await readdir(cacheDir);
  return {
    candidates,
    cacheDir,
    categoryTreeExists: files.includes("category_tree.json"),
    attributeCacheFiles: files.filter((file) => /^attrs_\d+_\d+\.json$/.test(file)).length,
    dictionaryCacheFiles: files.filter((file) => /^dict_\d+_\d+_\d+\.json$/.test(file)).length,
  };
}

function resultArray(payload: unknown) {
  const record = toRecord(payload);
  const result = record.result;
  if (Array.isArray(result)) return result;

  const resultRecord = toRecord(result);
  for (const key of ["items", "values", "categories", "attributes"]) {
    const candidate = resultRecord[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function childrenFrom(record: UnknownRecord) {
  for (const key of ["children", "childs", "items", "categories"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function buildCategorySourceKey(params: { descriptionCategoryId: number | null; typeId: number | null; fallbackKey: string }) {
  const { descriptionCategoryId, typeId, fallbackKey } = params;
  if (descriptionCategoryId !== null && typeId !== null) {
    return `description:${descriptionCategoryId}:type:${typeId}`;
  }

  if (descriptionCategoryId !== null) {
    return `description:${descriptionCategoryId}:category`;
  }

  if (typeId !== null) {
    return `type:${typeId}`;
  }

  return `node:${fallbackKey}`;
}

function flattenCategoryTree(nodes: unknown[], parent: FlattenedCategory | null = null, path: string[] = []): FlattenedCategory[] {
  return nodes.flatMap((node, index) => {
    const record = toRecord(node);
    const ownDescriptionCategoryId = numberFrom(record.description_category_id ?? record.descriptionCategoryId ?? record.category_id);
    const descriptionCategoryId = ownDescriptionCategoryId ?? parent?.descriptionCategoryId ?? null;
    const typeId = numberFrom(record.type_id ?? record.typeId);
    const sourceKey = buildCategorySourceKey({
      descriptionCategoryId,
      typeId,
      fallbackKey: `${parent?.sourceKey ?? "root"}:${index}`,
    });
    const categoryName = nullableStringFrom(record.category_name ?? record.categoryName ?? record.name) ?? parent?.categoryName ?? null;
    const typeName = nullableStringFrom(record.type_name ?? record.typeName);
    const label = typeName ?? categoryName ?? sourceKey;
    const children = childrenFrom(record);
    const currentPath = [...path, label];
    const current: FlattenedCategory = {
      sourceKey,
      descriptionCategoryId,
      typeId,
      label,
      categoryName,
      typeName,
      path: currentPath,
      parentSourceKey: parent?.sourceKey ?? null,
      depth: currentPath.length - 1,
      isLeaf: children.length === 0,
      disabled: booleanFrom(record.disabled ?? record.is_disabled ?? record.isDisabled),
      raw: record,
    };

    return [current, ...flattenCategoryTree(children, current, currentPath)];
  });
}

function readHasNext(payload: unknown) {
  const record = toRecord(payload);
  if (typeof record.has_next !== "undefined") return booleanFrom(record.has_next);
  if (typeof record.hasNext !== "undefined") return booleanFrom(record.hasNext);

  const result = toRecord(record.result);
  if (typeof result.has_next !== "undefined") return booleanFrom(result.has_next);
  if (typeof result.hasNext !== "undefined") return booleanFrom(result.hasNext);

  return false;
}

function isMissingDictionaryError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /dictionary not found|CacheService\.GetDictionariesByIDs|notfound/i.test(error.message);
}

async function upsertOzonCategories(categories: FlattenedCategory[]) {
  const now = new Date();

  for (const category of categories) {
    if (category.descriptionCategoryId !== null && category.typeId !== null) {
      const hasCurrentKey = await prisma.ozonCategory.findUnique({
        where: { sourceKey: category.sourceKey },
        select: { id: true },
      });

      if (!hasCurrentKey) {
        await prisma.ozonCategory.updateMany({
          where: {
            sourceKey: `type:${category.typeId}`,
            descriptionCategoryId: null,
          },
          data: { sourceKey: category.sourceKey },
        });
      }
    }

    await prisma.ozonCategory.upsert({
      where: { sourceKey: category.sourceKey },
      create: {
        sourceKey: category.sourceKey,
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
        label: category.label,
        categoryName: category.categoryName,
        typeName: category.typeName,
        path: toJson(category.path),
        parentSourceKey: category.parentSourceKey,
        depth: category.depth,
        isLeaf: category.isLeaf,
        disabled: category.disabled,
        raw: toJson(category.raw),
        syncedAt: now,
      },
      update: {
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
        label: category.label,
        categoryName: category.categoryName,
        typeName: category.typeName,
        path: toJson(category.path),
        parentSourceKey: category.parentSourceKey,
        depth: category.depth,
        isLeaf: category.isLeaf,
        disabled: category.disabled,
        raw: toJson(category.raw),
        syncedAt: now,
      },
    });
  }

  return categories.length;
}

async function upsertOzonAttributeRecord(params: {
  categoryId: string;
  record: UnknownRecord;
  language?: string;
  now?: Date;
}) {
  const ozonAttributeId = stringFrom(params.record.id ?? params.record.attribute_id ?? params.record.attributeId);
  const name = stringFrom(params.record.name);
  if (!ozonAttributeId || !name) return null;
  const now = params.now ?? new Date();
  const isChinese = params.language === "ZH_HANS";
  const originalAttribute = isChinese
    ? await prisma.ozonAttribute.findUnique({
        where: {
          categoryId_ozonAttributeId: {
            categoryId: params.categoryId,
            ozonAttributeId,
          },
        },
        select: { name: true },
      })
    : null;

  const attribute = await prisma.ozonAttribute.upsert({
    where: {
      categoryId_ozonAttributeId: {
        categoryId: params.categoryId,
        ozonAttributeId,
      },
    },
    create: {
      categoryId: params.categoryId,
      ozonAttributeId,
      name,
      nameZh: isChinese ? name : null,
      description: nullableStringFrom(params.record.description),
      type: nullableStringFrom(params.record.type ?? params.record.value_type ?? params.record.valueType),
      groupId: nullableStringFrom(params.record.group_id ?? params.record.groupId),
      groupName: nullableStringFrom(params.record.group_name ?? params.record.groupName),
      dictionaryId: nullableStringFrom(params.record.dictionary_id ?? params.record.dictionaryId),
      isRequired: booleanFrom(params.record.is_required ?? params.record.isRequired),
      isCollection: booleanFrom(params.record.is_collection ?? params.record.isCollection),
      isAspect: booleanFrom(params.record.is_aspect ?? params.record.isAspect),
      maxValueCount: numberFrom(params.record.max_value_count ?? params.record.maxValueCount),
      categoryDependent: booleanFrom(params.record.category_dependent ?? params.record.categoryDependent),
      raw: toJson(params.record),
      syncedAt: now,
    },
    update: {
      ...(isChinese
        ? { nameZh: name }
        : {
            name,
            description: nullableStringFrom(params.record.description),
            groupName: nullableStringFrom(
              params.record.group_name ?? params.record.groupName,
            ),
            raw: toJson(params.record),
          }),
      type: nullableStringFrom(params.record.type ?? params.record.value_type ?? params.record.valueType),
      groupId: nullableStringFrom(params.record.group_id ?? params.record.groupId),
      dictionaryId: nullableStringFrom(params.record.dictionary_id ?? params.record.dictionaryId),
      isRequired: booleanFrom(params.record.is_required ?? params.record.isRequired),
      isCollection: booleanFrom(params.record.is_collection ?? params.record.isCollection),
      isAspect: booleanFrom(params.record.is_aspect ?? params.record.isAspect),
      maxValueCount: numberFrom(params.record.max_value_count ?? params.record.maxValueCount),
      categoryDependent: booleanFrom(params.record.category_dependent ?? params.record.categoryDependent),
      syncedAt: now,
    },
  });

  if (isChinese) {
    await prisma.ozonAttribute.updateMany({
      where: {
        nameZh: null,
        OR: [
          { ozonAttributeId },
          ...(originalAttribute?.name
            ? [{ name: originalAttribute.name }]
            : []),
        ],
      },
      data: { nameZh: name },
    });
  }

  return attribute;
}

async function upsertOzonAttributeValueRecord(params: {
  attributeId: string;
  record: UnknownRecord;
  language?: string;
  now?: Date;
}) {
  const ozonValueId = stringFrom(params.record.id ?? params.record.value_id ?? params.record.valueId);
  const text = stringFrom(params.record.value ?? params.record.name);
  if (!ozonValueId || !text) return false;
  const now = params.now ?? new Date();
  const isChinese = params.language === "ZH_HANS";

  await prisma.ozonAttributeValue.upsert({
    where: {
      attributeId_ozonValueId: {
        attributeId: params.attributeId,
        ozonValueId,
      },
    },
    create: {
      attributeId: params.attributeId,
      ozonValueId,
      value: text,
      valueZh: isChinese ? text : null,
      info: nullableStringFrom(params.record.info),
      picture: nullableStringFrom(params.record.picture),
      raw: toJson(params.record),
      syncedAt: now,
    },
    update: {
      ...(isChinese ? { valueZh: text } : { value: text }),
      info: nullableStringFrom(params.record.info),
      picture: nullableStringFrom(params.record.picture),
      raw: toJson(params.record),
      syncedAt: now,
    },
  });

  return true;
}

export async function syncOzonCategoryTree(language = "DEFAULT") {
  const run = await prisma.ozonSyncRun.create({
    data: {
      action: "category_tree",
      status: "RUNNING",
      language,
      inputPayload: toJson({ endpoint: "/v1/description-category/tree", language }),
    },
  });

  try {
    const payload = await ozonSellerRequest<UnknownRecord>("/v1/description-category/tree", { language });
    const categories = flattenCategoryTree(resultArray(payload));
    const categoriesSynced = await upsertOzonCategories(categories);

    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        categoriesSynced,
        completedAt: new Date(),
        outputPayload: toJson({ categoriesSynced }),
      },
    });

    return { runId: run.id, categoriesSynced };
  } catch (error) {
    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "未知 Ozon 同步错误",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

export async function importOzonHdCache(options: { includeAttributes?: boolean; includeValues?: boolean } = {}) {
  const includeAttributes = options.includeAttributes ?? true;
  const includeValues = options.includeValues ?? true;
  const cacheState = await getOzonHdCacheState();

  if (!cacheState.cacheDir || !cacheState.categoryTreeExists) {
    throw new OzonHdCacheMissingError(`没有找到跟卖体系类目缓存 category_tree.json。已检查：${cacheState.candidates.join(" | ")}`);
  }

  const run = await prisma.ozonSyncRun.create({
    data: {
      action: "ozon_hd_cache_import",
      status: "RUNNING",
      language: "LOCAL_CACHE",
      inputPayload: toJson({
        cacheDir: cacheState.cacheDir,
        includeAttributes,
        includeValues,
      }),
    },
  });

  try {
    const treePayload = await readJsonFile(path.join(cacheState.cacheDir, "category_tree.json"));
    const categories = flattenCategoryTree(resultArray(treePayload));
    const categoriesSynced = await upsertOzonCategories(categories);
    let attributesSynced = 0;
    let valuesSynced = 0;

    if (includeAttributes) {
      const files = await readdir(cacheState.cacheDir);
      const attributeFiles = files.filter((file) => /^attrs_\d+_\d+\.json$/.test(file));

      for (const file of attributeFiles) {
        const match = /^attrs_(\d+)_(\d+)\.json$/.exec(file);
        if (!match) continue;
        const descriptionCategoryId = Number(match[1]);
        const typeId = Number(match[2]);
        const category = await prisma.ozonCategory.findFirst({
          where: { descriptionCategoryId, typeId },
        });
        if (!category) continue;

        const attrsPayload = await readJsonFile(path.join(cacheState.cacheDir, file));
        const attrs = resultArray(attrsPayload);
        const now = new Date();

        for (const attr of attrs) {
          const record = toRecord(attr);
          const ozonAttributeId = stringFrom(record.id ?? record.attribute_id ?? record.attributeId);
          const syncedAttribute = await upsertOzonAttributeRecord({
            categoryId: category.id,
            record,
            language: "DEFAULT",
            now,
          });
          if (!ozonAttributeId || !syncedAttribute) continue;

          attributesSynced += 1;

          if (!includeValues) continue;
          const dictPath = path.join(cacheState.cacheDir, `dict_${ozonAttributeId}_${descriptionCategoryId}_${typeId}.json`);
          if (!(await pathExists(dictPath))) continue;

          const valuesPayload = await readJsonFile(dictPath);
          for (const value of resultArray(valuesPayload)) {
            const didSync = await upsertOzonAttributeValueRecord({
              attributeId: syncedAttribute.id,
              record: toRecord(value),
              now,
            });
            if (didSync) valuesSynced += 1;
          }
        }
      }
    }

    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        categoriesSynced,
        attributesSynced,
        valuesSynced,
        completedAt: new Date(),
        outputPayload: toJson({
          cacheDir: cacheState.cacheDir,
          categoriesSynced,
          attributesSynced,
          valuesSynced,
        }),
      },
    });

    return {
      runId: run.id,
      cacheDir: cacheState.cacheDir,
      categoriesSynced,
      attributesSynced,
      valuesSynced,
    };
  } catch (error) {
    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "未知跟卖缓存导入错误",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

async function syncAttributeValues(params: {
  categoryId: string;
  descriptionCategoryId: number;
  typeId: number;
  ozonAttributeId: string;
  language: string;
  maxValues: number;
}) {
  let synced = 0;
  let lastValueId = "0";
  let hasNext = true;
  const now = new Date();

  while (hasNext && synced < params.maxValues) {
    const limit = Math.min(1000, params.maxValues - synced);
    const payload = await ozonSellerRequest<UnknownRecord>("/v1/description-category/attribute/values", {
      description_category_id: params.descriptionCategoryId,
      type_id: params.typeId,
      attribute_id: Number(params.ozonAttributeId),
      language: params.language,
      limit,
      last_value_id: Number(lastValueId),
    });
    const values = resultArray(payload);
    hasNext = readHasNext(payload) && values.length > 0;

    for (const value of values) {
      const record = toRecord(value);
      const didSync = await upsertOzonAttributeValueRecord({
        attributeId: params.categoryId,
        record,
        language: params.language,
        now,
      });
      if (!didSync) continue;

      synced += 1;
      lastValueId = stringFrom(record.id ?? record.value_id ?? record.valueId);
      if (synced >= params.maxValues) break;
    }
  }

  return synced;
}

export async function syncOzonCategoryAttributes(options: AttributeSyncOptions) {
  const language = options.language ?? "DEFAULT";
  const includeValues = options.includeValues ?? true;
  const maxValuesPerAttribute = options.maxValuesPerAttribute ?? 100;
  const category = await prisma.ozonCategory.findUnique({
    where: { id: options.categoryRecordId },
  });

  if (!category?.descriptionCategoryId || !category.typeId) {
    throw new Error("请选择已经同步到 description_category_id 和 type_id 的 Ozon 末级类目。");
  }

  const run = await prisma.ozonSyncRun.create({
    data: {
      action: "category_attributes",
      status: "RUNNING",
      language,
      inputPayload: toJson({
        endpoint: "/v1/description-category/attribute",
        categoryRecordId: options.categoryRecordId,
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
        includeValues,
        maxValuesPerAttribute,
      }),
    },
  });

  try {
    const payload = await ozonSellerRequest<UnknownRecord>("/v1/description-category/attribute", {
      description_category_id: category.descriptionCategoryId,
      type_id: category.typeId,
      language,
    });
    const attributes = resultArray(payload);
    const now = new Date();
    const syncedAttributeIds: string[] = [];
    let valuesSynced = 0;

    for (const attribute of attributes) {
      const record = toRecord(attribute);
      const ozonAttributeId = stringFrom(record.id ?? record.attribute_id ?? record.attributeId);
      const syncedAttribute = await upsertOzonAttributeRecord({
        categoryId: category.id,
        record,
        language,
        now,
      });
      if (!ozonAttributeId || !syncedAttribute) continue;

      syncedAttributeIds.push(ozonAttributeId);

      if (includeValues && syncedAttribute.dictionaryId && maxValuesPerAttribute > 0) {
        try {
          valuesSynced += await syncAttributeValues({
            categoryId: syncedAttribute.id,
            descriptionCategoryId: category.descriptionCategoryId,
            typeId: category.typeId,
            ozonAttributeId,
            language,
            maxValues: maxValuesPerAttribute,
          });
        } catch (error) {
          if (!isMissingDictionaryError(error)) {
            throw error;
          }
        }
      }
    }

    if (syncedAttributeIds.length > 0) {
      await prisma.ozonAttribute.deleteMany({
        where: {
          categoryId: category.id,
          ozonAttributeId: { notIn: syncedAttributeIds },
        },
      });
    }

    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        attributesSynced: syncedAttributeIds.length,
        valuesSynced,
        completedAt: new Date(),
        outputPayload: toJson({
          attributesSynced: syncedAttributeIds.length,
          valuesSynced,
        }),
      },
    });

    return {
      runId: run.id,
      categoryId: category.id,
      attributesSynced: syncedAttributeIds.length,
      valuesSynced,
    };
  } catch (error) {
    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "未知 Ozon 同步错误",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

export async function syncOzonCategoryAttributeTranslations(
  categoryRecordIds: string[],
  options: {
    includeValues?: boolean;
    maxValuesPerAttribute?: number;
  } = {},
) {
  const includeValues = options.includeValues ?? true;
  const maxValuesPerAttribute = options.maxValuesPerAttribute ?? 1000;
  const uniqueIds = [...new Set(categoryRecordIds)].slice(0, 50);
  const categories = await prisma.ozonCategory.findMany({
    where: {
      id: { in: uniqueIds },
      descriptionCategoryId: { not: null },
      typeId: { not: null },
    },
  });
  const run = await prisma.ozonSyncRun.create({
    data: {
      action: "category_attribute_translations_zh",
      status: "RUNNING",
      language: "ZH_HANS",
      inputPayload: toJson({
        categoryRecordIds: uniqueIds,
        categoryCount: categories.length,
        includeValues,
        maxValuesPerAttribute,
      }),
    },
  });

  try {
    const fetched = await Promise.all(
      categories.map(async (category) => {
        try {
          const payload = await ozonSellerRequest<UnknownRecord>(
            "/v1/description-category/attribute",
            {
              description_category_id: category.descriptionCategoryId,
              type_id: category.typeId,
              language: "ZH_HANS",
            },
          );
          return { category, payload, error: null };
        } catch (error) {
          return {
            category,
            payload: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    let categoriesSynced = 0;
    let attributesSynced = 0;
    let valuesSynced = 0;
    const failures: Array<{
      categoryId: string;
      label: string;
      error: string;
    }> = [];

    for (const item of fetched) {
      if (item.error || !item.payload) {
        failures.push({
          categoryId: item.category.id,
          label: item.category.label,
          error: item.error || "Ozon 没有返回属性数据。",
        });
        continue;
      }
      try {
        const now = new Date();
        for (const attribute of resultArray(item.payload)) {
          const record = toRecord(attribute);
          const ozonAttributeId = stringFrom(
            record.id ?? record.attribute_id ?? record.attributeId,
          );
          const synced = await upsertOzonAttributeRecord({
            categoryId: item.category.id,
            record,
            language: "ZH_HANS",
            now,
          });
          if (!synced) continue;
          attributesSynced += 1;
          if (
            includeValues &&
            synced.dictionaryId &&
            ozonAttributeId &&
            item.category.descriptionCategoryId &&
            item.category.typeId
          ) {
            try {
              valuesSynced += await syncAttributeValues({
                categoryId: synced.id,
                descriptionCategoryId: item.category.descriptionCategoryId,
                typeId: item.category.typeId,
                ozonAttributeId,
                language: "ZH_HANS",
                maxValues: maxValuesPerAttribute,
              });
            } catch (error) {
              if (!isMissingDictionaryError(error)) throw error;
            }
          }
        }
        categoriesSynced += 1;
      } catch (error) {
        failures.push({
          categoryId: item.category.id,
          label: item.category.label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        categoriesSynced,
        attributesSynced,
        valuesSynced,
        errorMessage: failures.length
          ? `${failures.length} 个类目的中文属性同步失败，可再次运行自动重试。`
          : null,
        outputPayload: toJson({
          requestedCategories: uniqueIds.length,
          categoriesSynced,
          attributesSynced,
          valuesSynced,
          failures,
        }),
        completedAt: new Date(),
      },
    });

    return {
      runId: run.id,
      requestedCategories: uniqueIds.length,
      categoriesSynced,
      attributesSynced,
      valuesSynced,
      failures,
    };
  } catch (error) {
    await prisma.ozonSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

export async function searchOzonAttributeValues(options: AttributeValueSearchOptions) {
  const limit = options.limit ?? 20;
  const value = options.value.trim();

  if (!value) {
    throw new Error("请输入要搜索的特征参考值。");
  }

  const category = await prisma.ozonCategory.findUnique({
    where: { id: options.categoryRecordId },
  });

  if (!category?.descriptionCategoryId || !category.typeId) {
    throw new Error("请选择已经同步到 description_category_id 和 type_id 的 Ozon 末级类目。");
  }

  const attribute = options.attributeRecordId
    ? await prisma.ozonAttribute.findUnique({ where: { id: options.attributeRecordId } })
    : options.ozonAttributeId
      ? await prisma.ozonAttribute.findUnique({
          where: {
            categoryId_ozonAttributeId: {
              categoryId: category.id,
              ozonAttributeId: options.ozonAttributeId,
            },
          },
        })
      : null;

  if (!attribute || attribute.categoryId !== category.id) {
    throw new Error("请选择当前 Ozon 类目下的特征。");
  }

  const payload = await ozonSellerRequest<UnknownRecord>("/v1/description-category/attribute/values/search", {
    description_category_id: category.descriptionCategoryId,
    type_id: category.typeId,
    attribute_id: Number(attribute.ozonAttributeId),
    value,
    limit,
  });
  const values = resultArray(payload);
  const now = new Date();
  let valuesSynced = 0;

  for (const item of values) {
    const didSync = await upsertOzonAttributeValueRecord({
      attributeId: attribute.id,
      record: toRecord(item),
      now,
    });
    if (didSync) valuesSynced += 1;
  }

  return {
    categoryId: category.id,
    attributeId: attribute.id,
    ozonAttributeId: attribute.ozonAttributeId,
    query: value,
    valuesSynced,
    values: values.map((item) => {
      const record = toRecord(item);
      return {
        ozonValueId: stringFrom(record.id ?? record.value_id ?? record.valueId),
        value: stringFrom(record.value ?? record.name),
        info: nullableStringFrom(record.info),
        picture: nullableStringFrom(record.picture),
      };
    }),
  };
}
