import apiClient from './client'

export const getActions = async (
  storeId?: number,
  options: { forceRefresh?: boolean; syncProducts?: boolean } = {}
) => {
  const response = await apiClient.get('/activities/actions', {
    params: {
      store_id: storeId,
      force_refresh: options.forceRefresh ? 1 : 0,
      sync_products: options.syncProducts ? 1 : 0,
    },
  })
  return response.data
}

export const getCandidates = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/candidates', payload, {
    params: { store_id: storeId },
  })
  return response.data
}

export const getParticipating = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/participating', payload, {
    params: { store_id: storeId },
  })
  return response.data
}

export const activateProducts = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/activate', payload, {
    params: { store_id: storeId },
  })
  return response.data
}

export const deactivateProducts = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/deactivate', payload, {
    params: { store_id: storeId },
  })
  return response.data
}

export const getDiscountTasks = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/discount-tasks', payload, {
    params: { store_id: storeId },
  })
  return response.data
}

export const approveDiscountTasks = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/discount-tasks/approve', payload, {
    params: { store_id: storeId },
  })
  return response.data
}

export const rejectDiscountTasks = async (payload: any, storeId?: number) => {
  const response = await apiClient.post('/activities/discount-tasks/reject', payload, {
    params: { store_id: storeId },
  })
  return response.data
}
