import os
import base64
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .aliyun_image_translation import (
    AliyunCredentialError,
    AliyunImageTranslationError,
    AliyunImageTranslationService,
)
from .baidu_image_translation import (
    BaiduCredentialError,
    BaiduImageTranslationError,
    BaiduImageTranslationService,
)
from .doubao_web_image_translation import (
    DoubaoWebImageServiceBusyError,
    DoubaoWebImageTranslationError,
    DoubaoWebImageTranslationService,
)
from .chatgpt_web_bridge import (
    bridge_status,
    cleanup_old_jobs,
    create_chatgpt_job,
    open_chatgpt_page,
    serialize_job,
)
from .image_workshop_processor import (
    process_product_image,
    process_product_image_regions,
)
from .image_translation_atlas import (
    AtlasInput,
    build_atlas_batches,
    crop_translated_atlas,
    data_url_bytes,
    png_data_url,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"
WORKSPACE_ROOT = ROOT_DIR.parents[1]
SHARED_BACKEND_DIR = WORKSPACE_ROOT / "ozon_websit" / "backend"
if str(SHARED_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_BACKEND_DIR))

try:
    from google_translate_image_rpc import (  # noqa: E402
        GoogleTranslateImageRpcError,
        GoogleTranslateImageRpcService,
        GoogleTranslateImageServiceBusyError,
    )
except ModuleNotFoundError:
    from .google_translate_image_rpc import (  # type: ignore
        GoogleTranslateImageRpcError,
        GoogleTranslateImageRpcService,
        GoogleTranslateImageServiceBusyError,
    )


def _env_bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


google_translate_image_service = GoogleTranslateImageRpcService(
    chrome_devtools_base=os.getenv(
        "CHROME_DEVTOOLS_BASE", "http://127.0.0.1:9222"
    ),
    browser_auto_start=_env_bool(
        "GOOGLE_TRANSLATE_IMAGE_BROWSER_AUTO_START", True
    ),
    browser_binary=os.getenv("GOOGLE_TRANSLATE_IMAGE_BROWSER_BINARY", ""),
    browser_profile_dir=os.getenv(
        "GOOGLE_TRANSLATE_IMAGE_BROWSER_PROFILE_DIR", "/tmp/chrome-9222"
    ),
    browser_headless=_env_bool(
        "GOOGLE_TRANSLATE_IMAGE_BROWSER_HEADLESS", True
    ),
    request_timeout_seconds=float(
        os.getenv("GOOGLE_TRANSLATE_IMAGE_TIMEOUT_SECONDS", "60")
    ),
    max_pending_requests=int(
        os.getenv("GOOGLE_TRANSLATE_IMAGE_MAX_PENDING_REQUESTS", "8")
    ),
    max_attempts=int(
        os.getenv("GOOGLE_TRANSLATE_IMAGE_MAX_ATTEMPTS", "2")
    ),
)

baidu_image_translation_service = BaiduImageTranslationService(
    direct_ip=os.getenv("BAIDU_TRANSLATE_DIRECT_IP", ""),
)
aliyun_image_translation_service = AliyunImageTranslationService()
doubao_web_image_translation_service = DoubaoWebImageTranslationService(
    chrome_devtools_base=os.getenv(
        "CHROME_DEVTOOLS_BASE", "http://127.0.0.1:9222"
    ),
    request_timeout_seconds=float(
        os.getenv("DOUBAO_WEB_IMAGE_TIMEOUT_SECONDS", "90")
    ),
    max_pending_requests=int(
        os.getenv("DOUBAO_WEB_IMAGE_MAX_PENDING_REQUESTS", "4")
    ),
)

app = FastAPI(title="Image Workshop OCR")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class DoubaoGenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=60000)
    images: List[str] = Field(default_factory=list, max_length=4)
    responseType: str = Field(default="text")


def _decode_image_data_url(value: str, index: int) -> Tuple[bytes, str]:
    match = re.fullmatch(
        r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)",
        str(value or ""),
    )
    if not match:
        raise ValueError(f"第 {index} 张参考图格式无效")
    try:
        image_bytes = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"第 {index} 张参考图 base64 内容无效") from exc
    if not image_bytes or len(image_bytes) > 12 * 1024 * 1024:
        raise ValueError(f"第 {index} 张参考图大小必须在 1B 到 12MB 之间")
    extension = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }[match.group(1)]
    return image_bytes, f"reference-{index}{extension}"


def _resolve_baidu_credentials(
    app_id: str = "",
    api_key: str = "",
) -> Tuple[str, str]:
    return (
        (app_id or os.getenv("BAIDU_TRANSLATE_APP_ID", "")).strip(),
        (api_key or os.getenv("BAIDU_TRANSLATE_API_KEY", "")).strip(),
    )


def _resolve_aliyun_credentials(
    access_key_id: str = "",
    access_key_secret: str = "",
    region_id: str = "",
) -> Tuple[str, str, str]:
    return (
        (
            access_key_id
            or os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID", "")
        ).strip(),
        (
            access_key_secret
            or os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "")
        ).strip(),
        (
            region_id
            or os.getenv("ALIBABA_CLOUD_REGION_ID", "cn-hangzhou")
        ).strip(),
    )


@app.on_event("startup")
def initialize_application() -> None:
    google_translate_image_service.start()


@app.on_event("shutdown")
def shutdown_application() -> None:
    google_translate_image_service.stop()
    doubao_web_image_translation_service.stop()


@app.get("/health")
def health() -> Dict[str, Any]:
    web_status = google_translate_image_service.status(probe=True)
    baidu_credentials = _resolve_baidu_credentials()
    aliyun_credentials = _resolve_aliyun_credentials()
    doubao_status = doubao_web_image_translation_service.status(probe=True)
    return {
        "ok": True,
        "engines": {
            "local": {"ready": True},
            "web": {"ready": web_status["ready"]},
            "baidu": {
                "ready": True,
                "configured": all(baidu_credentials),
            },
            "aliyun": {
                "ready": True,
                "configured": all(aliyun_credentials[:2]),
            },
            "doubao": {
                "ready": doubao_status["ready"],
                "configured": doubao_status["logged_in"],
                "browser_connected": doubao_status["browser_connected"],
                "detail": doubao_status["detail"],
            },
        },
    }


@app.post("/baidu/credentials/check")
async def check_baidu_credentials(
    app_id: str = Form(""),
    api_key: str = Form(""),
) -> Dict[str, Any]:
    resolved_app_id, resolved_api_key = _resolve_baidu_credentials(
        app_id,
        api_key,
    )
    try:
        await baidu_image_translation_service.check_credentials(
            app_id=resolved_app_id,
            api_key=resolved_api_key,
        )
    except BaiduCredentialError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except BaiduImageTranslationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    return {"ok": True}


@app.post("/aliyun/credentials/check")
async def check_aliyun_credentials(
    access_key_id: str = Form(""),
    access_key_secret: str = Form(""),
    region_id: str = Form("cn-hangzhou"),
) -> Dict[str, Any]:
    resolved_id, resolved_secret, resolved_region = _resolve_aliyun_credentials(
        access_key_id,
        access_key_secret,
        region_id,
    )
    try:
        await aliyun_image_translation_service.check_credentials(
            access_key_id=resolved_id,
            access_key_secret=resolved_secret,
            region_id=resolved_region,
        )
    except AliyunCredentialError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except AliyunImageTranslationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    return {"ok": True}


@app.get("/doubao/status")
def doubao_status() -> Dict[str, Any]:
    return doubao_web_image_translation_service.status(probe=True)


@app.post("/doubao/open")
def open_doubao_page() -> Dict[str, Any]:
    try:
        return doubao_web_image_translation_service.open_page()
    except DoubaoWebImageTranslationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@app.post("/doubao/generate")
async def generate_with_doubao(input: DoubaoGenerateRequest) -> Dict[str, Any]:
    response_type = (input.responseType or "text").strip().lower()
    if response_type not in {"text", "image"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="responseType 仅支持 text 或 image",
        )
    try:
        images = [
            _decode_image_data_url(image, index)
            for index, image in enumerate(input.images, start=1)
        ]
        result = await doubao_web_image_translation_service.generate(
            input.prompt,
            images=images,
            expect_image=response_type == "image",
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except DoubaoWebImageServiceBusyError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
        ) from exc
    except DoubaoWebImageTranslationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc

    if response_type == "image" and not result.image:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="豆包网页没有返回生成图片",
        )
    if response_type == "text" and not result.text:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="豆包网页没有返回文本内容",
        )
    return {
        "ok": True,
        "model": "doubao-image-web" if response_type == "image" else "doubao-web",
        "text": result.text,
        "image": result.image,
    }


@app.get("/chatgpt/status")
def chatgpt_status(browser_mode: str = "visible") -> Dict[str, Any]:
    return bridge_status(browser_mode)


@app.post("/chatgpt/open")
def chatgpt_open(browser_mode: str = "visible") -> Dict[str, Any]:
    try:
        return open_chatgpt_page(browser_mode)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@app.post("/chatgpt/jobs")
async def create_chatgpt_image_job(
    file: UploadFile = File(...),
    prompt: str = Form(...),
    browser_mode: str = Form("visible"),
) -> Dict[str, Any]:
    content_type = (file.content_type or "").lower()
    if content_type and not content_type.startswith("image/") and content_type != "application/octet-stream":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请上传图片文件")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片不能为空")
    if len(image_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="图片不能超过 12MB")

    cleanup_old_jobs()
    try:
        return create_chatgpt_job(
            image_bytes,
            filename=file.filename or "image.png",
            prompt=prompt,
            browser_mode=browser_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@app.get("/chatgpt/jobs/{job_id}")
def get_chatgpt_image_job(job_id: str) -> Dict[str, Any]:
    try:
        return serialize_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在") from exc


@app.post("/translate")
async def translate_image(
    file: UploadFile = File(...),
    target_language: str = Form("ru"),
    translation_mode: str = Form("product_short"),
    ocr_engine: str = Form("local"),
    baidu_app_id: str = Form(""),
    baidu_api_key: str = Form(""),
    aliyun_access_key_id: str = Form(""),
    aliyun_access_key_secret: str = Form(""),
    aliyun_region_id: str = Form("cn-hangzhou"),
    aliyun_field: str = Form("e-commerce"),
) -> Dict[str, Any]:
    content_type = (file.content_type or "").lower()
    if content_type and not content_type.startswith("image/") and content_type != "application/octet-stream":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请上传图片文件")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片不能为空")
    if len(image_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="图片不能超过 12MB")

    normalized_engine = (ocr_engine or "local").strip().lower()
    if normalized_engine not in {"local", "web", "baidu", "aliyun", "doubao"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="不支持的图片翻译引擎",
        )

    if normalized_engine == "aliyun":
        resolved_id, resolved_secret, resolved_region = _resolve_aliyun_credentials(
            aliyun_access_key_id,
            aliyun_access_key_secret,
            aliyun_region_id,
        )
        try:
            result = await aliyun_image_translation_service.translate(
                image_bytes,
                access_key_id=resolved_id,
                access_key_secret=resolved_secret,
                region_id=resolved_region,
                source_language="zh",
                target_language=target_language,
                field=aliyun_field,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except AliyunCredentialError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except AliyunImageTranslationError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc

        return {
            "image": result.image_data_url,
            "background": result.image_data_url,
            "regions": [],
            "engine": "aliyun-image-translation",
            "warnings": [],
            "sourceText": "",
            "translatedText": "",
            "detectedSourceLanguage": "zh",
        }

    if normalized_engine == "doubao":
        try:
            doubao_result = await doubao_web_image_translation_service.translate(
                image_bytes,
                filename=file.filename or "image.png",
                source_language="auto",
                target_language=target_language,
            )
            render_result = process_product_image_regions(
                image_bytes,
                regions=doubao_result.regions,
                target_language=target_language,
                engine="doubao-image-translation",
                warnings=[]
                if doubao_result.regions
                else ["豆包没有检测到可翻译的文字区域。"],
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except DoubaoWebImageServiceBusyError as exc:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=str(exc),
            ) from exc
        except DoubaoWebImageTranslationError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        except RuntimeError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc

        return {
            "image": render_result.image_data_url,
            "background": render_result.background_data_url,
            "regions": render_result.regions,
            "engine": render_result.engine,
            "model": "doubao-web",
            "warnings": render_result.warnings,
            "sourceText": doubao_result.source_text,
            "translatedText": doubao_result.translated_text,
            "detectedSourceLanguage": doubao_result.detected_source_language,
        }

    if normalized_engine == "baidu":
        resolved_app_id, resolved_api_key = _resolve_baidu_credentials(
            baidu_app_id,
            baidu_api_key,
        )
        try:
            result = await baidu_image_translation_service.translate(
                image_bytes,
                app_id=resolved_app_id,
                api_key=resolved_api_key,
                source_language="auto",
                target_language=target_language,
                high_precision_erase=True,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except BaiduCredentialError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except BaiduImageTranslationError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc

        return {
            "image": result.image_data_url,
            "background": result.image_data_url,
            "regions": [],
            "engine": "baidu-image-translation-v2",
            "warnings": [],
            "sourceText": result.source_text,
            "translatedText": result.translated_text,
            "detectedSourceLanguage": result.detected_source_language,
        }

    if normalized_engine == "web":
        try:
            result = await google_translate_image_service.translate(
                image_bytes,
                filename=file.filename or "image.png",
                mime_type=file.content_type,
                source_language="auto",
                target_language=target_language,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except GoogleTranslateImageServiceBusyError as exc:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=str(exc),
            ) from exc
        except GoogleTranslateImageRpcError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="网页图片翻译暂时不可用，请稍后重试",
            ) from exc

        return {
            "image": result.image_data_url,
            "background": result.image_data_url,
            "regions": [],
            "engine": "web-image-translation",
            "warnings": [],
            "sourceText": result.source_text,
            "translatedText": result.translated_text,
            "detectedSourceLanguage": result.detected_source_language,
        }

    try:
        result = process_product_image(
            image_bytes,
            filename=file.filename or "image.png",
            target_language=target_language,
            translation_mode=translation_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc

    return {
        "image": result.image_data_url,
        "background": result.background_data_url,
        "regions": result.regions,
        "engine": result.engine,
        "warnings": result.warnings,
        "sourceText": "",
        "translatedText": "",
        "detectedSourceLanguage": "",
    }


@app.post("/translate-atlas")
async def translate_image_atlas(
    files: List[UploadFile] = File(...),
    image_ids: str = Form("[]"),
    target_language: str = Form("ru"),
) -> Dict[str, Any]:
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请至少上传一张图片",
        )
    if len(files) > 20:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="图集批量翻译一次最多处理 20 张图片",
        )
    try:
        parsed_ids = json.loads(image_ids or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image_ids 格式无效",
        ) from exc
    if not isinstance(parsed_ids, list):
        parsed_ids = []

    atlas_inputs: List[AtlasInput] = []
    total_size = 0
    for index, file in enumerate(files):
        content_type = (file.content_type or "").lower()
        if content_type and not content_type.startswith("image/") and content_type != "application/octet-stream":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index + 1} 个文件不是图片",
            )
        image_bytes = await file.read()
        if not image_bytes or len(image_bytes) > 12 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"第 {index + 1} 张图片大小必须在 1B 到 12MB 之间",
            )
        total_size += len(image_bytes)
        if total_size > 60 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="图集批量翻译总文件大小不能超过 60MB",
            )
        atlas_inputs.append(
            AtlasInput(
                image_id=str(parsed_ids[index])
                if index < len(parsed_ids)
                else str(index),
                name=file.filename or f"image-{index + 1}.png",
                image_bytes=image_bytes,
            )
        )

    try:
        batches = build_atlas_batches(
            atlas_inputs,
            max_width=int(os.getenv("GOOGLE_TRANSLATE_ATLAS_MAX_WIDTH", "4096")),
            max_height=int(os.getenv("GOOGLE_TRANSLATE_ATLAS_MAX_HEIGHT", "4096")),
            margin=int(os.getenv("GOOGLE_TRANSLATE_ATLAS_MARGIN", "32")),
            gutter=int(os.getenv("GOOGLE_TRANSLATE_ATLAS_GUTTER", "48")),
        )
        crops = []
        source_texts = []
        translated_texts = []
        detected_languages = []
        for batch in batches:
            translated = await google_translate_image_service.translate(
                batch.image_bytes,
                filename=f"translation-atlas-{batch.index + 1}.png",
                mime_type="image/png",
                source_language="auto",
                target_language=target_language,
            )
            crops.extend(
                crop_translated_atlas(
                    data_url_bytes(translated.image_data_url),
                    batch,
                )
            )
            if translated.source_text:
                source_texts.append(translated.source_text)
            if translated.translated_text:
                translated_texts.append(translated.translated_text)
            if translated.detected_source_language:
                detected_languages.append(translated.detected_source_language)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except GoogleTranslateImageServiceBusyError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
        ) from exc
    except GoogleTranslateImageRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc

    crop_by_id = {crop.image_id: crop for crop in crops}
    ordered_results = []
    for item in atlas_inputs:
        crop = crop_by_id.get(item.image_id)
        if crop is None:
            continue
        ordered_results.append(
            {
                "imageId": crop.image_id,
                "name": crop.name,
                "image": png_data_url(crop.image_bytes),
                "width": crop.width,
                "height": crop.height,
                "atlasIndex": crop.atlas_index,
            }
        )

    return {
        "engine": "web-image-translation-atlas",
        "atlasCount": len(batches),
        "imageCount": len(ordered_results),
        "results": ordered_results,
        "sourceText": "\n".join(source_texts),
        "translatedText": "\n".join(translated_texts),
        "detectedSourceLanguages": detected_languages,
        "targetLanguage": target_language,
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/product-page")
def product_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "product-page.html")


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")
