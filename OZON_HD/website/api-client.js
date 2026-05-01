/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON SaaS API client used by the local dashboard.
 */
class OzonSaasClient {
  constructor(baseUrl = 'http://localhost:3001') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = null;
    this.apiKey = null;
  }

  setToken(token) { this.token = token; }
  setApiKey(apiKey) { this.apiKey = apiKey; }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };

    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    else if (this.apiKey) headers.Authorization = `ApiKey ${this.apiKey}`;

    const resp = await fetch(url, { ...options, headers });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  async register(email, password, displayName = '') {
    const data = await this._fetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
    this.token = data.token;
    return data;
  }

  async login(email, password) {
    const data = await this._fetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.token = data.token;
    return data;
  }

  async getMe() {
    return this._fetch('/me');
  }

  async updateMe(payload) {
    return this._fetch('/me', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async changePassword(currentPassword, newPassword) {
    return this._fetch('/me/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
  }

  async regenerateApiKey() {
    return this._fetch('/me/regenerate-api-key', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getDevices() {
    return this._fetch('/devices');
  }

  async createDevice(name) {
    return this._fetch('/devices', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async deleteDevice(deviceId) {
    return this._fetch(`/devices/${deviceId}`, { method: 'DELETE' });
  }

  async getStores() {
    return this._fetch('/stores');
  }

  async addStore(storeName, ozonClientId, ozonApiKey, cloudStoreId = null) {
    return this._fetch('/stores', {
      method: 'POST',
      body: JSON.stringify({
        store_name: storeName,
        ozon_client_id: ozonClientId,
        ozon_api_key: ozonApiKey,
        cloud_store_id: cloudStoreId,
      }),
    });
  }

  async deleteStore(storeId) {
    return this._fetch(`/stores/${storeId}`, { method: 'DELETE' });
  }

  async collectProduct(scrapedJson, price, storeId) {
    return this._fetch('/products/collect', {
      method: 'POST',
      body: JSON.stringify({ scrapedJson, price, store_id: storeId }),
    });
  }

  async getProducts(page = 1, limit = 20) {
    return this._fetch(`/products?page=${page}&limit=${limit}`);
  }

  async getProduct(productId) {
    return this._fetch(`/products/${productId}`);
  }

  async uploadProducts(productIds, storeId) {
    return this._fetch('/products/upload', {
      method: 'POST',
      body: JSON.stringify({ product_ids: productIds, store_id: storeId }),
    });
  }

  async getProductStatus(productId) {
    return this._fetch(`/products/${productId}/status`);
  }

  async getSubscription() {
    return this._fetch('/subscription');
  }

  async upgradeSubscription(plan, paymentId) {
    return this._fetch('/subscription/upgrade', {
      method: 'POST',
      body: JSON.stringify({ plan, payment_id: paymentId }),
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OzonSaasClient };
}

if (typeof window !== 'undefined') {
  window.OzonSaasClient = OzonSaasClient;
}
