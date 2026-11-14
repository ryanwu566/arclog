"""CSV 匯出與匯入。格式固定三欄：球序, 入框角度, 是否進球。對應 web/js/core/csv.js。"""
from __future__ import annotations

import math
import re

CSV_HEADER = ["球序", "入框角度", "是否進球"]

_YES = {"是", "1", "true", "y", "yes", "進", "進球", "有進", "made", "make", "o", "○", "✓"}
_NO = {"否", "0", "false", "n", "no", "沒進", "未進", "不進", "miss", "missed", "x", "✕", "×"}

_QUOTE = '"'


def shots_to_csv(shots: list[dict]) -> str:
    """shots：[{'angle','made'}]。回傳 CSV 文字（不含 BOM）。"""
    lines = [",".join(CSV_HEADER)]
    for i, s in enumerate(shots):
        # 角度本來就記到小數一位；這裡的進位方式和 constants.round_angle 相同
        made = "是" if s["made"] else "否"
        # 鏡頭角度太偏時（自動模式的 C 級）沒有入框角度，這一格留空
        if s.get("angle") is None:
            lines.append(f"{i + 1},,{made}")
            continue
        a = math.floor(float(s["angle"]) * 10 + 0.5) / 10
        lines.append(f"{i + 1},{a:.1f},{made}")
    return "\r\n".join(lines) + "\r\n"


def write_csv(path, shots: list[dict]) -> None:
    """寫檔（UTF-8 加 BOM，Excel 才不會亂碼）。"""
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        fh.write(shots_to_csv(shots))


def _split_line(line: str, delim: str) -> list[str]:
    out = []
    cur = ""
    quoted = False
    i = 0
    while i < len(line):
        ch = line[i]
        if quoted:
            if ch == _QUOTE and i + 1 < len(line) and line[i + 1] == _QUOTE:
                cur += _QUOTE
                i += 1
            elif ch == _QUOTE:
                quoted = False
            else:
                cur += ch
        elif ch == _QUOTE:
            quoted = True
        elif ch == delim:
            out.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    out.append(cur)
    return [s.strip() for s in out]


def _parse_made(text: str):
    k = str(text).strip().lower()
    if k in _YES:
        return True
    if k in _NO:
        return False
    return None


# 數字只接受一般的十進位寫法（和 csv.js 的 NUM_RE 相同）
_NUM_RE = re.compile(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$")


def _to_number(s) -> float:
    if isinstance(s, str) and _NUM_RE.match(s):
        return float(s)
    return math.nan


def parse_csv(text: str) -> dict:
    """解析 CSV。回傳 {'shots': [{'angle','made'}], 'warnings': [str]}。

    盡量寬鬆：容許 BOM、不同換行、Tab 或分號分隔、英文表頭、沒有表頭。
    """
    warnings: list[str] = []
    src = str(text)
    if src[:1] == "﻿":
        src = src[1:]
    lines = [ln for ln in re.split(r"\r\n|\n|\r", src) if ln.strip() != ""]
    if not lines:
        return {"shots": [], "warnings": ["檔案是空的"]}

    first = lines[0]
    if "\t" in first:
        delim = "\t"
    elif ";" in first and "," not in first:
        delim = ";"
    else:
        delim = ","
    rows = [_split_line(ln, delim) for ln in lines]

    col = {"order": 0, "angle": 1, "made": 2}
    head = rows[0]

    def looks_numeric(s: str) -> bool:
        return math.isfinite(_to_number(s))

    has_header = not any(looks_numeric(c) for c in head[:3])
    if has_header:
        def find(pattern: str) -> int:
            rx = re.compile(pattern, re.I)
            for i, h in enumerate(head):
                if rx.search(h):
                    return i
            return -1

        a = find(r"角度|angle|entry")
        m = find(r"進球|命中|made|make|result")
        o = find(r"球序|序|shot|#|no\.?$|index")
        if a >= 0 and m >= 0:
            col = {"order": o, "angle": a, "made": m}
        rows = rows[1:]

    parsed = []
    for i, r in enumerate(rows):
        line_no = i + 1 + (1 if has_header else 0)
        cell = r[col["angle"]] if col["angle"] < len(r) else ""
        angle = _to_number(cell)
        made = _parse_made(r[col["made"]] if col["made"] < len(r) else "")
        blank = cell.strip() == "" and col["angle"] < len(r)
        if blank:
            angle = None  # 角度留空：這一球只有進或沒進（自動模式偏角太大時）
        elif not math.isfinite(angle) or angle <= 0 or angle >= 90:
            warnings.append(f"第 {line_no} 列的入框角度看不懂，已略過")
            continue
        if made is None:
            warnings.append(f"第 {line_no} 列的是否進球看不懂，已略過")
            continue
        order = _to_number(r[col["order"]]) if 0 <= col["order"] < len(r) else math.nan
        parsed.append({"order": order if math.isfinite(order) else None, "seq": i, "angle": angle, "made": made})

    if parsed and all(p["order"] is not None for p in parsed):
        parsed.sort(key=lambda p: (p["order"], p["seq"]))
    return {"shots": [{"angle": p["angle"], "made": p["made"]} for p in parsed], "warnings": warnings}


def read_csv(path) -> dict:
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        return parse_csv(fh.read())
