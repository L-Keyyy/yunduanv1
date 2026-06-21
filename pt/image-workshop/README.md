# 商品图翻译 OCR 模块

这个目录是独立版图片工坊模块，包含：

- `backend/app.py`：独立 FastAPI 服务，提供页面和图片翻译接口。
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

返回：

- `image`：处理后的 PNG data URL。
- `regions`：OCR 命中的文字区域。
- `engine`：使用的识别引擎。
- `warnings`：处理警告。
