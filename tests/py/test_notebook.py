"""Colab notebook 的靜態檢查：格式正確、每一格程式前面都有中文說明、沒有殘留的輸出或金鑰。

實際執行（在本機用 synthetic 模式從頭跑到尾）比較久，不放在這裡；做法寫在檔案最後。
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

nbformat = pytest.importorskip("nbformat")

ROOT = Path(__file__).resolve().parents[2]
NB = ROOT / "training" / "arclog_train.ipynb"


@pytest.fixture(scope="module")
def nb():
    return nbformat.read(NB, as_version=4)


def test_notebook_is_valid(nb):
    nbformat.validate(nb)
    assert nb.metadata.get("accelerator") == "GPU"


def test_every_code_cell_has_a_chinese_explanation_before_it(nb):
    cells = nb.cells
    assert cells[0].cell_type == "markdown"
    code_cells = 0
    for i, cell in enumerate(cells):
        if cell.cell_type != "code":
            continue
        code_cells += 1
        prev = cells[i - 1]
        assert prev.cell_type == "markdown", f"第 {i} 格程式前面沒有說明"
        chinese = re.findall(r"[一-鿿]", prev.source)
        assert len(chinese) >= 40, f"第 {i} 格程式前面的說明太短：{prev.source[:40]!r}"
    assert code_cells >= 10


def test_code_cells_parse_and_have_no_outputs(nb):
    for i, cell in enumerate(nb.cells):
        if cell.cell_type != "code":
            continue
        assert cell.get("outputs", []) == [], f"第 {i} 格留著執行結果（提交前要清掉）"
        assert cell.get("execution_count") is None
        ast.parse(cell.source)  # 語法正確（這份 notebook 不用 ! 和 % 開頭的指令）


def test_covers_the_whole_flow_in_order(nb):
    code = "\n".join(c.source for c in nb.cells if c.cell_type == "code")
    steps = ["pip", "prepare_public.py", "build_dataset.py", "check_overlay.py", "train.py", "export_onnx.py", "evaluate.py", "files.download"]
    positions = [code.find(s) for s in steps]
    assert all(p >= 0 for p in positions), dict(zip(steps, positions))
    assert positions[4:] == sorted(positions[4:]), "訓練 → 匯出 → 評估 → 下載 的順序不對"
    for stage in ('"B"', '"C"', '"synthetic"'):
        assert f"STAGE == {stage}" in code


def test_api_key_is_read_from_an_input_field_and_never_stored(nb):
    code = "\n".join(c.source for c in nb.cells if c.cell_type == "code")
    assert "getpass(" in code, "金鑰要用輸入欄位讀取"
    assert "del api_key" in code
    raw = NB.read_text(encoding="utf-8")
    # 不可以把金鑰寫死在 notebook 裡
    assert not re.search(r"api_key\s*=\s*[\"'][A-Za-z0-9]{12,}[\"']", raw)
    assert "ROBOFLOW_API_KEY=" not in raw
    json.loads(raw)


# 在本機完整執行一次（synthetic 模式，CPU 大約十分鐘）：
#
#   python tests/run_notebook.py


def test_three_class_stage(nb):
    code = "\n".join(c.source for c in nb.cells if c.cell_type == "code")
    assert 'STAGE == "B3"' in code
    i_prep = code.find('"--classes", "ball,rim,backboard"')
    i_pseudo = code.find("training/pseudo_label.py")
    assert 0 <= i_prep < i_pseudo, "先轉成三類別、再補標"
    # 兩個要下載資料的階段都用輸入欄位讀金鑰，用完都刪掉
    assert code.count("getpass(") >= 2 and code.count("del api_key") >= 2
    assert "--rim-box" in code and "ALLOW_LICENSE" in code
