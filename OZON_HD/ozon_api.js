/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON Seller API 客户端
 * 封装分类树、属性查询、字典值查询等接口，带本地文件缓存
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');

class OzonApiClient {
  constructor(clientId, apiKey) {
    this.clientId = clientId || config.OZON_CLIENT_ID;
    this.apiKey = apiKey || config.OZON_API_KEY;
    this.baseUrl = config.OZON_API_BASE;
    this.cacheDir = path.resolve(config.CACHE_DIR);
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  _post(endpoint, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.baseUrl);
      const payload = JSON.stringify(body);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Client-Id': this.clientId,
          'Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`JSON 解析失败: ${e.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  _cacheKey(name) {
    return path.join(this.cacheDir, `${name}.json`);
  }

  _loadCache(name) {
    const fp = this._cacheKey(name);
    if (fs.existsSync(fp)) {
      console.log(`  [缓存] 从本地加载: ${fp}`);
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
    return null;
  }

  _saveCache(name, data) {
    const fp = this._cacheKey(name);
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  [缓存] 已保存到: ${fp}`);
  }

  async _cachedPost(cacheKey, endpoint, body) {
    const cached = this._loadCache(cacheKey);
    if (cached) return cached;

    console.log(`  [API] 正在请求 ${endpoint} ...`);
    const data = await this._post(endpoint, body);
    this._saveCache(cacheKey, data);
    return data;
  }

  /** 获取完整分类树 */
  async getCategoryTree(language = 'DEFAULT') {
    return this._cachedPost('category_tree', '/v1/description-category/tree', { language });
  }

  /** 获取指定分类+类型的属性列表 */
  async getCategoryAttributes(descriptionCategoryId, typeId, language = 'DEFAULT') {
    const key = `attrs_${descriptionCategoryId}_${typeId}`;
    return this._cachedPost(key, '/v1/description-category/attribute', {
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      language,
    });
  }

  /** 获取属性字典值（分页，自动拉取全部） */
  async getAttributeValues(attributeId, descriptionCategoryId, typeId, language = 'DEFAULT') {
    const key = `dict_${attributeId}_${descriptionCategoryId}_${typeId}`;
    const cached = this._loadCache(key);
    if (cached) return cached;

    console.log(`  [API] 正在获取属性 ${attributeId} 的字典值...`);
    const allValues = [];
    let lastValueId = 0;
    let hasNext = true;

    while (hasNext) {
      const resp = await this._post('/v1/description-category/attribute/values', {
        attribute_id: attributeId,
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        language,
        limit: 5000,
        last_value_id: lastValueId,
      });
      const values = resp.result || [];
      allValues.push(...values);
      hasNext = resp.has_next === true && values.length > 0;
      if (values.length > 0) {
        lastValueId = values[values.length - 1].id;
      }
    }

    const result = { result: allValues, total: allValues.length };
    this._saveCache(key, result);
    return result;
  }
}

module.exports = OzonApiClient;
