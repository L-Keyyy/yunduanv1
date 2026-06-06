import importlib.util
import json
import os
import platform
import shlex
import socket
import subprocess
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
REQUIREMENTS_PATH = BASE_DIR / "requirements.txt"
PYTHON = sys.executable or "python3"

BROWSERS = {
    "chrome": "Chrome",
    "edge": "Edge",
    "firefox": "Firefox",
}

OUTPUT_FORMATS = ["csv", "json", "xlsx", "txt", "sql"]

REQUIRED_MODULES = [
    ("selenium", "Selenium"),
    ("requests", "Requests"),
    ("playsound", "PlaySound"),
    ("openpyxl", "OpenPyXL"),
]

SCRIPT_ACTIONS = {
    "Spider_taobao.py": {"title": "淘宝爬虫", "desc": "搜索淘宝商品并导出数据"},
    "Spider_jd.py": {"title": "京东爬虫", "desc": "搜索京东商品并导出数据"},
    "1688Spider.py": {"title": "1688 爬虫", "desc": "旧版脚本，运行时需要在终端输入关键词和页码"},
    "GetCookie.py": {"title": "获取 Cookie", "desc": "登录商城并保存 Cookie / Storage"},
    "Update.py": {"title": "更新工具", "desc": "打开官方更新器"},
    "Starter.py": {"title": "旧版启动器", "desc": "打开原来的命令行启动菜单"},
}


def ensure_work_dirs():
    for dirname in ("cookie", "result", "logs"):
        (BASE_DIR / dirname).mkdir(exist_ok=True)


def default_config():
    return {
        "browser": "chrome",
        "output_format": ["csv", "json"],
        "create_time": int(time.time()),
    }


def load_config():
    if not CONFIG_PATH.exists():
        return default_config()
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return default_config()
    config = default_config()
    if isinstance(data, dict):
        config.update(data)
    if config.get("browser") not in BROWSERS:
        config["browser"] = "chrome"
    formats = [fmt for fmt in config.get("output_format", []) if fmt in OUTPUT_FORMATS]
    config["output_format"] = formats or ["csv", "json"]
    if not isinstance(config.get("create_time"), int):
        config["create_time"] = int(time.time())
    return config


def save_config(config):
    normalized = default_config()
    normalized.update(config if isinstance(config, dict) else {})
    normalized["browser"] = normalized.get("browser") if normalized.get("browser") in BROWSERS else "chrome"
    normalized["output_format"] = [
        fmt for fmt in normalized.get("output_format", []) if fmt in OUTPUT_FORMATS
    ] or ["csv", "json"]
    normalized["create_time"] = int(normalized.get("create_time") or int(time.time()))
    CONFIG_PATH.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    return normalized


def format_time(timestamp):
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(timestamp)))
    except Exception:
        return "-"


def missing_modules():
    missing = []
    for module_name, display_name in REQUIRED_MODULES:
        if importlib.util.find_spec(module_name) is None:
            missing.append(display_name)
    return missing


def cookie_files():
    cookie_dir = BASE_DIR / "cookie"
    cookie_dir.mkdir(exist_ok=True)
    files = [item for item in cookie_dir.iterdir() if item.is_file()]
    files.extend(
        item for item in BASE_DIR.iterdir() if item.is_file() and item.name.startswith("cookie\\")
    )
    return sorted(files, key=lambda path: path.stat().st_mtime, reverse=True)


def result_files():
    result_dir = BASE_DIR / "result"
    result_dir.mkdir(exist_ok=True)
    return sorted(
        [item for item in result_dir.iterdir() if item.is_file()],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def apple_script_escape(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def terminal_command(command, title="MarketSpider"):
    system = platform.system().lower()
    if system == "darwin":
        script = (
            'tell application "Terminal"\n'
            "activate\n"
            f'do script "{apple_script_escape(command)}"\n'
            "end tell"
        )
        subprocess.Popen(["osascript", "-e", script], cwd=str(BASE_DIR))
        return
    if system == "windows":
        subprocess.Popen(["cmd", "/c", "start", title, "cmd", "/k", command], cwd=str(BASE_DIR))
        return
    subprocess.Popen(command, cwd=str(BASE_DIR), shell=True)


def open_path(dirname):
    allowed = {
        "result": BASE_DIR / "result",
        "cookie": BASE_DIR / "cookie",
        "logs": BASE_DIR / "logs",
    }
    target = allowed.get(dirname)
    if not target:
        raise ValueError("Unsupported path")
    target.mkdir(exist_ok=True)
    system = platform.system().lower()
    if system == "darwin":
        subprocess.Popen(["open", str(target)])
    elif system == "windows":
        os.startfile(str(target))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(target)])


def status_payload():
    config = load_config()
    cookies = cookie_files()
    results = result_files()
    missing = missing_modules()
    return {
        "ok": True,
        "baseDir": str(BASE_DIR),
        "config": config,
        "browserLabel": BROWSERS.get(config.get("browser"), config.get("browser", "-")),
        "outputFormats": config.get("output_format", []),
        "configTime": format_time(config.get("create_time")),
        "missingModules": missing,
        "depsText": "已安装" if not missing else "缺少: " + ", ".join(missing),
        "cookieCount": len(cookies),
        "latestCookie": cookies[0].name if cookies else "",
        "resultCount": len(results),
        "latestResult": results[0].name if results else "",
        "scripts": SCRIPT_ACTIONS,
    }


def html_page():
    scripts_json = json.dumps(SCRIPT_ACTIONS, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MarketSpider 控制台</title>
  <style>
    :root {{
      --ink:#17352d; --muted:#6f817b; --paper:#fffdf6; --line:#d8e5dc;
      --green:#164034; --leaf:#2f8c64; --gold:#e7b44d; --danger:#c2410c;
      --bg:#eef6ef;
    }}
    * {{ box-sizing:border-box; }}
    body {{
      margin:0; min-height:100vh; color:var(--ink);
      font-family:"Avenir Next","PingFang SC","Hiragino Sans GB",Helvetica,Arial,sans-serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(231,180,77,.28), transparent 28rem),
        radial-gradient(circle at 82% 18%, rgba(47,140,100,.22), transparent 26rem),
        linear-gradient(135deg,#eef6ef,#fff8e6 58%,#e7f4ee);
    }}
    .shell {{ max-width:1180px; margin:0 auto; padding:32px 24px 44px; }}
    .hero {{
      position:relative; overflow:hidden; border-radius:30px; padding:34px;
      background:linear-gradient(135deg,#12382e,#1c5947 64%,#ddb55a);
      color:#fff8df; box-shadow:0 26px 70px rgba(22,64,52,.24);
    }}
    .hero:after {{
      content:""; position:absolute; inset:auto -80px -120px auto; width:360px; height:360px;
      border-radius:50%; background:rgba(255,255,255,.12);
    }}
    h1 {{ margin:0; font-size:40px; letter-spacing:-.04em; }}
    .hero p {{ margin:10px 0 0; color:#d8f0e4; font-weight:700; }}
    .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:20px; }}
    .card {{
      border:1px solid rgba(216,229,220,.9); border-radius:24px; padding:22px;
      background:rgba(255,253,246,.92); box-shadow:0 18px 50px rgba(23,53,45,.12);
      backdrop-filter: blur(10px);
    }}
    .wide {{ grid-column:1 / -1; }}
    .card h2 {{ margin:0 0 6px; font-size:22px; }}
    .hint {{ color:var(--muted); font-size:13px; font-weight:700; margin-bottom:16px; }}
    .status-grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }}
    .stat {{ padding:15px; border-radius:18px; background:#f4faf6; border:1px solid var(--line); }}
    .stat b {{ display:block; margin-bottom:5px; color:var(--muted); font-size:12px; }}
    .stat span {{ white-space:pre-line; font-weight:900; }}
    label {{ display:block; font-size:13px; color:var(--muted); font-weight:900; margin:14px 0 8px; }}
    .choice-row {{ display:flex; flex-wrap:wrap; gap:10px; }}
    .pill {{
      display:inline-flex; align-items:center; gap:8px; padding:10px 12px; border-radius:14px;
      background:#f7fbf7; border:1px solid var(--line); font-weight:900;
    }}
    input[type=radio], input[type=checkbox] {{ accent-color:var(--leaf); }}
    button {{
      border:0; border-radius:15px; padding:12px 16px; font-weight:950; cursor:pointer;
      color:white; background:linear-gradient(180deg,#39a76f,#1f6d51);
      box-shadow:0 12px 24px rgba(47,140,100,.2);
    }}
    button.secondary {{ color:var(--ink); background:#fff; border:1px solid var(--line); box-shadow:none; }}
    button.gold {{ color:#2d2110; background:linear-gradient(180deg,#ffd977,#e7b44d); }}
    .actions {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }}
    .action {{
      display:grid; grid-template-columns:1fr auto; gap:12px; align-items:center;
      padding:14px; border-radius:18px; background:#f8fbf8; border:1px solid var(--line);
    }}
    .action-title {{ font-weight:950; }}
    .action-desc {{ color:var(--muted); font-size:12px; margin-top:3px; font-weight:700; }}
    .tool-row {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }}
    .log {{
      height:120px; overflow:auto; border-radius:18px; padding:14px; color:#dff8e8;
      background:#10231e; font-family:Menlo,Consolas,monospace; font-size:12px;
    }}
    .footer {{ margin-top:16px; color:var(--muted); font-size:12px; font-weight:800; }}
    @media (max-width:880px) {{
      .grid,.actions,.status-grid,.tool-row {{ grid-template-columns:1fr; }}
      h1 {{ font-size:32px; }}
    }}
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>MarketSpider 控制台</h1>
      <p>浏览器版 UI，不依赖 Tkinter。配置、修复依赖、获取 Cookie、启动爬虫都在这里。</p>
    </section>

    <section class="grid">
      <div class="card">
        <h2>运行配置</h2>
        <div class="hint">保存后写入 config.json，原爬虫脚本会直接读取。</div>
        <label>浏览器</label>
        <div class="choice-row" id="browserChoices"></div>
        <label>默认输出格式</label>
        <div class="choice-row" id="formatChoices"></div>
        <div style="margin-top:18px; display:flex; gap:10px;">
          <button onclick="saveConfig()">保存配置</button>
          <button class="secondary" onclick="refreshStatus()">检查状态</button>
        </div>
      </div>

      <div class="card">
        <h2>状态</h2>
        <div class="hint">如果缺依赖，先点“安装/修复依赖”。</div>
        <div class="status-grid">
          <div class="stat"><b>配置</b><span id="configStat">加载中...</span></div>
          <div class="stat"><b>依赖</b><span id="depsStat">加载中...</span></div>
          <div class="stat"><b>Cookie</b><span id="cookieStat">加载中...</span></div>
          <div class="stat"><b>结果</b><span id="resultStat">加载中...</span></div>
        </div>
        <div class="tool-row" style="margin-top:16px;">
          <button class="gold" onclick="installDeps()">安装/修复依赖</button>
          <button class="secondary" onclick="openPath('result')">结果目录</button>
          <button class="secondary" onclick="openPath('cookie')">Cookie 目录</button>
          <button class="secondary" onclick="openPath('logs')">日志目录</button>
        </div>
      </div>

      <div class="card wide">
        <h2>启动功能</h2>
        <div class="hint">脚本会在新的终端窗口里运行，保留原脚本的弹窗和输入流程。</div>
        <div class="actions" id="actions"></div>
      </div>

      <div class="card wide">
        <h2>运行日志</h2>
        <div class="log" id="logBox"></div>
        <div class="footer" id="baseDir"></div>
      </div>
    </section>
  </main>

  <script>
    const scripts = {scripts_json};
    const formats = {json.dumps(OUTPUT_FORMATS)};
    const browsers = {json.dumps(BROWSERS, ensure_ascii=False)};
    let currentStatus = null;

    function log(message) {{
      const box = document.getElementById('logBox');
      const now = new Date().toLocaleTimeString();
      box.textContent += `[${{now}}] ${{message}}\\n`;
      box.scrollTop = box.scrollHeight;
    }}

    async function api(path, body) {{
      const options = body === undefined ? {{}} : {{
        method:'POST',
        headers:{{'Content-Type':'application/json'}},
        body:JSON.stringify(body)
      }};
      const res = await fetch(path, options);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '请求失败');
      return data;
    }}

    function renderChoices(status) {{
      const config = status.config;
      document.getElementById('browserChoices').innerHTML = Object.entries(browsers).map(([value,label]) => `
        <label class="pill"><input type="radio" name="browser" value="${{value}}" ${{config.browser === value ? 'checked' : ''}}> ${{label}}</label>
      `).join('');
      document.getElementById('formatChoices').innerHTML = formats.map(fmt => `
        <label class="pill"><input type="checkbox" name="format" value="${{fmt}}" ${{config.output_format.includes(fmt) ? 'checked' : ''}}> ${{fmt.toUpperCase()}}</label>
      `).join('');
    }}

    function renderActions() {{
      document.getElementById('actions').innerHTML = Object.entries(scripts).map(([script, item]) => `
        <div class="action">
          <div>
            <div class="action-title">${{item.title}}</div>
            <div class="action-desc">${{item.desc}}</div>
          </div>
          <button onclick="launchScript('${{script}}')">启动</button>
        </div>
      `).join('');
    }}

    async function refreshStatus() {{
      const status = await api('/api/status');
      currentStatus = status;
      renderChoices(status);
      renderActions();
      document.getElementById('configStat').textContent = `${{status.browserLabel}}\\n${{status.outputFormats.join(', ')}}\\n${{status.configTime}}`;
      document.getElementById('depsStat').textContent = status.depsText;
      document.getElementById('cookieStat').textContent = status.cookieCount ? `${{status.cookieCount}} 个文件\\n最新: ${{status.latestCookie}}` : '未找到 Cookie';
      document.getElementById('resultStat').textContent = status.resultCount ? `${{status.resultCount}} 个文件\\n最新: ${{status.latestResult}}` : '暂无结果文件';
      document.getElementById('baseDir').textContent = `项目目录: ${{status.baseDir}}`;
      log('状态已刷新');
    }}

    async function saveConfig() {{
      const browser = document.querySelector('input[name=browser]:checked')?.value || 'chrome';
      const output_format = Array.from(document.querySelectorAll('input[name=format]:checked')).map(el => el.value);
      if (!output_format.length) {{
        alert('请至少选择一种输出格式');
        return;
      }}
      await api('/api/config', {{browser, output_format, create_time: currentStatus?.config?.create_time}});
      log('配置已保存');
      await refreshStatus();
    }}

    async function launchScript(script) {{
      await saveConfig();
      await api('/api/launch', {{script}});
      log(`已启动 ${{script}}`);
    }}

    async function installDeps() {{
      await api('/api/install');
      log('已打开依赖安装终端');
    }}

    async function openPath(name) {{
      await api('/api/open-path', {{name}});
      log(`已打开 ${{name}} 目录`);
    }}

    refreshStatus().catch(err => log(`错误: ${{err.message}}`));
  </script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            body = html_page().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/status":
            self._send_json(status_payload())
            return
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self):
        try:
            payload = self._read_json()
            if self.path == "/api/config":
                saved = save_config(payload)
                self._send_json({"ok": True, "config": saved})
                return
            if self.path == "/api/launch":
                script = payload.get("script")
                if script not in SCRIPT_ACTIONS:
                    raise ValueError("Unsupported script")
                script_path = BASE_DIR / script
                command = " && ".join(
                    [
                        f"cd {shlex.quote(str(BASE_DIR))}",
                        f"{shlex.quote(PYTHON)} {shlex.quote(str(script_path))}",
                        'echo ""',
                        'echo "MarketSpider 任务窗口可在确认完成后关闭。"',
                    ]
                )
                terminal_command(command, f"MarketSpider - {script}")
                self._send_json({"ok": True})
                return
            if self.path == "/api/install":
                command = " && ".join(
                    [
                        f"cd {shlex.quote(str(BASE_DIR))}",
                        f"{shlex.quote(PYTHON)} -m pip install -r {shlex.quote(str(REQUIREMENTS_PATH))}",
                        'echo ""',
                        'echo "依赖安装完成后可回到浏览器 UI 点击检查状态。"',
                    ]
                )
                terminal_command(command, "MarketSpider - Install Requirements")
                self._send_json({"ok": True})
                return
            if self.path == "/api/open-path":
                open_path(str(payload.get("name") or ""))
                self._send_json({"ok": True})
                return
            self.send_error(404)
        except Exception as error:
            self._send_json({"ok": False, "error": str(error)}, status=500)

    def log_message(self, format, *args):
        return


def find_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    ensure_work_dirs()
    port = find_port()
    url = f"http://127.0.0.1:{port}/"
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"MarketSpider Web UI: {url}")
    if os.environ.get("MARKETSPIDER_NO_BROWSER") != "1":
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
