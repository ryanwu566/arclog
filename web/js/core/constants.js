// ArcLog 共用常數。
// 這個檔案和 arclog/constants.py 必須保持一致（tests/vectors/constants.json 會檢查）。

/** 籃框內徑（公尺）。校正時兩點的距離就代表這個長度。 */
export const RIM_DIAMETER_M = 0.45;

/** 籃球直徑（公尺）。七號球圓周約 75–78 公分，直徑約 24 公分。 */
export const BALL_DIAMETER_M = 0.24;

/** 球半徑，以「籃框內徑」為單位。 */
export const BALL_RADIUS_RIM = BALL_DIAMETER_M / (2 * RIM_DIAMETER_M);

/** 對標的理想入框角度（度）。 */
export const IDEAL_ENTRY_DEG = 45;

// 手機 1 倍鏡頭錄影時的焦距，以「畫面長邊的幾倍」表示。
// 26mm 等效鏡頭在 16:9 錄影時約 0.72 倍，加上防手震的裁切後大約 0.8 到 0.87 倍。
// 只用來估計「籃框因為透視看起來斜了幾度」（geometry.js 的 level='persp'），差 10% 影響不到 0.2 度。
export const FOCAL_RATIO = 0.8;

/**
 * 空氣阻力常數 k = ½·ρ·Cd·A / m，單位 1/公尺。
 * ρ=1.2 kg/m³、Cd≈0.5、半徑 0.12 m、質量 0.60 kg → 約 0.0226。
 * 軌跡滿足 y'' = −2κ·exp(2k·s)，s 是沿軌跡的弧長；k=0 時就是標準拋物線。
 * 只用拋物線擬合整段罰球軌跡，入框角度會低估約 1 度（見 docs/EVAL.md 的誤差來源）。
 */
export const DRAG_K_PER_M = 0.0226;

/** 同一個阻力常數，換成以「籃框內徑」為長度單位。 */
export const DRAG_K_RIM = DRAG_K_PER_M * RIM_DIAMETER_M;

/** 進球判定門檻（以球半徑的倍數表示），見 shot.js 的 judgeMake。 */
export const MAKE_NEAR_FACTOR = 0.6;
export const MAKE_FAR_FACTOR = 0.5;

/** 半自動標記每球最少要點幾個球心才能存。 */
export const MIN_MANUAL_POINTS = 4;

/** 角度一律記到小數一位，CSV 匯出再匯入才不會有捨入差。 */
export function roundAngle(deg) {
  return Math.floor(deg * 10 + 0.5) / 10;
}
