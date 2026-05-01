/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON 商品数据清洗主脚本
 *
 * 工作流程：
 * 1. 读取抓取的商品 JSON
 * 2. 调用 OZON API 获取分类树 → 匹配 description_category_id + type_id
 * 3. 获取该分类的属性定义 → 匹配属性 ID
 * 4. 获取字典属性的可选值 → 匹配 dictionary_value_id
 * 5. 应用默认值（货币 CNY、品牌、制造商、尺寸、重量等）
 * 6. 输出符合 /v3/product/import 格式的 JSON
 *
 * 用法：
 *   node main.js <商品JSON文件路径> [--price 价格] [--old-price 原价]
 *
 * 环境变量：
 *   OZON_CLIENT_ID - 你的 OZON 卖家 Client-Id
 *   OZON_API_KEY   - 你的 OZON 卖家 API-Key
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const OzonApiClient = require('./ozon_api');
const { findBestMatch, searchByKeyword } = require('./category_finder');
const { matchAttributes } = require('./attribute_matcher');
const { cleanProduct, getCharValue } = require('./product_cleaner');
const { downloadProductImages } = require('./image_downloader');

// ========== 参数解析 ==========
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { price: '0', old_price: '0' };
  let inputFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--price' && args[i + 1]) {
      opts.price = args[++i];
    } else if (args[i] === '--old-price' && args[i + 1]) {
      opts.old_price = args[++i];
    } else if (!args[i].startsWith('--')) {
      inputFile = args[i];
    }
  }

  return { inputFile, opts };
}

// ========== 主流程 ==========
async function main() {
  const { inputFile, opts } = parseArgs();

  // ---- 1. 确定输入文件 ----
  let jsonPath = inputFile;
  if (!jsonPath) {
    const files = fs.readdirSync('.').filter(
      (f) => f.endsWith('.json') && f.startsWith('ozon-product')
    );
    if (files.length === 0) {
      console.error('❌ 未找到商品 JSON 文件。用法: node main.js <文件路径>');
      process.exit(1);
    }
    jsonPath = files[0];
    console.log(`📄 自动检测到商品文件: ${jsonPath}`);
  }

  console.log('\n========================================');
  console.log('  OZON 商品数据清洗工具');
  console.log('========================================\n');

  const scrapedData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log(`✅ 已加载商品: ${scrapedData.title}`);
  console.log(`   来源: ${scrapedData.sourceUrl || '未知'}`);
  console.log(`   特征数: ${(scrapedData.characteristics || []).length}`);
  console.log(`   图片数: ${(scrapedData.gallery?.images || []).length}`);

  // ---- 2. 检查 API 凭证 ----
  const hasCredentials = config.OZON_CLIENT_ID && config.OZON_API_KEY;

  if (!hasCredentials) {
    console.log('\n⚠️  未配置 OZON API 凭证');
    console.log('   请设置环境变量 OZON_CLIENT_ID 和 OZON_API_KEY');
    console.log('   或在 config.js 中填写');
    console.log('\n   现在将使用离线模式（跳过 API 查询，使用缓存或占位符）\n');
  }

  const api = hasCredentials ? new OzonApiClient() : null;

  // ---- 3. 获取分类树并匹配 ----
  console.log('\n--- 步骤 1: 分类匹配 ---');
  let categoryInfo = null;
  const cacheCategoryTree = path.join(config.CACHE_DIR, 'category_tree.json');
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });

  let treeData = null;
  if (fs.existsSync(cacheCategoryTree)) {
    console.log(`  [缓存] 从本地加载分类树: ${cacheCategoryTree}`);
    treeData = JSON.parse(fs.readFileSync(cacheCategoryTree, 'utf-8'));
  } else if (api) {
    treeData = await api.getCategoryTree();
  }

  if (treeData) {
    const breadcrumbs = (scrapedData.breadcrumbs || []).map((b) => b.text);
    const typeName = getCharValue(scrapedData.characteristics || [], 'Тип') || '';

    console.log(`  面包屑: ${breadcrumbs.join(' > ')}`);
    console.log(`  商品类型: ${typeName}`);

    const match = findBestMatch(treeData, breadcrumbs, typeName);

    if (match) {
      categoryInfo = {
        description_category_id: match.description_category_id,
        type_id: match.type_id,
      };
      console.log(`  ✅ 匹配成功!`);
      console.log(`     路径: ${match.path.join(' > ')}`);
      console.log(`     description_category_id: ${match.description_category_id}`);
      console.log(`     type_id: ${match.type_id}`);
      console.log(`     匹配分数: ${match.score}`);
    } else {
      console.log('  ⚠️  未找到精确匹配，尝试关键词搜索...');
      const results = searchByKeyword(treeData, 'чемодан');
      if (results.length > 0) {
        console.log(`  找到 ${results.length} 个可能的匹配:`);
        results.slice(0, 5).forEach((r, i) => {
          console.log(`    ${i + 1}. ${r.path.join(' > ')} (type_id: ${r.type_id})`);
        });
        categoryInfo = {
          description_category_id: results[0].description_category_id,
          type_id: results[0].type_id,
        };
        console.log(`  ℹ️  自动选择第一个匹配`);
      }
    }
  }

  if (!categoryInfo) {
    console.log('  ⚠️  无法确定分类。使用占位符（需要手动填写）');
    categoryInfo = {
      description_category_id: 0,
      type_id: 0,
    };
  }

  // ---- 4. 获取属性并匹配 ----
  console.log('\n--- 步骤 2: 属性匹配 ---');
  let ozonFormattedAttrs = [];
  let matchReport = { matched: [], unmatched: [] };

  const cacheAttrsKey = `attrs_${categoryInfo.description_category_id}_${categoryInfo.type_id}`;
  const cacheAttrsFile = path.join(config.CACHE_DIR, `${cacheAttrsKey}.json`);

  let attrsData = null;
  if (fs.existsSync(cacheAttrsFile)) {
    console.log(`  [缓存] 从本地加载属性定义: ${cacheAttrsFile}`);
    attrsData = JSON.parse(fs.readFileSync(cacheAttrsFile, 'utf-8'));
  } else if (api && categoryInfo.description_category_id > 0) {
    attrsData = await api.getCategoryAttributes(
      categoryInfo.description_category_id,
      categoryInfo.type_id
    );
  }

  if (attrsData && attrsData.result) {
    const ozonAttrs = attrsData.result;
    console.log(`  OZON 属性总数: ${ozonAttrs.length}`);
    console.log(`  必填属性: ${ozonAttrs.filter((a) => a.is_required).length}`);

    // 字典值获取函数
    const getDictValues = async (attrId) => {
      const attr = ozonAttrs.find((a) => a.id === attrId);
      if (!attr || !attr.dictionary_id) return [];

      const dictKey = `dict_${attrId}_${categoryInfo.description_category_id}_${categoryInfo.type_id}`;
      const dictFile = path.join(config.CACHE_DIR, `${dictKey}.json`);

      if (fs.existsSync(dictFile)) {
        const cached = JSON.parse(fs.readFileSync(dictFile, 'utf-8'));
        return cached.result || [];
      }

      if (api) {
        const data = await api.getAttributeValues(
          attrId,
          categoryInfo.description_category_id,
          categoryInfo.type_id
        );
        return data.result || [];
      }

      return [];
    };

    matchReport = await matchAttributes(
      scrapedData.characteristics || [],
      ozonAttrs,
      getDictValues
    );
    ozonFormattedAttrs = matchReport.ozonFormat;

    console.log(`  ✅ 已匹配属性: ${matchReport.matched.length}`);
    if (matchReport.unmatched.length > 0) {
      console.log(`  ⚠️  未匹配属性: ${matchReport.unmatched.length}`);
      matchReport.unmatched.forEach((u) => {
        console.log(`     - ${u.name}: ${u.valueText}`);
      });
    }

    // 补充品牌属性
    const brandAttr = ozonAttrs.find(
      (a) => a.name.toLowerCase().includes('бренд') || a.name.toLowerCase() === 'brand'
    );
    if (brandAttr) {
      const alreadyHasBrand = ozonFormattedAttrs.some((a) => a.id === brandAttr.id);
      if (!alreadyHasBrand) {
        let brandValue = { dictionary_value_id: 0, value: config.DEFAULTS.brand };
        if (brandAttr.dictionary_id && api) {
          const dictValues = await getDictValues(brandAttr.id);
          // 搜索"Нет бренда"或类似的无品牌选项
          const noBrand = dictValues.find(
            (dv) =>
              dv.value.toLowerCase().includes('нет бренда') ||
              dv.value.toLowerCase().includes('без бренда') ||
              dv.value.toLowerCase().includes('no brand')
          );
          if (noBrand) {
            brandValue = { dictionary_value_id: noBrand.id, value: noBrand.value };
          }
        }
        ozonFormattedAttrs.push({
          id: brandAttr.id,
          complex_id: 0,
          values: [brandValue],
        });
        console.log(`  ℹ️  已补充品牌属性: ${brandValue.value}`);
      }
    }

    // 补充制造商属性
    const mfrAttr = ozonAttrs.find(
      (a) =>
        a.name.toLowerCase().includes('изготовитель') ||
        a.name.toLowerCase().includes('производитель') ||
        a.name.toLowerCase() === 'manufacturer'
    );
    if (mfrAttr) {
      const alreadyHasMfr = ozonFormattedAttrs.some((a) => a.id === mfrAttr.id);
      if (!alreadyHasMfr) {
        ozonFormattedAttrs.push({
          id: mfrAttr.id,
          complex_id: 0,
          values: [{ dictionary_value_id: 0, value: config.DEFAULTS.manufacturer }],
        });
        console.log(`  ℹ️  已补充制造商属性: ${config.DEFAULTS.manufacturer}`);
      }
    }
  } else {
    console.log('  ⚠️  无法获取属性定义（需要 API 凭证或本地缓存）');
    console.log('     属性将留空，请后续手动补充');
  }

  // ---- 5. 组装最终数据 ----
  console.log('\n--- 步骤 3: 数据组装 ---');
  const { item, meta } = cleanProduct(scrapedData, categoryInfo, ozonFormattedAttrs, {
    price: opts.price,
    old_price: opts.old_price,
  });

  console.log(`  offer_id: ${item.offer_id}`);
  console.log(`  名称: ${item.name}`);
  console.log(`  分类ID: ${item.description_category_id}`);
  console.log(`  类型ID: ${item.type_id}`);
  console.log(`  货币: ${item.currency_code}`);
  console.log(`  尺寸: ${item.depth}x${item.width}x${item.height} ${item.dimension_unit} (${meta.dimensions_source})`);
  console.log(`  重量: ${item.weight}${item.weight_unit} (${meta.weight_source})`);
  console.log(`  主图: ${item.primary_image ? '有' : '无'}`);
  console.log(`  附图: ${item.images.length} 张`);
  console.log(`  属性: ${item.attributes.length} 项`);
  console.log(`  价格: ${item.price} ${item.currency_code}`);

  // ---- 6. 图片下载 ----
  console.log('\n--- 步骤 4: 图片下载 ---');
  const imgResult = await downloadProductImages(scrapedData);

  if (imgResult.doneCount > 0) {
    // 替换 item 中的图片 URL 为本地路径
    if (item.primary_image && imgResult.localMap[item.primary_image]) {
      item._primary_image_local = imgResult.localMap[item.primary_image];
    }
    item._images_local = item.images.map((url) => imgResult.localMap[url] || null);
    meta.images_downloaded = imgResult.doneCount;
    meta.images_failed = imgResult.failCount;
    meta.images_mapping = imgResult.mappingFile;
  }

  console.log(`  ✅ 下载成功: ${imgResult.doneCount}  ❌ 失败: ${imgResult.failCount}`);

  // ---- 7. 输出结果 ----
  console.log('\n--- 步骤 5: 输出结果 ---');
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  // 输出完整的 API 请求体
  const importPayload = { items: [item] };
  const outputFile = path.join(
    config.OUTPUT_DIR,
    `product_import_${meta.source_product_id || 'unknown'}.json`
  );
  fs.writeFileSync(outputFile, JSON.stringify(importPayload, null, 2), 'utf-8');
  console.log(`  ✅ API 请求体已保存: ${outputFile}`);

  // 输出清洗报告
  const report = {
    summary: {
      input_file: jsonPath,
      product_title: item.name,
      offer_id: item.offer_id,
      category_matched: categoryInfo.description_category_id > 0,
      attributes_matched: matchReport.matched.length,
      attributes_unmatched: matchReport.unmatched.length,
      dimensions_source: meta.dimensions_source,
      weight_source: meta.weight_source,
    },
    category: categoryInfo,
    unmatched_attributes: matchReport.unmatched.map((u) => ({
      name: u.name,
      value: u.valueText,
    })),
    warnings: [],
    meta,
  };

  if (item.price === '0') {
    report.warnings.push('价格为 0，请使用 --price 参数指定价格');
  }
  if (categoryInfo.description_category_id === 0) {
    report.warnings.push(
      '分类未匹配，请配置 API 凭证后重新运行，或手动在输出文件中填写 description_category_id 和 type_id'
    );
  }
  if (matchReport.unmatched.length > 0) {
    report.warnings.push(
      `${matchReport.unmatched.length} 个属性未能自动匹配，可能需要手动补充`
    );
  }

  const reportFile = path.join(
    config.OUTPUT_DIR,
    `clean_report_${meta.source_product_id || 'unknown'}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  📋 清洗报告已保存: ${reportFile}`);

  // 输出警告
  if (report.warnings.length > 0) {
    console.log('\n⚠️  注意事项:');
    report.warnings.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));
  }

  console.log('\n========================================');
  console.log('  清洗完成！');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('❌ 执行出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});
