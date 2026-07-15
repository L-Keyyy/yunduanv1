# 商品图翻译 OCR 模块

这个目录是独立版图片工坊模块，包含：

- `backend/app.py`：独立 FastAPI 服务，提供页面和图片翻译接口。
- `backend/baidu_image_translation.py`：百度图片翻译 API V2.0 Bearer 鉴权和高精擦除回填。
- `backend/aliyun_image_translation.py`：阿里云机器翻译 `TranslateImage` SDK 接入和译图下载。
- `backend/doubao_web_image_translation.py`：通过 9222 Chrome 控制豆包网页版上传图片，读取 OCR/翻译区域并在本地回填。
- `backend/image_workshop_processor.py`：OCR、文字区域修补、译文重绘核心逻辑。
- `backend/requirements.txt`：独立模块依赖。
- `frontend/index.html`：多图上传测试页面。

## 启动

```bash
cd pt/image-workshop
python3 -m pip install -r backend/requirements.txt
python3 -m uvicorn backend.app:app --host 0.0.0.0 --port 8010
```

打开：

```text
http://127.0.0.1:8010/
```

## 接口

```text
POST /translate
```

表单字段：

- `file`：图片文件。
- `target_language`：目标语言，支持 `ru`、`en`、`es`、`de`。
- `translation_mode`：本地 OCR 翻译模式。
- `ocr_engine`：`local` 使用本地 OCR + Canvas，`web` 使用 Google 网页翻译，`doubao` 使用豆包网页版免费额度，`baidu` 使用百度图片翻译 V2.0，`aliyun` 使用阿里云图片翻译。
- `baidu_app_id`、`baidu_api_key`：选择 `baidu` 时使用的 APP ID 和 Bearer API Key。
- `aliyun_access_key_id`、`aliyun_access_key_secret`：选择 `aliyun` 时使用的阿里云 AccessKey。
- `aliyun_region_id`：阿里云地域，默认 `cn-hangzhou`。
- `aliyun_field`：`e-commerce` 电商图片翻译或 `general` 通用图片翻译。

返回：

- `image`：处理后的 PNG data URL。
- `regions`：OCR 命中的文字区域。
- `engine`：使用的识别引擎。
- `warnings`：处理警告。

## 豆包网页版图片翻译

该模式复用 Chrome 中的豆包登录态，不需要火山方舟 API Key：

1. 使用远程调试端口启动 Chrome，并保持 DevTools 只监听本机：

```bash
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-9222
```

2. 在这个 Chrome 中打开 `https://www.doubao.com/chat/` 并登录一次。
3. 页面“处理引擎”选择“豆包网页版图片翻译（免费）”。
4. 后端通过 CDP 上传图片，要求豆包返回归一化文字框与译文，再由本机 OpenCV/Canvas 擦除原文并回填。

状态与打开页面接口：

```text
GET  /doubao/status
POST /doubao/open
```

可选环境变量：

```bash
export CHROME_DEVTOOLS_BASE="http://127.0.0.1:9222"
export DOUBAO_WEB_IMAGE_TIMEOUT_SECONDS="90"
export DOUBAO_WEB_IMAGE_MAX_PENDING_REQUESTS="4"
```

豆包网页任务在单个标签页内串行执行；多用户部署时建议在服务入口排队，并限制全局并发。

## 百度图片翻译 V2.0

1. 在百度翻译开放平台开通“图片翻译 API V2.0”。
2. 在页面的“处理引擎”中选择“百度图片翻译 API V2.0”。
3. 填写 `APP ID` 和“API Key 管理”页面创建的 `API Key`，点击“测试密钥”。开发者信息页的“密钥”不用于 V2。
4. 处理时固定使用 `paste=1` 整图回填与 `view_type=1` 高精擦除。

也可以不在页面填写，启动服务前设置：

```bash
export BAIDU_TRANSLATE_APP_ID="your-app-id"
export BAIDU_TRANSLATE_API_KEY="your-api-key"
```

如果本机代理把 `fanyi-api.baidu.com` 解析到 `198.18.0.0/16`，后端会自动通过公共 DNS 查询真实地址并直连。也可以设置 `BAIDU_TRANSLATE_DIRECT_IP` 固定直连地址。

凭证测试接口：

```text
POST /baidu/credentials/check
```

## 阿里云图片翻译

`npx openplugin aliyun/alibabacloud-agent-toolkit` 是 Agent Toolkit 安装命令，不是图片翻译 API 地址。本模块实际调用阿里云机器翻译 `TranslateImage`（API 版本 `2018-10-12`）。

1. 开通阿里云机器翻译图片翻译服务。
2. 给 RAM 用户授予 `alimt:TranslateImage` 权限。
3. 在页面选择“阿里云图片翻译 API”。
4. 填写 `AccessKey ID`、`AccessKey Secret`，选择地域和图片翻译类型。

也可以使用标准环境变量：

```bash
export ALIBABA_CLOUD_ACCESS_KEY_ID="your-access-key-id"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="your-access-key-secret"
export ALIBABA_CLOUD_REGION_ID="cn-hangzhou"
```

测试连接会实际调用一次图片翻译：

```text
POST /aliyun/credentials/check
```
