import base64
import atexit
import http.client
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote, urlparse

import requests
import websocket


CDP_BASE_URL = "http://127.0.0.1:9222"
HIDDEN_CDP_PORT = int(os.getenv("IMAGE_WORKSHOP_HIDDEN_CDP_PORT", "9223"))
HIDDEN_CDP_BASE_URL = f"http://127.0.0.1:{HIDDEN_CDP_PORT}"
HIDDEN_PROFILE_DIR = Path(
    os.getenv("IMAGE_WORKSHOP_HIDDEN_PROFILE", str(Path.home() / ".image-workshop" / "hidden-chatgpt-profile"))
)
HIDDEN_BROWSER_ENABLED = os.getenv("IMAGE_WORKSHOP_ENABLE_HIDDEN_BROWSER", "0").lower() in {"1", "true", "yes"}
HIDDEN_HEADLESS = os.getenv("IMAGE_WORKSHOP_HIDDEN_HEADLESS", "0").lower() in {"1", "true", "yes"}
CHATGPT_URL = "https://chatgpt.com/"
JOB_ROOT = Path(tempfile.gettempdir()) / "image-workshop-chatgpt"

_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()
_HIDDEN_CHROME_PROCESS: Optional[subprocess.Popen[Any]] = None
_HIDDEN_CHROME_LOCK = threading.Lock()


class ChatGPTBridgeError(RuntimeError):
    pass


def _normalize_browser_mode(mode: str) -> str:
    normalized = (mode or "visible").strip().lower()
    if HIDDEN_BROWSER_ENABLED and normalized in {"hidden", "headless", "background"}:
        return "hidden"
    return "visible"


def _cdp_base_url(mode: str) -> str:
    return HIDDEN_CDP_BASE_URL if _normalize_browser_mode(mode) == "hidden" else CDP_BASE_URL


def _cdp_http_json(
    browser_mode: str,
    path: str,
    method: str = "GET",
    timeout: float = 4,
) -> Any:
    base = urlparse(_cdp_base_url(browser_mode))
    host = base.hostname or "127.0.0.1"
    port = base.port or 80
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(method, path, headers={"Host": f"{host}:{port}", "Connection": "close"})
        response = conn.getresponse()
        body = response.read().decode("utf-8", "replace")
        if response.status >= 400:
            raise ChatGPTBridgeError(f"CDP HTTP {response.status}: {body[:200]}")
        return json.loads(body)
    finally:
        conn.close()


def _find_chrome_binary() -> str:
    candidates = [
        os.getenv("IMAGE_WORKSHOP_CHROME_PATH", ""),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
        shutil.which("chromium-browser") or "",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise ChatGPTBridgeError("没有找到 Chrome，可设置 IMAGE_WORKSHOP_CHROME_PATH 指向 Chrome 程序")


def _is_cdp_ready(base_url: str) -> bool:
    try:
        parsed = urlparse(base_url)
        mode = "hidden" if parsed.port == HIDDEN_CDP_PORT else "visible"
        _cdp_http_json(mode, "/json/version", timeout=1.5)
        return True
    except Exception:
        return False


def _cdp_user_agent(base_url: str) -> str:
    try:
        parsed = urlparse(base_url)
        mode = "hidden" if parsed.port == HIDDEN_CDP_PORT else "visible"
        data = _cdp_http_json(mode, "/json/version", timeout=1.5)
        return str(data.get("User-Agent") or "")
    except Exception:
        return ""


def _kill_listener_on_port(port: int) -> None:
    try:
        result = subprocess.run(
            ["lsof", "-tiTCP:%s" % port, "-sTCP:LISTEN"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:
        return
    for raw_pid in result.stdout.splitlines():
        raw_pid = raw_pid.strip()
        if not raw_pid.isdigit():
            continue
        try:
            os.kill(int(raw_pid), 15)
        except Exception:
            pass
    time.sleep(1)


def _ensure_hidden_browser() -> None:
    global _HIDDEN_CHROME_PROCESS
    with _HIDDEN_CHROME_LOCK:
        if _is_cdp_ready(HIDDEN_CDP_BASE_URL):
            user_agent = _cdp_user_agent(HIDDEN_CDP_BASE_URL)
            if HIDDEN_HEADLESS or "HeadlessChrome" not in user_agent:
                return
            _kill_listener_on_port(HIDDEN_CDP_PORT)

        if _HIDDEN_CHROME_PROCESS and _HIDDEN_CHROME_PROCESS.poll() is None:
            _HIDDEN_CHROME_PROCESS.terminate()
            try:
                _HIDDEN_CHROME_PROCESS.wait(timeout=4)
            except subprocess.TimeoutExpired:
                _HIDDEN_CHROME_PROCESS.kill()

        HIDDEN_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        chrome = _find_chrome_binary()
        args = [
            chrome,
            f"--remote-debugging-port={HIDDEN_CDP_PORT}",
            f"--user-data-dir={HIDDEN_PROFILE_DIR}",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-popup-blocking",
            "--window-size=1440,1100",
            "--window-position=-2400,120",
            "about:blank",
        ]
        if HIDDEN_HEADLESS:
            args.insert(1, "--headless=new")
            args.insert(2, "--disable-gpu")

        _HIDDEN_CHROME_PROCESS = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )

    deadline = time.time() + 20
    while time.time() < deadline:
        if _is_cdp_ready(HIDDEN_CDP_BASE_URL):
            return
        time.sleep(0.4)
    raise ChatGPTBridgeError(f"隐藏 Chrome 启动超时，端口 {HIDDEN_CDP_PORT} 未就绪")


def _shutdown_hidden_browser() -> None:
    global _HIDDEN_CHROME_PROCESS
    with _HIDDEN_CHROME_LOCK:
        if not _HIDDEN_CHROME_PROCESS or _HIDDEN_CHROME_PROCESS.poll() is not None:
            return
        _HIDDEN_CHROME_PROCESS.terminate()
        try:
            _HIDDEN_CHROME_PROCESS.wait(timeout=4)
        except subprocess.TimeoutExpired:
            _HIDDEN_CHROME_PROCESS.kill()


atexit.register(_shutdown_hidden_browser)


def _sync_hidden_cookies_from_visible() -> int:
    if not _is_cdp_ready(CDP_BASE_URL) or not _is_cdp_ready(HIDDEN_CDP_BASE_URL):
        return 0
    visible_pages = [
        page for page in _list_pages("visible")
        if page.get("type") == "page"
        and page.get("webSocketDebuggerUrl")
        and any(domain in str(page.get("url") or "") for domain in ["chatgpt.com", "openai.com"])
    ]
    if not visible_pages:
        return 0

    source = CdpSession(str(visible_pages[0]["webSocketDebuggerUrl"]))
    try:
        cookies = source.call(
            "Storage.getCookies",
            {"urls": ["https://chatgpt.com/", "https://auth.openai.com/", "https://openai.com/"]},
            timeout=10,
        ).get("cookies") or []
    finally:
        source.close()

    cookie_params = []
    for cookie in cookies:
        domain = str(cookie.get("domain") or "")
        if not any(key in domain for key in ["chatgpt.com", "openai.com"]):
            continue
        item: Dict[str, Any] = {
            "name": cookie.get("name"),
            "value": cookie.get("value"),
            "domain": domain,
            "path": cookie.get("path") or "/",
            "secure": bool(cookie.get("secure")),
            "httpOnly": bool(cookie.get("httpOnly")),
        }
        if cookie.get("sameSite") in {"Strict", "Lax", "None"}:
            item["sameSite"] = cookie["sameSite"]
        expires = cookie.get("expires")
        if isinstance(expires, (int, float)) and expires > 0:
            item["expires"] = expires
        if item["name"] and item["value"] is not None:
            cookie_params.append(item)

    if not cookie_params:
        return 0

    target = _get_or_create_chatgpt_target("hidden")
    hidden = CdpSession(str(target["webSocketDebuggerUrl"]))
    try:
        hidden.call("Network.enable", timeout=10)
        hidden.call("Network.setCookies", {"cookies": cookie_params}, timeout=10)
    finally:
        hidden.close()
    return len(cookie_params)


class CdpSession:
    def __init__(self, websocket_url: str):
        self._ws = websocket.create_connection(websocket_url, timeout=30, suppress_origin=True)
        self._next_id = 1

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:
            pass

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 30) -> Dict[str, Any]:
        message_id = self._next_id
        self._next_id += 1
        self._ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self._ws.recv()
            if not raw:
                continue
            message = json.loads(raw)
            if message.get("id") != message_id:
                continue
            if "error" in message:
                raise ChatGPTBridgeError(message["error"].get("message") or str(message["error"]))
            return message.get("result") or {}
        raise ChatGPTBridgeError(f"CDP 调用超时：{method}")

    def evaluate(self, expression: str, timeout: float = 30) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": True,
            },
            timeout=timeout,
        )
        value = result.get("result") or {}
        if value.get("subtype") == "error":
            raise ChatGPTBridgeError(value.get("description") or value.get("value") or "页面脚本执行失败")
        return value.get("value")


def bridge_status(browser_mode: str = "visible") -> Dict[str, Any]:
    mode = _normalize_browser_mode(browser_mode)
    try:
        if mode == "hidden":
            _ensure_hidden_browser()
            _sync_hidden_cookies_from_visible()
        version = _cdp_http_json(mode, "/json/version", timeout=2)
        pages = _list_pages(mode)
    except Exception as exc:
        return {
            "browser_mode": mode,
            "browser_connected": False,
            "chatgpt_tab": False,
            "detail": f"无法连接 {'隐藏' if mode == 'hidden' else '9222'} Chrome：{exc}",
        }

    chatgpt_pages = [page for page in pages if "chatgpt.com" in str(page.get("url") or "")]
    return {
        "browser_mode": mode,
        "browser_connected": True,
        "browser": version.get("Browser"),
        "chatgpt_tab": bool(chatgpt_pages),
        "chatgpt_url": chatgpt_pages[0].get("url") if chatgpt_pages else "",
        "hidden_headless": HIDDEN_HEADLESS if mode == "hidden" else False,
        "hidden_port": HIDDEN_CDP_PORT if mode == "hidden" else None,
        "detail": "已连接隐藏 Chrome" if mode == "hidden" else "已连接 9222 Chrome",
    }


def open_chatgpt_page(browser_mode: str = "visible") -> Dict[str, Any]:
    mode = _normalize_browser_mode(browser_mode)
    if mode == "hidden":
        _ensure_hidden_browser()
        _sync_hidden_cookies_from_visible()
    target = _get_or_create_chatgpt_target(mode)
    if mode == "visible":
        try:
            _cdp_http_json("visible", f"/json/activate/{target['id']}", timeout=2)
        except Exception:
            pass
    return {
        "ok": True,
        "browser_mode": mode,
        "url": target.get("url") or CHATGPT_URL,
        "detail": "隐藏浏览器已在后台打开 ChatGPT" if mode == "hidden" else "已打开 ChatGPT",
    }


def create_chatgpt_job(
    image_bytes: bytes,
    filename: str,
    prompt: str,
    browser_mode: str = "visible",
) -> Dict[str, Any]:
    if not prompt.strip():
        raise ValueError("请输入提示词")
    if not image_bytes:
        raise ValueError("图片不能为空")

    job_id = uuid.uuid4().hex
    job_dir = JOB_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(filename or "image.png").suffix.lower() or ".png"
    input_path = job_dir / f"input{suffix}"
    input_path.write_bytes(image_bytes)

    job = {
        "id": job_id,
        "status": "queued",
        "stage": "等待网页 GPT",
        "browser_mode": _normalize_browser_mode(browser_mode),
        "prompt": prompt,
        "filename": filename,
        "input_path": str(input_path),
        "created_at": time.time(),
        "updated_at": time.time(),
        "result_image": None,
        "result_text": "",
        "error": "",
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job

    worker = threading.Thread(target=_run_job, args=(job_id,), daemon=True)
    worker.start()
    return serialize_job(job_id)


def serialize_job(job_id: str) -> Dict[str, Any]:
    with _JOBS_LOCK:
        job = dict(_JOBS.get(job_id) or {})
    if not job:
        raise KeyError(job_id)
    job.pop("input_path", None)
    job.pop("prompt", None)
    return job


def _set_job(job_id: str, **updates: Any) -> None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updated_at"] = time.time()


def _run_job(job_id: str) -> None:
    with _JOBS_LOCK:
        job = dict(_JOBS[job_id])
    try:
        browser_mode = _normalize_browser_mode(str(job.get("browser_mode") or "visible"))
        _set_job(
            job_id,
            status="running",
            stage="连接隐藏 Chrome" if browser_mode == "hidden" else "连接 9222 Chrome",
        )
        result = run_chatgpt_web_generation(
            image_path=Path(job["input_path"]),
            prompt=str(job["prompt"]),
            browser_mode=browser_mode,
            progress=lambda stage: _set_job(job_id, status="running", stage=stage),
        )
        _set_job(
            job_id,
            status="done",
            stage="已完成",
            result_image=result.get("result_image"),
            result_text=result.get("result_text") or "",
        )
    except Exception as exc:
        _set_job(job_id, status="error", stage="失败", error=str(exc))


def run_chatgpt_web_generation(
    *,
    image_path: Path,
    prompt: str,
    browser_mode: str = "visible",
    progress: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    progress = progress or (lambda _stage: None)
    mode = _normalize_browser_mode(browser_mode)
    if mode == "hidden":
        progress("启动隐藏 Chrome")
        _ensure_hidden_browser()
        progress("同步 ChatGPT 登录")
        _sync_hidden_cookies_from_visible()
    target = _get_or_create_chatgpt_target(mode)
    session = CdpSession(str(target["webSocketDebuggerUrl"]))
    try:
        session.call("Page.enable")
        session.call("Runtime.enable")
        session.call("DOM.enable")
        session.call("Input.setIgnoreInputEvents", {"ignore": False})

        progress("打开 ChatGPT 新聊天")
        _open_new_chat(session)

        progress("等待 ChatGPT 输入框")
        _wait_for_chatgpt_ready(session)

        progress("上传图片到 ChatGPT")
        baseline_images = _image_sources(session)
        _upload_file(session, image_path)
        _wait_for_upload_ready(session)
        baseline_images = _image_sources(session)

        progress("切换生成图片模式")
        _select_image_generation_mode(session)

        progress("填写提示词")
        _focus_prompt(session)
        _clear_prompt(session)
        session.call("Input.insertText", {"text": prompt}, timeout=10)
        time.sleep(0.5)

        progress("提交给 ChatGPT")
        _click_send(session)

        progress("等待网页 GPT 生成")
        result = _wait_for_result_image(session, baseline_images)
        if result.get("clip"):
            progress("截图回传结果")
            shot = session.call(
                "Page.captureScreenshot",
                {
                    "format": "png",
                    "captureBeyondViewport": False,
                    "clip": result["clip"],
                },
                timeout=30,
            )
            data = shot.get("data")
            if data:
                return {"result_image": f"data:image/png;base64,{data}", "result_text": result.get("text") or ""}

        if result.get("image_data_url"):
            return {"result_image": result["image_data_url"], "result_text": result.get("text") or ""}

        raise ChatGPTBridgeError(result.get("text") or "没有检测到 ChatGPT 返回的图片")
    finally:
        session.close()


def _list_pages(browser_mode: str = "visible") -> List[Dict[str, Any]]:
    return _cdp_http_json(browser_mode, "/json", timeout=4)


def _get_or_create_chatgpt_target(browser_mode: str = "visible") -> Dict[str, Any]:
    mode = _normalize_browser_mode(browser_mode)
    pages = _list_pages(mode)
    for page in pages:
        if page.get("type") == "page" and "chatgpt.com" in str(page.get("url") or ""):
            if page.get("webSocketDebuggerUrl"):
                return page

    target = _cdp_http_json(mode, f"/json/new?{quote(CHATGPT_URL, safe=':/?=&')}", method="PUT", timeout=5)
    if not target.get("webSocketDebuggerUrl"):
        raise ChatGPTBridgeError("无法创建 ChatGPT 标签页")
    return target


def _wait_for_chatgpt_ready(session: CdpSession) -> None:
    deadline = time.time() + 90
    last_state: Dict[str, Any] = {}
    while time.time() < deadline:
        state = session.evaluate(
            """
            (() => {
              const editor = document.querySelector('#prompt-textarea')
                || document.querySelector('[contenteditable="true"][role="textbox"]')
                || document.querySelector('[contenteditable="true"]')
                || document.querySelector('textarea');
              const text = document.body ? document.body.innerText : '';
              return {
                ready: Boolean(editor),
                url: location.href,
                title: document.title,
                loginRequired: /Log in|Sign up|登录|注册|继续使用 Google/i.test(text) && !editor,
                body: text.slice(0, 500)
              };
            })()
            """
        ) or {}
        last_state = state
        if state.get("ready"):
            return
        if state.get("loginRequired"):
            raise ChatGPTBridgeError("ChatGPT 需要先登录。请在 9222 Chrome 中登录后再重试。")
        time.sleep(1)
    raise ChatGPTBridgeError(f"等待 ChatGPT 输入框超时：{last_state.get('title') or last_state.get('url')}")


def _open_new_chat(session: CdpSession) -> None:
    session.call("Page.navigate", {"url": CHATGPT_URL}, timeout=10)
    deadline = time.time() + 30
    while time.time() < deadline:
        state = session.evaluate(
            """
            (() => ({
              readyState: document.readyState,
              url: location.href,
              hasBody: Boolean(document.body),
            }))()
            """,
            timeout=5,
        ) or {}
        if state.get("hasBody") and state.get("readyState") in {"interactive", "complete"}:
            return
        time.sleep(0.5)


def _image_sources(session: CdpSession) -> List[str]:
    return session.evaluate(
        """
        (() => Array.from(document.images)
          .map((img) => img.currentSrc || img.src || '')
          .filter(Boolean))()
        """
    ) or []


def _upload_file(session: CdpSession, image_path: Path) -> None:
    node_id = _query_file_input(session)
    if not node_id:
        session.evaluate(
            """
            (() => {
              const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
              const target = buttons.find((button) => {
                const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.textContent || ''}`.toLowerCase();
                return /attach|upload|file|paperclip|添加|上传|附件|文件/.test(label);
              });
              if (target) target.click();
              return Boolean(target);
            })()
            """
        )
        deadline = time.time() + 10
        while time.time() < deadline and not node_id:
            time.sleep(0.5)
            node_id = _query_file_input(session)
    if not node_id:
        raise ChatGPTBridgeError("没有找到 ChatGPT 的图片上传输入框")
    session.call("DOM.setFileInputFiles", {"nodeId": node_id, "files": [str(image_path)]}, timeout=20)


def _wait_for_upload_ready(session: CdpSession) -> None:
    deadline = time.time() + 45
    while time.time() < deadline:
        state = session.evaluate(
            """
            (() => {
              const text = document.body ? document.body.innerText : '';
              const removeButton = Array.from(document.querySelectorAll('button,[role="button"]')).find((button) => {
                const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.textContent || ''}`;
                return /移除文件|Remove file|删除文件|Remove attachment/i.test(label);
              });
              const imageButton = Array.from(document.querySelectorAll('button,[role="button"]')).find((button) => {
                const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.textContent || ''}`;
                return /打开图片|Open image|用户上传|uploaded image/i.test(label);
              });
              const busyUpload = /正在上传|Uploading|处理文件|Processing file/i.test(text);
              return { ready: Boolean(removeButton || imageButton) && !busyUpload, busyUpload };
            })()
            """,
            timeout=5,
        ) or {}
        if state.get("ready"):
            return
        time.sleep(0.6)
    time.sleep(1.5)


def _query_file_input(session: CdpSession) -> int:
    document = session.call("DOM.getDocument", {"depth": -1, "pierce": True})
    root = (document.get("root") or {}).get("nodeId")
    if not root:
        return 0
    result = session.call("DOM.querySelector", {"nodeId": root, "selector": 'input[type="file"]'})
    return int(result.get("nodeId") or 0)


def _focus_prompt(session: CdpSession) -> None:
    ok = session.evaluate(
        """
        (() => {
          const editor = document.querySelector('#prompt-textarea')
            || document.querySelector('[contenteditable="true"][role="textbox"]')
            || document.querySelector('[contenteditable="true"]')
            || document.querySelector('textarea');
          if (!editor) return false;
          editor.focus();
          return true;
        })()
        """
    )
    if not ok:
        raise ChatGPTBridgeError("没有找到 ChatGPT 输入框")


def _clear_prompt(session: CdpSession) -> None:
    session.evaluate(
        """
        (() => {
          const editor = document.querySelector('#prompt-textarea')
            || document.querySelector('[contenteditable="true"][role="textbox"]')
            || document.querySelector('[contenteditable="true"]')
            || document.querySelector('textarea');
          if (!editor) return false;
          editor.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          if ('value' in editor) editor.value = '';
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
          return true;
        })()
        """,
        timeout=5,
    )


def _select_image_generation_mode(session: CdpSession) -> None:
    deadline = time.time() + 12
    while time.time() < deadline:
        state = session.evaluate(
            """
            (() => {
              const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
              const target = buttons.find((button) => {
                const rect = button.getBoundingClientRect();
                const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.textContent || ''}`.trim();
                return /生成图片|Create image|Generate image|Image generation/i.test(label)
                  && rect.width > 0
                  && rect.height > 0
                  && rect.bottom > 0
                  && rect.top < innerHeight
                  && rect.right > 0
                  && rect.left < innerWidth
                  && !button.disabled
                  && button.getAttribute('aria-disabled') !== 'true';
              });
              if (!target) return { found: false };
              const rect = target.getBoundingClientRect();
              const selected = target.getAttribute('aria-pressed') === 'true'
                || target.getAttribute('data-state') === 'checked'
                || /selected|active|primary/i.test(target.className || '');
              return {
                found: true,
                selected,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                text: target.textContent || target.getAttribute('aria-label') || ''
              };
            })()
            """,
            timeout=5,
        ) or {}
        if state.get("selected"):
            return
        if state.get("found"):
            x = float(state.get("x") or 0)
            y = float(state.get("y") or 0)
            session.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"}, timeout=5)
            session.call(
                "Input.dispatchMouseEvent",
                {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1},
                timeout=5,
            )
            session.call(
                "Input.dispatchMouseEvent",
                {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1},
                timeout=5,
            )
            time.sleep(0.8)
            return
        time.sleep(0.5)


def _click_send(session: CdpSession) -> None:
    deadline = time.time() + 30
    last_state: Dict[str, Any] = {}
    while time.time() < deadline:
        state = session.evaluate(
            """
            (() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const candidates = [
                document.querySelector('[data-testid="send-button"]'),
                document.querySelector('#composer-submit-button'),
                document.querySelector('[aria-label*="发送提示"]'),
                document.querySelector('[aria-label*="Send prompt"]'),
                ...buttons.filter((button) => {
                  const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.textContent || ''}`.toLowerCase();
                  return /send|submit|发送|提交/.test(label);
                })
              ].filter(Boolean);
              const target = candidates.find((button) => {
                const rect = button.getBoundingClientRect();
                return rect.width > 0
                  && rect.height > 0
                  && rect.bottom > 0
                  && rect.top < innerHeight
                  && rect.right > 0
                  && rect.left < innerWidth
                  && !button.disabled
                  && button.getAttribute('aria-disabled') !== 'true';
              });
              const busy = Boolean(document.querySelector('[data-testid="stop-button"], [aria-label*="Stop"], [aria-label*="停止"]'));
              if (!target) return { ready: false, busy };
              const rect = target.getBoundingClientRect();
              return {
                ready: true,
                busy,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                aria: target.getAttribute('aria-label') || '',
                testid: target.getAttribute('data-testid') || '',
              };
            })()
            """,
            timeout=5,
        ) or {}
        last_state = state
        if state.get("busy"):
            return
        if state.get("ready"):
            x = float(state.get("x") or 0)
            y = float(state.get("y") or 0)
            session.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"}, timeout=5)
            session.call(
                "Input.dispatchMouseEvent",
                {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1},
                timeout=5,
            )
            session.call(
                "Input.dispatchMouseEvent",
                {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1},
                timeout=5,
            )
            time.sleep(1)
            sent = session.evaluate(
                """
                (() => {
                  const busy = Boolean(document.querySelector('[data-testid="stop-button"], [aria-label*="Stop"], [aria-label*="停止"]'));
                  const editor = document.querySelector('#prompt-textarea')
                    || document.querySelector('[contenteditable="true"][role="textbox"]')
                    || document.querySelector('[contenteditable="true"]')
                    || document.querySelector('textarea');
                  const text = editor ? (editor.innerText || editor.value || editor.textContent || '').trim() : '';
                  return busy || !text;
                })()
                """,
                timeout=5,
            )
            if sent:
                return

            clicked = session.evaluate(
                """
                (() => {
                  const target = document.querySelector('[data-testid="send-button"]')
                    || document.querySelector('#composer-submit-button')
                    || document.querySelector('[aria-label*="发送提示"]')
                    || document.querySelector('[aria-label*="Send prompt"]');
                  if (!target) return false;
                  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', isPrimary: true }));
                  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', isPrimary: true }));
                  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                  target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
                  return true;
                })()
                """,
                timeout=5,
            )
            if clicked:
                time.sleep(1)
                sent = session.evaluate(
                    """
                    (() => {
                      const busy = Boolean(document.querySelector('[data-testid="stop-button"], [aria-label*="Stop"], [aria-label*="停止"]'));
                      const editor = document.querySelector('#prompt-textarea')
                        || document.querySelector('[contenteditable="true"][role="textbox"]')
                        || document.querySelector('[contenteditable="true"]')
                        || document.querySelector('textarea');
                      const text = editor ? (editor.innerText || editor.value || editor.textContent || '').trim() : '';
                      return busy || !text;
                    })()
                    """,
                    timeout=5,
                )
                if sent:
                    return

            _focus_prompt(session)
            session.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13}, timeout=5)
            session.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13}, timeout=5)
            time.sleep(1)
            sent = session.evaluate(
                """
                (() => Boolean(document.querySelector('[data-testid="stop-button"], [aria-label*="Stop"], [aria-label*="停止"]')))()
                """,
                timeout=5,
            )
            if sent:
                return
        time.sleep(0.5)
    raise ChatGPTBridgeError(f"发送按钮没有触发提交：{last_state}")


def _wait_for_result_image(session: CdpSession, baseline_images: List[str]) -> Dict[str, Any]:
    baseline_json = json.dumps(list(set(baseline_images)))
    deadline = time.time() + 600
    stable_since = 0.0
    last_src = ""
    last_result: Dict[str, Any] = {}

    while time.time() < deadline:
        result = session.evaluate(
            f"""
            (() => {{
              const baseline = new Set({baseline_json});
              window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
              const images = Array.from(document.images).map((img, index) => {{
                const rect = img.getBoundingClientRect();
                const src = img.currentSrc || img.src || '';
                return {{
                  index,
                  src,
                  complete: img.complete,
                  naturalWidth: img.naturalWidth || 0,
                  naturalHeight: img.naturalHeight || 0,
                  x: rect.left,
                  y: rect.top,
                  width: rect.width,
                  height: rect.height,
                  area: rect.width * rect.height,
                  visible: rect.width > 120 && rect.height > 120 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
                }};
              }}).filter((img) =>
                img.src
                && !baseline.has(img.src)
                && img.complete
                && img.naturalWidth > 120
                && img.naturalHeight > 120
                && img.area > 20000
              );
              images.sort((a, b) => (b.y - a.y) || (b.area - a.area));
              const candidate = images[0] || null;
              if (candidate) {{
                const element = document.images[candidate.index];
                element.scrollIntoView({{ block: 'center', inline: 'center' }});
                const rect = element.getBoundingClientRect();
                candidate.clip = {{
                  x: Math.max(0, rect.left),
                  y: Math.max(0, rect.top),
                  width: Math.max(1, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)),
                  height: Math.max(1, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)),
                  scale: 1
                }};
              }}
              const busy = Boolean(document.querySelector('[data-testid="stop-button"], [aria-label*="Stop"], [aria-label*="停止"]'));
              const text = (document.body ? document.body.innerText : '').slice(-1200);
              return {{ candidate, busy, text }};
            }})()
            """,
            timeout=5,
        ) or {}
        candidate = result.get("candidate")
        if candidate and candidate.get("src") == last_src:
            if not stable_since:
                stable_since = time.time()
        elif candidate:
            last_src = candidate.get("src") or ""
            stable_since = time.time()
        last_result = result

        if candidate and not result.get("busy") and stable_since and time.time() - stable_since > 4:
            return {
                "clip": candidate.get("clip"),
                "text": result.get("text") or "",
            }
        time.sleep(2)

    text = last_result.get("text") if isinstance(last_result, dict) else ""
    raise ChatGPTBridgeError(f"等待 ChatGPT 图片结果超时。最后页面文字：{str(text)[-300:]}")


def cleanup_old_jobs(max_age_seconds: int = 24 * 3600) -> None:
    cutoff = time.time() - max_age_seconds
    with _JOBS_LOCK:
        old_ids = [job_id for job_id, job in _JOBS.items() if float(job.get("created_at") or 0) < cutoff]
        for job_id in old_ids:
            _JOBS.pop(job_id, None)
    if JOB_ROOT.exists():
        for path in JOB_ROOT.iterdir():
            if path.is_dir() and path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
