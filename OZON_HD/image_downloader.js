/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 图片下载模块
 * 从抓取的商品 JSON 中提取所有图片 URL，下载到本地 images/ 目录
 *
 * 可作为独立脚本运行：
 *   node image_downloader.js [商品JSON文件]
 *   node image_downloader.js --batch
 *
 * 也可作为模块引入：
 *   const { downloadProductImages } = require('./image_downloader');
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const IMAGES_DIR = 'images';
const CONCURRENCY = 5;

/**
 * 从商品 JSON 中提取所有图片 URL（去重）
 */
function extractImageUrls(data) {
  const urls = new Map();
  const productId = data.productId || 'unknown';

  // 商品主图 / gallery 图片
  if (data.gallery) {
    if (data.gallery.coverImage) {
      urls.set(data.gallery.coverImage, { type: 'gallery', index: 0 });
    }
    (data.gallery.images || []).forEach((img, i) => {
      if (img.src && !urls.has(img.src)) {
        urls.set(img.src, { type: 'gallery', index: i + 1 });
      }
    });
  }

  // 描述区图片
  if (data.description && data.description.images) {
    data.description.images.forEach((img, i) => {
      if (img.src && !urls.has(img.src)) {
        urls.set(img.src, { type: 'desc', index: i });
      }
    });
  }

  return urls;
}

/**
 * 从 URL 推断文件扩展名
 */
function getExtFromUrl(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  } catch {}
  return '.jpg';
}

/**
 * 下载单个文件
 */
function downloadFile(url, destPath, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;

    const req = transport.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('重定向次数过多'));
        return downloadFile(res.headers.location, destPath, maxRedirects - 1).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        const stat = fs.statSync(destPath);
        resolve(stat.size);
      });
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('下载超时'));
    });
  });
}

/**
 * 并发控制器
 */
async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then((r) => {
      executing.delete(p);
      return r;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}

/**
 * 处理单个商品的图片下载
 * @returns {object} 本地路径映射 { originalUrl: localPath }
 */
async function downloadProductImages(data) {
  const productId = data.productId || 'unknown';
  const productDir = path.join(IMAGES_DIR, String(productId));
  fs.mkdirSync(productDir, { recursive: true });

  const urlMap = extractImageUrls(data);
  const totalCount = urlMap.size;
  console.log(`  共 ${totalCount} 张图片待下载`);

  const localMap = {};
  let doneCount = 0;
  let failCount = 0;

  const tasks = [];
  for (const [url, info] of urlMap) {
    const ext = getExtFromUrl(url);
    const filename = `${info.type}_${String(info.index).padStart(3, '0')}${ext}`;
    const destPath = path.join(productDir, filename);

    tasks.push(() =>
      (async () => {
        // 已存在则跳过
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          doneCount++;
          localMap[url] = destPath;
          return { url, path: destPath, status: 'skipped' };
        }

        try {
          const size = await downloadFile(url, destPath);
          doneCount++;
          const progress = `[${doneCount}/${totalCount}]`;
          const sizeKb = (size / 1024).toFixed(1);
          process.stdout.write(`\r  ${progress} ${filename} (${sizeKb}KB)          `);
          localMap[url] = destPath;
          return { url, path: destPath, status: 'ok', size };
        } catch (err) {
          failCount++;
          return { url, path: destPath, status: 'error', error: err.message };
        }
      })()
    );
  }

  const results = await parallelLimit(tasks, CONCURRENCY);
  console.log('');

  // 生成映射文件
  const mappingFile = path.join(productDir, '_url_mapping.json');
  const mapping = {
    product_id: productId,
    downloaded_at: new Date().toISOString(),
    total: totalCount,
    success: doneCount,
    failed: failCount,
    files: {},
  };

  for (const r of results) {
    const val = r.status === 'fulfilled' ? r.value : { url: '?', status: 'error', error: r.reason?.message };
    mapping.files[val.url] = {
      local_path: val.path,
      status: val.status,
    };
  }

  fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf-8');

  return { localMap, totalCount, doneCount, failCount, mappingFile };
}

/**
 * 更新清洗后的 JSON，将图片 URL 替换为本地路径（或将来的上传 URL）
 */
function updateProductJson(outputJsonPath, localMap) {
  if (!fs.existsSync(outputJsonPath)) return;

  const data = JSON.parse(fs.readFileSync(outputJsonPath, 'utf-8'));
  const item = data.items?.[0];
  if (!item) return;

  if (item.primary_image && localMap[item.primary_image]) {
    item._primary_image_local = localMap[item.primary_image];
  }

  if (item.images) {
    item._images_local = item.images.map((url) => localMap[url] || null);
  }

  fs.writeFileSync(outputJsonPath, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { downloadProductImages, extractImageUrls };

// ========== 独立运行时的主流程 ==========
async function main() {
  const args = process.argv.slice(2);
  const isBatch = args.includes('--batch');

  console.log('========================================');
  console.log('  OZON 商品图片下载工具');
  console.log('========================================\n');

  // 确定输入文件
  let jsonFiles = [];
  if (isBatch) {
    jsonFiles = fs.readdirSync('.').filter((f) => f.match(/^ozon-product.*\.json$/));
  } else {
    const inputFile = args.find((a) => !a.startsWith('--'));
    if (inputFile) {
      jsonFiles = [inputFile];
    } else {
      jsonFiles = fs.readdirSync('.').filter((f) => f.match(/^ozon-product.*\.json$/));
    }
  }

  if (jsonFiles.length === 0) {
    console.error('❌ 未找到商品 JSON 文件');
    process.exit(1);
  }

  console.log(`📁 共 ${jsonFiles.length} 个商品文件\n`);

  let totalImages = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  for (const file of jsonFiles) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`📦 ${data.title || file}`);
    console.log(`   商品ID: ${data.productId}`);

    const result = await downloadProductImages(data);
    totalImages += result.totalCount;
    totalSuccess += result.doneCount;
    totalFail += result.failCount;

    console.log(`  ✅ 成功: ${result.doneCount}  ❌ 失败: ${result.failCount}`);
    console.log(`  📋 映射文件: ${result.mappingFile}`);

    // 尝试更新对应的清洗输出文件
    const outputFile = path.join('output', `product_import_${data.productId}.json`);
    if (fs.existsSync(outputFile)) {
      updateProductJson(outputFile, result.localMap);
      console.log(`  🔗 已更新输出文件: ${outputFile}`);
    }

    console.log('');
  }

  console.log('========================================');
  console.log(`  总计: ${totalImages} 张 | 成功: ${totalSuccess} | 失败: ${totalFail}`);
  console.log('========================================\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ 执行出错:', err.message);
    process.exit(1);
  });
}
