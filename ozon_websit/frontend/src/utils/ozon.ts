export const getSellerProductSearchUrl = (keyword?: string | number | null) => {
  const value = String(keyword ?? '').trim()
  if (!value) return ''
  return `https://seller.ozon.ru/app/products?search=${encodeURIComponent(value)}`
}
