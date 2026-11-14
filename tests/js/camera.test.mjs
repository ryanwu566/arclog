// 鏡頭擺位的幾何模擬（tools/camera_study.mjs）：
// 確認預設的水平基準在鏡頭擺正時沒有系統性偏差、垂直參考線基準的性質，以及拍攝指南裡引用的數字是對的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, F, H, MID, SHOT_DIST, W, around, designShot, measure, measureWithFrame, rimClicks, rollEstimates, verticalClicks, yawFormula } from '../../tools/camera_study.mjs';
import { makeHoopFrame } from '../../web/js/core/geometry.js';

const shots = [50, 54, 58].map((launch) => designShot(launch));
const worst = (cam, level, focal, vref) => Math.max(...shots.map((s) => Math.abs(measure(s, cam, level, focal, vref) - s.angle)));
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

// ── 垂直參考線（籃板側邊、籃架立柱）──────────────────────────────────────────

test('垂直參考線：鏡頭擺正時沒有系統性偏差（籃板看得到的擺法都一樣）', () => {
  for (const along of [-3, MID, -1, 0]) {
    for (const height of [0.9, 1.4, 2.0]) {
      for (const dist of [6, 8, 12]) {
        const cam = { ...BASE, along, height, dist };
        if (!verticalClicks(cam, 'board')) continue; // 籃板不在畫面裡就沒辦法用
        const e = worst(cam, 'vertical');
        assert.ok(e < 0.1, `along ${along} height ${height} dist ${dist}: ${e.toFixed(3)} 度`);
      }
    }
  }
  // 基準擺法一定看得到籃板側邊；腳架在罰球線旁邊、或只離 5 公尺時籃板會出畫面
  assert.ok(verticalClicks(BASE, 'board'));
  assert.equal(verticalClicks({ ...BASE, dist: 5 }, 'board'), null);
  assert.ok(Number.isNaN(measure(shots[0], { ...BASE, dist: 5 }, 'vertical')));
});

test('垂直參考線：手機歪多少都不受影響，也不需要焦距假設（修正透視在焦距不對時會偏）', () => {
  for (const rollDeg of [-5, -3, 3, 5]) {
    assert.ok(worst({ ...BASE, rollDeg }, 'vertical') < 0.05, `roll ${rollDeg}`);
  }
  for (const ratio of [0.6, 0.7, 0.9, 1.0, 1.6]) {
    const cam = { ...BASE, f: ratio * W, dist: (8 * ratio) / 0.8 };
    assert.ok(worst(cam, 'vertical') < 0.1, `焦距 ${ratio}：${worst(cam, 'vertical').toFixed(2)}`);
  }
  // 對照：焦距 0.6 倍時修正透視高估 0.3 度以上
  assert.ok(worst({ ...BASE, f: 0.6 * W, dist: 6 }, 'persp') > 0.3);
});

test('垂直參考線：籃框兩點點歪的影響比修正透視小；參考線本身點歪或不是真的鉛直才有影響', () => {
  const { left, right } = rimClicks(BASE);
  const back = { x: right.x, y: right.y - 1 };
  const errOf = (level) =>
    Math.max(...shots.map((s) => Math.abs(measureWithFrame(s, BASE, makeHoopFrame(left, back, { level, width: W, height: H, vertical: verticalClicks(BASE, 'board') })) - s.angle)));
  assert.ok(errOf('vertical') < errOf('persp'), `垂直 ${errOf('vertical').toFixed(2)}、透視 ${errOf('persp').toFixed(2)}`);
  // 參考線上端點歪 1 像素：0.15 度以內；那條線其實斜 1 度：約 0.2 到 0.4 度
  assert.ok(worst(BASE, 'vertical', undefined, { dxPx: 1 }) < 0.15);
  const lean = worst(BASE, 'vertical', undefined, { leanDeg: 1 });
  assert.ok(lean > 0.2 && lean < 0.5, `斜 1 度：${lean.toFixed(2)}`);
});

test('垂直參考線：鏡頭往上仰一樣修不掉，偏差大小和修正透視同一個量級', () => {
  for (const pitchDeg of [3, 5]) {
    const cam = { ...BASE, pitchDeg };
    const v = worst(cam, 'vertical');
    const p = worst(cam, 'persp');
    assert.ok(v > 0.15 && v < 0.7, `仰 ${pitchDeg}：垂直 ${v.toFixed(2)}`);
    assert.ok(Math.abs(v - p) < 0.3, `仰 ${pitchDeg}：垂直 ${v.toFixed(2)}、透視 ${p.toFixed(2)}`);
  }
});

test('垂直參考線估不出仰角：兩種歪斜估計的差，比點歪 1 像素或焦距不對造成的差還小', () => {
  // 仰 5 度時，籃板側邊和籃框兩個估計只差 0.5 度左右
  const r5 = rollEstimates({ ...BASE, pitchDeg: 5 });
  const signal = Math.abs(r5.vertical - r5.rim);
  assert.ok(signal > 0.3 && signal < 0.8, `仰 5 度的差 ${signal.toFixed(2)}`);
  // 籃框後緣點高 1 像素，籃框那個估計就變 0.6 度
  const { left, right } = rimClicks(BASE);
  const h0 = makeHoopFrame(left, right, { level: 'persp', width: W, height: H });
  const h1 = makeHoopFrame(left, { x: right.x, y: right.y - 1 }, { level: 'persp', width: W, height: H });
  assert.ok(Math.abs((h1.tiltDeg - h1.perspDeg) - (h0.tiltDeg - h0.perspDeg)) > signal);
  // 鏡頭焦距和假設差 25%（0.6 倍）時，兩者差將近 2 度：和仰角分不開
  const rf = rollEstimates({ ...BASE, f: 0.6 * W, dist: 6 });
  assert.ok(Math.abs(rf.vertical - rf.rim) > 3 * signal);
});
