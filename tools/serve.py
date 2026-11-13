#!/usr/bin/env python3
"""本機預覽用的靜態伺服器：把 web/ 當成網站根目錄。

    python tools/serve.py                 # http://127.0.0.1:8000
    python tools/serve.py --port 9000
    python tools/serve.py --no-isolation  # 不送 COOP/COEP 標頭（測試單執行緒 WASM 的退回路徑）

為什麼不直接用 `python -m http.server`：
  - Windows 上它常把 .js / .mjs 的類型回成 text/plain，瀏覽器會拒絕載入 ES module。
  - 多執行緒 WASM 需要 COOP/COEP 兩個標頭（和 web/vercel.json 送的一樣）。

只用標準函式庫。手機要測請用部署到 Vercel 的 HTTPS 網址：
區域網路的 http:// 位址不是安全環境，瀏覽器會停用 WebCodecs、WebGPU 和多執行緒。
"""
from __future__ import annotations

import argparse
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}


class Handler(SimpleHTTPRequestHandler):
    isolation = True
    quiet = False

    def guess_type(self, path):
        ext = Path(str(path)).suffix.lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        if self.isolation:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.quiet:
            super().log_message(fmt, *args)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="ArcLog 本機預覽伺服器")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--dir", default=str(ROOT / "web"), help="要當成網站根目錄的資料夾（預設 web/）")
    ap.add_argument("--no-isolation", action="store_true", help="不送 COOP/COEP 標頭")
    ap.add_argument("--quiet", action="store_true", help="不印每一筆請求")
    args = ap.parse_args()

    Handler.isolation = not args.no_isolation
    Handler.quiet = args.quiet
    handler = partial(Handler, directory=args.dir)
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as err:
        print(f"[X] 無法使用連接埠 {args.port}：{err}。請換一個，例如 --port {args.port + 1}")
        return 1
    print(f"ArcLog 預覽：http://{args.host}:{args.port}/   （Ctrl+C 結束）", flush=True)
    if not Handler.isolation:
        print("（已關閉 COOP/COEP：WASM 只會用單執行緒）", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已結束")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
