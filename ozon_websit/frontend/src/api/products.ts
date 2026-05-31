import apiClient from './client'
import { getAuthUser } from '../utils/auth'

const PRODUCT_LIST_CACHE_PREFIX = 'ozon_product_list_cache:v1:'
const PRODUCT_FILTER_CACHE_PREFIX = 'ozon_product_filter_cache:v1:'
const PRODUCT_CACHE_DIRTY_PREFIX = 'ozon_product_cache_dirty:v1:'
const INVENTORY_LIST_CACHE_PREFIX = 'ozon_inventory_list_cache:v1:'
const INVENTORY_CACHE_DIRTY_PREFIX = 'ozon_inventory_cache_dirty:v1:'

const resolveProductOwnerKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return username || 'anonymous'
}

const stableParamString = (params: Record<string, any>) => {
  const normalized = Object.keys(params || {})
    .sort()
    .map((key) => [key, params[key] == null ? '' : String(params[key])])
  return JSON.stringify(normalized)
}

const resolveProductListCacheKey = (params: Record<string, any>) =>
  `${PRODUCT_LIST_CACHE_PREFIX}${resolveProductOwnerKey()}:${stableParamString(params || {})}`

const resolveProductFilterCacheKey = (storeId?: number) =>
  `${PRODUCT_FILTER_CACHE_PREFIX}${resolveProductOwnerKey()}:${storeId ?? 'all'}`

const resolveProductDirtyKey = () =>
  `${PRODUCT_CACHE_DIRTY_PREFIX}${resolveProductOwnerKey()}`

const resolveInventoryListCacheKey = (params: Record<string, any>) =>
  `${INVENTORY_LIST_CACHE_PREFIX}${resolveProductOwnerKey()}:${stableParamString(params || {})}`

const resolveInventoryDirtyKey = () =>
  `${INVENTORY_CACHE_DIRTY_PREFIX}${resolveProductOwnerKey()}`

const readJsonCache = (key: string) => {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const writeJsonCache = (key: string, value: any) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota failures
  }
}

const clearProductCaches = () => {
  if (typeof window === 'undefined') return
  const ownerKey = resolveProductOwnerKey()
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i)
    if (!key) continue
    if (key.startsWith(`${PRODUCT_LIST_CACHE_PREFIX}${ownerKey}:`)) {
      localStorage.removeItem(key)
      continue
    }
    if (key.startsWith(`${PRODUCT_FILTER_CACHE_PREFIX}${ownerKey}:`)) {
      localStorage.removeItem(key)
    }
  }
}

const clearInventoryCaches = () => {
  if (typeof window === 'undefined') return
  const ownerKey = resolveProductOwnerKey()
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i)
    if (!key) continue
    if (key.startsWith(`${INVENTORY_LIST_CACHE_PREFIX}${ownerKey}:`)) {
      localStorage.removeItem(key)
    }
  }
}

const isProductCacheDirty = () => {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(resolveProductDirtyKey()) === '1'
  } catch {
    return false
  }
}

const setProductCacheDirty = (dirty: boolean) => {
  if (typeof window === 'undefined') return
  try {
    if (dirty) {
      localStorage.setItem(resolveProductDirtyKey(), '1')
      return
    }
    localStorage.removeItem(resolveProductDirtyKey())
  } catch {
    // ignore storage failures
  }
}

const isInventoryCacheDirty = () => {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(resolveInventoryDirtyKey()) === '1'
  } catch {
    return false
  }
}

const setInventoryCacheDirty = (dirty: boolean) => {
  if (typeof window === 'undefined') return
  try {
    if (dirty) {
      localStorage.setItem(resolveInventoryDirtyKey(), '1')
      return
    }
    localStorage.removeItem(resolveInventoryDirtyKey())
  } catch {
    // ignore storage failures
  }
}

export const markProductDataDirty = () => {
  clearProductCaches()
  setProductCacheDirty(true)
}

export const markInventoryDataDirty = () => {
  clearInventoryCaches()
  setInventoryCacheDirty(true)
}

type ProductFetchOptions = {
  forceRefresh?: boolean
}

export const fetchProducts = async (
  params: Record<string, any>,
  options: ProductFetchOptions = {},
) => {
  const shouldForceRefresh = Boolean(options.forceRefresh) || isProductCacheDirty()
  const cacheKey = resolveProductListCacheKey(params || {})
  if (!shouldForceRefresh) {
    const cached = readJsonCache(cacheKey)
    if (cached) {
      return cached
    }
  }

  const response = await apiClient.get('/products', { params })
  const payload = response.data
  writeJsonCache(cacheKey, payload)
  setProductCacheDirty(false)
  return payload
}

export const fetchProductFilters = async (
  storeId?: number,
  options: ProductFetchOptions = {},
) => {
  const shouldForceRefresh = Boolean(options.forceRefresh) || isProductCacheDirty()
  const cacheKey = resolveProductFilterCacheKey(storeId)
  if (!shouldForceRefresh) {
    const cached = readJsonCache(cacheKey)
    if (cached) {
      return cached
    }
  }

  const response = await apiClient.get('/products/filters', {
    params: {
      store_id: storeId,
    },
  })
  const payload = response.data
  writeJsonCache(cacheKey, payload)
  return payload
}

export const fetchProductMarketInsights = async (productId: number, period = 'weekly') => {
  const response = await apiClient.get(`/products/${productId}/market-insights`, {
    params: {
      period,
    },
  })
  return response.data
}

export const syncProducts = async () => {
  const response = await apiClient.post('/products/sync')
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

export const batchUpdateProductPrice = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/price', payload)
  markProductDataDirty()
  return response.data
}

export const batchUpdateProductStock = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/stock', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

export const batchArchiveProducts = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/archive', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

export const batchRemarkProducts = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/remark', payload)
  markProductDataDirty()
  return response.data
}

export const batchRetryProducts = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/products/batch/retry', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

type InventoryFetchOptions = {
  forceRefresh?: boolean
}

export const fetchInventory = async (
  params: Record<string, any>,
  options: InventoryFetchOptions = {},
) => {
  const shouldForceRefresh = Boolean(options.forceRefresh) || isInventoryCacheDirty()
  const cacheKey = resolveInventoryListCacheKey(params || {})
  if (!shouldForceRefresh) {
    const cached = readJsonCache(cacheKey)
    if (cached) {
      return cached
    }
  }

  const response = await apiClient.get('/inventory', { params })
  const payload = response.data
  writeJsonCache(cacheKey, payload)
  setInventoryCacheDirty(false)
  return payload
}

export const batchBackupInventory = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/backup', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

export const batchRestoreInventory = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/restore', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

export const batchUpdateInventoryStock = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/update-stock', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}

export const batchUpdateInventoryAutomation = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/inventory/batch/automation', payload)
  markProductDataDirty()
  markInventoryDataDirty()
  return response.data
}
