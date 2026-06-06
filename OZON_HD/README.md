# OZON 自动上货模块

> 把从 OZON 抓取的商品 JSON 清洗成符合 Seller API 格式的数据，一键上传到你的 OZON 店铺。

## 在整个系统中的位置

```
  +-----------------+       +------------------+       +------------------+
  |   抓取模块       |       |   上货模块(本模块)  |       |   Website 模块    |
  |   Scraper       |  -->  |   Cleaner+Upload |  <--  |   Seller 后台     |
  +-----------------+       +------------------+       +------------------+
  |                         |                          |
  | 浏览 OZON 商品页面       | 1. 数据清洗               | 采集列表管理
  | 抓取页面数据为 JSON      | 2. 分类/属性自动匹配      | 选择商品 → 触发上传
  | 输出: ozon-product-     | 3. 图片下载到本地          | 查看上传状态
  |       xxx.json          | 4. 调用 API 上传到 OZON   | 价格/库存管理
  |                         |                          |
  +-------------------------+--------------------------+
```

### 数据流

```
抓取模块输出 JSON
       |
       v
  clean(json, {price})     <-- Website 模块调用
       |
       |  1. 匹配 OZON 分类树 → description_category_id + type_id
       |  2. 匹配 50 个属性 → attribute_id + dictionary_value_id
       |  3. 尺寸 cm→mm / 重量 kg→g / 图片限制 15 张
       |  4. 自动填充：品牌(无品牌) / 制造商(China) / 货币(CNY) / 型号名(随机)
       |  5. 下载全部图片到 images/{productId}/
       |
       v
  upload(item)              <-- Website 模块在用户点击"上传"时调用
       |
       v
  OZON /v3/product/import → task_id
       |
       v
  check(taskId)             <-- Website 模块轮询状态
       |
       v
  imported / failed / pending
```

## 快速开始

### 1. 配置 API 凭证

二选一：

**方式 A - 环境变量（推荐）**
```bash
export OZON_CLIENT_ID=你的ClientId
export OZON_API_KEY=你的ApiKey
```

**方式 B - 直接写 config.js**
```js
// config.js
OZON_CLIENT_ID: '你的ClientId',
OZON_API_KEY: '你的ApiKey',
```

### 2. 命令行使用

```bash
# 清洗单个商品（含图片下载）+ 输出到 output/
node main.js ozon-product-xxx.json --price 299 --old-price 599

# 批量清洗所有 ozon-product-*.json
node batch_clean.js --price 299

# 上传到 OZON
node upload.js output/product_import_xxx.json

# 查询上传状态
node upload.js --check 4167243491
```

### 3. 程序化调用（给 Website 模块用）

```js
const ozon = require('./index');  // 或你的包路径

// ---- 场景 1: 抓取模块送来一个 JSON，先清洗存着 ----
const result = await ozon.clean(scrapedJson, {
  price: '299',
  old_price: '599',
  downloadImages: true,   // 下载图片到本地
  saveOutput: true,        // 保存到 output/
});

// result.item    → 可直接提交给 OZON 的商品对象
// result.meta    → 清洗元数据（来源URL、尺寸来源等）
// result.images  → 图片下载结果（本地路径映射）
// result.outputFile → 输出文件路径

// ---- 场景 2: 用户在 Website 后台点了"上传" ----
const uploadResult = await ozon.upload(result.item);

// uploadResult.task_id → OZON 返回的任务 ID

// ---- 场景 3: 轮询上传状态 ----
const status = await ozon.check(uploadResult.task_id);

// status.items[0].status → 'imported' / 'failed' / 'pending'
// status.items[0].errors → 错误详情数组

// ---- 场景 4: 一键清洗+上传（懒人模式）----
const all = await ozon.cleanAndUpload(scrapedJson, { price: '299' });
```

## 接口文档

### `clean(input, options)` → Promise

清洗商品数据。

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `object \| string` | 抓取模块输出的 JSON 对象，或 JSON 文件路径 |
| `options.price` | `string` | 售价（必填） |
| `options.old_price` | `string` | 原价 |
| `options.downloadImages` | `boolean` | 是否下载图片，默认 `true` |
| `options.saveOutput` | `boolean` | 是否保存输出文件，默认 `true` |

**返回值：**
```js
{
  success: true,
  item: { ... },        // OZON API 格式的商品对象
  meta: { ... },        // 元数据
  images: {
    localMap: { 原始URL: '本地路径', ... },
    doneCount: 24,
    failCount: 0,
    mappingFile: 'images/xxx/_url_mapping.json'
  },
  outputFile: 'output/product_import_xxx.json',
  errors: []
}
```

### `upload(items)` → Promise

上传商品到 OZON。

| 参数 | 类型 | 说明 |
|------|------|------|
| `items` | `object \| object[]` | 单个 item 或 item 数组，来自 `clean()` 返回的 `.item` |

**返回值：**
```js
{ success: true, task_id: 4167243491, error: null }
```

### `check(taskId)` → Promise

查询上传状态。

**返回值：**
```js
{
  items: [
    { offer_id: 'xxx', product_id: 123, status: 'imported', errors: [] }
  ],
  total: 1
}
```

### `cleanAndUpload(input, options)` → Promise

一键清洗 + 上传 + 查询状态。

**返回值：**
```js
{
  clean:  { ... },   // clean() 的返回值
  upload: { ... },   // upload() 的返回值
  status: { ... }    // check() 的返回值（5秒后自动查询）
}
```

## 文件结构

```
├── index.js               程序化入口（给外部模块 require 用）
├── main.js                命令行入口 - 单个商品清洗
├── batch_clean.js         命令行入口 - 批量清洗
├── upload.js              命令行入口 - 上传 + 状态查询
├── config.js              配置（API 凭证 + 默认值）
│
├── ozon_api.js            OZON Seller API 客户端（带文件缓存）
├── category_finder.js     分类树搜索算法
├── attribute_matcher.js   属性名 → 属性ID 模糊匹配
├── product_cleaner.js     数据转换核心（尺寸/重量/图片/默认值）
├── image_downloader.js    图片并发下载器
│
├── cache/                 API 响应缓存（分类树、属性字典）
│   ├── category_tree.json           完整分类树（~1.5MB，首次自动下载）
│   ├── attrs_{catId}_{typeId}.json  分类属性定义
│   └── dict_{attrId}_*.json         属性字典值
│
├── images/                下载的商品图片
│   └── {productId}/
│       ├── gallery_000.jpg ~ gallery_019.jpg
│       ├── desc_000.jpg ~ desc_004.jpg
│       └── _url_mapping.json        原始URL ↔ 本地路径
│
└── output/                清洗输出
    ├── product_import_{id}.json     可直接提交的 API 请求体
    ├── batch_import_{n}.json        批量请求体（每批 ≤100 个）
    └── clean_report_{id}.json       清洗报告
```

## 清洗规则速查

| 字段 | 规则 |
|------|------|
| **分类** | 自动从 OZON 分类树匹配（按面包屑 + 商品类型名） |
| **属性** | 50 个属性逐一模糊匹配，字典类属性自动查 dictionary_value_id |
| **品牌** | 默认 `Нет бренда`（从字典匹配） |
| **制造商** | 默认 `China` |
| **货币** | 固定 `CNY` |
| **尺寸** | 有 → cm 转 mm；无 → 默认 100x100x150mm |
| **重量** | 有 → kg 转 g；无 → 默认 500g |
| **货号 offer_id** | 原SKU + 商品名前4字符（如 `1345363077Чемо`） |
| **型号名** | 随机生成（`SKU-XXXXXX`） |
| **增值税** | `0`（不征税） |
| **条形码** | 留空 |
| **图片** | 主图 1 张 + 附图最多 14 张 = 总共 15 张上限 |

## 与抓取模块对接

抓取模块只需要输出符合以下结构的 JSON：

```js
{
  "productId": 1345363077,              // 必须
  "title": "商品标题",                    // 必须
  "breadcrumbs": [                       // 用于分类匹配
    { "text": "Аксессуары", "url": "..." },
    { "text": "Чемоданы", "url": "..." }
  ],
  "characteristics": [                   // 用于属性匹配
    { "name": "Тип", "valueText": "Чемодан", "values": ["Чемодан"] },
    { "name": "Цвет", "valueText": "Мятный", "values": ["Мятный"] }
    // ...
  ],
  "gallery": {                           // 用于图片
    "coverImage": "https://...",
    "images": [ { "src": "https://...", "alt": "..." } ]
  },
  "description": {                       // 用于商品描述
    "text": "纯文本描述",
    "html": "<span>HTML描述</span>",
    "images": [ { "src": "https://..." } ]
  },
  "sourceUrl": "https://..."             // 可选，记录来源
}
```

只要抓取模块输出的 JSON 包含上述字段，丢给 `clean()` 就能自动完成所有转换。

## 与 Website 模块对接

Website 后台典型的调用流程：

```js
const ozon = require('你的上货模块路径');

// ========== 路由 1: 采集 ==========
// 抓取模块送来 JSON → 清洗 → 存数据库
app.post('/api/collect', async (req, res) => {
  const result = await ozon.clean(req.body.scrapedJson, {
    price: req.body.price || '0',
    downloadImages: true,
    saveOutput: true,
  });
  // 存到你的数据库
  await db.products.create({
    offer_id: result.item.offer_id,
    title: result.item.name,
    cleaned_item: result.item,   // 完整的清洗结果
    meta: result.meta,
    status: 'draft',             // 待上传
  });
  res.json({ ok: true, offer_id: result.item.offer_id });
});

// ========== 路由 2: 上传 ==========
// 用户点击"上传到 OZON"
app.post('/api/upload/:offerId', async (req, res) => {
  const product = await db.products.findOne({ offer_id: req.params.offerId });
  const result = await ozon.upload(product.cleaned_item);
  if (result.success) {
    await db.products.update({ offer_id: req.params.offerId }, {
      status: 'uploading',
      task_id: result.task_id,
    });
  }
  res.json(result);
});

// ========== 路由 3: 查询状态 ==========
app.get('/api/status/:taskId', async (req, res) => {
  const status = await ozon.check(req.params.taskId);
  res.json(status);
});
```

## 默认值修改

所有默认值在 `config.js` 的 `DEFAULTS` 对象中：

```js
DEFAULTS: {
  currency_code: 'CNY',         // 货币
  dimension_unit: 'mm',         // 尺寸单位
  weight_unit: 'g',             // 重量单位
  default_depth_mm: 100,        // 默认深度
  default_width_mm: 100,        // 默认宽度
  default_height_mm: 150,       // 默认高度
  manufacturer: 'China',        // 制造商
  brand: '无品牌',               // 品牌
  vat: '0',                     // 增值税
  barcode: '',                  // 条形码
}
```

## 缓存机制

首次运行会从 OZON API 下载分类树和属性字典，保存到 `cache/` 目录。后续运行直接读缓存，不重复请求。

如需刷新缓存，删除 `cache/` 目录重新运行即可。
