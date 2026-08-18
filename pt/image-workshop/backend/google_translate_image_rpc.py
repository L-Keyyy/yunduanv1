import asyncio
import argparse
import base64
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote, urlparse

import httpx
from websocket import create_connection


GOOGLE_TRANSLATE_ORIGIN = "https://translate.google.com"
GOOGLE_IMAGE_RPC_ID = "WqWDPb"
DEFAULT_DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.0.0 Safari/537.36"
)
SUPPORTED_IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}


class GoogleTranslateImageRpcError(RuntimeError):
    pass


class GoogleTranslateImageServiceBusyError(GoogleTranslateImageRpcError):
    pass


@dataclass
class GoogleTranslateImageRpcResult:
    image_data_url: str
    mime_type: str
    source_text: str
    translated_text: str
    detected_source_language: str
    page_url: str
    rpc_status: int
    target_id: str


class GoogleTranslateImageRpcService:
    def __init__(
        self,
        *,
        chrome_devtools_base: str,
        browser_auto_start: bool = True,
        browser_binary: str = "",
        browser_profile_dir: str = "/tmp/chrome-9222",
        browser_headless: bool = True,
        request_timeout_seconds: float = 60.0,
        max_pending_requests: int = 8,
        max_attempts: int = 2,
    ):
        self.chrome_devtools_base = chrome_devtools_base.rstrip("/")
        self.browser_auto_start = browser_auto_start
        self.browser_binary = browser_binary.strip()
        self.browser_profile_dir = str(Path(browser_profile_dir).expanduser())
        self.browser_headless = browser_headless
        self.request_timeout_seconds = max(float(request_timeout_seconds), 5.0)
        self.max_pending_requests = max(int(max_pending_requests), 1)
        self.max_attempts = max(int(max_attempts), 1)

        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="google-image-translate",
        )
        self._state_lock = threading.Lock()
        self._pending_jobs = 0
        self._active = False
        self._ready = False
        self._started = False
        self._stopped = False
        self._target_id = ""
        self._last_error = ""
        self._last_success_at: Optional[float] = None
        self._browser_process: Optional[subprocess.Popen[Any]] = None

    def start(self) -> None:
        with self._state_lock:
            if self._started or self._stopped:
                return
            self._started = True
            self._pending_jobs += 1
        future = self._executor.submit(self._warm_up_sync)
        future.add_done_callback(self._job_finished)

    def stop(self) -> None:
        with self._state_lock:
            if self._stopped:
                return
            self._stopped = True

        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._state_lock:
            target_id = self._target_id
            browser_process = self._browser_process
        if target_id:
            _close_chrome_target(self.chrome_devtools_base, target_id)
        if browser_process is not None and browser_process.poll() is None:
            try:
                browser_process.terminate()
            except OSError:
                pass

    async def translate(
        self,
        image_bytes: bytes,
        *,
        filename: str,
        mime_type: Optional[str],
        source_language: str,
        target_language: str,
    ) -> GoogleTranslateImageRpcResult:
        with self._state_lock:
            if self._stopped:
                raise GoogleTranslateImageRpcError("图片翻译服务已停止")
            if self._pending_jobs >= self.max_pending_requests:
                raise GoogleTranslateImageServiceBusyError(
                    "图片翻译服务繁忙，请稍后重试"
                )
            self._pending_jobs += 1

        future = self._executor.submit(
            self._translate_sync,
            image_bytes,
            filename,
            mime_type,
            source_language,
            target_language,
        )
        future.add_done_callback(self._job_finished)
        return await asyncio.wrap_future(future)

    def status(self, *, probe: bool = False) -> Dict[str, Any]:
        reachable = _is_devtools_reachable(self.chrome_devtools_base) if probe else None
        with self._state_lock:
            ready = self._ready
            if reachable is not None:
                ready = ready and reachable
            queued = max(self._pending_jobs - (1 if self._active else 0), 0)
            return {
                "status": "healthy" if ready else "unavailable",
                "ready": ready,
                "busy": self._active,
                "queueDepth": queued,
                "queueCapacity": self.max_pending_requests,
                "lastSuccessAt": self._last_success_at,
            }

    def _job_finished(self, _future: concurrent.futures.Future[Any]) -> None:
        with self._state_lock:
            self._pending_jobs = max(self._pending_jobs - 1, 0)

    def _warm_up_sync(self) -> None:
        try:
            self._ensure_browser_ready()
            target = _pick_or_create_translate_target(
                self.chrome_devtools_base,
                _translate_image_url("auto", "zh-CN"),
                target_id=self._target_id,
                prefer_existing=False,
            )
            websocket_url = str(target.get("webSocketDebuggerUrl") or "")
            if not websocket_url:
                raise GoogleTranslateImageRpcError(
                    "图片翻译工作页缺少调试连接地址"
                )
            with _ChromeDevtoolsSession(websocket_url, timeout_seconds=30.0) as session:
                session.send("Page.enable")
                session.send("Runtime.enable")
                session.send(
                    "Page.navigate",
                    {"url": _translate_image_url("auto", "zh-CN")},
                )
                _wait_for_page_ready(session, timeout_seconds=20.0)
            with self._state_lock:
                self._target_id = str(target.get("id") or "")
                self._ready = True
                self._last_error = ""
        except Exception as exc:
            with self._state_lock:
                self._ready = False
                self._last_error = str(exc)

    def _translate_sync(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: Optional[str],
        source_language: str,
        target_language: str,
    ) -> GoogleTranslateImageRpcResult:
        with self._state_lock:
            self._active = True

        last_error: Optional[Exception] = None
        try:
            for attempt in range(self.max_attempts):
                try:
                    self._ensure_browser_ready()
                    with self._state_lock:
                        target_id = self._target_id
                    result = translate_image_with_google_internal_rpc(
                        image_bytes,
                        filename=filename,
                        mime_type=mime_type,
                        source_language=source_language,
                        target_language=target_language,
                        chrome_devtools_base=self.chrome_devtools_base,
                        timeout_seconds=self.request_timeout_seconds,
                        target_id=target_id,
                        prefer_existing_target=False,
                    )
                    with self._state_lock:
                        self._target_id = result.target_id
                        self._ready = True
                        self._last_error = ""
                        self._last_success_at = time.time()
                    return result
                except ValueError:
                    raise
                except Exception as exc:
                    last_error = exc
                    with self._state_lock:
                        self._ready = False
                        self._last_error = str(exc)
                    self._reset_worker_target()
                    if attempt + 1 < self.max_attempts:
                        time.sleep(0.5)
        finally:
            with self._state_lock:
                self._active = False

        raise GoogleTranslateImageRpcError(
            str(last_error or "Google 图片翻译服务暂时不可用")
        ) from last_error

    def _ensure_browser_ready(self) -> None:
        if _is_devtools_reachable(self.chrome_devtools_base):
            return
        if not self.browser_auto_start:
            raise GoogleTranslateImageRpcError("图片翻译执行服务未启动")
        self._start_browser()

    def _start_browser(self) -> None:
        parsed = urlparse(self.chrome_devtools_base)
        hostname = parsed.hostname or ""
        if hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise GoogleTranslateImageRpcError(
                "仅支持自动启动本机图片翻译执行服务"
            )
        port = parsed.port or 9222
        binary = _resolve_chrome_binary(self.browser_binary)
        Path(self.browser_profile_dir).mkdir(parents=True, exist_ok=True)

        args = [
            binary,
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={self.browser_profile_dir}",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1280,900",
            "--lang=zh-CN",
        ]
        if self.browser_headless:
            args.extend(
                [
                    "--headless=new",
                    "--disable-gpu",
                    "--disable-blink-features=AutomationControlled",
                    f"--user-agent={DEFAULT_DESKTOP_USER_AGENT}",
                ]
            )
        args.append("about:blank")

        try:
            process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as exc:
            raise GoogleTranslateImageRpcError(
                f"无法启动图片翻译执行服务: {exc}"
            ) from exc

        with self._state_lock:
            self._browser_process = process

        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            if _is_devtools_reachable(self.chrome_devtools_base):
                return
            if process.poll() is not None:
                break
            time.sleep(0.25)
        raise GoogleTranslateImageRpcError("图片翻译执行服务启动超时")

    def _reset_worker_target(self) -> None:
        with self._state_lock:
            target_id = self._target_id
            self._target_id = ""
        if target_id:
            _close_chrome_target(self.chrome_devtools_base, target_id)


class _ChromeDevtoolsSession:
    def __init__(self, websocket_url: str, *, timeout_seconds: float = 120.0):
        self.websocket_url = websocket_url
        self.timeout_seconds = timeout_seconds
        self.connection = None
        self.message_id = 0

    def __enter__(self) -> "_ChromeDevtoolsSession":
        self.connection = create_connection(
            self.websocket_url,
            timeout=self.timeout_seconds,
            suppress_origin=True,
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass

    def send(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self.connection is None:
            raise GoogleTranslateImageRpcError("Chrome DevTools session is not connected")

        self.message_id += 1
        current_id = self.message_id
        self.connection.send(
            json.dumps(
                {"id": current_id, "method": method, "params": params or {}},
                ensure_ascii=False,
            )
        )
        while True:
            payload = json.loads(self.connection.recv())
            if payload.get("id") != current_id:
                continue
            if payload.get("error"):
                raise GoogleTranslateImageRpcError(
                    f"Chrome DevTools command failed: {payload['error']}"
                )
            return payload.get("result") or {}

    def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        result = self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
            },
        )
        if result.get("exceptionDetails"):
            exception = result["exceptionDetails"].get("text") or "unknown exception"
            raise GoogleTranslateImageRpcError(f"Chrome page script failed: {exception}")
        remote = result.get("result") or {}
        if "value" in remote:
            return remote.get("value")
        return None


def translate_image_with_google_internal_rpc(
    image_bytes: bytes,
    *,
    filename: str = "image.png",
    mime_type: Optional[str] = None,
    source_language: str = "auto",
    target_language: str = "zh-CN",
    chrome_devtools_base: str = "http://127.0.0.1:9222",
    timeout_seconds: float = 60.0,
    target_id: str = "",
    prefer_existing_target: bool = True,
) -> GoogleTranslateImageRpcResult:
    if not image_bytes:
        raise ValueError("图片不能为空")

    normalized_mime = _normalize_mime_type(filename=filename, mime_type=mime_type)
    if normalized_mime not in SUPPORTED_IMAGE_MIME_TYPES:
        raise ValueError("图片翻译仅支持 jpg、png、webp 图片")

    target_url = _translate_image_url(source_language, target_language)
    target = _pick_or_create_translate_target(
        chrome_devtools_base,
        target_url,
        target_id=target_id,
        prefer_existing=prefer_existing_target,
    )
    websocket_url = str(target.get("webSocketDebuggerUrl") or "")
    if not websocket_url:
        raise GoogleTranslateImageRpcError("Chrome Translate 页面缺少调试 WebSocket 地址")

    with _ChromeDevtoolsSession(websocket_url, timeout_seconds=max(timeout_seconds, 30.0)) as session:
        session.send("Page.enable")
        session.send("Runtime.enable")
        session.send("Page.navigate", {"url": target_url})
        _wait_for_page_ready(session, timeout_seconds=min(timeout_seconds, 20.0))

        payload = _run_translate_upload(
            session,
            image_bytes=image_bytes,
            filename=filename,
            mime_type=normalized_mime,
            timeout_seconds=timeout_seconds,
        )

    image_base64 = str(payload.get("imageBase64") or "")
    output_mime = str(payload.get("mimeType") or "image/png")
    if not image_base64:
        raise GoogleTranslateImageRpcError("Google 图片翻译未返回输出图片")
    if (
        not payload.get("sourceText")
        and not payload.get("translatedText")
        and _same_base64_bytes(image_base64, image_bytes)
    ):
        raise GoogleTranslateImageRpcError(
            "Google 图片翻译返回了原图，通常是当前 Chrome/headless 环境未触发真实图片翻译"
        )

    return GoogleTranslateImageRpcResult(
        image_data_url=f"data:{output_mime};base64,{image_base64}",
        mime_type=output_mime,
        source_text=str(payload.get("sourceText") or ""),
        translated_text=str(payload.get("translatedText") or ""),
        detected_source_language=str(payload.get("detectedSourceLanguage") or ""),
        page_url=str(payload.get("pageUrl") or target_url),
        rpc_status=int(payload.get("rpcStatus") or 0),
        target_id=str(target.get("id") or ""),
    )


def _normalize_mime_type(*, filename: str, mime_type: Optional[str]) -> str:
    normalized = (mime_type or "").split(";")[0].strip().lower()
    if normalized == "image/jpg":
        normalized = "image/jpeg"
    if normalized in SUPPORTED_IMAGE_MIME_TYPES:
        return normalized

    guessed = mimetypes.guess_type(filename or "")[0] or ""
    guessed = guessed.split(";")[0].strip().lower()
    if guessed == "image/jpg":
        guessed = "image/jpeg"
    if guessed in SUPPORTED_IMAGE_MIME_TYPES:
        return guessed
    return normalized or "application/octet-stream"


def _same_base64_bytes(image_base64: str, image_bytes: bytes) -> bool:
    try:
        output_bytes = base64.b64decode(image_base64, validate=True)
    except Exception:
        return False
    return hashlib.sha256(output_bytes).digest() == hashlib.sha256(image_bytes).digest()


def _translate_image_url(source_language: str, target_language: str) -> str:
    source = quote((source_language or "auto").strip() or "auto", safe="-")
    target = quote((target_language or "zh-CN").strip() or "zh-CN", safe="-")
    return f"{GOOGLE_TRANSLATE_ORIGIN}/?hl=zh-cn&sl={source}&tl={target}&op=images"


def _pick_or_create_translate_target(
    chrome_devtools_base: str,
    target_url: str,
    *,
    target_id: str = "",
    prefer_existing: bool = True,
) -> Dict[str, Any]:
    base = chrome_devtools_base.rstrip("/")
    with httpx.Client(timeout=8.0, trust_env=False) as client:
        response = client.get(f"{base}/json/list")
        response.raise_for_status()
        targets = response.json()
        if not isinstance(targets, list):
            raise GoogleTranslateImageRpcError("Chrome DevTools 返回了异常页面列表")

        if target_id:
            selected = next(
                (
                    item
                    for item in targets
                    if item.get("type") == "page"
                    and item.get("webSocketDebuggerUrl")
                    and str(item.get("id") or "") == target_id
                ),
                None,
            )
            if selected:
                return selected

        pages = [
            item
            for item in targets
            if item.get("type") == "page"
            and item.get("webSocketDebuggerUrl")
            and "translate.google.com" in str(item.get("url") or "")
        ]
        if prefer_existing and pages:
            return pages[0]

        encoded_url = quote(target_url, safe="")
        try:
            create_response = client.put(f"{base}/json/new?{encoded_url}")
        except httpx.HTTPError:
            create_response = client.get(f"{base}/json/new?{encoded_url}")
        create_response.raise_for_status()
        created = create_response.json()
        if not isinstance(created, dict):
            raise GoogleTranslateImageRpcError("Chrome DevTools 创建页面失败")
        return created


def _is_devtools_reachable(chrome_devtools_base: str) -> bool:
    try:
        with httpx.Client(timeout=2.0, trust_env=False) as client:
            response = client.get(f"{chrome_devtools_base.rstrip('/')}/json/version")
            return response.status_code == 200
    except (httpx.HTTPError, ValueError):
        return False


def _close_chrome_target(chrome_devtools_base: str, target_id: str) -> None:
    if not target_id:
        return
    try:
        with httpx.Client(timeout=3.0, trust_env=False) as client:
            response = client.put(
                f"{chrome_devtools_base.rstrip('/')}/json/close/{quote(target_id, safe='')}"
            )
            if response.status_code >= 400:
                client.get(
                    f"{chrome_devtools_base.rstrip('/')}/json/close/{quote(target_id, safe='')}"
                )
    except httpx.HTTPError:
        pass


def _resolve_chrome_binary(configured_binary: str) -> str:
    if configured_binary:
        configured_path = str(Path(configured_binary).expanduser())
        if Path(configured_path).is_file():
            return configured_path
        resolved = shutil.which(configured_binary)
        if resolved:
            return resolved
        raise GoogleTranslateImageRpcError("配置的 Chrome 可执行文件不存在")

    candidates = []
    if sys.platform == "darwin":
        candidates.append(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        )
    elif sys.platform.startswith("win"):
        for root_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = os.getenv(root_name)
            if root:
                candidates.append(
                    str(Path(root) / "Google/Chrome/Application/chrome.exe")
                )
    else:
        for executable in (
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ):
            resolved = shutil.which(executable)
            if resolved:
                candidates.append(resolved)

    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    raise GoogleTranslateImageRpcError("未找到 Chrome 可执行文件")


def _wait_for_page_ready(
    session: _ChromeDevtoolsSession,
    *,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + max(timeout_seconds, 1.0)
    last_error = ""
    stable_checks = 0
    while time.monotonic() < deadline:
        try:
            page_state = session.evaluate(
                "({ readyState: document.readyState, url: location.href })",
                await_promise=False,
            )
            ready_state = page_state.get("readyState") if isinstance(page_state, dict) else ""
            page_url = page_state.get("url") if isinstance(page_state, dict) else ""
            if (
                ready_state in {"interactive", "complete"}
                and urlparse(str(page_url)).hostname == "translate.google.com"
            ):
                stable_checks += 1
                if stable_checks >= 3:
                    return
            else:
                stable_checks = 0
        except Exception as exc:
            last_error = str(exc)
            stable_checks = 0
        time.sleep(0.25)
    raise GoogleTranslateImageRpcError(f"Google Translate 页面加载超时: {last_error}")


def _run_translate_upload(
    session: _ChromeDevtoolsSession,
    *,
    image_bytes: bytes,
    filename: str,
    mime_type: str,
    timeout_seconds: float,
) -> Dict[str, Any]:
    image_base64 = base64.b64encode(image_bytes).decode("ascii")
    request_id = f"gt_image_rpc_{int(time.time() * 1000)}"
    expression = _build_upload_script(
        image_base64=image_base64,
        filename=filename or "image.png",
        mime_type=mime_type,
        request_id=request_id,
        timeout_ms=int(max(timeout_seconds, 5.0) * 1000),
    )
    raw_result = session.evaluate(expression, await_promise=True)
    if isinstance(raw_result, str):
        try:
            result = json.loads(raw_result)
        except json.JSONDecodeError as exc:
            raise GoogleTranslateImageRpcError("Google Translate 页面返回了非 JSON 结果") from exc
    elif isinstance(raw_result, dict):
        result = raw_result
    else:
        raise GoogleTranslateImageRpcError("Google Translate 页面返回了空结果")

    if not result.get("ok"):
        message = str(result.get("error") or "Google 图片翻译失败")
        raise GoogleTranslateImageRpcError(message)
    return result


def _build_upload_script(
    *,
    image_base64: str,
    filename: str,
    mime_type: str,
    request_id: str,
    timeout_ms: int,
) -> str:
    image_base64_literal = json.dumps(image_base64)
    filename_literal = json.dumps(filename)
    mime_type_literal = json.dumps(mime_type)
    request_id_literal = json.dumps(request_id)
    return f"""
    (async () => {{
      const imageBase64 = {image_base64_literal};
      const filename = {filename_literal};
      const mimeType = {mime_type_literal};
      const requestId = {request_id_literal};
      const timeoutMs = {int(timeout_ms)};
      const rpcId = {json.dumps(GOOGLE_IMAGE_RPC_ID)};

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const decodeBase64 = (value) => {{
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {{
          bytes[index] = binary.charCodeAt(index);
        }}
        return bytes;
      }};
      const parseBatchExecute = (text) => {{
        const lines = String(text || "").split("\\n").filter((line) => line.startsWith("[["));
        for (const line of lines) {{
          let rows = null;
          try {{
            rows = JSON.parse(line);
          }} catch (error) {{
            continue;
          }}
          for (const row of rows || []) {{
            if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== rpcId) {{
              continue;
            }}
            if (!row[2]) {{
              return {{
                ok: false,
                error: `Google image RPC returned empty payload: ${{JSON.stringify(row).slice(0, 300)}}`,
                rpcStatus: 0
              }};
            }}
            const payload = JSON.parse(row[2]);
            const image = Array.isArray(payload[0]) ? payload[0] : [];
            return {{
              ok: true,
              imageBase64: image[0] || "",
              mimeType: image[1] || "image/png",
              sourceText: payload[1] || "",
              translatedText: payload[2] || "",
              detectedSourceLanguage: payload[3] || "",
              rpcStatus: 200
            }};
          }}
        }}
        return {{ ok: false, error: "No WqWDPb response found in batchexecute payload" }};
      }};
      const recordRpcResponse = async (requestKey, status, text) => {{
        const parsed = parseBatchExecute(text);
        window.__gtImageRpcResponses.push({{
          requestId: requestKey || null,
          status,
          pageUrl: location.href,
          ...parsed
        }});
      }};
      const ensureInterceptor = () => {{
        window.__gtImageRpcResponses = window.__gtImageRpcResponses || [];
        if (window.__gtImageRpcInterceptorInstalled) {{
          return;
        }}
        window.__gtImageRpcInterceptorInstalled = true;

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {{
          this.__gtImageRpcUrl = String(url || "");
          return originalOpen.call(this, method, url, ...rest);
        }};
        XMLHttpRequest.prototype.send = function(body) {{
          const requestKey = window.__gtImageRpcActiveRequestId || null;
          const bodyText = typeof body === "string" ? body : "";
          const isTarget = this.__gtImageRpcUrl.includes(`rpcids=${{rpcId}}`) || bodyText.includes(rpcId);
          if (isTarget) {{
            this.addEventListener("loadend", () => {{
              try {{
                recordRpcResponse(requestKey, this.status, this.responseText || "");
              }} catch (error) {{
                window.__gtImageRpcResponses.push({{
                  requestId: requestKey,
                  ok: false,
                  status: this.status || 0,
                  error: String(error),
                  pageUrl: location.href
                }});
              }}
            }});
          }}
          return originalSend.call(this, body);
        }};

        const originalFetch = window.fetch;
        window.fetch = async function(input, init) {{
          const url = typeof input === "string" ? input : String(input && input.url || "");
          const bodyText = typeof (init && init.body) === "string" ? init.body : "";
          const requestKey = window.__gtImageRpcActiveRequestId || null;
          const isTarget = url.includes(`rpcids=${{rpcId}}`) || bodyText.includes(rpcId);
          const response = await originalFetch.apply(this, arguments);
          if (isTarget) {{
            response.clone().text().then((text) => {{
              recordRpcResponse(requestKey, response.status, text);
            }}).catch((error) => {{
              window.__gtImageRpcResponses.push({{
                requestId: requestKey,
                ok: false,
                status: response.status || 0,
                error: String(error),
                pageUrl: location.href
              }});
            }});
          }}
          return response;
        }};
      }};
      const findImageInput = () => [...document.querySelectorAll("input[type=file]")]
        .find((input) => String(input.accept || "").includes("image/png"));
      const openImageMode = async () => {{
        for (let attempt = 0; attempt < 20; attempt += 1) {{
          if (findImageInput()) {{
            return true;
          }}
          const button = [...document.querySelectorAll("button")]
            .find((item) => /图片|Images?/i.test(item.getAttribute("aria-label") || item.innerText || ""));
          if (button) {{
            button.click();
          }}
          await wait(300);
        }}
        return Boolean(findImageInput());
      }};

      ensureInterceptor();
      const imageModeReady = await openImageMode();
      if (!imageModeReady) {{
        return JSON.stringify({{ ok: false, error: "未找到 Google 图片翻译上传入口" }});
      }}

      const input = findImageInput();
      const file = new File([decodeBase64(imageBase64)], filename, {{ type: mimeType }});
      const transfer = new DataTransfer();
      transfer.items.add(file);

      window.__gtImageRpcActiveRequestId = requestId;
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", {{ bubbles: true }}));
      input.dispatchEvent(new Event("change", {{ bubbles: true }}));

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {{
        const response = [...window.__gtImageRpcResponses]
          .reverse()
          .find((item) => item.requestId === requestId);
        if (response) {{
          window.__gtImageRpcActiveRequestId = null;
          return JSON.stringify(response);
        }}
        await wait(250);
      }}
      window.__gtImageRpcActiveRequestId = null;
      return JSON.stringify({{ ok: false, error: "等待 Google 图片翻译 RPC 响应超时", pageUrl: location.href }});
    }})()
    """


def _extension_for_mime_type(mime_type: str) -> str:
    normalized = (mime_type or "").split(";", 1)[0].strip().lower()
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(normalized, ".png")


def _write_data_url_to_file(data_url: str, output_path: Path) -> None:
    if "," not in data_url:
        raise GoogleTranslateImageRpcError("输出图片 data URL 格式异常")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))


def _default_output_path(input_path: Path, mime_type: str) -> Path:
    return input_path.with_name(
        f"{input_path.stem}.translated{_extension_for_mime_type(mime_type)}"
    )


def _parse_cli_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="通过 Chrome DevTools/Google Translate 图片页翻译本地图片并保存译图。"
    )
    parser.add_argument("image", help="输入图片路径，支持 jpg/png/webp")
    parser.add_argument("-o", "--output", help="输出图片路径；默认写到同目录 *.translated.*")
    parser.add_argument("--from-lang", default="auto", help="源语言代码，默认 auto")
    parser.add_argument("--to", "--target-language", dest="target_language", default="en", help="目标语言代码，默认 en")
    parser.add_argument("--cdp", default="http://127.0.0.1:9222", help="Chrome DevTools 地址，默认 http://127.0.0.1:9222")
    parser.add_argument("--timeout", type=float, default=60.0, help="翻译超时秒数，默认 60")
    parser.add_argument(
        "--auto-start",
        action="store_true",
        help="当 CDP 端口不可用时自动启动一个 Chrome 执行服务",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="配合 --auto-start 使用：启动有界面 Chrome；默认使用 headless=new",
    )
    parser.add_argument("--chrome-binary", default="", help="Chrome 可执行文件路径，可选")
    parser.add_argument(
        "--profile-dir",
        default="/tmp/chrome-google-translate-image",
        help="配合 --auto-start 使用的 Chrome profile 目录",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 输出翻译元信息",
    )
    return parser.parse_args()


def _run_cli() -> int:
    args = _parse_cli_args()
    input_path = Path(args.image).expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"输入图片不存在: {input_path}")

    image_bytes = input_path.read_bytes()
    mime_type = _normalize_mime_type(
        filename=input_path.name,
        mime_type=mimetypes.guess_type(str(input_path))[0],
    )

    if args.auto_start:
        service = GoogleTranslateImageRpcService(
            chrome_devtools_base=args.cdp,
            browser_auto_start=True,
            browser_binary=args.chrome_binary,
            browser_profile_dir=args.profile_dir,
            browser_headless=not args.headed,
            request_timeout_seconds=args.timeout,
            max_attempts=2,
        )
        try:
            result = service._translate_sync(
                image_bytes,
                input_path.name,
                mime_type,
                args.from_lang,
                args.target_language,
            )
        finally:
            service.stop()
    else:
        result = translate_image_with_google_internal_rpc(
            image_bytes,
            filename=input_path.name,
            mime_type=mime_type,
            source_language=args.from_lang,
            target_language=args.target_language,
            chrome_devtools_base=args.cdp,
            timeout_seconds=args.timeout,
            prefer_existing_target=True,
        )

    output_path = (
        Path(args.output).expanduser().resolve()
        if args.output
        else _default_output_path(input_path, result.mime_type)
    )
    _write_data_url_to_file(result.image_data_url, output_path)

    payload = {
        "ok": True,
        "output": str(output_path),
        "mimeType": result.mime_type,
        "sourceText": result.source_text,
        "translatedText": result.translated_text,
        "detectedSourceLanguage": result.detected_source_language,
        "pageUrl": result.page_url,
        "targetId": result.target_id,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"输出图片: {output_path}")
        if result.detected_source_language:
            print(f"检测语言: {result.detected_source_language}")
        if result.source_text:
            print(f"原文: {result.source_text}")
        if result.translated_text:
            print(f"译文: {result.translated_text}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_run_cli())
