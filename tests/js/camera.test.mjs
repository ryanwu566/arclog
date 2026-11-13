// 鏡頭擺位的幾何模擬（tools/camera_study.mjs）：
// 確認預設的水平基準在鏡頭擺正時沒有系統性偏差，以及拍攝指南裡引用的數字是對的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, F, MID, SHOT_DIST, W, around, designShot, measure, rimClicks, yawFormula } from '../../tools/camera_study.mjs';

const shots = [50, 54, 58].map((launch) => designShot(launch));
const worst = (cam, level, focal) => Math.max(...shots.map((s) => Math.abs(measure(s, cam, level, focal) - s.angle)));
const mean = (cam, level) => shots.reduce((a, s) => a + (measure(s, cam, level) - s.angle), 0) / shots.length;

test('模擬的三球是 40 到 53 度的入框角度', () => {
  const angles = shots.map((s) => s.angle);
  assert.ok(angles[0] > 39 && angles[0] < 42, String(angles));
  assert.ok(angles[1] > 45 && angles[1] < 48, String(angles));
  assert.ok(angles[2] > 51 && angles[2] < 54, String(angles));
});

test('鏡頭擺正時：修正透視的水平基準沒有系統性偏差（不論腳架位置、高度、距離）', () => {
  for (const along of [-SHOT_DIST, -3, MID, -1, 0]) {
    for (const height of [0.9, 1.4, 2.0]) {
      for (const dist of [6, 8, 12]) {
        const cam = { ...BASE, along, height, dist };
        const e = worst(cam, 'persp');
        assert.ok(e < 0.1, `along ${along} height ${height} dist ${dist}: ${e.toFixed(3)} 度`);
      }
    }
  }
});

test('鏡頭擺正時：直接用籃框連線當水平會高估（這就是要修正透視的原因）', () => {
  // 籃框不在畫面正中央、又比鏡頭高：橢圓最左最右兩點不在同一個深度，連線是斜的
  assert.ok(mean(BASE, 'rim') > 0.5, `基準擺法 ${mean(BASE, 'rim').toFixed(2)}`);
  assert.ok(mean({ ...BASE, dist: 5 }, 'rim') > 1.5);
  // 籃框在畫面正中央時就沒有這個問題
  assert.ok(worst({ ...BASE, along: 0 }, 'rim') < 0.1);
  // 鏡頭和籃框一樣高時也沒有
  assert.ok(worst({ ...BASE, height: 3.05 }, 'rim') < 0.1);
});

test('手機左右歪：修正透視的基準不受影響，畫面水平的基準每歪 1 度差約 0.2 到 0.4 度', () => {
  for (const rollDeg of [-3, -1, 1, 3, 5]) {
    assert.ok(worst({ ...BASE, rollDeg }, 'persp') < 0.15, `roll ${rollDeg}: ${worst({ ...BASE, rollDeg }, 'persp').toFixed(3)}`);
  }
  const perDeg = shots.map((s) => measure(s, { ...BASE, rollDeg: 1 }, 'image') - s.angle);
  for (const e of perDeg) assert.ok(e > 0.12 && e < 0.5, String(perDeg));
});

test('偏離正側面 θ 度：相機很遠時符合 tan(量測) = tan(真實) / cos θ', () => {
  for (const theta of [5, 10, 15, 20]) {
    const cam = around(theta, 300, { f: F * 37.5 });
    for (const s of shots) {
      const sim = measure(s, cam, 'image');
      const formula = yawFormula(s.angle, theta);
      assert.ok(Math.abs(sim - formula) < 0.12, `θ ${theta}：模擬 ${sim.toFixed(2)}、公式 ${formula.toFixed(2)}`);
    }
  }
  // 規格裡的兩個數字：45 度的球，偏 10 度約高估 0.4 度，偏 20 度約高估 1.8 度
  assert.ok(Math.abs(yawFormula(45, 10) - 45 - 0.44) < 0.01);
  assert.ok(Math.abs(yawFormula(45, 20) - 45 - 1.78) < 0.01);
});

test('偏離正側面：實際距離（8 公尺）多了一項透視效應，兩個方向不對稱', () => {
  const s = shots[1];
  const toward = measure(s, around(-10, 8)) - s.angle; // 往投籃者後方偏
  const away = measure(s, around(10, 8)) - s.angle; // 往籃框後方偏
  assert.ok(toward > 0.8 && toward < 1.5, `往投籃者後方偏 10 度：${toward.toFixed(2)}`);
  assert.ok(away < -0.2 && away > -0.8, `往籃框後方偏 10 度：${away.toFixed(2)}`);
});

test('鏡頭往上仰會低估：仰 5 度約 0.2 到 0.6 度（任何水平基準都修不掉）', () => {
  for (const s of shots) {
    const e = measure(s, { ...BASE, pitchDeg: 5 }) - s.angle;
    assert.ok(e < -0.15 && e > -0.7, `仰 5 度：${e.toFixed(2)}`);
  }
  for (const s of shots) {
    const e = measure(s, { ...BASE, pitchDeg: 5 }, 'image') - s.angle;
    assert.ok(e < -0.5, `畫面水平、仰 5 度：${e.toFixed(2)}`);
  }
});

test('假設的焦距差 12% 以內，修正透視的誤差在 0.3 度以內', () => {
  for (const ratio of [0.7, 0.8, 0.9]) {
    const cam = { ...BASE, f: ratio * W, dist: (8 * ratio) / 0.8 };
    assert.ok(worst(cam, 'persp') < 0.3, `焦距 ${ratio}：${worst(cam, 'persp').toFixed(2)}`);
  }
});

test('校正點：籃框橢圓最左最右兩點在基準擺法下不等高（透視造成的傾斜約 3 度）', () => {
  const { left, right } = rimClicks(BASE);
  const tilt = (Math.atan2(left.y - right.y, right.x - left.x) * 180) / Math.PI;
  assert.ok(tilt > 2 && tilt < 4.5, `傾斜 ${tilt.toFixed(2)} 度`);
});
