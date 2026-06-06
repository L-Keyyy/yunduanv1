# Ozon 后台管理系统设计文档

## 1. Ozon API 调研总结
- **认证方式**：基于 HTTP Header，需传递 `Client-Id` 和 `Api-Key`。
- **请求频率限制**：基于 `Client-Id` 限制，超限返回 `429 Too Many Requests`，需实现指数退避和重试机制，建议使用 Redis 缓存和异步定时拉取代替实时高频请求。
- **核心接口**：
  - 商品列表：`/v2/product/list` 或 `/v3/product/info/list`
  - 库存查询/更新：`/v3/product/info/stocks`，`/v1/product/stocks`
  - 订单接口：`/v3/posting/fbs/list` (FBS订单), `/v2/posting/fbo/list` (FBO订单)

## 2. 系统架构与技术栈选型
考虑到已有“数据抓取模块”和“数据清洗上传模块”（通常为 Python 编写），后端推荐使用 Python 技术栈以实现无缝集成。

### 技术栈
- **前端 (Frontend)**: Vue 3 + TypeScript + Element Plus 构建管理后台，ECharts 用于数据可视化展示（大盘数据、销量折线图等）。
- **后端 (Backend)**: Python 3.10+ & FastAPI。FastAPI 具有高性能、原生支持异步 (Asyncio)、自带交互式 API 文档 (Swagger UI) 的特点，非常适合对接外部 API 和数据流。
- **数据库 (Database)**: PostgreSQL (核心业务数据) + Redis (API 响应缓存、会话管理、限流)。
- **任务调度 (Task Queue)**: Celery + Redis 用于后台定时拉取 Ozon 订单和库存数据，避免频繁触发 API 限制。

### 架构图简述
```text
[ Web 前端 (Vue3 + ECharts) ]
         | (RESTful API / WebSocket 实时推送)
[ FastAPI 后端 ] <---> [ Redis 缓存 & 消息队列 ] <---> [ Celery 异步任务池 ]
         |                                                 | (定时轮询/数据同步)
[ PostgreSQL 数据库 ]                                  [ Ozon 官方 API ]
         |
[ 已有的抓取与清洗模块 (预留接口) ]
```

## 3. 数据库 ER 表结构设计

### 3.1 用户与权限 (`users`)
- `id`: UUID, 主键
- `username`: String, 唯一
- `password_hash`: String
- `role`: Enum ('admin', 'operator', 'viewer')
- `created_at`: DateTime

### 3.2 Ozon 授权信息 (`ozon_credentials`)
- `id`: UUID, 主键
- `store_name`: String, 店铺名称
- `client_id`: String
- `api_key`: String
- `is_active`: Boolean

### 3.3 商品表 (`products`)
- `id`: UUID, 主键
- `ozon_product_id`: Integer, Ozon商品ID
- `offer_id`: String, 商家SKU
- `name`: String, 商品名称
- `price`: Decimal, 价格
- `status`: String, 状态 (可见/隐藏等)
- `updated_at`: DateTime

### 3.4 库存监控 (`inventory_records`)
- `id`: UUID, 主键
- `product_id`: UUID, 关联 products.id
- `stock_fbo`: Integer, FBO库存
- `stock_fbs`: Integer, FBS库存
- `recorded_at`: DateTime, 记录时间 (用于时序图表)

### 3.5 订单表 (`orders`)
- `id`: UUID, 主键
- `posting_number`: String, Ozon订单号
- `status`: String, 订单状态 (awaiting_packaging, awaiting_deliver, delivered 等)
- `order_type`: Enum ('FBO', 'FBS')
- `created_at`: DateTime, 订单创建时间
- `shipment_date`: DateTime, 需发货时间
- `total_amount`: Decimal, 订单总额

### 3.6 操作日志 (`operation_logs`)
- `id`: UUID, 主键
- `user_id`: UUID, 关联 users.id
- `action`: String, 操作类型 (如: 'update_stock', 'login')
- `target`: String, 操作对象
- `ip_address`: String
- `timestamp`: DateTime
