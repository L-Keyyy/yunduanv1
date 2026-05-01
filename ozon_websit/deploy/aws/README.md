# AWS 部署模板说明

本目录提供的是当前项目在 AWS 上的第一阶段部署模板，目标是：

1. 先把核心 API 跑起来
2. 先把 worker 和定时任务入口准备好
3. 先让 `RDS PostgreSQL`、`ElastiCache Redis`、`Chrome 9222` 能接入

## 建议部署顺序

1. 创建 `RDS PostgreSQL`
2. 创建 `ElastiCache Redis`
3. 准备一台 `EC2` 运行 Chrome 9222 与 Seller 登录态
4. 创建 `ECR` 仓库并推送镜像
5. 创建 `ECS Cluster`
6. 先部署 API Service
7. 再部署 Worker Service
8. 最后用 `EventBridge Scheduler` 触发按需的 Job Task

## 目录内容

- `api-task-definition.json`
  - FastAPI API 服务模板
- `worker-task-definition.json`
  - Celery Worker 服务模板
- `job-task-definition.json`
  - 给 EventBridge Scheduler 跑一次性同步任务的模板
- `push-backend-image.ps1`
  - 构建并推送后端镜像到 ECR
- `push-frontend-image.ps1`
  - 构建并推送前端镜像到 ECR
- `render-task-definition.ps1`
  - 用占位符渲染 ECS task definition 模板
- `register-task-definition.ps1`
  - 渲染后直接注册 ECS task definition

## 需要替换的占位符

以下值需要按你的 AWS 环境替换：

- `<AWS_REGION>`
- `<ACCOUNT_ID>`
- `<EXECUTION_ROLE_ARN>`
- `<TASK_ROLE_ARN>`
- `<ECR_IMAGE_URI>`
- `<SUBNET_ID_1>`
- `<SUBNET_ID_2>`
- `<SECURITY_GROUP_ID>`
- `<RDS_ENDPOINT>`
- `<REDIS_ENDPOINT>`
- `<FRONTEND_ORIGIN>`
- `<CHROME_HOST>`
- `<SECRET_KEY>`
- `<ADMIN_USERNAME>`
- `<ADMIN_PASSWORD>`

## API Service 建议

- 镜像使用 backend Dockerfile 构建的同一镜像
- 容器端口：`8000`
- ALB 健康检查路径：`/healthz`
- `RUN_MIGRATIONS_ON_START=1`
- `AUTO_CREATE_SCHEMA=false`
- `ENABLE_LOCAL_BOOTSTRAP=false`

## 镜像推送脚本示例

后端：

```powershell
.\push-backend-image.ps1 `
  -AwsRegion ap-southeast-1 `
  -AwsAccountId 123456789012 `
  -RepositoryName ozon-management-backend `
  -ImageTag 2026-04-22 `
  -CreateRepositoryIfMissing
```

前端：

```powershell
.\push-frontend-image.ps1 `
  -AwsRegion ap-southeast-1 `
  -AwsAccountId 123456789012 `
  -RepositoryName ozon-management-frontend `
  -ImageTag 2026-04-22 `
  -ApiBaseUrl https://api.example.com/api/v1 `
  -CreateRepositoryIfMissing
```

## Task Definition 渲染与注册示例

```powershell
.\register-task-definition.ps1 `
  -AwsRegion ap-southeast-1 `
  -TemplatePath .\api-task-definition.json `
  -OutputPath .\rendered\api-task-definition.rendered.json `
  -Replacements @{
    AWS_REGION = "ap-southeast-1"
    EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/ecsTaskExecutionRole"
    TASK_ROLE_ARN = "arn:aws:iam::123456789012:role/ozonTaskRole"
    ECR_IMAGE_URI = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/ozon-management-backend:2026-04-22"
    RDS_ENDPOINT = "example.cluster-xxxx.ap-southeast-1.rds.amazonaws.com"
    REDIS_ENDPOINT = "example.xxxxxx.ng.0001.aps1.cache.amazonaws.com"
    FRONTEND_ORIGIN = "https://app.example.com"
    CHROME_HOST = "10.0.2.15"
    SECRET_KEY = "replace-me"
    ADMIN_USERNAME = "admin"
    ADMIN_PASSWORD = "replace-me"
  }
```

## Worker Service 建议

- 与 API 使用同一镜像
- 通过 command 覆盖为 `./start-worker.sh`
- 不挂在 ALB 后面
- 副本数先从 `1` 开始

## EventBridge Job 建议

Job Task 适合做：

- `python job_runner.py verify-stores`
- `python job_runner.py sync-products`
- `python job_runner.py sync-orders --days 7`
- `python job_runner.py sync-core --days 7`

推荐频率：

- 订单同步：每 `5-10` 分钟
- 店铺状态校验：每 `30-60` 分钟
- 商品同步：每 `30-60` 分钟

## Chrome 9222 连接说明

当前代码已经支持把浏览器地址改成环境变量：

- `CHROME_DEVTOOLS_BASE=http://<CHROME_HOST>:9222`

注意：

- 不建议把 `9222` 直接暴露到公网
- API / Worker 最好通过私网访问这台浏览器协助 EC2
- Seller 登录态应保留在 EC2 持久化用户目录中
