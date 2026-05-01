import apiClient from './client'

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
  const response = await apiClient.get('/stores', {
    params: {
      refresh_status: refreshStatus,
    },
  })
  return Array.isArray(response.data) ? response.data.map(sanitizeStore) : response.data
}

export const createStore = async (storeData: any) => {
  const response = await apiClient.post('/stores', storeData)
  return sanitizeStore(response.data)
}

export const deleteStore = async (storeId: number) => {
  const response = await apiClient.delete(`/stores/${storeId}`)
  return response.data
}

export const verifyStore = async (storeId: number) => {
  const response = await apiClient.post(`/stores/${storeId}/verify`)
  return sanitizeStore(response.data)
}

export const updateStore = async (storeId: number, payload: any) => {
  const response = await apiClient.patch(`/stores/${storeId}`, payload)
  return sanitizeStore(response.data)
}

export const syncStoreBrowserWarehouses = async (storeId: number) => {
  const response = await apiClient.post(`/stores/${storeId}/sync-browser-warehouses`)
  return response.data
}
