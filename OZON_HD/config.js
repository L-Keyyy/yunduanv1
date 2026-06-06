/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON 上货工具配置文件
 * 请在此处填写你的 OZON Seller API 凭证
 */
module.exports = {
  // ========== OZON API 凭证（必填）==========
  OZON_CLIENT_ID: process.env.OZON_CLIENT_ID || '',
  OZON_API_KEY: process.env.OZON_API_KEY || '',

  // ========== Cloud upload bridge ==========
  CLOUD_UPLOAD_ENABLED: process.env.OZON_CLOUD_UPLOAD_ENABLED !== '0',
  CLOUD_API_BASE: process.env.OZON_CLOUD_API_BASE || 'http://35.209.87.105/api/v1',
  CLOUD_DEFAULT_STORE_ID: process.env.OZON_CLOUD_DEFAULT_STORE_ID || '',
  CLOUD_DEFAULT_STORE_NAME: process.env.OZON_CLOUD_DEFAULT_STORE_NAME || '',
  CLOUD_REQUEST_TIMEOUT_MS: Number(process.env.OZON_CLOUD_REQUEST_TIMEOUT_MS || 15000),

  // ========== API 基础配置 ==========
  OZON_API_BASE: 'https://api-seller.ozon.ru',

  // ========== 默认值配置 ==========
  DEFAULTS: {
    currency_code: 'CNY',
    dimension_unit: 'mm',
    weight_unit: 'g',
    default_depth_mm: 100,
    default_width_mm: 100,
    default_height_mm: 150,
    manufacturer: 'China',
    brand: '无品牌',
    vat: '0',
    barcode: '',
  },

  // ========== 缓存目录 ==========
  CACHE_DIR: 'cache',
  OUTPUT_DIR: 'output',
};
