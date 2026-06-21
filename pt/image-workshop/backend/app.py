from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .chatgpt_web_bridge import (
    bridge_status,
    cleanup_old_jobs,
    create_chatgpt_job,
    open_chatgpt_page,
    serialize_job,
)
from .image_workshop_processor import process_product_image


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"

app = FastAPI(title="Image Workshop OCR")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, str]:
    return {"ok": "true"}


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
) -> Dict[str, Any]:
    content_type = (file.content_type or "").lower()
    if content_type and not content_type.startswith("image/") and content_type != "application/octet-stream":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请上传图片文件")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图片不能为空")
    if len(image_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="图片不能超过 12MB")

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
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")
