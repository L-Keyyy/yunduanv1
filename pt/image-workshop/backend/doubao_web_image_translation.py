import json
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
import websocket


DOUBAO_CHAT_URL = "https://www.doubao.com/chat/"

TARGET_LANGUAGE_NAMES = {
    "ru": "俄语",
    "en": "英语",
    "es": "西班牙语",
    "de": "德语",
    "zh": "简体中文",
    "zh-cn": "简体中文",
    "ja": "日语",
    "ko": "韩语",
}


class DoubaoWebImageTranslationError(RuntimeError):
    pass


class DoubaoWebImageServiceBusyError(DoubaoWebImageTranslationError):
    pass


@dataclass
class DoubaoWebImageTranslationResult:
    regions: List[Dict[str, Any]]
    source_text: str
    translated_text: str
    detected_source_language: str
    target_language: str


@dataclass
class DoubaoWebGenerationResult:
    text: str
    image: str


class DoubaoWebImageTranslationService:
    """Drive a signed-in Doubao web page through Chrome DevTools."""

    def __init__(
        self,
        *,
        chrome_devtools_base: str = "http://127.0.0.1:9222",
        request_timeout_seconds: float = 90,
        max_pending_requests: int = 4,
    ) -> None:
        self.chrome_devtools_base = chrome_devtools_base.rstrip("/")
        self.request_timeout_seconds = max(20.0, float(request_timeout_seconds))
        self.max_pending_requests = max(1, int(max_pending_requests))
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="doubao-web-image-translate",
        )
        self._pending = 0
        self._pending_lock = threading.Lock()

    async def translate(
        self,
        image_bytes: bytes,
        *,
        filename: str = "image.png",
        source_language: str = "auto",
        target_language: str = "ru",
    ) -> DoubaoWebImageTranslationResult:
        if not image_bytes:
            raise ValueError("图片不能为空")
        if len(image_bytes) > 12 * 1024 * 1024:
            raise ValueError("豆包网页版上传图片不能超过 12MB")

        return await self._enqueue(
            self._translate_sync,
            image_bytes,
            filename,
            source_language,
            target_language,
        )

    async def generate(
        self,
        prompt: str,
        *,
        images: Optional[List[tuple[bytes, str]]] = None,
        expect_image: bool = False,
    ) -> DoubaoWebGenerationResult:
        normalized_prompt = str(prompt or "").strip()
        if not normalized_prompt:
            raise ValueError("提示词不能为空")
        if len(normalized_prompt) > 60000:
            raise ValueError("提示词不能超过 60000 个字符")

        normalized_images = list(images or [])
        if len(normalized_images) > 4:
            raise ValueError("豆包网页版一次最多上传 4 张参考图")
        for image_bytes, _ in normalized_images:
            if not image_bytes:
                raise ValueError("参考图不能为空")
            if len(image_bytes) > 12 * 1024 * 1024:
                raise ValueError("单张参考图不能超过 12MB")

        return await self._enqueue(
            self._generate_sync,
            normalized_prompt,
            normalized_images,
            expect_image,
        )

    async def _enqueue(self, function, *args):
        with self._pending_lock:
            if self._pending >= self.max_pending_requests:
                raise DoubaoWebImageServiceBusyError("豆包网页任务队列已满，请稍后重试")
            self._pending += 1

        try:
            import asyncio

            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(self._executor, function, *args)
        finally:
            with self._pending_lock:
                self._pending = max(0, self._pending - 1)

    def stop(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    def status(self, *, probe: bool = False) -> Dict[str, Any]:
        try:
            pages = _devtools_pages(self.chrome_devtools_base)
        except Exception as exc:
            return {
                "ready": False,
                "browser_connected": False,
                "doubao_tab": False,
                "logged_in": False,
                "detail": str(exc),
            }

        target = _find_doubao_target(pages)
        result = {
            "ready": bool(target),
            "browser_connected": True,
            "doubao_tab": bool(target),
            "logged_in": False,
            "detail": "豆包网页已打开" if target else "豆包网页尚未打开",
        }
        if probe and target:
            try:
                state = _probe_target(target)
                result.update(state)
                result["ready"] = bool(state.get("page_ready"))
            except Exception as exc:
                result["ready"] = False
                result["detail"] = f"豆包网页检测失败：{exc}"
        return result

    def open_page(self) -> Dict[str, Any]:
        pages = _devtools_pages(self.chrome_devtools_base)
        target = _find_doubao_target(pages)
        if target is None:
            target = _create_target(self.chrome_devtools_base, DOUBAO_CHAT_URL)
        _bring_to_front(target)
        return {
            "ok": True,
            "target_id": target.get("id", ""),
            "url": target.get("url") or DOUBAO_CHAT_URL,
        }

    def _translate_sync(
        self,
        image_bytes: bytes,
        filename: str,
        source_language: str,
        target_language: str,
    ) -> DoubaoWebImageTranslationResult:
        target = self.open_page()
        pages = _devtools_pages(self.chrome_devtools_base)
        page = next(
            (
                item
                for item in pages
                if str(item.get("id") or "") == str(target.get("target_id") or "")
            ),
            None,
        ) or _find_doubao_target(pages)
        if page is None:
            raise DoubaoWebImageTranslationError("没有找到豆包网页标签页")

        suffix = Path(filename or "image.png").suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            suffix = ".png"
        with tempfile.TemporaryDirectory(prefix="doubao-image-") as temp_dir:
            image_path = Path(temp_dir) / f"upload{suffix}"
            image_path.write_bytes(image_bytes)
            response_text = _upload_and_translate(
                page,
                str(image_path),
                source_language=source_language,
                target_language=target_language,
                timeout_seconds=self.request_timeout_seconds,
            )

        parsed = _extract_json_object(response_text)
        image_width, image_height = _image_dimensions(image_bytes)
        regions = _normalize_regions(parsed, image_width, image_height)
        source_text = "\n".join(
            str(region.get("text") or "").strip()
            for region in regions
            if str(region.get("text") or "").strip()
        )
        translated_text = "\n".join(
            str(region.get("translatedText") or "").strip()
            for region in regions
            if str(region.get("translatedText") or "").strip()
        )
        return DoubaoWebImageTranslationResult(
            regions=regions,
            source_text=source_text,
            translated_text=translated_text,
            detected_source_language=str(
                parsed.get("detected_source_language")
                or parsed.get("detectedSourceLanguage")
                or source_language
                or "auto"
            ),
            target_language=(target_language or "ru").strip().lower(),
        )

    def _generate_sync(
        self,
        prompt: str,
        images: List[tuple[bytes, str]],
        expect_image: bool,
    ) -> DoubaoWebGenerationResult:
        target = self.open_page()
        pages = _devtools_pages(self.chrome_devtools_base)
        page = next(
            (
                item
                for item in pages
                if str(item.get("id") or "") == str(target.get("target_id") or "")
            ),
            None,
        ) or _find_doubao_target(pages)
        if page is None:
            raise DoubaoWebImageTranslationError("没有找到豆包网页标签页")

        with tempfile.TemporaryDirectory(prefix="doubao-generate-") as temp_dir:
            image_paths: List[str] = []
            for index, (image_bytes, filename) in enumerate(images):
                suffix = Path(filename or "image.png").suffix.lower()
                if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                    suffix = ".png"
                image_path = Path(temp_dir) / f"reference-{index + 1}{suffix}"
                image_path.write_bytes(image_bytes)
                image_paths.append(str(image_path))

            result = _send_prompt(
                page,
                prompt=prompt,
                image_paths=image_paths,
                expect_image=expect_image,
                timeout_seconds=self.request_timeout_seconds,
            )
        return DoubaoWebGenerationResult(
            text=str(result.get("text") or "").strip(),
            image=str(result.get("image") or "").strip(),
        )


class _CdpClient:
    def __init__(self, websocket_url: str, timeout_seconds: float) -> None:
        self.ws = websocket.create_connection(
            websocket_url,
            timeout=timeout_seconds,
            suppress_origin=True,
        )
        self.next_id = 1

    def close(self) -> None:
        self.ws.close()

    def call(self, method: str, params: Optional[Dict[str, Any]] = None):
        call_id = self.next_id
        self.next_id += 1
        self.ws.send(
            json.dumps(
                {"id": call_id, "method": method, "params": params or {}},
                ensure_ascii=False,
            )
        )
        while True:
            payload = json.loads(self.ws.recv())
            if payload.get("id") != call_id:
                continue
            if payload.get("error"):
                raise DoubaoWebImageTranslationError(
                    str(payload["error"].get("message") or payload["error"])
                )
            return payload.get("result") or {}

    def evaluate(self, expression: str):
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        value = result.get("result") or {}
        if value.get("subtype") == "error":
            raise DoubaoWebImageTranslationError(str(value.get("description") or "页面脚本执行失败"))
        return value.get("value")


def _upload_and_translate(
    target: Dict[str, Any],
    image_path: str,
    *,
    source_language: str,
    target_language: str,
    timeout_seconds: float,
) -> str:
    result = _send_prompt(
        target,
        prompt=_translation_prompt(source_language, target_language),
        image_paths=[image_path],
        expect_image=False,
        timeout_seconds=timeout_seconds,
    )
    return str(result.get("text") or "").strip()


def _send_prompt(
    target: Dict[str, Any],
    *,
    prompt: str,
    image_paths: List[str],
    expect_image: bool,
    timeout_seconds: float,
) -> Dict[str, str]:
    websocket_url = str(target.get("webSocketDebuggerUrl") or "")
    if not websocket_url:
        raise DoubaoWebImageTranslationError("豆包标签页缺少 DevTools WebSocket 地址")

    client = _CdpClient(websocket_url, timeout_seconds)
    try:
        client.call("DOM.enable")
        client.call("Runtime.enable")
        client.call("Page.enable")
        client.call("Page.navigate", {"url": DOUBAO_CHAT_URL})
        _wait_for_page(client, timeout_seconds)

        if image_paths:
            document = client.call("DOM.getDocument", {"depth": 1, "pierce": True})
            root_node_id = int((document.get("root") or {}).get("nodeId") or 0)
            query = client.call(
                "DOM.querySelector",
                {"nodeId": root_node_id, "selector": "input[type=file]"},
            )
            file_node_id = int(query.get("nodeId") or 0)
            if not file_node_id:
                raise DoubaoWebImageTranslationError("豆包网页没有找到图片上传控件")
            client.call(
                "DOM.setFileInputFiles",
                {"nodeId": file_node_id, "files": image_paths},
            )

        set_prompt_expression = f"""
        (() => {{
          const textarea = document.querySelector('textarea[placeholder="发消息..."]');
          if (!textarea) return {{ok:false, reason:'textarea'}};
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype, 'value'
          ).set;
          setter.call(textarea, {json.dumps(prompt, ensure_ascii=False)});
          textarea.dispatchEvent(new InputEvent('input', {{
            bubbles: true,
            inputType: 'insertText',
            data: {json.dumps(prompt, ensure_ascii=False)}
          }}));
          textarea.dispatchEvent(new Event('change', {{bubbles:true}}));
          textarea.focus();
          return {{ok:true, value:textarea.value}};
        }})()
        """
        prompt_state = client.evaluate(set_prompt_expression) or {}
        if not prompt_state.get("ok"):
            raise DoubaoWebImageTranslationError("豆包网页没有找到消息输入框")

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            send_state = client.evaluate(
                """
                (() => {
                  const button = document.querySelector('#flow-end-msg-send');
                  return {
                    exists: !!button,
                    disabled: !button || button.getAttribute('aria-disabled') === 'true'
                      || button.getAttribute('data-disabled') === 'true'
                  };
                })()
                """
            ) or {}
            if send_state.get("exists") and not send_state.get("disabled"):
                break
            time.sleep(0.25)
        else:
            raise DoubaoWebImageTranslationError("豆包图片上传仍在处理中，请稍后重试")

        baseline_ids = client.evaluate(
            "[...document.querySelectorAll('[data-message-id]')].map(e => e.dataset.messageId)"
        ) or []
        client.evaluate("document.querySelector('#flow-end-msg-send')?.click(); true")

        while time.monotonic() < deadline:
            state = client.evaluate(
                f"""
                (() => {{
                  const baseline = new Set({json.dumps(baseline_ids)});
                  const candidates = [...document.querySelectorAll('[data-message-id]')]
                    .filter(node => !baseline.has(node.dataset.messageId))
                    .filter(node => !String(node.className).includes('justify-end'))
                    .filter(node => node.querySelector('.md-box-root'));
                  const message = candidates.at(-1);
                  const markdown = message?.querySelector('.md-box-root');
                  const images = message ? [...message.querySelectorAll('img')]
                    .map(image => ({{
                      src: image.currentSrc || image.src || '',
                      width: image.naturalWidth || image.width || 0,
                      height: image.naturalHeight || image.height || 0
                    }}))
                    .filter(image => image.src
                      && !image.src.startsWith('data:image/svg+xml')
                      && image.width >= 256
                      && image.height >= 256)
                    .map(image => image.src) : [];
                  return {{
                    id: message?.dataset.messageId || '',
                    text: markdown?.innerText || '',
                    streaming: markdown?.dataset.streaming || '',
                    images,
                    loginPrompt: document.body.innerText.includes('登录以解锁更多功能')
                  }};
                }})()
                """
            ) or {}
            images = state.get("images") if isinstance(state.get("images"), list) else []
            if expect_image and images:
                image = _page_image_data(client, str(images[0]))
                return {
                    "text": str(state.get("text") or "").strip(),
                    "image": image,
                }
            if (
                not expect_image
                and state.get("text")
                and state.get("streaming") in {"", "false", False, None}
            ):
                return {"text": str(state["text"]).strip(), "image": ""}
            time.sleep(0.5)

        if expect_image:
            raise DoubaoWebImageTranslationError("等待豆包返回生成图片超时")
        raise DoubaoWebImageTranslationError("等待豆包返回结果超时")
    except websocket.WebSocketException as exc:
        raise DoubaoWebImageTranslationError("豆包网页连接已断开") from exc
    finally:
        client.close()


def _page_image_data(client: _CdpClient, image_url: str) -> str:
    if not image_url:
        return ""
    expression = f"""
    (async () => {{
      const url = {json.dumps(image_url, ensure_ascii=False)};
      try {{
        const response = await fetch(url);
        if (!response.ok) return url;
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {{
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || url));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }});
      }} catch (_) {{
        return url;
      }}
    }})()
    """
    return str(client.evaluate(expression) or image_url)


def _wait_for_page(client: _CdpClient, timeout_seconds: float) -> None:
    deadline = time.monotonic() + min(timeout_seconds, 30)
    last_state: Dict[str, Any] = {}
    while time.monotonic() < deadline:
        state = client.evaluate(
            """
            (() => ({
              ready: document.readyState,
              textarea: !!document.querySelector('textarea[placeholder="发消息..."]'),
              upload: !!document.querySelector('input[type=file]'),
              loggedIn: (document.body?.innerText || '').includes('历史对话')
                || (document.body?.innerText || '').includes('云盘')
            }))()
            """
        ) or {}
        last_state = state
        if (
            state.get("ready") in {"interactive", "complete"}
            and state.get("textarea")
            and state.get("upload")
            and state.get("loggedIn")
        ):
            return
        time.sleep(0.25)
    if last_state.get("textarea") and last_state.get("upload"):
        raise DoubaoWebImageTranslationError("请先在 9222 Chrome 中登录豆包网页版")
    raise DoubaoWebImageTranslationError("豆包网页加载超时")


def _translation_prompt(source_language: str, target_language: str) -> str:
    source_hint = (
        "自动识别原文语言"
        if (source_language or "auto").strip().lower() == "auto"
        else f"原文语言是 {source_language}"
    )
    target_name = TARGET_LANGUAGE_NAMES.get(
        (target_language or "ru").strip().lower(),
        target_language,
    )
    return f"""
识别图片中所有有意义的文字块，{source_hint}，翻译成{target_name}。
只返回一个 JSON 对象，不要 Markdown，不要解释，结构必须是：
{{"detected_source_language":"语言代码","coordinate_space":"normalized_1000","regions":[{{"bbox":[x1,y1,x2,y2],"text":"原文","translated_text":"译文"}}]}}
规则：bbox 使用相对于整张图片的 0 到 1000 整数坐标；左上角是 x1,y1，右下角是 x2,y2；属于同一视觉文字块的内容合并；保留数字、单位、品牌和商品名。
""".strip()


def _devtools_pages(base_url: str) -> List[Dict[str, Any]]:
    try:
        response = httpx.get(f"{base_url}/json/list", timeout=5.0)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise DoubaoWebImageTranslationError(
            f"Chrome DevTools 未连接：{base_url}"
        ) from exc
    return payload if isinstance(payload, list) else []


def _find_doubao_target(pages: List[Dict[str, Any]]):
    return next(
        (
            item
            for item in pages
            if item.get("type") == "page"
            and "doubao.com" in str(item.get("url") or "")
        ),
        None,
    )


def _create_target(base_url: str, url: str) -> Dict[str, Any]:
    try:
        response = httpx.put(
            f"{base_url}/json/new?{quote(url, safe='')}",
            timeout=10.0,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise DoubaoWebImageTranslationError("打开豆包网页失败") from exc
    if not isinstance(payload, dict):
        raise DoubaoWebImageTranslationError("Chrome 没有返回豆包标签页信息")
    return payload


def _bring_to_front(target: Dict[str, Any]) -> None:
    websocket_url = str(target.get("webSocketDebuggerUrl") or "")
    if not websocket_url:
        return
    client = _CdpClient(websocket_url, 10)
    try:
        client.call("Page.bringToFront")
    finally:
        client.close()


def _probe_target(target: Dict[str, Any]) -> Dict[str, Any]:
    websocket_url = str(target.get("webSocketDebuggerUrl") or "")
    client = _CdpClient(websocket_url, 10)
    try:
        state = client.evaluate(
            """
            (() => {
              const body = document.body?.innerText || '';
              const pageReady = !!document.querySelector('textarea[placeholder="发消息..."]')
                && !!document.querySelector('input[type=file]');
              const loggedIn = body.includes('历史对话') || body.includes('云盘');
              return {pageReady, loggedIn};
            })()
            """
        ) or {}
    finally:
        client.close()
    return {
        "page_ready": bool(state.get("pageReady")),
        "logged_in": bool(state.get("loggedIn")),
        "detail": "豆包网页版已登录" if state.get("loggedIn") else "豆包网页已打开，请确认登录状态",
    }


def _extract_json_object(text: str) -> Dict[str, Any]:
    normalized = str(text or "").strip()
    if normalized.startswith("```"):
        lines = normalized.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        normalized = "\n".join(lines).strip()

    decoder = json.JSONDecoder()
    for index, char in enumerate(normalized):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(normalized[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise DoubaoWebImageTranslationError("豆包没有返回有效的文字区域 JSON")


def _normalize_regions(
    payload: Dict[str, Any],
    image_width: int,
    image_height: int,
) -> List[Dict[str, Any]]:
    raw_regions = payload.get("regions")
    if not isinstance(raw_regions, list):
        raw_regions = payload.get("texts")
    if not isinstance(raw_regions, list):
        raw_regions = []

    coordinate_space = str(payload.get("coordinate_space") or "normalized_1000")
    regions: List[Dict[str, Any]] = []
    for item in raw_regions:
        if not isinstance(item, dict):
            continue
        source_text = str(
            item.get("text") or item.get("source_text") or item.get("sourceText") or ""
        ).strip()
        translated_text = str(
            item.get("translated_text")
            or item.get("translatedText")
            or item.get("translation")
            or ""
        ).strip()
        if not source_text and not translated_text:
            continue
        rect = _region_rect(
            item.get("bbox") or item.get("box") or item.get("rect"),
            image_width,
            image_height,
            coordinate_space,
        )
        if rect is None:
            continue
        x, y, width, height = rect
        regions.append(
            {
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "text": source_text,
                "translatedText": translated_text or source_text,
                "confidence": 0.9,
                "source": "doubao-web",
            }
        )
    regions.sort(key=lambda region: (region["y"], region["x"]))
    return regions


def _region_rect(
    raw_box: Any,
    image_width: int,
    image_height: int,
    coordinate_space: str,
):
    if isinstance(raw_box, dict):
        if all(key in raw_box for key in ("x", "y", "width", "height")):
            values = [
                raw_box["x"],
                raw_box["y"],
                float(raw_box["x"]) + float(raw_box["width"]),
                float(raw_box["y"]) + float(raw_box["height"]),
            ]
        else:
            values = [
                raw_box.get("x1", raw_box.get("left")),
                raw_box.get("y1", raw_box.get("top")),
                raw_box.get("x2", raw_box.get("right")),
                raw_box.get("y2", raw_box.get("bottom")),
            ]
    elif isinstance(raw_box, (list, tuple)) and len(raw_box) >= 4:
        values = list(raw_box[:4])
    else:
        return None

    try:
        x1, y1, x2, y2 = [float(value) for value in values]
    except (TypeError, ValueError):
        return None

    space = coordinate_space.lower()
    maximum = max(abs(x1), abs(y1), abs(x2), abs(y2))
    if "pixel" in space:
        pass
    elif maximum <= 1.0:
        x1, x2 = x1 * image_width, x2 * image_width
        y1, y2 = y1 * image_height, y2 * image_height
    else:
        x1, x2 = x1 * image_width / 1000, x2 * image_width / 1000
        y1, y2 = y1 * image_height / 1000, y2 * image_height / 1000

    left = max(0, min(image_width - 1, round(min(x1, x2))))
    top = max(0, min(image_height - 1, round(min(y1, y2))))
    right = max(left + 1, min(image_width, round(max(x1, x2))))
    bottom = max(top + 1, min(image_height, round(max(y1, y2))))
    width = right - left
    height = bottom - top
    if width < 3 or height < 3:
        return None
    return left, top, width, height


def _image_dimensions(image_bytes: bytes):
    import io

    try:
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as image:
            return image.size
    except Exception as exc:
        raise ValueError("无法读取图片文件") from exc
