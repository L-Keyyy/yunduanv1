# 后端 API 接口设计规范 (基于 RESTful 架构)

所有接口的基础路径为：`/api/v1`

## 1. 认证与用户模块 (Auth)
- `POST /auth/login`
  - 请求体：`{"username": "admin", "password": "xxx"}`
  - 返回：`{"access_token": "jwt_token", "token_type": "bearer"}`
- `GET /users/me`
  - 返回当前登录用户信息及权限角色。

## 2. 数据可视化面板 (Dashboard)
- `GET /dashboard/summary`
  - 功能：获取大盘数据（当日订单量、待备货订单数、商品总数、库存预警SKU数）。
  - 返回：
    ```json
    {
      "today_orders": 125,
      "pending_fbs_orders": 12,
      "total_products": 450,
      "low_stock_alerts": 5
    }
    ```
- `GET /dashboard/sales-chart`
  - 功能：获取近 7/30 天的销量趋势数据，供 ECharts 渲染折线图。

## 3. 商品与库存管理 (Products & Inventory)
- `GET /products`
  - 参数：`?page=1&size=20&status=visible`
  - 返回：商品列表、对应的 FBO/FBS 库存、以及抓取模块同步过来的竞品/历史价格数据。
- `PUT /products/{product_id}/stock`
  - 请求体：`{"stock_fbs": 100}`
  - 功能：调用 Ozon API 实时更新 FBS 库存，并记录到本地操作日志。

## 4. 订单监控 (Orders)
- `GET /orders`
  - 参数：`?type=fbs&status=awaiting_packaging&date_from=2023-10-01`
  - 功能：查询同步下来的订单列表，包含发货截止时间倒计时。
- `POST /orders/sync`
  - 功能：手动触发一次 Ozon 最新订单的异步拉取任务 (Celery Task)。

## 5. 系统与日志 (System & Logs)
- `GET /logs`
  - 功能：获取操作日志，支持按用户、操作类型、日期范围过滤。
- `GET /settings/ozon-credentials`
  - 功能：管理绑定的 Ozon 店铺及 API 密钥。
