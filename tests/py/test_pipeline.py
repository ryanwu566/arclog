"""訓練和評估的指令工具，用小的合成影片從頭到尾跑一次（不含訓練本身）：

    make_synth → build_dataset → check_overlay（和真值比對）→ evaluate（階段 A 模型）→ analyze（--grid、錯誤訊息）

合成畫面是用網站示範模式的同一份繪圖程式（經由 Node）產生的，所以需要 Node 和 `npm install`；沒有的話這個測試會跳過。
這裡只確認「工具接得起來、數字合理」；合成資料上的結果不代表真實準確度。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def run(*args: str, expect: int | None = 0) -> str:
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    proc = subprocess.run([sys.executable, *args], cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = proc.stdout + proc.stderr
    if expect is not None:
        assert proc.returncode == expect, f"{' '.join(args)} 回傳 {proc.returncode}（預期 {expect}）：\n{out}"
    return out


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> Path:
    if shutil.which("node") is None or not (ROOT / "node_modules" / "@napi-rs" / "canvas").exists():
        pytest.skip("需要 Node 和 npm install 才能產生合成影片")
    out = tmp_path_factory.mktemp("synth")
    run("training/make_synth.py", "--out", str(out), "--videos", "2", "--shots", "3", "--small", "--seed", "5")
    return out


def test_make_synth_outputs(synth: Path):
    index = json.loads((synth / "index.json").read_text(encoding="utf-8"))
    assert index["synthetic"] is True and len(index["videos"]) == 2
    for v in index["videos"]:
        for key in ("video", "bundle", "truth"):
            assert (synth / v[key]).exists(), v[key]
        truth = json.loads((synth / v["truth"]).read_text(encoding="utf-8"))
        bundle = json.loads((synth / v["bundle"]).read_text(encoding="utf-8"))
        assert bundle["synthetic"] is True and len(bundle["shots"]) == len(truth["shots"]) == 3
        assert len(bundle["frameTimes"]) == truth["frameCount"]


def test_build_dataset_splits_by_video_and_matches_truth(synth: Path, tmp_path: Path):
    ds = tmp_path / "dataset"
    out = run("training/build_dataset.py", "--pairs", str(synth), "--out", str(ds))
    assert "幀號直接對應" in out
    assert "合成資料" in out
    manifest = json.loads((ds / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["synthetic"] is True and manifest["splitBy"] == "video"
    # 同一支影片的畫面只會在一組
    seen: dict[str, set[str]] = {}
    for im in manifest["images"]:
        seen.setdefault(im["video"], set()).add(im["split"])
        assert (ds / "images" / im["file"]).exists()
        label = (ds / "labels" / im["file"]).with_suffix(".txt").read_text(encoding="utf-8").split()
        assert len(label) == 5 * im["boxes"]
    assert len(seen) == 2 and all(len(s) == 1 for s in seen.values())
    assert {next(iter(s)) for s in seen.values()} == {"train", "val"}  # 兩支影片：一支訓練、一支驗證
    assert "只有 2 支影片" in out
    positives = sum(1 for im in manifest["images"] if im["boxes"])
    negatives = sum(1 for im in manifest["images"] if not im["boxes"])
    assert positives >= 100 and 0 < negatives <= positives * 0.31
    yaml = (ds / "data.yaml").read_text(encoding="utf-8")
    assert "0: basketball" in yaml and "train: images/train" in yaml and "val: images/val" in yaml

    # 疊圖檢查：標註和真值的球心平均差不到 3 像素；負樣本確實沒有球
    out = run("training/check_overlay.py", "--dataset", str(ds), "--truth", str(synth), "--max-error", "3")
    assert "每一張都確實沒有球" in out
    assert (ds / "overlay_check.jpg").exists() and (ds / "overlay_negatives.jpg").exists()

    # 已經有東西的資料夾不會被默默蓋掉
    assert "已經有東西" in run("training/build_dataset.py", "--pairs", str(synth), "--out", str(ds), expect=1)


def test_build_dataset_rejects_wrong_video(synth: Path, tmp_path: Path):
    """標註包配到別支影片（幀數不同）：要擋下來，不能產生錯位的訓練資料。"""
    index = json.loads((synth / "index.json").read_text(encoding="utf-8"))
    a, b = index["videos"]
    bundle = json.loads((synth / a["bundle"]).read_text(encoding="utf-8"))
    other_frames = len(json.loads((synth / b["bundle"]).read_text(encoding="utf-8"))["frameTimes"])
    # 把標註包改成「標註時看到的幀數少很多」，模擬標註時用的是另一個檔案
    bundle["frameTimes"] = bundle["frameTimes"][: max(10, other_frames // 2)]
    for shot in bundle["shots"]:
        shot["frames"] = [f for f in shot["frames"] if f["f"] < len(bundle["frameTimes"])] or shot["frames"][:1]
    bundle["shots"] = [s for s in bundle["shots"] if s["frames"][0]["f"] < len(bundle["frameTimes"])]
    bundle["noBall"] = []
    wrong = tmp_path / "wrong.arclog.json"
    wrong.write_text(json.dumps(bundle), encoding="utf-8")
    out = run("training/build_dataset.py", "--pair", str(synth / a["video"]), str(wrong), "--out", str(tmp_path / "ds"), expect=1)
    assert "幀數不同" in out and "略過" in out


def test_evaluate_stage_a_on_synthetic(synth: Path, tmp_path: Path):
    out_dir = tmp_path / "eval"
    doc = tmp_path / "EVAL.md"
    doc.write_text("# x\n<!-- EVAL:REAL:BEGIN -->\n舊\n<!-- EVAL:REAL:END -->\n<!-- EVAL:SYNTH:BEGIN -->\n舊\n<!-- EVAL:SYNTH:END -->\n", encoding="utf-8")
    out = run("training/evaluate.py", "--pairs", str(synth), "--truth", str(synth), "--section", "synthetic",
              "--models", "arclog-ball-a-coco", "--out", str(out_dir), "--write-doc", str(doc))
    result = json.loads((out_dir / "eval_synthetic.json").read_text(encoding="utf-8"))["arclog-ball-a-coco"]["total"]
    assert result["videos"] == 2 and result["manualShots"] == 6
    assert result["recall"] > 0.5, out
    assert result["matched"] >= 4, out
    assert result["extra"] == 0, out
    assert result["angleMae"] < 1.0 and result["truthMae"] < 1.0, out
    text = doc.read_text(encoding="utf-8")
    assert "arclog-ball-a-coco" in text and "對真值的 MAE" in text
    assert "<!-- EVAL:REAL:BEGIN -->\n舊\n<!-- EVAL:REAL:END -->" in text  # 只改指定的那一段

    # 合成影片不能寫進「實拍」的表
    out = run("training/evaluate.py", "--pairs", str(synth), "--models", "arclog-ball-a-coco", "--out", str(out_dir), expect=1)
    assert "合成資料" in out


def test_evaluate_without_data_writes_pending(tmp_path: Path):
    doc = tmp_path / "EVAL.md"
    doc.write_text("<!-- EVAL:REAL:BEGIN -->\n<!-- EVAL:REAL:END -->\n", encoding="utf-8")
    run("training/evaluate.py", "--write-doc", str(doc))
    text = doc.read_text(encoding="utf-8")
    rows = [line for line in text.splitlines() if line.startswith("| 階段")]
    assert len(rows) == 3
    for row in rows:
        cells = [c.strip() for c in row.strip("|").split("|")]
        assert cells[1:] == ["待實測"] * 8, row


def test_analyze_grid_and_errors(synth: Path, tmp_path: Path):
    video = next(synth.glob("*.mp4"))
    out = run("tools/analyze.py", str(video), "--grid", "--out", str(tmp_path))
    assert (tmp_path / f"{video.stem}.grid.png").exists(), out
    assert "需要 --hoop" in run("tools/analyze.py", str(video), "--out", str(tmp_path), expect=1)
    assert "格式" in run("tools/analyze.py", str(video), "--hoop", "1,2,3", "--out", str(tmp_path), expect=1)
    assert "找不到影片" in run("tools/analyze.py", str(tmp_path / "nope.mp4"), "--hoop", "1,2,3,4", expect=1)
    assert "太接近" in run("tools/analyze.py", str(video), "--hoop", "5,5,5,5", "--out", str(tmp_path), expect=1)
