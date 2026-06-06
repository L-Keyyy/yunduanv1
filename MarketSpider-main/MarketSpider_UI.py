import importlib.util
import json
import os
import platform
import shlex
import subprocess
import sys
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk


BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
REQUIREMENTS_PATH = BASE_DIR / "requirements.txt"
PYTHON = sys.executable or "python3"
UI_LOG_PATH = BASE_DIR / "logs" / "ui_launcher.log"

BROWSERS = {
    "chrome": "Chrome",
    "edge": "Edge",
    "firefox": "Firefox",
}

OUTPUT_FORMATS = [
    ("csv", "CSV"),
    ("json", "JSON"),
    ("xlsx", "Excel"),
    ("txt", "TXT"),
    ("sql", "SQL"),
]

REQUIRED_MODULES = [
    ("selenium", "Selenium"),
    ("requests", "Requests"),
    ("playsound", "PlaySound"),
    ("openpyxl", "OpenPyXL"),
]

SCRIPT_ACTIONS = [
    ("Spider_taobao.py", "淘宝爬虫", "搜索淘宝商品并导出数据"),
    ("Spider_jd.py", "京东爬虫", "搜索京东商品并导出数据"),
    ("1688Spider.py", "1688 爬虫", "1688 旧版脚本，运行时需要在终端输入关键词和页码"),
    ("GetCookie.py", "获取 Cookie", "登录商城并保存 Cookie / Storage"),
    ("Update.py", "更新工具", "打开官方更新器"),
    ("Starter.py", "旧版启动器", "打开原来的命令行启动菜单"),
]


def ensure_work_dirs():
    for dirname in ("cookie", "result", "logs", "Logs"):
        (BASE_DIR / dirname).mkdir(exist_ok=True)


def write_ui_log(message):
    try:
        ensure_work_dirs()
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        with UI_LOG_PATH.open("a", encoding="utf-8") as fp:
            fp.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


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
    config.update(data if isinstance(data, dict) else {})
    if config.get("browser") not in BROWSERS:
        config["browser"] = "chrome"
    formats = [fmt for fmt in config.get("output_format", []) if fmt in dict(OUTPUT_FORMATS)]
    config["output_format"] = formats or ["csv", "json"]
    if not isinstance(config.get("create_time"), int):
        config["create_time"] = int(time.time())
    return config


def save_config(config):
    CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def format_time(timestamp):
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp))
    except Exception:
        return "-"


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

    terminals = [
        ["x-terminal-emulator", "-e", "bash", "-lc", command],
        ["gnome-terminal", "--", "bash", "-lc", command],
        ["konsole", "-e", "bash", "-lc", command],
        ["xterm", "-e", "bash", "-lc", command],
    ]
    for candidate in terminals:
        try:
            subprocess.Popen(candidate, cwd=str(BASE_DIR))
            return
        except FileNotFoundError:
            continue

    subprocess.Popen(command, cwd=str(BASE_DIR), shell=True)


def open_path(path):
    target = Path(path)
    target.mkdir(exist_ok=True)
    system = platform.system().lower()
    if system == "darwin":
        subprocess.Popen(["open", str(target)])
    elif system == "windows":
        os.startfile(str(target))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(target)])


class MarketSpiderApp(tk.Tk):
    def __init__(self):
        super().__init__()
        ensure_work_dirs()
        write_ui_log("ui process started")
        self.config_data = load_config()
        save_config(self.config_data)

        self.title("MarketSpider 控制台")
        self.geometry("980x680")
        self.minsize(900, 620)
        self.configure(bg="#edf4ef")
        write_ui_log("root configured")

        self.browser_var = tk.StringVar(value=self.config_data["browser"])
        self.output_vars = {
            fmt: tk.BooleanVar(value=fmt in self.config_data.get("output_format", []))
            for fmt, _label in OUTPUT_FORMATS
        }
        self.status_var = tk.StringVar(value="正在启动 MarketSpider 控制台...")
        self.config_var = tk.StringVar(value="加载中...")
        self.deps_var = tk.StringVar(value="加载中...")
        self.cookie_var = tk.StringVar(value="加载中...")

        try:
            self._configure_styles()
            write_ui_log("styles configured")
            self._build_layout()
            write_ui_log("layout built")
            self.after(50, self._force_initial_paint)
            self.after(120, self.refresh_status)
            write_ui_log("ui layout rendered")
        except Exception as error:
            write_ui_log(f"ui layout failed: {error}")
            self._show_error_screen(error)

    def _bring_to_front(self):
        try:
            self.lift()
            self.attributes("-topmost", True)
            self.focus_force()
            self.after(1500, lambda: self.attributes("-topmost", False))
        except tk.TclError:
            pass

    def _force_initial_paint(self):
        try:
            self.update_idletasks()
            self._bring_to_front()
            write_ui_log("initial paint forced")
        except tk.TclError as error:
            write_ui_log(f"initial paint failed: {error}")

    def _show_error_screen(self, error):
        for child in self.winfo_children():
            child.destroy()
        frame = tk.Frame(self, bg="#fff7ed")
        frame.pack(fill="both", expand=True)
        tk.Label(
            frame,
            text="MarketSpider UI 启动失败",
            bg="#fff7ed",
            fg="#9a3412",
            font=("Helvetica Neue", 24, "bold"),
        ).pack(pady=(120, 12))
        tk.Label(
            frame,
            text=str(error),
            bg="#fff7ed",
            fg="#7c2d12",
            font=("Helvetica Neue", 13),
            wraplength=760,
            justify="left",
        ).pack(padx=40)
        tk.Label(
            frame,
            text=f"详细日志: {UI_LOG_PATH}",
            bg="#fff7ed",
            fg="#9a3412",
            font=("Helvetica Neue", 11),
        ).pack(pady=(20, 0))

    def _configure_styles(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        style.configure("App.TFrame", background="#edf4ef")
        style.configure("Panel.TFrame", background="#ffffff")
        style.configure("Hero.TFrame", background="#14372d")
        style.configure("Title.TLabel", background="#14372d", foreground="#fff8df", font=("Avenir Next", 26, "bold"))
        style.configure("HeroSub.TLabel", background="#14372d", foreground="#cde7d8", font=("Avenir Next", 12))
        style.configure("PanelTitle.TLabel", background="#ffffff", foreground="#15352d", font=("Avenir Next", 16, "bold"))
        style.configure("Text.TLabel", background="#ffffff", foreground="#2b3c39", font=("Avenir Next", 12))
        style.configure("Muted.TLabel", background="#ffffff", foreground="#6d7f78", font=("Avenir Next", 10))
        style.configure("Status.TLabel", background="#eef7f1", foreground="#22443b", font=("Avenir Next", 11, "bold"))
        style.configure("Primary.TButton", font=("Avenir Next", 12, "bold"), padding=(14, 10))
        style.configure("Soft.TButton", font=("Avenir Next", 11, "bold"), padding=(12, 8))
        style.configure("Danger.TButton", font=("Avenir Next", 11, "bold"), padding=(12, 8))
        style.configure("TCheckbutton", background="#ffffff", foreground="#263c36", font=("Avenir Next", 11))
        style.configure("TRadiobutton", background="#ffffff", foreground="#263c36", font=("Avenir Next", 11))

    def _panel(self, parent, row, column, **grid):
        frame = ttk.Frame(parent, style="Panel.TFrame", padding=18)
        frame.grid(row=row, column=column, sticky="nsew", padx=10, pady=10, **grid)
        return frame

    def _build_layout(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        hero = ttk.Frame(self, style="Hero.TFrame", padding=(28, 24))
        hero.grid(row=0, column=0, sticky="ew")
        hero.columnconfigure(0, weight=1)

        ttk.Label(hero, text="MarketSpider 控制台", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(
            hero,
            text="配置浏览器、修复依赖、获取 Cookie、启动各平台爬虫。双击启动器即可打开这个界面。",
            style="HeroSub.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(8, 0))

        main = ttk.Frame(self, style="App.TFrame", padding=14)
        main.grid(row=1, column=0, sticky="nsew")
        main.columnconfigure(0, weight=1)
        main.columnconfigure(1, weight=1)
        main.rowconfigure(1, weight=1)

        config_panel = self._panel(main, 0, 0)
        run_panel = self._panel(main, 0, 1)
        status_panel = self._panel(main, 1, 0, columnspan=2)
        status_panel.columnconfigure(0, weight=1)

        self._build_config_panel(config_panel)
        self._build_run_panel(run_panel)
        self._build_status_panel(status_panel)

        footer = ttk.Label(
            self,
            textvariable=self.status_var,
            style="Status.TLabel",
            anchor="w",
            padding=(18, 10),
        )
        footer.grid(row=2, column=0, sticky="ew")

    def _build_config_panel(self, parent):
        ttk.Label(parent, text="运行配置", style="PanelTitle.TLabel").pack(anchor="w")
        ttk.Label(parent, text="保存后会写入 config.json，爬虫脚本会直接读取。", style="Muted.TLabel").pack(anchor="w", pady=(4, 14))

        browser_box = ttk.Frame(parent, style="Panel.TFrame")
        browser_box.pack(fill="x", pady=(0, 14))
        ttk.Label(browser_box, text="浏览器", style="Text.TLabel").pack(anchor="w")
        for value, label in BROWSERS.items():
            ttk.Radiobutton(browser_box, text=label, value=value, variable=self.browser_var).pack(side="left", padx=(0, 18), pady=(8, 0))

        output_box = ttk.Frame(parent, style="Panel.TFrame")
        output_box.pack(fill="x", pady=(0, 16))
        ttk.Label(output_box, text="默认输出格式", style="Text.TLabel").pack(anchor="w")
        checks = ttk.Frame(output_box, style="Panel.TFrame")
        checks.pack(fill="x", pady=(8, 0))
        for fmt, label in OUTPUT_FORMATS:
            ttk.Checkbutton(checks, text=label, variable=self.output_vars[fmt]).pack(side="left", padx=(0, 14))

        ttk.Button(parent, text="保存配置", style="Primary.TButton", command=self.save_current_config).pack(fill="x", pady=(0, 10))
        ttk.Button(parent, text="检查状态", style="Soft.TButton", command=self.refresh_status).pack(fill="x")

    def _build_run_panel(self, parent):
        ttk.Label(parent, text="启动功能", style="PanelTitle.TLabel").pack(anchor="w")
        ttk.Label(parent, text="脚本会在新终端窗口启动，保留原有输入和弹窗流程。", style="Muted.TLabel").pack(anchor="w", pady=(4, 14))

        for script, title, description in SCRIPT_ACTIONS:
            row = ttk.Frame(parent, style="Panel.TFrame")
            row.pack(fill="x", pady=5)
            text_box = ttk.Frame(row, style="Panel.TFrame")
            text_box.pack(side="left", fill="x", expand=True)
            ttk.Label(text_box, text=title, style="Text.TLabel").pack(anchor="w")
            ttk.Label(text_box, text=description, style="Muted.TLabel").pack(anchor="w")
            ttk.Button(row, text="启动", style="Soft.TButton", command=lambda s=script: self.launch_script(s)).pack(side="right", padx=(10, 0))

    def _build_status_panel(self, parent):
        ttk.Label(parent, text="状态与工具", style="PanelTitle.TLabel").grid(row=0, column=0, sticky="w")

        cards = ttk.Frame(parent, style="Panel.TFrame")
        cards.grid(row=1, column=0, sticky="ew", pady=(12, 8))
        cards.columnconfigure(0, weight=1)
        cards.columnconfigure(1, weight=1)
        cards.columnconfigure(2, weight=1)

        self._status_card(cards, 0, "配置文件", self.config_var)
        self._status_card(cards, 1, "运行依赖", self.deps_var)
        self._status_card(cards, 2, "Cookie", self.cookie_var)

        tools = ttk.Frame(parent, style="Panel.TFrame")
        tools.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        tools.columnconfigure((0, 1, 2, 3), weight=1)

        ttk.Button(tools, text="安装/修复依赖", style="Primary.TButton", command=self.install_requirements).grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ttk.Button(tools, text="打开结果目录", style="Soft.TButton", command=lambda: open_path(BASE_DIR / "result")).grid(row=0, column=1, sticky="ew", padx=8)
        ttk.Button(tools, text="打开 Cookie 目录", style="Soft.TButton", command=lambda: open_path(BASE_DIR / "cookie")).grid(row=0, column=2, sticky="ew", padx=8)
        ttk.Button(tools, text="打开日志目录", style="Soft.TButton", command=lambda: open_path(BASE_DIR / "logs")).grid(row=0, column=3, sticky="ew", padx=(8, 0))

        self.log_box = tk.Text(parent, height=8, bg="#10231e", fg="#dbf7e4", insertbackground="#dbf7e4", relief="flat", padx=12, pady=10)
        self.log_box.grid(row=3, column=0, sticky="nsew", pady=(16, 0))
        parent.rowconfigure(3, weight=1)

    def _status_card(self, parent, column, title, var):
        frame = ttk.Frame(parent, style="Panel.TFrame", padding=12)
        frame.grid(row=0, column=column, sticky="nsew", padx=6)
        ttk.Label(frame, text=title, style="Muted.TLabel").pack(anchor="w")
        ttk.Label(frame, textvariable=var, style="Text.TLabel", wraplength=240).pack(anchor="w", pady=(6, 0))

    def save_current_config(self):
        output_format = [fmt for fmt, var in self.output_vars.items() if var.get()]
        if not output_format:
            messagebox.showwarning("配置未保存", "请至少选择一种输出格式。")
            return

        self.config_data = {
            "browser": self.browser_var.get(),
            "output_format": output_format,
            "create_time": self.config_data.get("create_time", int(time.time())),
        }
        save_config(self.config_data)
        self.log("配置已保存到 config.json")
        self.refresh_status()

    def check_missing_modules(self):
        missing = []
        for module_name, display_name in REQUIRED_MODULES:
            if importlib.util.find_spec(module_name) is None:
                missing.append(display_name)
        return missing

    def cookie_files(self):
        cookie_dir = BASE_DIR / "cookie"
        files = []
        if not cookie_dir.exists():
            cookie_dir.mkdir(exist_ok=True)
        files.extend([item for item in cookie_dir.iterdir() if item.is_file()])
        files.extend(
            [
                item
                for item in BASE_DIR.iterdir()
                if item.is_file() and item.name.startswith("cookie\\")
            ]
        )
        return sorted(
            files,
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )

    def refresh_status(self):
        config = load_config()
        browser_label = BROWSERS.get(config.get("browser"), config.get("browser", "-"))
        output_text = ", ".join(config.get("output_format", []))
        self.config_var.set(f"{browser_label}\n{output_text}\n{format_time(config.get('create_time'))}")

        missing = self.check_missing_modules()
        self.deps_var.set("已安装" if not missing else "缺少: " + ", ".join(missing))

        cookies = self.cookie_files()
        if cookies:
            recent = cookies[0]
            self.cookie_var.set(f"{len(cookies)} 个文件\n最新: {recent.name}")
        else:
            self.cookie_var.set("未找到 Cookie\n建议先点击获取 Cookie")

        self.status_var.set(f"项目目录: {BASE_DIR}")
        self.log("状态已刷新")

    def launch_script(self, script_name):
        script_path = BASE_DIR / script_name
        if not script_path.exists():
            messagebox.showerror("无法启动", f"未找到脚本: {script_name}")
            return

        self.save_current_config()
        command = " && ".join(
            [
                f"cd {shlex.quote(str(BASE_DIR))}",
                f"{shlex.quote(PYTHON)} {shlex.quote(str(script_path))}",
                'echo ""',
                'echo "MarketSpider 任务窗口可在确认完成后关闭。"',
            ]
        )
        terminal_command(command, title=f"MarketSpider - {script_name}")
        self.log(f"已启动 {script_name}")

    def install_requirements(self):
        if not REQUIREMENTS_PATH.exists():
            messagebox.showerror("无法安装", "未找到 requirements.txt")
            return

        command = " && ".join(
            [
                f"cd {shlex.quote(str(BASE_DIR))}",
                f"{shlex.quote(PYTHON)} -m pip install -r {shlex.quote(str(REQUIREMENTS_PATH))}",
                'echo ""',
                'echo "依赖安装完成后可回到 UI 点击检查状态。"',
            ]
        )
        terminal_command(command, title="MarketSpider - Install Requirements")
        self.log("已打开依赖安装窗口")

    def log(self, message):
        timestamp = time.strftime("%H:%M:%S", time.localtime())
        self.log_box.insert("end", f"[{timestamp}] {message}\n")
        self.log_box.see("end")


if __name__ == "__main__":
    app = MarketSpiderApp()
    app.mainloop()
