/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON 上货模块 - 统一入口
 *
 * 供外部模块（抓取模块、Website 模块）程序化调用。
 * 三个核心方法：clean / upload / check
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const OzonApiClient = require('./ozon_api');
const { findBestMatch, searchByKeyword } = require('./category_finder');
const { matchAttributes } = require('./attribute_matcher');
const { cleanProduct, getCharValue } = require('./product_cleaner');
const { downloadProductImages } = require('./image_downloader');

let _api = null;
let _treeData = null;

function getApi() {
  if (_api) return _api;
  if (!config.OZON_CLIENT_ID || !config.OZON_API_KEY) return null;
  _api = new OzonApiClient();
  return _api;
}

async function getTreeData() {
  if (_treeData) return _treeData;
  const cachePath = path.join(config.CACHE_DIR, 'category_tree.json');
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  if (fs.existsSync(cachePath)) {
    _treeData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return _treeData;
  }
  const api = getApi();
  if (api) {
    _treeData = await api.getCategoryTree();
    return _treeData;
  }
  return null;
}

/**
 * 清洗单个商品
 *
 * @param {object|string} input - 抓取的商品 JSON 对象，或 JSON 文件路径
 * @param {object} options
 * @param {string} options.price        - 售价（必填）
 * @param {string} options.old_price    - 原价（可选）
 * @param {boolean} options.downloadImages - 是否下载图片到本地，默认 true
 * @param {boolean} options.saveOutput  - 是否保存输出文件到 output/，默认 true
 *
 * @returns {Promise<{
 *   success: boolean,
 *   item: object,           // /v3/product/import 的 item 对象
 *   meta: object,           // 清洗元数据
 *   images: object|null,    // 图片下载结果
 *   outputFile: string|null,// 输出文件路径
 *   errors: string[]
 * }>}
 */
async function clean(input, options = {}) {
  const errors = [];
  const opts = {
    price: '0',
    old_price: '0',
    downloadImages: true,
    saveOutput: true,
    ...options,
  };

  // 解析输入
  let scrapedData;
  if (typeof input === 'string') {
    scrapedData = JSON.parse(fs.readFileSync(input, 'utf-8'));
  } else {
    scrapedData = input;
  }

  // 分类匹配
  let categoryInfo = { description_category_id: 0, type_id: 0 };
  const treeData = await getTreeData();

  if (treeData) {
    const breadcrumbs = (scrapedData.breadcrumbs || []).map((b) => b.text);
    const typeName = getCharValue(scrapedData.characteristics || [], 'Тип') || '';
    const match = findBestMatch(treeData, breadcrumbs, typeName);

    if (match) {
      categoryInfo = {
        description_category_id: match.description_category_id,
        type_id: match.type_id,
      };
    } else {
      const kw = typeName || breadcrumbs[breadcrumbs.length - 1] || '';
      const results = searchByKeyword(treeData, kw);
      if (results.length > 0) {
        categoryInfo = {
          description_category_id: results[0].description_category_id,
          type_id: results[0].type_id,
        };
      }
    }
  }

  if (categoryInfo.description_category_id === 0) {
    errors.push('分类未匹配，需要 API 凭证或本地缓存');
  }

  // 属性匹配
  let ozonFormattedAttrs = [];
  const api = getApi();

  if (api && categoryInfo.description_category_id > 0) {
    const attrsData = await api.getCategoryAttributes(
      categoryInfo.description_category_id,
      categoryInfo.type_id
    );

    if (attrsData && attrsData.result) {
      const getDictValues = async (attrId) => {
        const attr = attrsData.result.find((a) => a.id === attrId);
        if (!attr || !attr.dictionary_id) return [];
        const data = await api.getAttributeValues(
          attrId, categoryInfo.description_category_id, categoryInfo.type_id
        );
        return data.result || [];
      };

      const matchReport = await matchAttributes(
        scrapedData.characteristics || [], attrsData.result, getDictValues
      );
      ozonFormattedAttrs = matchReport.ozonFormat;

      // 补充品牌
      const brandAttr = attrsData.result.find(
        (a) => a.name.toLowerCase().includes('бренд') || a.name.toLowerCase() === 'brand'
      );
      if (brandAttr && !ozonFormattedAttrs.some((a) => a.id === brandAttr.id)) {
        let brandValue = { dictionary_value_id: 0, value: config.DEFAULTS.brand };
        if (brandAttr.dictionary_id) {
          const dictValues = await getDictValues(brandAttr.id);
          const noBrand = dictValues.find(
            (dv) => dv.value.toLowerCase().includes('нет бренда') || dv.value.toLowerCase().includes('без бренда')
          );
          if (noBrand) brandValue = { dictionary_value_id: noBrand.id, value: noBrand.value };
        }
        ozonFormattedAttrs.push({ id: brandAttr.id, complex_id: 0, values: [brandValue] });
      }

      // 补充制造商
      const mfrAttr = attrsData.result.find(
        (a) => a.name.toLowerCase().includes('изготовитель') || a.name.toLowerCase().includes('производитель')
      );
      if (mfrAttr && !ozonFormattedAttrs.some((a) => a.id === mfrAttr.id)) {
        ozonFormattedAttrs.push({
          id: mfrAttr.id, complex_id: 0,
          values: [{ dictionary_value_id: 0, value: config.DEFAULTS.manufacturer }],
        });
      }
    }
  }

  // 组装
  const { item, meta } = cleanProduct(scrapedData, categoryInfo, ozonFormattedAttrs, {
    price: opts.price,
    old_price: opts.old_price,
  });

  // 图片下载
  let images = null;
  if (opts.downloadImages) {
    images = await downloadProductImages(scrapedData);
    if (images.doneCount > 0) {
      item._primary_image_local = images.localMap[item.primary_image] || null;
      item._images_local = item.images.map((url) => images.localMap[url] || null);
      meta.images_downloaded = images.doneCount;
      meta.images_failed = images.failCount;
    }
  }

  // 保存输出
  let outputFile = null;
  if (opts.saveOutput) {
    fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    outputFile = path.join(config.OUTPUT_DIR, `product_import_${meta.source_product_id || 'unknown'}.json`);
    fs.writeFileSync(outputFile, JSON.stringify({ items: [item] }, null, 2), 'utf-8');
  }

  return {
    success: errors.length === 0,
    item,
    meta,
    images,
    outputFile,
    errors,
  };
}

/**
 * 上传商品到 OZON
 *
 * @param {object|object[]} items - 单个 item 或 item 数组（来自 clean() 的返回值）
 * @returns {Promise<{success: boolean, task_id: number|null, error: string|null}>}
 */
async function upload(items) {
  const api = getApi();
  if (!api) {
    return { success: false, task_id: null, error: '未配置 OZON API 凭证' };
  }

  const itemArray = Array.isArray(items) ? items : [items];

  // 校验必填字段
  for (const item of itemArray) {
    if (!item.description_category_id) return { success: false, task_id: null, error: `${item.offer_id}: 缺少 description_category_id` };
    if (!item.type_id) return { success: false, task_id: null, error: `${item.offer_id}: 缺少 type_id` };
    if (!item.primary_image) return { success: false, task_id: null, error: `${item.offer_id}: 缺少主图` };
  }

  try {
    const result = await api._post('/v3/product/import', { items: itemArray });
    return { success: true, task_id: result.result?.task_id, error: null };
  } catch (err) {
    return { success: false, task_id: null, error: err.message };
  }
}

/**
 * 查询上传任务状态
 *
 * @param {number} taskId
 * @returns {Promise<{items: Array<{offer_id, status, errors}>}>}
 */
async function check(taskId) {
  const api = getApi();
  if (!api) throw new Error('未配置 OZON API 凭证');

  const result = await api._post('/v1/product/import/info', { task_id: Number(taskId) });
  return result.result || {};
}

/**
 * 一键执行：清洗 + 上传 + 查询状态
 *
 * @param {object|string} input - 抓取的 JSON 或文件路径
 * @param {object} options - 同 clean() 的 options
 * @returns {Promise<{clean: object, upload: object, status: object|null}>}
 */
async function cleanAndUpload(input, options = {}) {
  const cleanResult = await clean(input, options);

  if (!cleanResult.success && cleanResult.item.description_category_id === 0) {
    return { clean: cleanResult, upload: null, status: null };
  }

  const uploadResult = await upload(cleanResult.item);

  let status = null;
  if (uploadResult.success && uploadResult.task_id) {
    await new Promise((r) => setTimeout(r, 5000));
    status = await check(uploadResult.task_id);
  }

  return { clean: cleanResult, upload: uploadResult, status };
}

module.exports = { clean, upload, check, cleanAndUpload, config };
