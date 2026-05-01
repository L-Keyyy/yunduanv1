/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 后台 Worker - 异步执行清洗/上传任务
 * 从队列取任务 → 调用上货模块 → 更新数据库状态
 */
const path = require('path');
const fs = require('fs');
const { stores } = require('./db');
const { pickNextJob, completeJob, failJob } = require('./queue');
const { decrypt } = require('./crypto');
const cloudUploadClient = require('./cloud_upload_client');

const uploaderPath = path.resolve(__dirname, '..');
const OzonApiClient = require(path.join(uploaderPath, 'ozon_api'));
const { findBestMatch, searchByKeyword, flattenTree } = require(path.join(uploaderPath, 'category_finder'));
const { matchAttributes } = require(path.join(uploaderPath, 'attribute_matcher'));
const { buildCharacteristicPool, cleanProduct, getCharValue } = require(path.join(uploaderPath, 'product_cleaner'));
const { downloadProductImages } = require(path.join(uploaderPath, 'image_downloader'));
const uploaderConfig = require(path.join(uploaderPath, 'config'));

const CATEGORY_STOP_WORDS = new Set([
  'для', 'под', 'над', 'при', 'это', 'или', 'без', 'с', 'со', 'из', 'в', 'во', 'на', 'по', 'к',
  'и', 'а', 'но', 'от', 'до', 'над', 'у', 'за', 'над', 'the', 'and'
]);

function normalizeCategoryText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenVariants(token) {
  const variants = new Set();
  const normalized = normalizeCategoryText(token);
  if (!normalized || normalized.length < 3) {
    return variants;
  }

  variants.add(normalized);

  const endings = [
    'иями', 'ями', 'ами', 'его', 'ого', 'ему', 'ому', 'ыми', 'ими',
    'ией', 'ей', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ам', 'ям',
    'ах', 'ях', 'ов', 'ев', 'ом', 'ем', 'ую', 'юю', 'ы', 'и', 'а', 'я', 'у', 'ю', 'о', 'е'
  ];

  for (const ending of endings) {
    if (normalized.endsWith(ending) && normalized.length - ending.length >= 3) {
      variants.add(normalized.slice(0, -ending.length));
    }
  }

  if (normalized.endsWith('ь') && normalized.length >= 4) {
    variants.add(normalized.slice(0, -1));
  }
  if (normalized.length >= 7) {
    variants.add(normalized.slice(0, -1));
  }
  if (normalized.length >= 8) {
    variants.add(normalized.slice(0, -2));
  }

  return variants;
}

function tokenizeCategoryText(value) {
  const tokens = new Set();
  for (const part of normalizeCategoryText(value).split(' ')) {
    if (!part || part.length < 3 || CATEGORY_STOP_WORDS.has(part)) {
      continue;
    }
    for (const variant of tokenVariants(part)) {
      if (!CATEGORY_STOP_WORDS.has(variant) && variant.length >= 3) {
        tokens.add(variant);
      }
    }
  }
  return [...tokens];
}

function buildCategorySignals(scrapedData) {
  const breadcrumbs = (scrapedData.breadcrumbs || []).map((item) => String(item?.text || '').trim()).filter(Boolean);
  const tailBreadcrumbs = breadcrumbs.slice(-4);
  const typeName = getCharValue(scrapedData.characteristics || [], 'Тип') || '';
  const title = String(scrapedData.title || '');

  const highPriorityTokens = new Set([
    ...tokenizeCategoryText(typeName),
    ...tailBreadcrumbs.slice(-2).flatMap((item) => tokenizeCategoryText(item)),
  ]);
  const mediumPriorityTokens = new Set([
    ...tokenizeCategoryText(title),
    ...tailBreadcrumbs.flatMap((item) => tokenizeCategoryText(item)),
  ]);

  return {
    breadcrumbs: tailBreadcrumbs,
    typeName,
    highPriorityTokens: [...highPriorityTokens],
    mediumPriorityTokens: [...mediumPriorityTokens],
  };
}

function categoryTextsEquivalent(left, right) {
  const normalizedLeft = normalizeCategoryText(left);
  const normalizedRight = normalizeCategoryText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft) ||
    (() => {
      const leftTokens = new Set(tokenizeCategoryText(normalizedLeft));
      const rightTokens = new Set(tokenizeCategoryText(normalizedRight));
      if (!leftTokens.size || !rightTokens.size) {
        return false;
      }

      let sharedCount = 0;
      for (const token of leftTokens) {
        if (rightTokens.has(token)) {
          sharedCount += 1;
        }
      }

      return sharedCount >= Math.min(2, leftTokens.size, rightTokens.size);
    })()
  );
}

function countBreadcrumbPrefixMatches(leafPath = [], breadcrumbs = []) {
  const normalizedLeafPath = (leafPath || []).map(normalizeCategoryText).filter(Boolean);
  const normalizedBreadcrumbs = (breadcrumbs || []).map(normalizeCategoryText).filter(Boolean);
  const compareLength = Math.min(normalizedLeafPath.length, normalizedBreadcrumbs.length);
  let matches = 0;

  for (let index = 0; index < compareLength; index += 1) {
    if (!categoryTextsEquivalent(normalizedLeafPath[index], normalizedBreadcrumbs[index])) {
      break;
    }
    matches += 1;
  }

  return matches;
}

function shouldLockDirectCategory(directMatch, breadcrumbs, typeName) {
  if (!directMatch) {
    return false;
  }

  const prefixMatches = countBreadcrumbPrefixMatches(directMatch.path || [], breadcrumbs || []);
  const requiredMatches = Math.min((directMatch.path || []).length, (breadcrumbs || []).length, 3);
  const strongBreadcrumbPath = requiredMatches >= 2 && prefixMatches >= requiredMatches;
  if (!strongBreadcrumbPath) {
    return false;
  }

  const normalizedType = normalizeCategoryText(typeName);
  if (!normalizedType) {
    return true;
  }

  return categoryTextsEquivalent(directMatch.type_name, normalizedType);
}

function rankCategoryCandidates(treeData, scrapedData, limit = 12) {
  const leaves = flattenTree(treeData).filter((leaf) => !leaf.disabled);
  const signals = buildCategorySignals(scrapedData);
  const normalizedType = normalizeCategoryText(signals.typeName);

  const ranked = [];
  for (const leaf of leaves) {
    const leafType = normalizeCategoryText(leaf.type_name);
    const leafPath = leaf.path.map(normalizeCategoryText);
    const leafPathText = leafPath.join(' > ');
    const leafText = `${leafPathText} > ${leafType}`;
    let score = 0;
    const matchedSignals = new Set();

    if (normalizedType) {
      if (leafType === normalizedType) {
        score += 90;
      } else if (leafType.includes(normalizedType) || normalizedType.includes(leafType)) {
        score += 48;
      }
    }

    signals.breadcrumbs.forEach((breadcrumb, index) => {
      const normalizedBreadcrumb = normalizeCategoryText(breadcrumb);
      if (!normalizedBreadcrumb) {
        return;
      }
      const exactWeight = 26 - index * 4;
      const partialWeight = 16 - index * 2;
      if (leafPathText.includes(normalizedBreadcrumb)) {
        score += exactWeight;
      } else {
        const breadcrumbTokens = tokenizeCategoryText(breadcrumb);
        if (breadcrumbTokens.some((token) => leafPathText.includes(token))) {
          score += partialWeight;
        }
      }
    });

    signals.highPriorityTokens.forEach((token) => {
      if (leafType.includes(token)) {
        score += 16;
        matchedSignals.add(token);
      } else if (leafText.includes(token)) {
        score += 8;
        matchedSignals.add(token);
      }
    });

    signals.mediumPriorityTokens.forEach((token) => {
      if (leafType.includes(token)) {
        score += 6;
        matchedSignals.add(token);
      } else if (leafText.includes(token)) {
        score += 3;
        matchedSignals.add(token);
      }
    });

    if (matchedSignals.size >= 2) {
      score += matchedSignals.size * 7;
    }

    if (score > 0) {
      ranked.push({ ...leaf, lexicalScore: score });
    }
  }

  ranked.sort((a, b) => b.lexicalScore - a.lexicalScore);
  const unique = [];
  const seen = new Set();
  for (const candidate of ranked) {
    const key = `${candidate.description_category_id}:${candidate.type_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

function hasMeaningfulAttribute(entry) {
  return Array.isArray(entry?.values) && entry.values.some((value) => {
    if (value?.dictionary_value_id && Number(value.dictionary_value_id) > 0) {
      return true;
    }
    return Boolean(String(value?.value || '').trim());
  });
}

function upsertAttribute(attributes, attr, values) {
  const existing = attributes.find((item) => item.id === attr.id);
  const nextValues = (values || []).filter((value) => {
    if (value?.dictionary_value_id && Number(value.dictionary_value_id) > 0) {
      return true;
    }
    return Boolean(String(value?.value || '').trim());
  });

  if (!nextValues.length) {
    return;
  }

  if (existing) {
    existing.complex_id = 0;
    existing.values = nextValues;
    return;
  }

  attributes.push({
    id: attr.id,
    complex_id: 0,
    values: nextValues,
  });
}

function extractDescriptionText(scrapedData) {
  const directText = String(scrapedData?.description?.text || '').trim();
  if (directText) {
    return directText;
  }

  const html = String(scrapedData?.description?.html || '');
  if (!html) {
    return '';
  }

  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeHashtag(tag) {
  const raw = String(tag || '').trim();
  if (!raw) {
    return '';
  }

  const token = raw
    .replace(/^#+/, '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_]+/gu, '');

  return token ? `#${token}` : '';
}

function buildHashtagText(scrapedData) {
  const tags = [...new Set((scrapedData?.hashtags || []).map(normalizeHashtag).filter(Boolean))];
  return tags.slice(0, 30).join(' ');
}

async function buildCountryAttributeValues(attr, getDictValues) {
  const fallbackValue = uploaderConfig.DEFAULTS.manufacturer || 'China';
  if (!attr?.dictionary_id) {
    return [{ dictionary_value_id: 0, value: fallbackValue }];
  }

  const dictValues = await getDictValues(attr.id);
  const match = dictValues.find((value) => {
    const normalized = String(value?.value || '').toLowerCase();
    return normalized.includes('китай') || normalized.includes('china') || normalized.includes('中国');
  });

  if (match) {
    return [{ dictionary_value_id: match.id, value: match.value }];
  }

  return [{ dictionary_value_id: 0, value: fallbackValue }];
}

async function resolveCategoryInfo(treeData, scrapedData, credentials) {
  const breadcrumbs = (scrapedData.breadcrumbs || []).map((item) => item.text);
  const typeName = getCharValue(scrapedData.characteristics || [], 'Тип') || '';
  const signals = buildCategorySignals(scrapedData);

  const directMatch = findBestMatch(treeData, breadcrumbs, typeName);
  const directCategoryLocked = shouldLockDirectCategory(directMatch, breadcrumbs, typeName);
  let fallbackCategory = { description_category_id: 0, type_id: 0 };

  if (directMatch) {
    fallbackCategory = {
      description_category_id: directMatch.description_category_id,
      type_id: directMatch.type_id,
    };
  } else {
    const keyword = typeName || breadcrumbs[breadcrumbs.length - 1] || '';
    const results = searchByKeyword(treeData, keyword);
    if (results.length > 0) {
      fallbackCategory = {
        description_category_id: results[0].description_category_id,
        type_id: results[0].type_id,
      };
    }
  }

  if (directCategoryLocked) {
    return {
      description_category_id: directMatch.description_category_id,
      type_id: directMatch.type_id,
      resolution: {
        strategy: 'locked-breadcrumb',
        attributeScore: null,
        compared: [{
          description_category_id: directMatch.description_category_id,
          type_id: directMatch.type_id,
          lexicalScore: directMatch.score || 0,
          attributeScore: null,
          path: directMatch.path || [],
          locked: true,
        }],
      },
    };
  }

  if (!credentials) {
    return {
      ...fallbackCategory,
      resolution: {
        strategy: directMatch ? 'direct' : 'keyword',
        compared: [],
      },
    };
  }

  const api = new OzonApiClient(credentials.clientId, credentials.apiKey);
  const candidates = rankCategoryCandidates(treeData, scrapedData, 10);
  const keywordTerms = [
    ...signals.highPriorityTokens,
    ...signals.mediumPriorityTokens.filter((token) => token.length >= 4),
    ...signals.breadcrumbs.slice(-2).map((item) => normalizeCategoryText(item)),
  ].filter(Boolean);
  const uniqueKeywordTerms = [...new Set(keywordTerms)].slice(0, 10);

  uniqueKeywordTerms.forEach((term, termIndex) => {
    const keywordMatches = searchByKeyword(treeData, term).slice(0, 5);
    keywordMatches.forEach((match, matchIndex) => {
      candidates.push({
        ...match,
        lexicalScore: 170 - termIndex * 8 - matchIndex * 6,
      });
    });
  });

  if (directMatch) {
    candidates.unshift({
      description_category_id: directMatch.description_category_id,
      type_id: directMatch.type_id,
      type_name: directMatch.type_name,
      path: directMatch.path,
      lexicalScore: (directMatch.score || 0) + 100,
    });
  } else if (fallbackCategory.description_category_id > 0 && fallbackCategory.type_id > 0) {
    candidates.unshift({
      ...fallbackCategory,
      type_name: '',
      path: [],
      lexicalScore: 100,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.description_category_id}:${candidate.type_id}`;
    if (!candidate.description_category_id || !candidate.type_id || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  let best = {
    ...fallbackCategory,
    attributeScore: -1,
    lexicalScore: directMatch?.score || 0,
  };
  const compared = [];

  for (const candidate of deduped) {
    try {
      const attrsData = await api.getCategoryAttributes(
        candidate.description_category_id,
        candidate.type_id
      );
      const attrs = attrsData?.result || [];
      if (!attrs.length) {
        compared.push({
          description_category_id: candidate.description_category_id,
          type_id: candidate.type_id,
          lexicalScore: candidate.lexicalScore || 0,
          attributeScore: 0,
          path: candidate.path || [],
        });
        continue;
      }

      // 这里只比较“名称能否命中”，不拉字典值，避免类目探测阶段额外放大 API 成本。
      const report = await matchAttributes(scrapedData.characteristics || [], attrs, async () => []);
      const attributeScore = report.ozonFormat.length;
      compared.push({
        description_category_id: candidate.description_category_id,
        type_id: candidate.type_id,
        lexicalScore: candidate.lexicalScore || 0,
        attributeScore,
        path: candidate.path || [],
      });

      const currentTotal = best.attributeScore * 1000 + (best.lexicalScore || 0);
      const nextTotal = attributeScore * 1000 + (candidate.lexicalScore || 0);
      if (nextTotal > currentTotal) {
        best = {
          description_category_id: candidate.description_category_id,
          type_id: candidate.type_id,
          attributeScore,
          lexicalScore: candidate.lexicalScore || 0,
        };
      }
    } catch (_error) {
      // Ignore individual candidate failures and continue with remaining candidates.
    }
  }

  return {
    description_category_id: best.description_category_id,
    type_id: best.type_id,
    resolution: {
      strategy: best.attributeScore >= 0 ? 'attribute-fit' : directMatch ? 'direct' : 'keyword',
      attributeScore: best.attributeScore >= 0 ? best.attributeScore : null,
      compared,
    },
  };
}

async function processClean(job) {
  const { productId, storeId } = job.payload;
  const product = stores.products.get(productId);
  if (!product) throw new Error('商品不存在');

  const scrapedData = typeof product.scraped_json === 'string'
    ? JSON.parse(product.scraped_json) : product.scraped_json;
  const normalizedScrapedData = {
    ...scrapedData,
    characteristics: buildCharacteristicPool(scrapedData),
  };

  let credentials = null;
  if (storeId) {
    const store = stores.ozon_stores.get(storeId);
    if (store) {
      credentials = {
        clientId: decrypt(store.ozon_client_id_enc),
        apiKey: decrypt(store.ozon_api_key_enc),
      };
    }
  }

  stores.products.update(productId, { status: 'cleaning' });

  // 分类匹配
  const cachePath = path.join(uploaderPath, 'cache', 'category_tree.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  let treeData = null;

  if (fs.existsSync(cachePath)) {
    treeData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } else if (credentials) {
    const api = new OzonApiClient(credentials.clientId, credentials.apiKey);
    treeData = await api.getCategoryTree();
  }

  let categoryInfo = { description_category_id: 0, type_id: 0 };
  if (treeData) {
    categoryInfo = await resolveCategoryInfo(treeData, normalizedScrapedData, credentials);
  }

  // 属性匹配
  let ozonFormattedAttrs = [];
  if (credentials && categoryInfo.description_category_id > 0) {
    const api = new OzonApiClient(credentials.clientId, credentials.apiKey);
    const attrsData = await api.getCategoryAttributes(
      categoryInfo.description_category_id, categoryInfo.type_id
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
        normalizedScrapedData.characteristics || [], attrsData.result, getDictValues
      );
      ozonFormattedAttrs = matchReport.ozonFormat;

      const brandAttr = attrsData.result.find((a) => a.name.toLowerCase().includes('бренд'));
      if (brandAttr && !ozonFormattedAttrs.some((a) => a.id === brandAttr.id)) {
        let brandValue = { dictionary_value_id: 0, value: uploaderConfig.DEFAULTS.brand };
        if (brandAttr.dictionary_id) {
          const dv = await getDictValues(brandAttr.id);
          const nb = dv.find((d) => d.value.toLowerCase().includes('нет бренда'));
          if (nb) brandValue = { dictionary_value_id: nb.id, value: nb.value };
        }
        ozonFormattedAttrs.push({ id: brandAttr.id, complex_id: 0, values: [brandValue] });
      }

      const countryAttr = attrsData.result.find(
        (a) =>
          a.id === 4389 ||
          a.name.toLowerCase().includes('страна-изготовитель') ||
          a.name.toLowerCase().includes('страна производства')
      );
      if (countryAttr && !hasMeaningfulAttribute(ozonFormattedAttrs.find((a) => a.id === countryAttr.id))) {
        upsertAttribute(
          ozonFormattedAttrs,
          countryAttr,
          await buildCountryAttributeValues(countryAttr, getDictValues)
        );
      }

      const annotationAttr = attrsData.result.find(
        (a) => a.id === 4191 || a.name.toLowerCase().includes('аннотац')
      );
      const annotationText = extractDescriptionText(normalizedScrapedData);
      if (annotationAttr && annotationText && !hasMeaningfulAttribute(ozonFormattedAttrs.find((a) => a.id === annotationAttr.id))) {
        upsertAttribute(ozonFormattedAttrs, annotationAttr, [
          { dictionary_value_id: 0, value: annotationText },
        ]);
      }

      const hashtagsAttr = attrsData.result.find(
        (a) => a.id === 23171 || a.name.toLowerCase().includes('хештег')
      );
      const hashtagText = buildHashtagText(normalizedScrapedData);
      if (hashtagsAttr && hashtagText && !hasMeaningfulAttribute(ozonFormattedAttrs.find((a) => a.id === hashtagsAttr.id))) {
        upsertAttribute(ozonFormattedAttrs, hashtagsAttr, [
          { dictionary_value_id: 0, value: hashtagText },
        ]);
      }
    }
  }

  const { item, meta } = cleanProduct(normalizedScrapedData, categoryInfo, ozonFormattedAttrs, {
    price: product.price || '0',
    old_price: product.old_price || normalizedScrapedData?.follow_config?.old_price || '0',
    min_price: product.follow_min_price || normalizedScrapedData?.follow_config?.min_price || null,
    model: product.model || normalizedScrapedData?.follow_config?.model || '',
  });

  const imgResult = await downloadProductImages(scrapedData);
  if (imgResult.doneCount > 0) {
    item._primary_image_local = imgResult.localMap[item.primary_image] || null;
    item._images_local = item.images.map((url) => imgResult.localMap[url] || null);
  }

  stores.products.update(productId, {
    cleaned_item: item,
    offer_id: item.offer_id,
    status: 'ready',
    images_count: meta.total_images,
    attributes: item.attributes,
    attributes_count: item.attributes.length,
    category_info: {
      description_category_id: item.description_category_id,
      type_id: item.type_id,
      resolution: categoryInfo.resolution || null,
    },
  });

  return { offer_id: item.offer_id, attributes: item.attributes.length, images: meta.total_images };
}

async function processUpload(job) {
  const { productId, userId, storeId } = job.payload;
  const product = stores.products.get(productId);
  if (!product || !product.cleaned_item) throw new Error('商品未清洗或不存在');

  const store = stores.ozon_stores.get(storeId);
  if (!store) throw new Error('店铺不存在');

  if (!cloudUploadClient.isEnabled()) {
    throw new Error('Cloud upload bridge is disabled. Set OZON_CLOUD_UPLOAD_ENABLED=1 to enable.');
  }

  stores.products.update(productId, {
    status: 'uploading',
    cloud_upload_status: 'submitting',
    errors: null,
  });

  const item = typeof product.cleaned_item === 'string'
    ? JSON.parse(product.cleaned_item) : product.cleaned_item;

  const payload = cloudUploadClient.buildUploadPayload({
    items: [item],
    localTaskId: job.id,
    source: 'ozon_hd_local',
    store,
  });
  const remoteJob = await cloudUploadClient.createUploadJob(payload);
  const remoteStatus = String(remoteJob?.status || 'submitted').trim() || 'submitted';
  const taskId = remoteJob?.ozon_task_id ? String(remoteJob.ozon_task_id) : '';
  const nextStatus = remoteStatus === 'submit_failed' || remoteStatus === 'failed'
    ? 'failed'
    : 'uploaded';

  stores.products.update(productId, {
    status: nextStatus,
    ozon_task_id: taskId,
    cloud_upload_job_id: remoteJob?.id || null,
    cloud_upload_status: remoteStatus,
    cloud_store_id: remoteJob?.store_id || null,
    errors: remoteJob?.error ? { error: remoteJob.error } : null,
  });

  if (nextStatus === 'failed') {
    throw new Error(remoteJob?.error || 'Cloud upload submission failed.');
  }

  // 增加用户用量
  const user = stores.users.get(userId);
  if (user) {
    stores.users.update(userId, { monthly_upload_count: (user.monthly_upload_count || 0) + 1 });
  }

  return {
    task_id: taskId || null,
    cloud_job_id: remoteJob?.id || null,
    cloud_status: remoteStatus,
  };
}

async function processCleanAndUpload(job) {
  const cleanResult = await processClean(job);
  const uploadResult = await processUpload(job);
  return { ...cleanResult, ...uploadResult };
}

const HANDLERS = {
  clean: processClean,
  upload: processUpload,
  clean_and_upload: processCleanAndUpload,
};

let running = false;

async function startWorkerLoop(intervalMs = 2000) {
  if (running) return;
  running = true;
  console.log('[Worker] 后台任务处理器已启动');

  while (running) {
    try {
      const job = pickNextJob();
      if (job) {
        console.log(`[Worker] 处理任务 ${job.id} (${job.type})`);
        const handler = HANDLERS[job.type];
        if (!handler) {
          failJob(job.id, `未知任务类型: ${job.type}`);
          continue;
        }
        try {
          const result = await handler(job);
          completeJob(job.id, result);
          console.log(`[Worker] 任务完成 ${job.id}`);
        } catch (err) {
          failJob(job.id, err.message);
          console.error(`[Worker] 任务失败 ${job.id}: ${err.message}`);
          stores.products.update(job.payload.productId, {
            status: 'failed', errors: { error: err.message },
          });
        }
      }
    } catch (err) {
      console.error('[Worker] 轮询异常:', err.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function stopWorker() { running = false; }

module.exports = { startWorkerLoop, stopWorker, processClean, processUpload };
