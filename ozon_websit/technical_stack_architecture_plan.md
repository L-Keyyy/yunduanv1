# Ozon 项目技术栈与云架构规划

本文档用于固定当前项目从“本地功能基本完成”过渡到“云端长期稳定运行”的技术栈、分层方式、部署形态和演进路径。

本文档与 [cloud_sync_guidance.md](D:\ozon\ozon_websit\cloud_sync_guidance.md) 配套使用：
- `cloud_sync_guidance.md` 负责定义同步逻辑、缓存保留策略、哪些能力需要浏览器协助。
- 本文档负责定义技术栈、AWS 服务映射、系统分层、部署阶段和后续演进路线。

后续如果要继续改代码、补部署、拆服务、做自动同步，默认以这两份文档为准。

## 1. 当前项目事实基线

### 1.1 当前前端技术栈
- Vue 3
- TypeScript
- Vite
- Element Plus
- Pinia
- Vue Router
- Axios
- ECharts

### 1.2 当前后端技术栈
- Python
- FastAPI
- SQLAlchemy 2.x
- Pydantic Settings
- Uvicorn
- httpx
- websocket-client

### 1.3 当前数据与任务能力
- 数据库当前默认仍是 `SQLite`
- 配置中已经预留 `PostgreSQL` 连接能力
- 配置中已经预留 `Redis`
- 依赖已包含 `Celery`
- 但当前“定时同步体系”还没有真正作为云端常驻任务跑起来

### 1.4 当前特殊运行依赖
- 存在一类功能依赖 `Chrome DevTools 9222`
- 存在一类功能依赖 `Seller 页面登录态`
- 这类能力不是普通 Ozon API 调用，而是浏览器协助型能力
- 这也是后续架构必须单独分层的根本原因

## 2. 总体规划原则

后续统一遵守以下原则：

1. 核心业务层和浏览器协助层必须逻辑分离。
2. 业务主数据以 `PostgreSQL` 为准，不再以 `SQLite` 作为生产主库。
3. `Redis` 负责短缓存、队列、锁、限流和任务中间状态，不承担业务主数据存储。
4. 同步策略采用“定时同步为主，手动同步为辅”。
5. 页面读取优先查本系统数据库，不让前端页面频繁直接打 Ozon 外部接口。
6. Seller 页面抓取类功能保留缓存和失败兜底，不做“每次切页都重新抓取”。
7. 不把浏览器抓取能力和核心业务 API 耦合成“一挂全挂”。
8. 云端演进按“先能跑、再稳定、再拆分、再扩展”的顺序推进。

## 3. 推荐目标技术栈

### 3.1 前端
- `Vue 3 + TypeScript + Vite`
- UI 继续使用 `Element Plus`
- 状态管理继续使用 `Pinia`
- 图表继续使用 `ECharts`
- HTTP 客户端继续使用 `Axios`

结论：
- 前端栈本身不需要大改。
- 后续主要变化不是框架替换，而是环境配置、鉴权方式、API 地址和发布方式。

### 3.1.1 关于 Next.js 的固定结论

当前阶段默认不把现有前端改写为 `Next.js`。

原因：
- 现有前端本质上是登录后管理后台，不是 SEO 驱动的公开站点。
- 主要页面是 Dashboard、店铺、商品、库存、订单、活动、消息、数据分析、热门标签、定价计算等后台业务页。
- 这些页面的核心诉求是认证后操作、图表展示、后台接口调用和复杂状态管理，不是首屏 SEO。
- 当前前端已经是典型的 `SPA 管理后台` 结构，直接继续用 `Vue + Vite` 成本最低。
- 如果切到 `Next.js` 但仍然主要依赖现有 FastAPI API，那么会增加一次整站迁移成本，但不会同步带来决定性收益。
- `Next.js` 虽然支持 `Node.js server`、`Docker` 和 `static export`，但静态导出能力本身对服务端特性支持有限，不是当前管理后台的关键收益点。

因此后续统一按下面的口径执行：
- 当前管理后台继续使用 `Vue 3 + Vite`。
- 不为“看起来更现代”而做一次纯框架迁移。
- 只有在出现明确业务理由时，才考虑引入 `Next.js`。

可以考虑引入 `Next.js` 的场景只有这些：
- 后续要新增一个公开官网、营销页、帮助中心、内容站。
- 后续要做一个对 SEO、首屏渲染、公开落地页体验要求很高的用户前台。
- 后续希望把部分前端能力做成 `BFF`，让前端服务端直接处理鉴权、聚合接口、边缘渲染。
- 后续准备做一次完整前端重构，而不是在现有管理后台上做高成本平移。

如果未来真的要采用 `Next.js`，默认原则是：
- 使用 `App Router`
- 采用与当前后台分开的新应用，而不是直接在当前 Vue 后台里硬切
- 优先用于公开前台或新模块，不优先用于现有内部管理后台

### 3.2 后端 API
- `Python 3.12` 作为目标运行时
- `FastAPI` 继续作为主 API 框架
- `SQLAlchemy 2.x` 继续作为 ORM
- `Pydantic Settings` 继续负责配置管理
- 容器内优先使用 `Uvicorn`，横向扩容交给 ECS

结论：
- 后端主框架不需要换。
- 后续重点是补齐生产级配置、容器化、数据库迁移、任务拆分和可观测性。

### 3.3 数据与缓存
- 主数据库：`PostgreSQL`
- 短缓存/消息队列/分布式锁：`Redis`
- 持久快照/导出文件/后续历史分析数据：`S3`

结论：
- `PostgreSQL` 负责订单、商品、库存、店铺、任务记录、日志等业务数据。
- `Redis` 负责活动短缓存、通知共享缓存、任务队列、限流、去重锁。
- Seller 抓取类“历史快照”后续可逐步从单机磁盘迁移到 `S3/Redis/数据库`。

### 3.4 异步任务与调度
- 异步执行：`Celery Worker`
- Broker / Result Backend：`Redis`
- 定时调度：AWS 上优先采用 `EventBridge Scheduler`

结论：
- 保留 `Celery` 作为执行层。
- 不建议把 `Celery Beat` 作为 AWS 上的主调度中心。
- 定时任务触发交给 AWS 原生调度，更适合云端长期运行。

### 3.5 浏览器协助层
- `Chrome / Chromium`
- `Chrome DevTools 9222`
- 持久化登录 Profile
- 独立浏览器协助进程或独立浏览器协助节点

结论：
- 这层能力保留。
- 不把它伪装成普通数据库查询或普通 Ozon API 请求。
- 它是单独的能力层，后续可以独立维护、单独故障隔离、单独做缓存兜底。

### 3.6 运维与交付
- 容器镜像：`Docker`
- 镜像仓库：`Amazon ECR`
- 基础设施管理：`Terraform` 优先
- CI/CD：`GitHub Actions`
- 日志与监控：`CloudWatch Logs + CloudWatch Alarms`
- 密钥管理：`Secrets Manager` 或 `SSM Parameter Store`

结论：
- 后续不要继续靠手工改服务器环境作为正式发布方式。
- 要尽快进入“镜像发布 + 环境变量注入 + 任务部署”的标准化交付方式。

## 4. AWS 服务映射

| 领域 | 推荐 AWS 服务 | 说明 |
| --- | --- | --- |
| 前端静态资源 | `S3 + CloudFront` | 前端构建产物发布到 S3，由 CloudFront 提供加速与 HTTPS |
| 自定义域名/证书 | `Route 53 + ACM` | 如果后续上正式域名，统一走 ACM 证书和 CloudFront / ALB |
| API 服务 | `ECS Fargate + ALB` | FastAPI 容器化后挂在 ALB 后面 |
| 异步 Worker | `ECS Fargate` | Celery Worker 独立服务，不和 API 绑死 |
| 定时任务 | `EventBridge Scheduler` | 定时触发 ECS 任务或同步任务 |
| 主数据库 | `Amazon RDS for PostgreSQL` | 正式生产主库 |
| Redis | `Amazon ElastiCache` | 用于缓存、队列、锁、限流 |
| 浏览器协助层 | `EC2` | 运行 Chrome 9222、Seller 登录态、抓取脚本 |
| 镜像仓库 | `Amazon ECR` | 存放 API / Worker 镜像 |
| 日志监控 | `CloudWatch` | 日志、指标、报警 |
| 密钥与配置 | `Secrets Manager / SSM Parameter Store` | 管理 Ozon 密钥、数据库连接、后台管理员密码等 |
| 安全运维入口 | `AWS Systems Manager Session Manager` | 管理 EC2，不暴露 SSH 入口作为默认方式 |
| 导出文件/快照 | `S3` | 存储报表、备份、抓取快照、历史分析数据 |

## 5. 两阶段架构规划

### 5.1 第一阶段：最快可落地的过渡架构

适用场景：
- 你当前代码刚从本地迁到 AWS
- 浏览器协助能力仍然强依赖 `localhost:9222`
- 当前目标是“先稳定跑起来”，而不是立刻把系统完全服务化

推荐形态：
- 前端可以先继续跟随后端同机部署，或单独放到 `S3 + CloudFront`
- 后端 API 先部署在一台 AWS 服务器上
- `Chrome 9222` 和后端部署在同一台机器
- 数据库尽快切到 `RDS PostgreSQL`
- `Redis` 尽快切到 `ElastiCache`

这一阶段的核心目标不是追求最优雅，而是：
- 尽量少改代码
- 先把浏览器协助型能力迁上云
- 先脱离本机依赖
- 先把主数据迁出 SQLite

结论：
- 如果你现在已经在 AWS 上跑了 Chrome 9222，这一阶段最现实。
- 当前项目最容易先落地的是“应用和浏览器协助仍同机，数据库与 Redis 托管化”。

### 5.2 第二阶段：正式的目标架构

目标形态：
- 前端：`S3 + CloudFront`
- 核心 API：`ECS Fargate + ALB`
- 异步 Worker：`ECS Fargate`
- 定时任务：`EventBridge Scheduler`
- 主数据库：`RDS PostgreSQL`
- 缓存与队列：`ElastiCache Redis`
- 浏览器协助层：独立 `EC2`

这一阶段的核心变化：
- 核心业务服务和浏览器协助服务彻底拆开
- API 与 Worker 不再和 Chrome 9222 同机耦合
- 浏览器层故障不会拖垮订单、商品、库存、活动等核心能力
- 扩容时优先扩 API / Worker，不必动浏览器节点

## 6. 目标逻辑分层

### 6.1 核心业务层
负责：
- 店铺管理
- 商品管理
- 库存管理
- 订单管理
- 上传任务管理
- 活动管理
- 通知消息
- Dashboard 统计
- 定价计算
- 类目佣金
- Ozon 官方 API 调用
- 任务调度与数据入库

技术归属：
- FastAPI
- PostgreSQL
- Redis
- Celery Worker
- EventBridge Scheduler

### 6.2 浏览器协助层
负责：
- Chrome 9222
- Seller 登录态维护
- 页面脚本执行
- Seller 类目趋势抓取
- 热门标签/搜索词抓取
- Ozon 仓库浏览器同步

技术归属：
- EC2
- Chrome/Chromium
- 持久化浏览器 Profile
- 本地缓存或后续迁移后的 Redis/S3 快照

### 6.3 前端接入层
负责：
- 页面渲染
- 业务交互
- API 调用
- 状态管理
- 图表展示

技术归属：
- Vue 3
- Pinia
- Element Plus
- ECharts
- CloudFront 分发

## 7. 网络与安全规划

### 7.1 生产目标网络结构
- 公网入口：`ALB`
- 前端通过 `CloudFront` 暴露
- `RDS` 和 `ElastiCache` 放在私网
- 浏览器协助 `EC2` 不建议直接暴露 9222 到公网
- 优先通过私网访问浏览器协助服务
- 运维入口优先使用 `Session Manager`

### 7.2 关于 Chrome 9222 的固定要求
- 不能把 `9222` 作为公网常开端口暴露
- 不能默认把 Seller 登录态直接暴露给外网访问
- 需要持久化浏览器 Profile，避免登录态频繁丢失
- 后续要把当前写死的 `127.0.0.1:9222` 逐步改造成可配置的浏览器协助地址

### 7.3 密钥管理
以下信息不再写死在代码或散落在服务器上：
- Ozon Client ID
- Ozon API Key
- 数据库连接串
- Redis 连接串
- FastAPI Secret Key
- 管理员账号密码

统一放入：
- `Secrets Manager`
- 或 `SSM Parameter Store`

## 8. 数据、缓存与同步在架构中的归属

本段与 `cloud_sync_guidance.md` 保持完全一致。

### 8.1 数据归属
- `PostgreSQL` 是业务主数据源
- `Redis` 是短缓存与任务中间层
- `S3` 是导出文件、历史快照、长期归档候选位置

### 8.2 页面读取原则
- 数据库型页面：直接查 `PostgreSQL`
- Ozon API 型页面：实时查或短缓存
- Seller 抓取型页面：必须有缓存和失败兜底

### 8.3 同步原则
- 订单、店铺状态、商品等：以后台定时同步为主
- 页面仍保留手动同步按钮
- 浏览器抓取型功能不做随切页自动重抓

## 9. 模块与云端归属

| 模块 | 主要数据来源 | 是否需要浏览器协助 | 云端归属 |
| --- | --- | --- | --- |
| 店铺管理 | PostgreSQL + Ozon API | 否 | 核心业务层 |
| 商品管理 | PostgreSQL + Ozon API | 否 | 核心业务层 |
| 库存管理 | PostgreSQL，仓库同步时需 Seller | 部分需要 | 核心业务层 + 浏览器协助层 |
| 订单管理 | PostgreSQL + Ozon API | 否 | 核心业务层 |
| 上传任务 | PostgreSQL + Ozon API | 否 | 核心业务层 |
| Dashboard | PostgreSQL + 少量 Ozon API | 否 | 核心业务层 |
| 通知消息 | Ozon API + PostgreSQL | 否 | 核心业务层 |
| 活动管理 | Ozon API + 本地商品补充 | 否 | 核心业务层 |
| 定价计算 | 本地计算 + PostgreSQL 模板 | 否 | 核心业务层 |
| 类目佣金 | 整理数据/静态数据 | 否 | 核心业务层 |
| Seller 类目趋势 | Seller 页面抓取 | 是 | 浏览器协助层 |
| 热门标签/搜索词趋势 | Seller 页面抓取 | 是 | 浏览器协助层 |
| 同步 Ozon 仓库 | Seller 页面抓取 | 是 | 浏览器协助层 |

## 10. 建议补齐的工程能力

当前项目后续要尽快补齐以下能力：

1. `Dockerfile`
2. 多环境配置：`dev / staging / prod`
3. 数据库迁移工具：`Alembic`
4. 健康检查接口
5. 结构化日志
6. Worker 独立启动方式
7. 定时任务入口与幂等保护
8. 统一的环境变量清单
9. 前端构建与发布脚本
10. GitHub Actions 发布流水线

说明：
- 这些不是“锦上添花”，而是从本地项目进入云端长期运行前必须补齐的基础设施。

## 11. CI/CD 规划

### 11.1 前端发布
- GitHub Actions 构建前端
- 输出静态资源
- 发布到 `S3`
- 触发 `CloudFront` 失效刷新

### 11.2 后端发布
- GitHub Actions 构建 API / Worker 镜像
- 推送到 `ECR`
- 更新 `ECS Service`

### 11.3 数据库变更
- 发布前执行 `Alembic migrate`
- 不再依赖手工改表

## 12. 推荐演进路线

### 第 1 步：先把云端基础跑稳
- AWS 服务器继续承担 Chrome 9222
- 后端先与 Chrome 同机运行
- 主数据库切到 `RDS PostgreSQL`
- Redis 切到 `ElastiCache`
- 把 `.env` 和密钥迁到云端密钥管理

### 第 2 步：补生产级工程能力
- 容器化
- Alembic
- 健康检查
- 日志监控
- CI/CD

### 第 3 步：把同步任务正式云端化
- 引入 Worker
- 订单同步定时化
- 店铺状态校验定时化
- 商品与通知同步定时化

### 第 4 步：拆分浏览器协助层
- 核心 API 迁到 ECS
- Worker 迁到 ECS
- 浏览器协助层保留在独立 EC2
- Chrome 9222 不再要求与 API 同机

### 第 5 步：做更长期的稳态优化
- 缓存从单机磁盘逐步迁移到 Redis / S3 / 数据库
- 增加告警、重试、幂等、任务追踪
- 根据吞吐决定是否扩 API / Worker / 浏览器节点

## 13. 明确不采用的路线

当前阶段默认不采用：
- `SQLite` 作为正式生产主库
- 前端页面直接高频打 Ozon API 作为主要读取方式
- 用浏览器抓取替代所有正式数据链路
- 把 Chrome 9222 暴露到公网长期使用
- 一开始就上 Kubernetes / EKS

原因：
- 复杂度和收益不匹配
- 会拖慢当前项目从“能用”走向“稳定”的速度

## 14. 固定结论

后续统一按下面这套理解执行：

- 前端栈继续保留 `Vue 3 + TypeScript + Vite + Element Plus`
- 后端栈继续保留 `FastAPI + SQLAlchemy + Redis + Celery`
- 生产主库统一迁移到 `PostgreSQL`
- 云端调度统一优先采用 `EventBridge Scheduler`
- 浏览器协助能力单独成层，不和核心业务绑死
- 第一阶段先做“同机过渡架构”
- 第二阶段再做“核心业务层和浏览器协助层拆分”

## 15. AWS 官方参考

- Amazon ECS 与负载均衡：
  - https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html
- EventBridge Scheduler 调度 ECS：
  - https://docs.aws.amazon.com/AmazonECS/latest/developerguide/tasks-scheduled-eventbridge-scheduler.html
- Amazon RDS for PostgreSQL：
  - https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html
- Amazon ElastiCache：
  - https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/GettingStarted.html
- Amazon ECR：
  - https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html
- Secrets Manager：
  - https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html
- Systems Manager Session Manager：
  - https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html
- S3 静态网站与 CloudFront：
  - https://docs.aws.amazon.com/AmazonS3/latest/dev/WebsiteHosting.html
  - https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/getting-started-secure-static-website-cloudformation-template.html
