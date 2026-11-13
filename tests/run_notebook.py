#!/usr/bin/env python3
"""在本機把 Colab notebook 從頭到尾執行一次，確認每一格都跑得過。

    python tests/run_notebook.py                 # synthetic 模式（預設；CPU 大約十分鐘）
    python tests/run_notebook.py --epochs 1      # 更快：只訓練一輪

執行後的 notebook（含每一格的輸出）存到 data/scratch/arclog_train.executed.ipynb，不會動到 training/ 裡的原檔。
階段 B 需要 Roboflow 金鑰和輸入欄位，沒辦法這樣自動跑；階段 C 需要實拍影片。
需要 requirements-dev.txt 和 training/requirements.txt 裡的套件，以及 Node（產生合成影片用）。
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="在本機執行 training/arclog_train.ipynb")
    ap.add_argument("--stage", default="synthetic", choices=["synthetic", "C"], help="synthetic（預設）或 C（需要 --data-dir）")
    ap.add_argument("--epochs", type=int, default=None)
    ap.add_argument("--data-dir", default=None, help="階段 C：放 videos/ 的資料夾")
    args = ap.parse_args()

    import nbformat
    from nbclient import NotebookClient
    from nbclient.exceptions import CellExecutionError

    os.environ["ARCLOG_STAGE"] = args.stage
    if args.epochs:
        os.environ["ARCLOG_EPOCHS"] = str(args.epochs)
    if args.data_dir:
        os.environ["ARCLOG_DATA_DIR"] = args.data_dir
    os.environ.setdefault("PYTHONUTF8", "1")

    nb = nbformat.read(ROOT / "training" / "arclog_train.ipynb", as_version=4)
    out = ROOT / "data" / "scratch" / "arclog_train.executed.ipynb"
    out.parent.mkdir(parents=True, exist_ok=True)
    client = NotebookClient(nb, timeout=6 * 3600, kernel_name="python3", resources={"metadata": {"path": str(ROOT / "training")}})
    t0 = time.time()
    code = 0
    try:
        client.execute()
    except CellExecutionError as err:
        print("[X] 有一格執行失敗：")
        print(str(err)[-3000:])
        code = 1
    nbformat.write(nb, out)
    ran = sum(1 for c in nb.cells if c.cell_type == "code" and c.get("execution_count"))
    total = sum(1 for c in nb.cells if c.cell_type == "code")
    print(f"執行了 {ran}/{total} 格，用了 {(time.time() - t0) / 60:.1f} 分鐘；結果存到 {out}")
    if code == 0:
        # 印出每一格輸出的最後幾行，方便確認
        for i, c in enumerate(nb.cells):
            if c.cell_type != "code":
                continue
            text = "".join(o.get("text", "") for o in c.get("outputs", []) if o.get("output_type") == "stream")
            tail = [line for line in text.strip().splitlines() if line.strip()][-2:]
            print(f"  第 {i:2d} 格：" + (" ｜ ".join(t[:110] for t in tail) if tail else "（沒有文字輸出）"))
        print("[OK] notebook 從頭到尾執行成功")
    return code


if __name__ == "__main__":
    sys.exit(main())
