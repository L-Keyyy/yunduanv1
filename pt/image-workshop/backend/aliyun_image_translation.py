import base64
import io
import json
from dataclasses import dataclass
from typing import Any, Callable, Optional

import httpx


ALIYUN_MAX_IMAGE_BYTES = 10 * 1024 * 1024
SUPPORTED_FIELDS = {"general", "e-commerce"}


class AliyunImageTranslationError(RuntimeError):
    pass


class AliyunCredentialError(AliyunImageTranslationError):
    pass


@dataclass
class AliyunImageTranslationResult:
    image_data_url: str
    final_image_url: str
    in_painting_url: str
    template_json: str


class AliyunImageTranslationService:
    """Alibaba Cloud Machine Translation TranslateImage client."""

    def __init__(
        self,
        *,
        client_factory: Optional[Callable[[str, str, str], Any]] = None,
        download_client_factory: Callable[..., Any] = httpx.AsyncClient,
    ) -> None:
        self._client_factory = client_factory or self._create_client
        self._download_client_factory = download_client_factory

    async def check_credentials(
        self,
        *,
        access_key_id: str,
        access_key_secret: str,
        region_id: str = "cn-hangzhou",
    ) -> None:
        await self.translate(
            _credential_test_image(),
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            region_id=region_id,
            source_language="en",
            target_language="zh",
            field="general",
        )

    async def translate(
        self,
        image_bytes: bytes,
        *,
        access_key_id: str,
        access_key_secret: str,
        region_id: str = "cn-hangzhou",
        source_language: str = "zh",
        target_language: str = "ru",
        field: str = "e-commerce",
    ) -> AliyunImageTranslationResult:
        access_key_id, access_key_secret, region_id = self._normalize_credentials(
            access_key_id,
            access_key_secret,
            region_id,
        )
        if not image_bytes:
            raise ValueError("图片不能为空")
        if len(image_bytes) > ALIYUN_MAX_IMAGE_BYTES:
            raise ValueError("阿里云图片翻译要求原图不能超过 10MB")
        normalized_field = field if field in SUPPORTED_FIELDS else "e-commerce"

        try:
            from Tea.exceptions import TeaException
            from alibabacloud_alimt20181012 import models as alimt_models
            from alibabacloud_tea_util import models as util_models
        except Exception as exc:
            raise AliyunImageTranslationError(
                "缺少阿里云机器翻译 SDK，请安装 alibabacloud_alimt20181012"
            ) from exc

        client = self._client_factory(access_key_id, access_key_secret, region_id)
        request = alimt_models.TranslateImageRequest(
            image_base_64=base64.b64encode(image_bytes).decode("ascii"),
            source_language=(source_language or "zh").strip().lower(),
            target_language=(target_language or "ru").strip().lower(),
            field=normalized_field,
            ext=json.dumps(
                {
                    "needEditorData": "false",
                    "ignoreEntityRecognize": "true",
                },
                separators=(",", ":"),
            ),
        )
        runtime = util_models.RuntimeOptions(
            autoretry=True,
            max_attempts=2,
            connect_timeout=20_000,
            read_timeout=90_000,
        )
        try:
            response = await client.translate_image_with_options_async(request, runtime)
        except TeaException as exc:
            code = str(getattr(exc, "code", "") or "")
            message = str(getattr(exc, "message", "") or str(exc))
            if _is_credential_error(code, message, getattr(exc, "statusCode", None)):
                raise AliyunCredentialError(f"阿里云 AccessKey 验证失败：{code or message}") from exc
            raise AliyunImageTranslationError(
                f"阿里云图片翻译失败：{code or message}"
            ) from exc
        except Exception as exc:
            raise AliyunImageTranslationError("无法连接阿里云图片翻译服务") from exc

        body = getattr(response, "body", None)
        code = int(getattr(body, "code", 0) or 0)
        message = str(getattr(body, "message", "") or "")
        if code != 200:
            if _is_credential_error(str(code), message, getattr(response, "status_code", None)):
                raise AliyunCredentialError(f"阿里云 AccessKey 验证失败：{message or code}")
            raise AliyunImageTranslationError(f"阿里云图片翻译失败：{message or code}")

        data = getattr(body, "data", None)
        final_image_url = str(getattr(data, "final_image_url", "") or "").strip()
        if not final_image_url:
            raise AliyunImageTranslationError("阿里云没有返回最终翻译图片")
        image_data_url = await self._download_image(final_image_url)
        return AliyunImageTranslationResult(
            image_data_url=image_data_url,
            final_image_url=final_image_url,
            in_painting_url=str(getattr(data, "in_painting_url", "") or ""),
            template_json=str(getattr(data, "template_json", "") or ""),
        )

    @staticmethod
    def _create_client(access_key_id: str, access_key_secret: str, region_id: str):
        from alibabacloud_alimt20181012.client import Client
        from alibabacloud_tea_openapi import models as open_api_models

        config = open_api_models.Config(
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            region_id=region_id,
            endpoint="mt.cn-hangzhou.aliyuncs.com"
            if region_id == "cn-hangzhou"
            else "mt.aliyuncs.com",
        )
        return Client(config)

    async def _download_image(self, url: str) -> str:
        try:
            async with self._download_client_factory(
                timeout=httpx.Timeout(60.0, connect=15.0),
                follow_redirects=True,
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise AliyunImageTranslationError("阿里云译图已生成，但下载失败") from exc

        image_bytes = response.content
        if not image_bytes:
            raise AliyunImageTranslationError("阿里云返回的翻译图片为空")
        if len(image_bytes) > 25 * 1024 * 1024:
            raise AliyunImageTranslationError("阿里云返回的翻译图片超过 25MB")
        content_type = str(response.headers.get("content-type") or "").split(";", 1)[0]
        mime_type = content_type if content_type.startswith("image/") else _detect_image_mime(image_bytes)
        encoded = base64.b64encode(image_bytes).decode("ascii")
        return f"data:{mime_type};base64,{encoded}"

    @staticmethod
    def _normalize_credentials(
        access_key_id: str,
        access_key_secret: str,
        region_id: str,
    ):
        normalized_id = str(access_key_id or "").strip()
        normalized_secret = str(access_key_secret or "").strip()
        normalized_region = str(region_id or "cn-hangzhou").strip()
        missing = []
        if not normalized_id:
            missing.append("AccessKey ID")
        if not normalized_secret:
            missing.append("AccessKey Secret")
        if missing:
            raise AliyunCredentialError(f"请填写阿里云 {' / '.join(missing)}")
        return normalized_id, normalized_secret, normalized_region


def _is_credential_error(code: str, message: str, status_code: Any) -> bool:
    text = f"{code} {message}".lower()
    return status_code in {401, 403} or any(
        marker in text
        for marker in (
            "invalidaccesskeyid",
            "signaturedoesnotmatch",
            "forbidden",
            "unauthorized",
            "accesskey",
            "signature",
        )
    )


def _credential_test_image() -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (360, 120), "white")
    ImageDraw.Draw(image).text((24, 42), "TEST IMAGE", fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _detect_image_mime(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    if image_bytes.startswith(b"GIF8"):
        return "image/gif"
    return "image/png"
