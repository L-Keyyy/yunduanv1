import base64
import binascii
import io
import ipaddress
import ssl
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit

import httpx


BAIDU_IMAGE_TRANSLATE_URL = "https://fanyi-api.baidu.com/ait/api/picture/translate"
BAIDU_MAX_IMAGE_BYTES = 5 * 1024 * 1024
BAIDU_DOH_URLS = (
    "https://cloudflare-dns.com/dns-query",
    "https://dns.google/resolve",
)


class BaiduImageTranslationError(RuntimeError):
    pass


class BaiduCredentialError(BaiduImageTranslationError):
    pass


@dataclass
class BaiduImageTranslationResult:
    image_data_url: str
    source_text: str
    translated_text: str
    detected_source_language: str
    target_language: str
    contents: List[Dict[str, Any]]


class BaiduImageTranslationService:
    """Baidu Picture Translation API V2.0 Bearer-token client."""

    def __init__(
        self,
        *,
        translate_url: str = BAIDU_IMAGE_TRANSLATE_URL,
        client_factory: Callable[..., Any] = httpx.AsyncClient,
        direct_ip: str = "",
    ) -> None:
        self.translate_url = translate_url
        self._client_factory = client_factory
        self._direct_ip = direct_ip.strip()

    async def check_credentials(
        self,
        *,
        app_id: str,
        api_key: str,
    ) -> None:
        app_id, api_key = self._normalize_credentials(app_id, api_key)
        payload = self._request_payload(
            _credential_test_image(),
            app_id=app_id,
            source_language="en",
            target_language="zh",
            paste=0,
            high_precision_erase=True,
        )
        await self._post_translation(payload, api_key)

    async def translate(
        self,
        image_bytes: bytes,
        *,
        app_id: str,
        api_key: str,
        source_language: str = "auto",
        target_language: str = "ru",
        high_precision_erase: bool = True,
    ) -> BaiduImageTranslationResult:
        app_id, api_key = self._normalize_credentials(app_id, api_key)
        if not image_bytes:
            raise ValueError("图片不能为空")
        if len(image_bytes) > BAIDU_MAX_IMAGE_BYTES:
            raise ValueError("百度图片翻译 V2.0 要求原图不能超过 5MB")

        request_payload = self._request_payload(
            image_bytes,
            app_id=app_id,
            source_language=source_language,
            target_language=target_language,
            paste=1,
            high_precision_erase=high_precision_erase,
        )
        data = await self._post_translation(request_payload, api_key)
        paste_image = str(
            data.get("paste_img")
            or data.get("pasteImg")
            or ""
        ).strip()
        if not paste_image:
            raise BaiduImageTranslationError("百度已返回翻译结果，但没有返回整图贴合图片")

        contents = data.get("contents")
        if not isinstance(contents, list):
            contents = data.get("content")
        if not isinstance(contents, list):
            contents = []

        return BaiduImageTranslationResult(
            image_data_url=_base64_image_to_data_url(paste_image),
            source_text=str(data.get("src") or data.get("sumSrc") or ""),
            translated_text=str(data.get("dst") or data.get("sumDst") or ""),
            detected_source_language=str(data.get("from") or source_language or "auto"),
            target_language=str(data.get("to") or target_language or ""),
            contents=[item for item in contents if isinstance(item, dict)],
        )

    @staticmethod
    def _request_payload(
        image_bytes: bytes,
        *,
        app_id: str,
        source_language: str,
        target_language: str,
        paste: int,
        high_precision_erase: bool,
    ) -> Dict[str, Any]:
        return {
            "from": (source_language or "auto").strip().lower(),
            "to": (target_language or "ru").strip().lower(),
            "appid": app_id,
            "content": base64.b64encode(image_bytes).decode("ascii"),
            "paste": paste,
            "need_intervene": 0,
            "view_type": 1 if high_precision_erase else 0,
            "model_type": "nmt",
        }

    async def _post_translation(
        self,
        request_payload: Dict[str, Any],
        api_key: str,
    ) -> Dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        try:
            response = await self._post(self.translate_url, request_payload, headers)
        except httpx.ConnectError:
            response = await self._post_through_direct_ip(request_payload, headers)
        except httpx.TimeoutException as exc:
            raise BaiduImageTranslationError("百度图片翻译请求超时，请稍后重试") from exc
        except httpx.HTTPError as exc:
            raise BaiduImageTranslationError("无法连接百度图片翻译服务") from exc

        payload = self._response_json(response, "百度图片翻译")
        self._raise_api_error(payload, response.status_code)
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        return data

    async def _post(
        self,
        url: str,
        payload: Dict[str, Any],
        headers: Dict[str, str],
    ) -> httpx.Response:
        async with self._client_factory(
            timeout=httpx.Timeout(90.0, connect=20.0)
        ) as client:
            return await client.post(url, json=payload, headers=headers)

    async def _post_through_direct_ip(
        self,
        payload: Dict[str, Any],
        headers: Dict[str, str],
    ) -> httpx.Response:
        try:
            direct_ip = self._direct_ip or await self._resolve_direct_ip()
            parsed = urlsplit(self.translate_url)
            direct_url = f"https://{direct_ip}{parsed.path}"
            if parsed.query:
                direct_url = f"{direct_url}?{parsed.query}"

            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            direct_headers = dict(headers)
            direct_headers["Host"] = parsed.hostname or "fanyi-api.baidu.com"
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(90.0, connect=20.0),
                verify=ssl_context,
                trust_env=False,
            ) as client:
                return await client.post(
                    direct_url,
                    json=payload,
                    headers=direct_headers,
                )
        except httpx.TimeoutException as exc:
            raise BaiduImageTranslationError("百度图片翻译请求超时，请稍后重试") from exc
        except Exception as exc:
            raise BaiduImageTranslationError(
                "无法连接百度图片翻译服务，请将 fanyi-api.baidu.com 设置为代理直连"
            ) from exc

    async def _resolve_direct_ip(self) -> str:
        hostname = urlsplit(self.translate_url).hostname or "fanyi-api.baidu.com"
        for doh_url in BAIDU_DOH_URLS:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.get(
                        doh_url,
                        params={"name": hostname, "type": "A"},
                        headers={"Accept": "application/dns-json"},
                    )
                payload = response.json()
                for answer in payload.get("Answer") or []:
                    if int(answer.get("type") or 0) != 1:
                        continue
                    candidate = str(answer.get("data") or "").strip()
                    if ipaddress.ip_address(candidate).version == 4:
                        self._direct_ip = candidate
                        return candidate
            except Exception:
                continue
        raise BaiduImageTranslationError("无法解析百度图片翻译服务地址")

    @staticmethod
    def _normalize_credentials(app_id: str, api_key: str) -> tuple:
        normalized_app_id = str(app_id or "").strip()
        normalized_api_key = str(api_key or "").strip()
        missing = []
        if not normalized_app_id:
            missing.append("APP ID")
        if not normalized_api_key:
            missing.append("API Key")
        if missing:
            raise BaiduCredentialError(f"请填写百度 {' / '.join(missing)}")
        return normalized_app_id, normalized_api_key

    @staticmethod
    def _response_json(response: httpx.Response, service_name: str) -> Dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            raise BaiduImageTranslationError(f"{service_name}返回了无法解析的数据") from exc
        if not isinstance(payload, dict):
            raise BaiduImageTranslationError(f"{service_name}返回格式不正确")
        return payload

    @staticmethod
    def _raise_api_error(payload: Dict[str, Any], status_code: int) -> None:
        error_code = payload.get("error_code")
        has_error_code = error_code not in (None, "", 0, "0")
        if status_code < 400 and not has_error_code and not payload.get("error"):
            return
        message = str(
            payload.get("error_msg")
            or payload.get("error_description")
            or payload.get("error")
            or f"HTTP {status_code}"
        )
        prefix = f"{error_code}：" if has_error_code else ""
        error_message = f"百度图片翻译失败：{prefix}{message}"
        if str(error_code) in {"54001", "55002", "55007"} or status_code in {401, 403}:
            raise BaiduCredentialError(error_message)
        raise BaiduImageTranslationError(error_message)


def _credential_test_image() -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (360, 120), "white")
    ImageDraw.Draw(image).text((24, 42), "TEST IMAGE", fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _base64_image_to_data_url(value: str) -> str:
    if value.startswith("data:image/") and ";base64," in value:
        return value

    encoded = "".join(value.split())
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BaiduImageTranslationError("百度返回的贴合图片 Base64 无效") from exc
    if not image_bytes:
        raise BaiduImageTranslationError("百度返回的贴合图片为空")

    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        mime_type = "image/png"
    elif image_bytes.startswith(b"\xff\xd8\xff"):
        mime_type = "image/jpeg"
    elif image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        mime_type = "image/webp"
    else:
        mime_type = "image/png"
    return f"data:{mime_type};base64,{encoded}"
