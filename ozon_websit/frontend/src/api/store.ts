import apiClient from './client'
import { getAuthUser } from '../utils/auth'

const STORE_CACHE_PREFIX = 'ozon_store_list_cache:v1:'
const STORE_CACHE_DIRTY_PREFIX = 'ozon_store_list_dirty:v1:'

type StoreCachePayload = {
  updated_at: number
  stores: any[]
}

const resolveStoreCacheKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return `${STORE_CACHE_PREFIX}${username || 'anonymous'}`
}

const resolveStoreDirtyKey = () => {
  const username = (getAuthUser()?.username || 'anonymous').trim().toLowerCase()
  return `${STORE_CACHE_DIRTY_PREFIX}${username || 'anonymous'}`
}

const readStoreCache = (): any[] | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(resolveStoreCacheKey())
    if (!raw) return null
    const payload = JSON.parse(raw) as StoreCachePayload
    if (!payload || !Array.isArray(payload.stores)) {
      return null
    }
    return payload.stores
  } catch {
    return null
  }
}

const writeStoreCache = (stores: any[]) => {
  if (typeof window === 'undefined') return
  try {
    const payload: StoreCachePayload = {
      updated_at: Date.now(),
      stores,
    }
    localStorage.setItem(resolveStoreCacheKey(), JSON.stringify(payload))
  } catch {
    // ignore quota or JSON errors
  }
}

const clearStoreCache = () => {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(resolveStoreCacheKey())
  } catch {
    // ignore remove failures
  }
}

const isStoreCacheDirty = () => {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(resolveStoreDirtyKey()) === '1'
  } catch {
    return false
  }
}

const setStoreCacheDirty = (dirty: boolean) => {
  if (typeof window === 'undefined') return
  try {
    if (dirty) {
      localStorage.setItem(resolveStoreDirtyKey(), '1')
      return
    }
    localStorage.removeItem(resolveStoreDirtyKey())
  } catch {
    // ignore storage failures
  }
}

export const markStoreDataDirty = () => {
  setStoreCacheDirty(true)
}

const sanitizeLimitValue = (value: any) => {
  if (typeof value !== 'string') return value
  const parts = value.split(' / ')
  if (parts.length < 3) return value
  return parts.slice(0, 2).join(' / ')
}

const sanitizeStore = (store: any) => {
  if (!store || typeof store !== 'object') return store
  return {
    ...store,
    daily_limit: sanitizeLimitValue(store.daily_limit),
    can_update: sanitizeLimitValue(store.can_update),
  }
}

export const fetchStores = async (refreshStatus = false) => {
  const shouldForceRefresh = refreshStatus || isStoreCacheDirty()
  if (!shouldForceRefresh) {
    const cachedStores = readStoreCache()
    if (cachedStores) {
      return cachedStores
    }
  }

  const response = await apiClient.get('/stores', {
    params: {
      refresh_status: refreshStatus,
    },
  })
  const stores = Array.isArray(response.data) ? response.data.map(sanitizeStore) : response.data
  if (Array.isArray(stores)) {
    writeStoreCache(stores)
    setStoreCacheDirty(false)
  } else {
    clearStoreCache()
    setStoreCacheDirty(false)
  }
  return stores
}

export const createStore = async (storeData: any) => {
  const response = await apiClient.post('/stores', storeData)
  clearStoreCache()
  return sanitizeStore(response.data)
}

export const deleteStore = async (storeId: number) => {
  const response = await apiClient.delete(`/stores/${storeId}`)
  clearStoreCache()
  return response.data
}

export const verifyStore = async (storeId: number) => {
  const response = await apiClient.post(`/stores/${storeId}/verify`)
  clearStoreCache()
  return sanitizeStore(response.data)
}

export const updateStore = async (storeId: number, payload: any) => {
  const response = await apiClient.patch(`/stores/${storeId}`, payload)
  clearStoreCache()
  return sanitizeStore(response.data)
}

export const syncStoreWarehouses = async (storeId: number) => {
  const response = await apiClient.post(`/stores/${storeId}/sync-warehouses`)
  clearStoreCache()
  return response.data
}
