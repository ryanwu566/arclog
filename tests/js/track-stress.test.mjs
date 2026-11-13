// 追蹤邏輯的隨機壓力測試（小規模版）。完整統計請跑：node tests/js/track-stress.mjs 200
//
// 40 組隨機條件（幀率 30/60、每 1–4 幀偵測一次、漏偵測 5–45%、每幀 0–30% 機率出現假偵測、
// 位置雜訊、鏡射、相機歪斜、地上的球、運球），每組 10 球。
//
// 這裡的門檻是「不可以退步」的底線，不是對實拍的保證：合成偵測沒有真實模型的各種毛病。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMany } from './track-stress.mjs';

test('追蹤：40 組隨機條件下不多抓、很少判錯、角度誤差小', () => {
  const r = runMany(40);
  const abs = r.errs.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  const big = abs.filter((e) => e >= 1).length;
  const summary = `${r.shots} 球：漏 ${r.missed}、多抓 ${r.extra}、判錯 ${r.wrongMake}；誤差中位數 ${q(0.5).toFixed(3)}、90% ${q(0.9).toFixed(3)}、最大 ${abs[abs.length - 1].toFixed(3)} 度`;
  assert.equal(r.shots, 400);
  assert.equal(r.extra, 0, `不可以把不是投籃的東西當成投籃。${summary}`);
  assert.ok(r.wrongMake <= 2, `進球判定錯太多。${summary}`);
  assert.ok(r.missed <= 0.06 * r.shots, `漏太多球。${summary}`);
  assert.ok(q(0.5) < 0.15, `誤差中位數太大。${summary}`);
  assert.ok(q(0.9) < 0.5, `90% 的球誤差應小於 0.5 度。${summary}`);
  assert.ok(big <= 2, `誤差超過 1 度的球太多（${big} 球）。${summary}`);
});
