import apiClient from './client'

export const fetchPricingTemplates = async () => {
  const response = await apiClient.get('/pricing/templates')
  return response.data
}

export const savePricingTemplate = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/pricing/templates', payload)
  return response.data
}

export const calculatePricing = async (payload: Record<string, any>) => {
  const response = await apiClient.post('/pricing/calculate', payload)
  return response.data
}
