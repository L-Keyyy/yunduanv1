/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 批量商品数据清洗脚本
 *
 * 扫描当前目录下所有 ozon-product-*.json 文件，逐个进行数据清洗。
 * 清洗结果统一输出到 output/ 目录。
 *
 * 用法：
 *   node batch_clean.js [--price 默认价格] [--old-price 默认原价] [--dir 输入目录]
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const OzonApiClient = require('./ozon_api');
const { findBestMatch, searchByKeyword } = require('./category_finder');
const { matchAttributes } = require('./attribute_matcher');
const { cleanProduct, getCharValue } = require('./product_cleaner');
const { downloadProductImages } = require('./image_downloader');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { price: '0', old_price: '0', dir: '.' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--price' && args[i + 1]) opts.price = args[++i];
    else if (args[i] === '--old-price' && args[i + 1]) opts.old_price = args[++i];
    else if (args[i] === '--dir' && args[i + 1]) opts.dir = args[++i];
  }

  return opts;
}

async function processOneProduct(filePath, api, treeData, opts) {
  const scrapedData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const productName = scrapedData.title || path.basename(filePath);
  console.log(`\n  📦 处理: ${productName}`);

  // 分类匹配
  let categoryInfo = { description_category_id: 0, type_id: 0 };

  if (treeData) {
    const breadcrumbs = (scrapedData.breadcrumbs || []).map((b) => b.text);
    const typeName = getCharValue(scrapedData.characteristics || [], 'Тип') || '';
    const match = findBestMatch(treeData, breadcrumbs, typeName);

    if (match) {
      categoryInfo = {
        description_category_id: match.description_category_id,
        type_id: match.type_id,
      };
      console.log(`     分类: ${match.path.join(' > ')} (score: ${match.score})`);
    } else {
      const kw = typeName || breadcrumbs[breadcrumbs.length - 1] || '';
      const results = searchByKeyword(treeData, kw);
      if (results.length > 0) {
        categoryInfo = {
          description_category_id: results[0].description_category_id,
          type_id: results[0].type_id,
        };
      }
      console.log(`     分类: 模糊匹配 (${kw})`);
    }
  }

  // 属性匹配
  let ozonFormattedAttrs = [];
  let matchReport = { matched: [], unmatched: [] };

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
          attrId,
          categoryInfo.description_category_id,
          categoryInfo.type_id
        );
        return data.result || [];
      };

      matchReport = await matchAttributes(
        scrapedData.characteristics || [],
        attrsData.result,
        getDictValues
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
            (dv) =>
              dv.value.toLowerCase().includes('нет бренда') ||
              dv.value.toLowerCase().includes('без бренда')
          );
          if (noBrand) brandValue = { dictionary_value_id: noBrand.id, value: noBrand.value };
        }
        ozonFormattedAttrs.push({ id: brandAttr.id, complex_id: 0, values: [brandValue] });
      }

      // 补充制造商
      const mfrAttr = attrsData.result.find(
        (a) =>
          a.name.toLowerCase().includes('изготовитель') ||
          a.name.toLowerCase().includes('производитель')
      );
      if (mfrAttr && !ozonFormattedAttrs.some((a) => a.id === mfrAttr.id)) {
        ozonFormattedAttrs.push({
          id: mfrAttr.id,
          complex_id: 0,
          values: [{ dictionary_value_id: 0, value: config.DEFAULTS.manufacturer }],
        });
      }
    }
  }

  // 组装清洗数据
  const { item, meta } = cleanProduct(scrapedData, categoryInfo, ozonFormattedAttrs, {
    price: opts.price,
    old_price: opts.old_price,
  });

  // 图片下载
  console.log(`     正在下载图片...`);
  const imgResult = await downloadProductImages(scrapedData);
  if (imgResult.doneCount > 0) {
    if (item.primary_image && imgResult.localMap[item.primary_image]) {
      item._primary_image_local = imgResult.localMap[item.primary_image];
    }
    item._images_local = item.images.map((url) => imgResult.localMap[url] || null);
    meta.images_downloaded = imgResult.doneCount;
    meta.images_failed = imgResult.failCount;
    meta.images_mapping = imgResult.mappingFile;
  }

  console.log(`     offer_id: ${item.offer_id}`);
  console.log(`     尺寸: ${item.depth}x${item.width}x${item.height}mm  重量: ${item.weight}g`);
  console.log(`     图片: ${item.images.length + 1}张 (已下载${imgResult.doneCount}张)  属性: ${item.attributes.length}项`);

  return { item, meta, matchReport };
}

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  OZON 批量商品数据清洗');
  console.log('========================================');

  // 查找所有商品 JSON 文件
  const inputDir = path.resolve(opts.dir);
  const jsonFiles = fs
    .readdirSync(inputDir)
    .filter((f) => f.match(/^ozon-product.*\.json$/))
    .map((f) => path.join(inputDir, f));

  if (jsonFiles.length === 0) {
    console.error(`❌ 在 ${inputDir} 中未找到 ozon-product-*.json 文件`);
    process.exit(1);
  }

  console.log(`\n📁 找到 ${jsonFiles.length} 个商品文件`);

  // 初始化 API（如果有凭证）
  const hasCredentials = config.OZON_CLIENT_ID && config.OZON_API_KEY;
  const api = hasCredentials ? new OzonApiClient() : null;

  if (!hasCredentials) {
    console.log('⚠️  离线模式（未配置 API 凭证）');
  }

  // 加载分类树
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  const cacheTreePath = path.join(config.CACHE_DIR, 'category_tree.json');
  let treeData = null;

  if (fs.existsSync(cacheTreePath)) {
    treeData = JSON.parse(fs.readFileSync(cacheTreePath, 'utf-8'));
    console.log('📂 已从缓存加载分类树');
  } else if (api) {
    treeData = await api.getCategoryTree();
    console.log('📂 已从 API 获取并缓存分类树');
  }

  // 逐个处理
  const allItems = [];
  const reports = [];
  let successCount = 0;
  let failCount = 0;

  for (const filePath of jsonFiles) {
    try {
      const result = await processOneProduct(filePath, api, treeData, opts);
      allItems.push(result.item);
      reports.push({
        file: path.basename(filePath),
        offer_id: result.item.offer_id,
        status: 'success',
        unmatched_count: result.matchReport.unmatched.length,
      });
      successCount++;
    } catch (err) {
      console.error(`  ❌ 处理失败: ${err.message}`);
      reports.push({
        file: path.basename(filePath),
        status: 'error',
        error: err.message,
      });
      failCount++;
    }
  }

  // 输出汇总
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  // 按 100 个一组分批（OZON API 限制每次 100 个）
  const BATCH_SIZE = 100;
  for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
    const batch = allItems.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchFile = path.join(config.OUTPUT_DIR, `batch_import_${batchNum}.json`);
    fs.writeFileSync(batchFile, JSON.stringify({ items: batch }, null, 2), 'utf-8');
    console.log(`\n✅ 批次 ${batchNum}: ${batch.length} 个商品 → ${batchFile}`);
  }

  // 输出批量报告
  const batchReport = {
    total: jsonFiles.length,
    success: successCount,
    failed: failCount,
    batches: Math.ceil(allItems.length / BATCH_SIZE),
    details: reports,
    generated_at: new Date().toISOString(),
  };
  const reportFile = path.join(config.OUTPUT_DIR, 'batch_report.json');
  fs.writeFileSync(reportFile, JSON.stringify(batchReport, null, 2), 'utf-8');

  console.log(`\n📋 批量报告: ${reportFile}`);
  console.log(`\n========================================`);
  console.log(`  总计: ${jsonFiles.length} | 成功: ${successCount} | 失败: ${failCount}`);
  console.log(`========================================\n`);
}

main().catch((err) => {
  console.error('❌ 批量处理出错:', err.message);
  process.exit(1);
});
