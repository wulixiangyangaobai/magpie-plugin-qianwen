# /// script
# requires-python = ">=3.11"
# dependencies = ["browser-cookie3==0.20.1"]
# ///
"""读取千问 App (Qianwen.app / com.alibaba.tongyi) 桌面登录态。

输出 JSON 到 stdout，仅供父进程读取；不记录任何凭据值。
"""
import json
import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path

if sys.platform != "darwin":
    raise RuntimeError("千问桌面登录导入目前仅支持 macOS；需要安装并登录千问 App。")

root = Path.home() / "Library/Application Support/Qianwen"
profile = "Default"
cookie_file = root / profile / "Cookies"
if not cookie_file.is_file():
    raise FileNotFoundError("千问 App 配置中没有 Cookies 文件，请先打开客户端并登录。")

# 提前探测钥匙串项目，避免解密库在凭据缺失时用默认密码。
service = "Qianwen Safe Storage"
user = "Qianwen"
probe = subprocess.run(
    ["/usr/bin/security", "-q", "find-generic-password", "-a", user, "-s", service],
    capture_output=True, timeout=20,
)
if probe.returncode != 0:
    raise RuntimeError("钥匙串中找不到 Qianwen Safe Storage 项目，请确认千问 App 已登录。")
key = subprocess.run(
    ["/usr/bin/security", "-q", "find-generic-password", "-w", "-a", user, "-s", service],
    capture_output=True, check=True, timeout=20,
)
if not key.stdout.strip():
    raise RuntimeError("Qianwen Safe Storage 没有可用密码。")
del key

import browser_cookie3
jar = browser_cookie3.ChromiumBased(
    browser="Qianwen", cookie_file=str(cookie_file), domain_name="qianwen.com",
    osx_key_service=service, osx_key_user=user,
).load()
cookies = [
    {"name": c.name, "value": c.value, "domain": c.domain.lstrip("."), "path": c.path,
     "secure": c.secure, "expires": c.expires}
    for c in jar if c.domain.lstrip(".") == "qianwen.com" or c.domain.endswith(".qianwen.com")
]
if not any(c["name"] == "tongyi_sso_ticket" and c["value"] for c in cookies):
    raise RuntimeError("千问 App 当前配置没有登录会话，请在客户端登录后重试。")

client_version = ""
app_info = Path("/Applications/Qianwen.app/Contents/Info.plist")
if app_info.is_file():
    with app_info.open("rb") as f:
        client_version = plistlib.load(f).get("CFBundleShortVersionString", "")

print(json.dumps({"profile": profile, "cookies": cookies, "clientVersion": client_version}))
