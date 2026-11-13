#!/usr/bin/env python3
"""提交前檢查暫存區：這是公開 repo，實拍影片、抽出的畫面、含人像的檔案、金鑰都不可以提交。

用法（在 repo 根目錄）：

    python tools/check_staged.py          # 檢查 git add 之後的暫存區
    python tools/check_staged.py --all    # 檢查所有已追蹤的檔案

有問題時會列出檔案並以非 0 結束。只用標準函式庫。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp", ".mts"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".bmp", ".gif", ".webp", ".tif", ".tiff"}
WEIGHT_EXT = {".pt", ".pth", ".engine", ".torchscript", ".safetensors"}

# 合成測試影片（每一幀畫著幀號條碼，沒有任何實拍內容）只准放這裡，而且要很小
SYNTH_VIDEO_DIR = "tests/fixtures/video/"
SYNTH_VIDEO_MAX = 400 * 1024

# 圖片只准放這些地方（合成示意圖、網站圖示）
IMAGE_ALLOWED = ("web/img/", "docs/img/", "tests/fixtures/img/")

FORBIDDEN_DIRS = ("data/", "runs/", "datasets/", "weights/", ".venv/", "node_modules/")
MAX_BYTES = 50 * 1024 * 1024

SECRET_PATTERNS = [
    # api_key="xxxxxxxxxxxxxxxx" 這種寫死的金鑰（佔位字串不算）
    re.compile(r"""api[_-]?key\s*[=:]\s*["']([A-Za-z0-9_\-]{16,})["']""", re.I),
    re.compile(r"""ROBOFLOW_API_KEY\s*=\s*["']?([A-Za-z0-9]{16,})"""),
    re.compile(r"""\bgh[pousr]_[A-Za-z0-9]{30,}"""),
]
PLACEHOLDER = re.compile(r"your|xxxx|placeholder|example|<|\{", re.I)


def git(*args: str) -> str:
    out = subprocess.run(["git", *args], capture_output=True, check=True)
    return out.stdout.decode("utf-8", "replace")


def ext_of(path: str) -> str:
    dot = path.rfind(".")
    return path[dot:].lower() if dot >= 0 else ""


def main() -> int:
    # Windows 主控台或管線的編碼不一定印得出中文，印不出來時用 ? 代替而不是當掉
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--all", action="store_true", help="檢查所有已追蹤的檔案，而不是只看暫存區")
    args = ap.parse_args()

    if args.all:
        listing = git("-c", "core.quotepath=off", "ls-files", "-z")
    else:
        listing = git("-c", "core.quotepath=off", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    files = [f for f in listing.split("\0") if f]
    problems: list[str] = []

    for f in files:
        ext = ext_of(f)
        spec = f":{f}" if not args.all else f"HEAD:{f}"
        try:
            size = int(git("cat-file", "-s", spec).strip())
        except (subprocess.CalledProcessError, ValueError):
            size = 0

        if f.startswith(FORBIDDEN_DIRS):
            problems.append(f"{f}：這個目錄不應該進版控")
            continue
        if ext in VIDEO_EXT:
            if not f.startswith(SYNTH_VIDEO_DIR):
                problems.append(f"{f}：影片檔不可以提交（只有 {SYNTH_VIDEO_DIR} 的合成測試影片例外）")
            elif size > SYNTH_VIDEO_MAX:
                problems.append(f"{f}：合成測試影片太大（{size // 1024} KB），請確認不是實拍影片")
            continue
        if ext in IMAGE_EXT and not f.startswith(IMAGE_ALLOWED):
            problems.append(f"{f}：圖片只能放在 {', '.join(IMAGE_ALLOWED)}，而且不可以含真人")
            continue
        if ext in WEIGHT_EXT:
            problems.append(f"{f}：PyTorch 權重不提交，請只提交匯出的 ONNX")
            continue
        if size > MAX_BYTES:
            problems.append(f"{f}：檔案 {size / 1e6:.0f} MB，超過 50 MB")
            continue

        # 文字檔才掃金鑰
        if ext in {".py", ".js", ".mjs", ".json", ".md", ".ipynb", ".txt", ".yaml", ".yml", ".html", ".toml", ".cfg", ".ini", ".ps1", ".sh"} and size < 5_000_000:
            if f.startswith("web/vendor/"):
                continue
            try:
                text = git("cat-file", "-p", spec)
            except subprocess.CalledProcessError:
                continue
            for pat in SECRET_PATTERNS:
                for m in pat.finditer(text):
                    token = m.group(1) if m.groups() else m.group(0)
                    if PLACEHOLDER.search(token):
                        continue
                    problems.append(f"{f}：看起來有寫死的金鑰（{token[:4]}…）")
                    break

    scope = "已追蹤的檔案" if args.all else "暫存區"
    if problems:
        print(f"[X] {scope}有 {len(problems)} 個問題：")
        for p in problems:
            print("  - " + p)
        return 1
    print(f"[OK] {scope}共 {len(files)} 個檔案，沒有影片、不該出現的圖片、權重或金鑰。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
