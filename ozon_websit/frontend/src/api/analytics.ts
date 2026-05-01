import apiClient from './client'

const HOT_TAGS_FRONTEND_CACHE_TTL_MS = 5 * 60 * 1000
const hotTagsResponseCache = new Map<string, { expiresAt: number; data: any }>()

export interface AnalyticsChartItem {
  name: string
  value: number
}

export interface AnalyticsSummary {
  scopeLabel: string
  totalSales: number
  salesDelta: number
  orderCount: number
  orderDelta: number
  soldUnits: number
  soldUnitsDelta: number
  activeSkus: number
  activeSkusDelta: number
  catalogSkus: number
  stockOnHand: number
  lowStockSkus: number
  avgOrderValue: number
  avgOrderValueDelta: number
  storeCount: number
  leafCategoryCount: number
  matchedOrders: number
  unmatchedOrders: number
  matchedRate: number
}

export interface AnalyticsTrend {
  labels: string[]
  sales: number[]
  orders: number[]
  units: number[]
}

export interface AnalyticsTableRow {
  name: string
  salesAmount: number
  salesDelta: number
  salesShare: number
  orderCount: number
  orderDelta: number
  soldUnits: number
  skuCount: number
  avgPrice: number
  avgOrderValue: number
  stockOnHand: number
  lowStockSkus: number
  storeCount: number
  top5Share: number
  matchedOrders: number
  nextPath: string[]
  canDrillDown: boolean
}

export interface AnalyticsMeta {
  days: number
  scopeLabel: string
  generatedAt: string
  currentStart: string
  currentEnd: string
  previousStart: string
  previousEnd: string
  hasData: boolean
  canDrillDown: boolean
}

export interface CategoryAnalyticsResponse {
  path: string[]
  summary: AnalyticsSummary
  trend: AnalyticsTrend
  charts: {
    sales: AnalyticsChartItem[]
    orders: AnalyticsChartItem[]
    skus: AnalyticsChartItem[]
  }
  table: AnalyticsTableRow[]
  insights: string[]
  meta: AnalyticsMeta
}

export interface MarketCategoryTrendRow {
  id: string
  name: string
  salesAmount: number
  salesDelta: number
  soldUnits: number
  sellerCount: number
  avgPrice: number
  avgPriceDelta: number
  brandCount: number
  leaderShare: number
  buyoutRate: number
  level: number
  canDrillDown: boolean
}

export interface MarketCategoryTrendResponse {
  scopeLabel: string
  sourceUrl: string
  companyId: number
  rootScope: 'none' | 'selected' | 'all'
  path: number[]
  basePathLabel: string
  rootOptions: Array<{
    id: number
    name: string
  }>
  level: number
  maxLevel: number
  canDrillDown: boolean
  group: string
  period: string
  periodLabel: string
  generatedAt: string
  charts: {
    sales: AnalyticsChartItem[]
    units: AnalyticsChartItem[]
    sellers: AnalyticsChartItem[]
  }
  table: MarketCategoryTrendRow[]
}

const createEmptyCategoryAnalytics = (): CategoryAnalyticsResponse => ({
  path: [],
  summary: {
    scopeLabel: '全部类目',
    totalSales: 0,
    salesDelta: 0,
    orderCount: 0,
    orderDelta: 0,
    soldUnits: 0,
    soldUnitsDelta: 0,
    activeSkus: 0,
    activeSkusDelta: 0,
    catalogSkus: 0,
    stockOnHand: 0,
    lowStockSkus: 0,
    avgOrderValue: 0,
    avgOrderValueDelta: 0,
    storeCount: 0,
    leafCategoryCount: 0,
    matchedOrders: 0,
    unmatchedOrders: 0,
    matchedRate: 0,
  },
  trend: {
    labels: [],
    sales: [],
    orders: [],
    units: [],
  },
  charts: {
    sales: [],
    orders: [],
    skus: [],
  },
  table: [],
  insights: [],
  meta: {
    days: 7,
    scopeLabel: '全部类目',
    generatedAt: '',
    currentStart: '',
    currentEnd: '',
    previousStart: '',
    previousEnd: '',
    hasData: false,
    canDrillDown: true,
  },
})

const normalizeLegacyCategoryAnalytics = (
  payload: Record<string, any>,
  days: number,
  path: string,
): CategoryAnalyticsResponse => {
  const empty = createEmptyCategoryAnalytics()
  const legacyRows = Array.isArray(payload.table) ? payload.table : []
  const totalSales = legacyRows.reduce((sum, row) => sum + Number(row.orderAmount || 0), 0)
  const totalOrders = legacyRows.reduce((sum, row) => sum + Number(row.orderCount || 0), 0)
  const totalStores = legacyRows.reduce((sum, row) => sum + Number(row.sellerCount || 0), 0)
  const pathParts = path ? path.split('/').filter(Boolean) : []

  return {
    path: Array.isArray(payload.path) ? payload.path : pathParts,
    summary: {
      ...empty.summary,
      scopeLabel: pathParts.length ? pathParts.join(' / ') : '全部类目',
      totalSales,
      salesDelta: Number(legacyRows[0]?.amountChange || 0),
      orderCount: totalOrders,
      orderDelta: 0,
      soldUnits: totalOrders,
      soldUnitsDelta: 0,
      activeSkus: legacyRows.length,
      activeSkusDelta: 0,
      catalogSkus: legacyRows.length,
      stockOnHand: 0,
      lowStockSkus: 0,
      avgOrderValue: totalOrders > 0 ? Number((totalSales / totalOrders).toFixed(2)) : 0,
      avgOrderValueDelta: 0,
      storeCount: totalStores,
      leafCategoryCount: legacyRows.length,
      matchedOrders: totalOrders,
      unmatchedOrders: 0,
      matchedRate: totalOrders > 0 ? 100 : 0,
    },
    trend: empty.trend,
    charts: {
      sales: Array.isArray(payload.charts?.sales) ? payload.charts.sales : [],
      orders: Array.isArray(payload.charts?.volume) ? payload.charts.volume : [],
      skus: Array.isArray(payload.charts?.sellers) ? payload.charts.sellers : [],
    },
    table: legacyRows.map((row: Record<string, any>) => ({
      name: String(row.category || '未分类'),
      salesAmount: Number(row.orderAmount || 0),
      salesDelta: Number(row.amountChange || 0),
      salesShare: totalSales > 0 ? Number((((Number(row.orderAmount || 0)) / totalSales) * 100).toFixed(2)) : 0,
      orderCount: Number(row.orderCount || 0),
      orderDelta: 0,
      soldUnits: Number(row.orderCount || 0),
      skuCount: Number(row.brandCount || 0),
      avgPrice: Number(row.avgPrice || 0),
      avgOrderValue: Number(row.avgPrice || 0),
      stockOnHand: 0,
      lowStockSkus: 0,
      storeCount: Number(row.sellerCount || 0),
      top5Share: Number(row.top5Share || 0),
      matchedOrders: Number(row.orderCount || 0),
      nextPath: [...pathParts, String(row.category || '未分类')],
      canDrillDown: pathParts.length < 3,
    })),
    insights: ['当前后端仍返回旧版分析结构，前端已自动兼容显示。'],
    meta: {
      ...empty.meta,
      days,
      scopeLabel: pathParts.length ? pathParts.join(' / ') : '全部类目',
      generatedAt: new Date().toISOString(),
      hasData: legacyRows.length > 0,
      canDrillDown: pathParts.length < 3,
    },
  }
}

export const fetchCategoryAnalytics = async (
  days = 7,
  path = '',
  storeId?: number,
): Promise<CategoryAnalyticsResponse> => {
  const response = await apiClient.get('/analytics/categories', {
    params: { days, path, store_id: storeId },
  })
  const payload = response.data || {}
  if (payload.summary && payload.trend && payload.meta) {
    return payload as CategoryAnalyticsResponse
  }
  return normalizeLegacyCategoryAnalytics(payload, days, path)
}

export const createEmptyMarketCategoryTrends = (): MarketCategoryTrendResponse => ({
  scopeLabel: 'Seller 当前类目',
  sourceUrl: '',
  companyId: 0,
  rootScope: 'none',
  path: [],
  basePathLabel: '',
  rootOptions: [],
  level: 1,
  maxLevel: 3,
  canDrillDown: true,
  group: '',
  period: '',
  periodLabel: '',
  generatedAt: '',
  charts: {
    sales: [],
    units: [],
    sellers: [],
  },
  table: [],
})

export const fetchMarketCategoryTrends = async (
  path: number[] = [],
  rootScope: 'current' | 'all' = 'current',
  period: '7_days' | '28_days' | 'quarter' | 'year' = '28_days',
): Promise<MarketCategoryTrendResponse> => {
  const response = await apiClient.get('/analytics/market-category-trends', {
    timeout: rootScope === 'all' ? 180000 : undefined,
    params: {
      path: path.join('/'),
      root_scope: rootScope,
      period,
    },
  })
  const payload = response.data || {}
  return {
    ...createEmptyMarketCategoryTrends(),
    ...payload,
    charts: {
      ...createEmptyMarketCategoryTrends().charts,
      ...(payload.charts || {}),
    },
    table: Array.isArray(payload.table)
      ? payload.table.map((row: Record<string, any>) => ({
          level: Number(row.level || payload.level || 1),
          canDrillDown: Boolean(row.canDrillDown ?? (Number(payload.level || 1) < 3)),
          ...row,
        }))
      : [],
  }
}

export const fetchCommissions = async (search = '') => {
  const response = await apiClient.get('/commissions', {
    params: { search },
  })
  return response.data
}

export const fetchHotTags = async (search = '', trendDays = 7) => {
  const normalizedTrendDays = Number(trendDays) === 28 ? 28 : 7
  const cacheKey = `${String(search || '').trim()}::${normalizedTrendDays}`
  const cachedEntry = hotTagsResponseCache.get(cacheKey)
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return cachedEntry.data
  }
  const response = await apiClient.get('/hot-tags', {
    params: { search, trend_days: normalizedTrendDays },
  })
  hotTagsResponseCache.set(cacheKey, {
    expiresAt: Date.now() + HOT_TAGS_FRONTEND_CACHE_TTL_MS,
    data: response.data,
  })
  return response.data
}
