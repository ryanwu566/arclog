// 可重現的亂數產生器（mulberry32）。
// JS 和 Python（arclog/prng.py）用同一個演算法，所以同一個種子會得到同一串數字，
// RANSAC 在兩邊才會挑到一樣的樣本。

/**
 * @param {number} seed 32 位元整數種子
 * @returns {() => number} 每次呼叫回傳 [0, 1) 的數
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 回傳 0 到 n-1 的整數。 */
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}

/** 常態分布亂數（Box–Muller），給合成資料加雜訊用。 */
export function randNormal(rng) {
  let u = rng();
  if (u < 1e-12) u = 1e-12;
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
