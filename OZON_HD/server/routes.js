/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * REST API routes for the local OZON_HD service.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const { stores } = require('./db');
const {
  authMiddleware,
  signToken,
  resolveUserFromAuthorizationHeader,
  hashDeviceToken,
} = require('./auth');
const { encrypt } = require('./crypto');
const { addJob } = require('./queue');
const cloudUploadClient = require('./cloud_upload_client');

const router = express.Router();

const PLAN_STORE_LIMITS = { free: 1, basic: 2, pro: 5, enterprise: 999 };
const PLANS = {
  free: { limit: 5, price: 0 },
  basic: { limit: 100, price: 99 },
  pro: { limit: 500, price: 299 },
  enterprise: { limit: 99999, price: 799 },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDisplayName(value, fallbackEmail = '') {
  const raw = String(value || '').trim();
  if (raw) {
    return raw.slice(0, 80);
  }
  const fallback = String(fallbackEmail || '').split('@')[0].trim();
  return fallback ? fallback.slice(0, 80) : 'User';
}

function generateApiKey() {
  return `ozon_${crypto.randomBytes(24).toString('hex')}`;
}

function generateDeviceToken() {
  return `ozd_${crypto.randomBytes(24).toString('hex')}`;
}

function buildUserPayload(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name || normalizeDisplayName('', user.email),
    plan: user.plan,
    plan_expires_at: user.plan_expires_at,
    monthly_upload_limit: user.monthly_upload_limit,
    monthly_upload_count: user.monthly_upload_count || 0,
    api_key: user.api_key,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at || null,
  };
}

function buildDevicePayload(device) {
  if (!device) {
    return null;
  }
  return {
    id: device.id,
    name: device.name,
    token_preview: device.token_preview || null,
    last_used_at: device.last_used_at || null,
    revoked_at: device.revoked_at || null,
    created_at: device.created_at,
    updated_at: device.updated_at,
  };
}

function normalizePriceInput(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(2);
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const match = text.replace(/\s+/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!match) {
    return null;
  }

  const numericValue = Number(match[0].replace(',', '.'));
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : null;
}

function normalizeCloudStoreId(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

function getDefaultStoreForUser(user, explicitStoreId = null) {
  if (explicitStoreId) {
    return stores.ozon_stores.findOne(
      (store) => store.id === explicitStoreId && store.user_id === user.id
    );
  }

  return (
    stores.ozon_stores.findOne((store) => store.user_id === user.id && store.is_default) ||
    stores.ozon_stores.findOne((store) => store.user_id === user.id) ||
    null
  );
}

function insertScrapedProduct({
  user,
  storeId,
  data,
  price,
  oldPrice = '0',
  followMinPrice = null,
  model = '',
  status = 'draft',
}) {
  const productId = uuid();
  const title = data.title || 'Untitled product';
  const sourceProductId = String(data.productId || '');
  const imagesCount = data.gallery?.images?.length || 0;

  stores.products.insert({
    id: productId,
    user_id: user.id,
    store_id: storeId,
    source_product_id: sourceProductId,
    title,
    offer_id: null,
    scraped_json: data,
    status,
    ozon_task_id: null,
    ozon_product_id: null,
    cloud_upload_job_id: null,
    cloud_upload_status: null,
    cloud_store_id: null,
    errors: null,
    price: price || '0',
    old_price: oldPrice || '0',
    follow_min_price: followMinPrice || null,
    model: model || '',
    images_count: imagesCount,
  });

  return {
    productId,
    title,
    sourceProductId,
    imagesCount,
  };
}

function getRelatedJobs(productId) {
  return stores.jobs
    .find((job) => job.payload?.productId === productId)
    .sort((left, right) => (right.created_at || '').localeCompare(left.created_at || ''));
}

function resolveExtensionUser(req) {
  const header = req.headers.authorization || '';
  if (header) {
    try {
      const user = resolveUserFromAuthorizationHeader(header);
      if (user) {
        return user;
      }
    } catch (_error) {
      // Fall through to local single-user mode.
    }
  }

  const users = stores.users.all();
  if (users.length === 1) {
    return users[0];
  }

  if (users.length === 0) {
    throw new Error('OZON_HD has no registered user. Create one in the local dashboard first.');
  }

  throw new Error('OZON_HD has multiple users. Provide Authorization: ApiKey <key>.');
}

async function buildProductStatusPayload(product, includeOzonStatus = true) {
  const result = {
    product_id: product.id,
    source_product_id: product.source_product_id,
    title: product.title,
    offer_id: product.offer_id || null,
    status: product.status,
    price: product.price,
    images_count: product.images_count,
    ozon_task_id: product.ozon_task_id,
    ozon_product_id: product.ozon_product_id,
    cloud_upload_job_id: product.cloud_upload_job_id || null,
    cloud_upload_status: product.cloud_upload_status || null,
    cloud_store_id: product.cloud_store_id || null,
    errors: product.errors,
    attributes_count: product.attributes_count || (product.cleaned_item?.attributes || []).length || 0,
    category_info: product.category_info || null,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };

  if (!includeOzonStatus || !product.cloud_upload_job_id || product.status !== 'uploaded') {
    return result;
  }

  try {
    const remoteJob = await cloudUploadClient.refreshUploadJob(product.cloud_upload_job_id);
    result.cloud_upload_status = remoteJob.status || result.cloud_upload_status;
    result.cloud_store_id = remoteJob.store_id || result.cloud_store_id;
    result.ozon_task_id = remoteJob.ozon_task_id || result.ozon_task_id;
    result.ozon_status = cloudUploadClient.extractOzonStatus(remoteJob);
    result.errors = remoteJob.error ? { error: remoteJob.error } : result.errors;

    const nextProductState = {
      cloud_upload_status: remoteJob.status || product.cloud_upload_status || null,
      cloud_store_id: remoteJob.store_id || product.cloud_store_id || null,
      ozon_task_id: remoteJob.ozon_task_id || product.ozon_task_id || null,
    };
    if (remoteJob.error) {
      nextProductState.errors = { error: remoteJob.error };
    }
    if (remoteJob.status === 'failed' || remoteJob.status === 'submit_failed') {
      nextProductState.status = 'failed';
    }
    stores.products.update(product.id, nextProductState);
  } catch (_error) {
    // Ignore transient cloud refresh failures.
  }

  return result;
}

// Public auth routes.
router.post('/auth/register', async (req, res) => {
  try {
    const { email, password, display_name } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = stores.users.findOne((user) => normalizeEmail(user.email) === normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'Email is already registered.' });
    }

    const id = uuid();
    const hash = await bcrypt.hash(password, 10);
    const apiKey = generateApiKey();
    const user = stores.users.insert({
      id,
      email: normalizedEmail,
      display_name: normalizeDisplayName(display_name, normalizedEmail),
      password_hash: hash,
      api_key: apiKey,
      plan: 'free',
      plan_expires_at: null,
      monthly_upload_limit: 5,
      monthly_upload_count: 0,
      last_login_at: new Date().toISOString(),
    });

    const token = signToken(id);
    res.json({ token, user: buildUserPayload(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const user = stores.users.findOne((item) => normalizeEmail(item.email) === normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const nextUser = stores.users.update(user.id, { last_login_at: new Date().toISOString() }) || user;
    const token = signToken(nextUser.id);
    res.json({
      token,
      user: buildUserPayload(nextUser),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public local-only route used by the browser extension.
router.post('/extension/one-click-upload', (req, res) => {
  try {
    const user = resolveExtensionUser(req);
    const { scrapedJson, price, old_price, follow_min_price, model, store_id } = req.body || {};
    if (!scrapedJson) {
      return res.status(400).json({ error: 'Missing scrapedJson.' });
    }

    const data = typeof scrapedJson === 'string' ? JSON.parse(scrapedJson) : scrapedJson;
    const normalizedPrice =
      normalizePriceInput(price) ||
      normalizePriceInput(data?.price) ||
      normalizePriceInput(data?.pricing?.uploadPrice) ||
      normalizePriceInput(data?.pricing?.priceText) ||
      normalizePriceInput(data?.pricing?.cardPriceText);
    const normalizedOldPrice =
      normalizePriceInput(old_price) ||
      normalizePriceInput(data?.pricing?.oldPrice) ||
      normalizePriceInput(data?.pricing?.originalPriceText) ||
      '0';
    const normalizedMinPrice =
      normalizePriceInput(follow_min_price) ||
      normalizePriceInput(data?.follow_config?.min_price) ||
      null;
    const normalizedModel = String(model || data?.follow_config?.model || '').trim().slice(0, 120);

    if (!normalizedPrice || Number(normalizedPrice) <= 0) {
      return res.status(400).json({ error: 'Missing upload price. Extract a buyer-side price first.' });
    }

    const store = getDefaultStoreForUser(user, store_id);
    if (!store) {
      return res.status(400).json({ error: 'No OZON store configured for the current OZON_HD user.' });
    }

    const enrichedData = {
      ...data,
      follow_config: {
        ...(data?.follow_config || {}),
        store_id: store.id,
        price: normalizedPrice,
        old_price: normalizedOldPrice,
        min_price: normalizedMinPrice,
        model: normalizedModel,
        updated_at: new Date().toISOString(),
      },
    };

    const inserted = insertScrapedProduct({
      user,
      storeId: store.id,
      data: enrichedData,
      price: normalizedPrice,
      oldPrice: normalizedOldPrice,
      followMinPrice: normalizedMinPrice,
      model: normalizedModel,
      status: 'queued',
    });

    const jobId = addJob('clean_and_upload', {
      productId: inserted.productId,
      userId: user.id,
      storeId: store.id,
    });

    res.json({
      ok: true,
      product_id: inserted.productId,
      job_id: jobId,
      title: inserted.title,
      status: 'queued',
      price: normalizedPrice,
      store_id: store.id,
    });
  } catch (err) {
    const statusCode = /registered user|multiple users|store configured|Missing upload price/i.test(
      err.message
    )
      ? 400
      : 500;
    res.status(statusCode).json({ error: err.message });
  }
});

router.get('/extension/products/:id/status', async (req, res) => {
  try {
    const user = resolveExtensionUser(req);
    const product = stores.products.findOne(
      (item) => item.id === req.params.id && item.user_id === user.id
    );
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const payload = await buildProductStatusPayload(product, true);
    const requestedJobId = String(req.query.job_id || '').trim();
    const relatedJobs = getRelatedJobs(product.id);
    const job = requestedJobId
      ? relatedJobs.find((item) => item.id === requestedJobId) || null
      : relatedJobs[0] || null;

    res.json({
      ok: true,
      ...payload,
      job_id: job?.id || null,
      job_status: job?.status || null,
      job_error: job?.error || null,
      job_result: job?.result || null,
    });
  } catch (err) {
    const statusCode = /registered user|multiple users|Product not found/i.test(err.message) ? 400 : 500;
    res.status(statusCode).json({ error: err.message });
  }
});

// Authenticated routes.
router.use(authMiddleware);

router.get('/me', (req, res) => {
  res.json(buildUserPayload(req.user));
});

router.patch('/me', (req, res) => {
  try {
    const nextDisplayName = normalizeDisplayName(req.body?.display_name, req.user.email);
    const updated = stores.users.update(req.user.id, { display_name: nextDisplayName });
    res.json({ ok: true, user: buildUserPayload(updated || req.user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/me/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required.' });
    }
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const user = stores.users.get(req.user.id);
    const valid = await bcrypt.compare(String(current_password), String(user?.password_hash || ''));
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await bcrypt.hash(String(new_password), 10);
    stores.users.update(req.user.id, { password_hash: passwordHash });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/me/regenerate-api-key', (req, res) => {
  try {
    const apiKey = generateApiKey();
    stores.users.update(req.user.id, { api_key: apiKey });
    res.json({ ok: true, api_key: apiKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/devices', (req, res) => {
  const devices = stores.devices
    .find((device) => device.user_id === req.user.id)
    .sort((left, right) => (right.created_at || '').localeCompare(left.created_at || ''))
    .map(buildDevicePayload);
  res.json(devices);
});

router.post('/devices', (req, res) => {
  try {
    const existingCount = stores.devices.count(
      (device) => device.user_id === req.user.id && !device.revoked_at
    );
    const token = generateDeviceToken();
    const name = String(req.body?.name || '').trim().slice(0, 80) || `Device ${existingCount + 1}`;
    const device = stores.devices.insert({
      id: uuid(),
      user_id: req.user.id,
      name,
      token_hash: hashDeviceToken(token),
      token_preview: `${token.slice(0, 12)}...${token.slice(-4)}`,
      last_used_at: null,
      revoked_at: null,
    });
    res.json({ ok: true, device: buildDevicePayload(device), token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/devices/:id', (req, res) => {
  const device = stores.devices.findOne(
    (item) => item.id === req.params.id && item.user_id === req.user.id
  );
  if (!device) {
    return res.status(404).json({ error: 'Device not found.' });
  }

  stores.devices.update(device.id, { revoked_at: new Date().toISOString() });
  res.json({ ok: true });
});

router.get('/stores', (req, res) => {
  const list = stores.ozon_stores.find((store) => store.user_id === req.user.id);
  res.json(
    list.map((store) => ({
      id: store.id,
      store_name: store.store_name,
      cloud_store_id: normalizeCloudStoreId(store.cloud_store_id),
      is_default: !!store.is_default,
      created_at: store.created_at,
    }))
  );
});

router.post('/stores', (req, res) => {
  try {
    const { store_name, ozon_client_id, ozon_api_key, cloud_store_id } = req.body || {};
    if (!store_name || !ozon_client_id || !ozon_api_key) {
      return res.status(400).json({ error: 'store_name, ozon_client_id and ozon_api_key are required.' });
    }

    const existing = stores.ozon_stores.find((store) => store.user_id === req.user.id);
    const limit = PLAN_STORE_LIMITS[req.user.plan] || 1;
    if (existing.length >= limit) {
      return res.status(403).json({ error: `Current plan supports up to ${limit} stores.` });
    }

    const id = uuid();
    const isDefault = existing.length === 0;

    stores.ozon_stores.insert({
      id,
      user_id: req.user.id,
      store_name,
      ozon_client_id_enc: encrypt(ozon_client_id),
      ozon_api_key_enc: encrypt(ozon_api_key),
      cloud_store_id: normalizeCloudStoreId(cloud_store_id),
      is_default: isDefault,
    });

    res.json({
      id,
      store_name,
      cloud_store_id: normalizeCloudStoreId(cloud_store_id),
      is_default: isDefault,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/stores/:id', (req, res) => {
  const store = stores.ozon_stores.findOne(
    (item) => item.id === req.params.id && item.user_id === req.user.id
  );
  if (!store) {
    return res.status(404).json({ error: 'Store not found.' });
  }

  stores.ozon_stores.delete(req.params.id);
  res.json({ ok: true });
});

router.post('/products/collect', (req, res) => {
  try {
    const { scrapedJson, price, store_id } = req.body || {};
    if (!scrapedJson) {
      return res.status(400).json({ error: 'Missing scrapedJson.' });
    }

    const data = typeof scrapedJson === 'string' ? JSON.parse(scrapedJson) : scrapedJson;
    const store = getDefaultStoreForUser(req.user, store_id);
    const storeId = store?.id || null;
    const inserted = insertScrapedProduct({
      user: req.user,
      storeId,
      data,
      price: normalizePriceInput(price) || '0',
      status: 'draft',
    });
    const jobId = addJob('clean', { productId: inserted.productId, userId: req.user.id, storeId });

    res.json({
      ok: true,
      product_id: inserted.productId,
      job_id: jobId,
      title: inserted.title,
      status: 'cleaning',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const result = stores.products.paginate((product) => product.user_id === req.user.id, page, limit);

  const products = result.items.map((product) => ({
    id: product.id,
    source_product_id: product.source_product_id,
    title: product.title,
    offer_id: product.offer_id,
    status: product.status,
    price: product.price,
    images_count: product.images_count,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }));

  res.json({
    products,
    pagination: {
      page,
      limit,
      total: result.total,
      pages: result.pages,
    },
  });
});

router.get('/products/:id', (req, res) => {
  const product = stores.products.findOne(
    (item) => item.id === req.params.id && item.user_id === req.user.id
  );
  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  res.json(product);
});

router.post('/products/upload', (req, res) => {
  try {
    const { product_ids, store_id } = req.body || {};
    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({ error: 'product_ids must be a non-empty array.' });
    }

    const user = req.user;
    const remaining = (user.monthly_upload_limit || 5) - (user.monthly_upload_count || 0);
    if (remaining <= 0 && user.plan !== 'enterprise') {
      return res.status(403).json({
        error: 'Monthly upload limit reached.',
        limit: user.monthly_upload_limit,
        used: user.monthly_upload_count,
      });
    }
    if (product_ids.length > remaining && user.plan !== 'enterprise') {
      return res.status(403).json({
        error: `Only ${remaining} uploads remain this month.`,
      });
    }

    const store = getDefaultStoreForUser(user, store_id);
    if (!store) {
      return res.status(400).json({ error: 'Bind an OZON store before uploading.' });
    }

    const jobs = [];
    for (const productId of product_ids) {
      const product = stores.products.findOne(
        (item) => item.id === productId && item.user_id === user.id
      );
      if (!product || product.status !== 'ready') {
        continue;
      }

      const jobId = addJob('upload', {
        productId,
        userId: user.id,
        storeId: store.id,
      });
      jobs.push({ product_id: productId, job_id: jobId });
    }

    res.json({ ok: true, submitted: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/:id/status', async (req, res) => {
  try {
    const product = stores.products.findOne(
      (item) => item.id === req.params.id && item.user_id === req.user.id
    );
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const payload = await buildProductStatusPayload(product, true);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/subscription', (req, res) => {
  const user = req.user;
  const limit = user.monthly_upload_limit || 5;
  const count = user.monthly_upload_count || 0;
  res.json({
    plan: user.plan,
    plan_expires_at: user.plan_expires_at,
    monthly_upload_limit: limit,
    monthly_upload_count: count,
    remaining: Math.max(0, limit - count),
  });
});

router.post('/subscription/upgrade', (req, res) => {
  const { plan, payment_id } = req.body || {};
  const planConfig = PLANS[plan];
  if (!planConfig) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  stores.users.update(req.user.id, {
    plan,
    plan_expires_at: expiresAt,
    monthly_upload_limit: planConfig.limit,
  });

  stores.subscriptions.insert({
    id: uuid(),
    user_id: req.user.id,
    plan,
    amount: planConfig.price,
    expires_at: expiresAt,
    payment_id: payment_id || null,
  });

  res.json({
    ok: true,
    plan,
    expires_at: expiresAt,
    monthly_limit: planConfig.limit,
  });
});

module.exports = router;
