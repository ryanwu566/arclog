"""共用常數。必須和 web/js/core/constants.js 保持一致（tests/vectors/constants.json 會檢查）。"""
import math

#: 籃框內徑（公尺）。校正時兩點的距離就代表這個長度。
RIM_DIAMETER_M = 0.45

#: 籃球直徑（公尺）。
BALL_DIAMETER_M = 0.24

#: 球半徑，以「籃框內徑」為單位。
BALL_RADIUS_RIM = BALL_DIAMETER_M / (2 * RIM_DIAMETER_M)

#: 對標的理想入框角度（度）。
IDEAL_ENTRY_DEG = 45

#: 手機 1 倍鏡頭錄影時的焦距（畫面長邊的幾倍）。只用來估計籃框因透視看起來斜了幾度，見 geometry.py。
FOCAL_RATIO = 0.8

#: 空氣阻力常數 k = ½·ρ·Cd·A / m（1/公尺）。說明見 constants.js。
DRAG_K_PER_M = 0.0226

#: 同一個阻力常數，以「籃框內徑」為長度單位。
DRAG_K_RIM = DRAG_K_PER_M * RIM_DIAMETER_M

#: 進球判定門檻（球半徑的倍數），見 shot.judge_make。
MAKE_NEAR_FACTOR = 0.6
MAKE_FAR_FACTOR = 0.5

#: 半自動標記每球最少要點幾個球心。
MIN_MANUAL_POINTS = 4


def round_angle(deg: float) -> float:
    """角度記到小數一位（.5 一律進位，和 JS 相同）。"""
    return math.floor(deg * 10 + 0.5) / 10
