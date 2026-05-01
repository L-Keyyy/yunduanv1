/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * 轻量 JSON 文件数据库 — 零原生依赖，任何平台即装即用
 * 生产环境通过 Docker 切换到 PostgreSQL
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DB_PATH || path.join(__dirname, 'data');

class JsonStore {
  constructor(name) {
    this.name = name;
    this.file = path.join(DATA_DIR, `${name}.json`);
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    try {
      this._cache = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      this._cache = [];
    }
    return this._cache;
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this._cache, null, 2), 'utf-8');
  }

  all() { return this._load(); }

  find(predicate) { return this._load().filter(predicate); }

  findOne(predicate) { return this._load().find(predicate) || null; }

  get(id) { return this.findOne((r) => r.id === id); }

  insert(record) {
    this._load();
    record.created_at = record.created_at || new Date().toISOString();
    record.updated_at = record.updated_at || record.created_at;
    this._cache.push(record);
    this._save();
    return record;
  }

  update(id, changes) {
    this._load();
    const idx = this._cache.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    Object.assign(this._cache[idx], changes, { updated_at: new Date().toISOString() });
    this._save();
    return this._cache[idx];
  }

  delete(id) {
    this._load();
    const before = this._cache.length;
    this._cache = this._cache.filter((r) => r.id !== id);
    if (this._cache.length !== before) this._save();
    return before !== this._cache.length;
  }

  count(predicate) {
    return predicate ? this.find(predicate).length : this._load().length;
  }

  paginate(predicate, page = 1, limit = 20) {
    const all = predicate ? this.find(predicate) : this._load();
    const sorted = all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const offset = (page - 1) * limit;
    return {
      items: sorted.slice(offset, offset + limit),
      total: sorted.length,
      page,
      pages: Math.ceil(sorted.length / limit),
    };
  }
}

// 初始化数据目录
function migrate() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[DB] 数据目录:', DATA_DIR);
}

// 表实例（单例）
const stores = {
  users: new JsonStore('users'),
  devices: new JsonStore('devices'),
  ozon_stores: new JsonStore('ozon_stores'),
  products: new JsonStore('products'),
  subscriptions: new JsonStore('subscriptions'),
  jobs: new JsonStore('jobs'),
};

module.exports = { migrate, stores, JsonStore };

if (require.main === module) {
  migrate();
  console.log('[DB] 初始化完成');
}
