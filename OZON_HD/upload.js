/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON 商品上传脚本
 *
 * 读取 output/ 中清洗好的 JSON，调用 /v3/product/import 接口上传到 OZON。
 *
 * 用法：
 *   node upload.js [batch_import_1.json]   上传指定批次文件
 *   node upload.js --all                   上传所有批次文件
 *   node upload.js --check <task_id>       查询上传任务状态
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const OzonApiClient = require('./ozon_api');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { files: [], checkTaskId: null, all: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1]) {
      opts.checkTaskId = args[++i];
    } else if (args[i] === '--all') {
      opts.all = true;
    } else if (!args[i].startsWith('--')) {
      opts.files.push(args[i]);
    }
  }

  return opts;
}

async function uploadBatch(api, filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const itemCount = (payload.items || []).length;

  console.log(`\n📤 上传: ${path.basename(filePath)} (${itemCount} 个商品)`);

  // 验证必填字段
  for (const item of payload.items) {
    const errors = [];
    if (!item.description_category_id) errors.push('缺少 description_category_id');
    if (!item.type_id) errors.push('缺少 type_id');
    if (item.price === '0') errors.push('价格为 0');
    if (!item.primary_image) errors.push('缺少主图');

    if (errors.length > 0) {
      console.log(`   ⚠️  ${item.offer_id}: ${errors.join(', ')}`);
      console.log('   跳过此商品（请先修正数据）');
      return null;
    }
  }

  const result = await api._post('/v3/product/import', payload);
  console.log(`   ✅ 上传成功! task_id: ${result.result?.task_id}`);
  return result;
}

async function checkTask(api, taskId) {
  console.log(`\n🔍 查询任务状态: ${taskId}`);
  const result = await api._post('/v1/product/import/info', { task_id: Number(taskId) });

  if (result.result && result.result.items) {
    console.log(`   总计: ${result.result.total} 个商品`);
    for (const item of result.result.items) {
      const status = item.status === 'imported' ? '✅' : item.status === 'failed' ? '❌' : '⏳';
      console.log(`   ${status} ${item.offer_id}: ${item.status}`);
      if (item.errors && item.errors.length > 0) {
        item.errors.forEach((e) => console.log(`      错误: ${JSON.stringify(e)}`));
      }
    }
  }

  return result;
}

async function main() {
  const opts = parseArgs();

  if (!config.OZON_CLIENT_ID || !config.OZON_API_KEY) {
    console.error('❌ 未配置 OZON API 凭证');
    console.error('   请设置环境变量 OZON_CLIENT_ID 和 OZON_API_KEY，或在 config.js 中填写');
    process.exit(1);
  }

  const api = new OzonApiClient();

  console.log('========================================');
  console.log('  OZON 商品上传工具');
  console.log('========================================');

  // 查询任务状态
  if (opts.checkTaskId) {
    await checkTask(api, opts.checkTaskId);
    return;
  }

  // 确定上传文件
  let files = opts.files;

  if (opts.all) {
    const outputDir = path.resolve(config.OUTPUT_DIR);
    files = fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('batch_import_') || f.startsWith('product_import_'))
      .map((f) => path.join(outputDir, f));
  }

  if (files.length === 0) {
    console.log('\n用法:');
    console.log('  node upload.js output/product_import_xxx.json   上传单个商品');
    console.log('  node upload.js --all                            上传所有批次');
    console.log('  node upload.js --check <task_id>                查询上传状态');
    return;
  }

  // 逐个上传
  const results = [];
  for (const file of files) {
    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`   ❌ 文件不存在: ${filePath}`);
      continue;
    }
    try {
      const result = await uploadBatch(api, filePath);
      if (result) {
        results.push({ file: path.basename(filePath), task_id: result.result?.task_id });
      }
    } catch (err) {
      console.error(`   ❌ 上传失败: ${err.message}`);
      results.push({ file: path.basename(filePath), error: err.message });
    }
  }

  // 输出汇总
  if (results.length > 0) {
    console.log('\n========================================');
    console.log('  上传汇总');
    console.log('========================================');
    results.forEach((r) => {
      if (r.task_id) {
        console.log(`  ✅ ${r.file} → task_id: ${r.task_id}`);
      } else {
        console.log(`  ❌ ${r.file} → ${r.error}`);
      }
    });
    console.log('\n提示: 使用 node upload.js --check <task_id> 查询上传结果');

    // 保存上传记录
    const logFile = path.join(config.OUTPUT_DIR, 'upload_log.json');
    let logs = [];
    if (fs.existsSync(logFile)) {
      logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    }
    logs.push({ timestamp: new Date().toISOString(), results });
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf-8');
  }
}

main().catch((err) => {
  console.error('❌ 执行出错:', err.message);
  process.exit(1);
});
