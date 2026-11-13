#!/usr/bin/env python3
"""把 models/ 的 ONNX 模型和 manifest 複製到 web/models/。

models/ 是正本；但 Vercel 的根目錄是 web/，網站讀不到上一層，所以要多放一份。
（Git 對內容相同的檔案只存一份，repo 不會因此變大。）

    python tools/sync_models.py           # 複製
    python tools/sync_models.py --check   # 只檢查兩邊是否一致（測試會跑這個）

只用標準函式庫。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "models"
DST = ROOT / "web" / "models"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def wanted_files() -> list[str]:
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    return ["manifest.json"] + [m["file"] for m in manifest.get("models", [])]


def check() -> list[str]:
    """回傳問題清單；空的代表一致。"""
    problems: list[str] = []
    if not (SRC / "manifest.json").exists():
        return ["models/manifest.json 不存在"]
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    ids = [m["id"] for m in manifest.get("models", [])]
    if len(set(ids)) != len(ids):
        problems.append("manifest 裡有重複的模型 id")
    if manifest.get("default") not in ids:
        problems.append(f"manifest 的 default「{manifest.get('default')}」不在模型清單裡")
    for m in manifest.get("models", []):
        f = SRC / m["file"]
        if not f.exists():
            problems.append(f"models/{m['file']} 不存在")
            continue
        if m.get("sha256") and sha256(f) != m["sha256"]:
            problems.append(f"models/{m['file']} 的內容和 manifest 記錄的雜湊不符")
        if m.get("bytes") and f.stat().st_size != m["bytes"]:
            problems.append(f"models/{m['file']} 的大小和 manifest 記錄的不符")
    names = wanted_files()
    for name in names:
        a, b = SRC / name, DST / name
        if not a.exists():
            continue
        if not b.exists():
            problems.append(f"web/models/{name} 不存在")
        elif sha256(a) != sha256(b):
            problems.append(f"web/models/{name} 和 models/{name} 不一樣")
    if DST.exists():
        for extra in sorted(p.name for p in DST.iterdir() if p.is_file() and p.name not in names and p.name != "README.md"):
            problems.append(f"web/models/{extra} 是多出來的檔案")
    return problems


def sync() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    names = wanted_files()
    for name in names:
        shutil.copyfile(SRC / name, DST / name)
    for p in DST.iterdir():
        if p.is_file() and p.name not in names and p.name != "README.md":
            p.unlink()
    print(f"已同步 {len(names)} 個檔案到 web/models/")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="把 models/ 同步到 web/models/")
    ap.add_argument("--check", action="store_true", help="只檢查，不複製")
    args = ap.parse_args()
    if not args.check:
        sync()
    problems = check()
    if problems:
        print("[X] models/ 和 web/models/ 不一致：")
        for p in problems:
            print("  - " + p)
        print("請執行 python tools/sync_models.py")
        return 1
    print("[OK] models/ 和 web/models/ 一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
