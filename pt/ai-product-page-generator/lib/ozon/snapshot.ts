import { prisma } from "@/lib/db/prisma";
import { getOzonConnectionState, type OzonConnectionState } from "@/lib/ozon/client";
import { getOzonHdCacheState, type OzonHdCacheState } from "@/lib/ozon/sync-service";

export type OzonAttributeValueSnapshot = {
  id: string;
  ozonValueId: string;
  value: string;
  info: string | null;
  picture: string | null;
};

export type OzonAttributeSnapshot = {
  id: string;
  ozonAttributeId: string;
  name: string;
  description: string | null;
  type: string | null;
  groupName: string | null;
  dictionaryId: string | null;
  isRequired: boolean;
  isCollection: boolean;
  isAspect: boolean;
  maxValueCount: number | null;
  categoryDependent: boolean;
  syncedAt: string;
  dictionaryValueCount: number;
  values: OzonAttributeValueSnapshot[];
};

export type OzonCategorySnapshot = {
  id: string;
  sourceKey: string;
  descriptionCategoryId: number | null;
  typeId: number | null;
  label: string;
  categoryName: string | null;
  typeName: string | null;
  path: string[];
  depth: number;
  isLeaf: boolean;
  disabled: boolean;
  syncedAt: string;
  attributeCount?: number;
  requiredAttributeCount?: number;
  attributes?: OzonAttributeSnapshot[];
};

export type OzonSyncRunSnapshot = {
  id: string;
  action: string;
  status: string;
  language: string;
  categoriesSynced: number;
  attributesSynced: number;
  valuesSynced: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type OzonFeatureSnapshot = {
  connection: OzonConnectionState;
  localCache: OzonHdCacheState;
  counts: {
    categories: number;
    leafCategories: number;
    attributes: number;
    requiredAttributes: number;
    values: number;
  };
  lastSyncRun: OzonSyncRunSnapshot | null;
  categories: OzonCategorySnapshot[];
  selectedCategory: OzonCategorySnapshot | null;
};

function jsonPathToStrings(path: unknown) {
  return Array.isArray(path) ? path.map((item) => String(item)) : [];
}

function serializeRun(run: Awaited<ReturnType<typeof prisma.ozonSyncRun.findFirst>>): OzonSyncRunSnapshot | null {
  if (!run) return null;

  return {
    id: run.id,
    action: run.action,
    status: run.status,
    language: run.language,
    categoriesSynced: run.categoriesSynced,
    attributesSynced: run.attributesSynced,
    valuesSynced: run.valuesSynced,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function serializeCategory(
  category: Awaited<ReturnType<typeof prisma.ozonCategory.findMany>>[number],
  counts?: { attributes?: number; required?: number },
): OzonCategorySnapshot {
  return {
    id: category.id,
    sourceKey: category.sourceKey,
    descriptionCategoryId: category.descriptionCategoryId,
    typeId: category.typeId,
    label: category.label,
    categoryName: category.categoryName,
    typeName: category.typeName,
    path: jsonPathToStrings(category.path),
    depth: category.depth,
    isLeaf: category.isLeaf,
    disabled: category.disabled,
    syncedAt: category.syncedAt.toISOString(),
    attributeCount: counts?.attributes,
    requiredAttributeCount: counts?.required,
  };
}

export async function getOzonFeatureSnapshot(params: { categoryId?: string; query?: string } = {}): Promise<OzonFeatureSnapshot> {
  const query = params.query?.trim();
  const categoryWhere = {
    disabled: false,
    typeId: { not: null },
    ...(query
      ? {
          OR: [
            { label: { contains: query } },
            { categoryName: { contains: query } },
            { typeName: { contains: query } },
          ],
        }
      : {}),
  };

  const localCache = await getOzonHdCacheState();
  const [categories, lastSyncRun, categoryCount, leafCategoryCount, attributeCount, requiredAttributeCount, valueCount] =
    await prisma.$transaction([
      prisma.ozonCategory.findMany({
        where: categoryWhere,
        orderBy: [{ depth: "asc" }, { label: "asc" }],
        take: 300,
      }),
      prisma.ozonSyncRun.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.ozonCategory.count(),
      prisma.ozonCategory.count({ where: { isLeaf: true, disabled: false } }),
      prisma.ozonAttribute.count(),
      prisma.ozonAttribute.count({ where: { isRequired: true } }),
      prisma.ozonAttributeValue.count(),
    ]);

  const selectedCategoryId = params.categoryId ?? null;
  const selectedCategory = selectedCategoryId
    ? await prisma.ozonCategory.findUnique({
        where: { id: selectedCategoryId },
        include: {
          attributes: {
            orderBy: [{ isRequired: "desc" }, { groupName: "asc" }, { name: "asc" }],
            include: {
              _count: { select: { values: true } },
              values: {
                orderBy: { value: "asc" },
                take: 50,
              },
            },
          },
        },
      })
    : null;

  return {
    connection: await getOzonConnectionState(),
    localCache,
    counts: {
      categories: categoryCount,
      leafCategories: leafCategoryCount,
      attributes: attributeCount,
      requiredAttributes: requiredAttributeCount,
      values: valueCount,
    },
    lastSyncRun: serializeRun(lastSyncRun),
    categories: categories.map((category) => serializeCategory(category)),
    selectedCategory: selectedCategory
      ? {
          ...serializeCategory(selectedCategory, {
            attributes: selectedCategory.attributes.length,
            required: selectedCategory.attributes.filter((attribute) => attribute.isRequired).length,
          }),
          attributes: selectedCategory.attributes.map((attribute) => ({
            id: attribute.id,
            ozonAttributeId: attribute.ozonAttributeId,
            name: attribute.name,
            description: attribute.description,
            type: attribute.type,
            groupName: attribute.groupName,
            dictionaryId: attribute.dictionaryId,
            isRequired: attribute.isRequired,
            isCollection: attribute.isCollection,
            isAspect: attribute.isAspect,
            maxValueCount: attribute.maxValueCount,
            categoryDependent: attribute.categoryDependent,
            syncedAt: attribute.syncedAt.toISOString(),
            dictionaryValueCount: attribute._count.values,
            values: attribute.values.map((value) => ({
              id: value.id,
              ozonValueId: value.ozonValueId,
              value: value.value,
              info: value.info,
              picture: value.picture,
            })),
          })),
        }
      : null,
  };
}
