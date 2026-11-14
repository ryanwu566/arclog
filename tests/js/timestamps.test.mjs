// 網站用 Mediabunny 讀出每一幀的時間戳；這個測試確認它和 ffprobe（也就是 Python 的 PyAV）讀到的一樣。
// 這是「瀏覽器標的幀」和「Python 抽的幀」能對齊的基礎。
//
// 測試影片是 tests/fixtures/video/ 的條碼影片：固定／可變幀率、有 B 幀、帶旋轉、時間偏移、HEVC。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './helpers.mjs';
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from '../../web/vendor/mediabunny-1.65.2/mediabunny.min.mjs';
import { describeTiming, nearestIndex } from '../../web/js/media/source.js';

const FIX = join(ROOT, 'tests', 'fixtures', 'video');
const expected = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'));

async function readTimes(name) {
  const buf = readFileSync(join(FIX, name));
  const input = new Input({ source: new BufferSource(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const raw = [];
    for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      if (p.timestamp >= 0) raw.push(p.timestamp);
    }
    raw.sort((a, b) => a - b);
    return {
      times: raw,
      codec: await track.getCodec(),
      rotation: await track.getRotation(),
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
    };
  } finally {
    input.dispose();
  }
}

for (const [name, info] of Object.entries(expected.files)) {
  test(`時間戳和 ffprobe 一致：${name}（${info.note}）`, async () => {
    const got = await readTimes(name);
    assert.equal(got.times.length, info.frames, '幀數');
    for (let i = 0; i < info.frames; i++) {
      assert.ok(Math.abs(got.times[i] - info.times[i]) < 2e-6, `第 ${i} 幀：${got.times[i]} vs ffprobe ${info.times[i]}`);
    }
    assert.equal(got.width, info.displayWidth, '顯示寬度（已套用旋轉）');
    assert.equal(got.height, info.displayHeight, '顯示高度（已套用旋轉）');
    assert.ok(['avc', 'hevc'].includes(got.codec), `編碼 ${got.codec}`);
  });
}

test('describeTiming：固定幀率與可變幀率', () => {
  const cfr = describeTiming(Float64Array.from(expected.files['cfr30_h264.mp4'].times));
  assert.ok(Math.abs(cfr.fps - 30) < 0.01 && cfr.vfr === false);
  const cfr60 = describeTiming(Float64Array.from(expected.files['cfr60_h264.mov'].times));
  assert.ok(Math.abs(cfr60.fps - 60) < 0.01 && cfr60.vfr === false);
  const vfr = describeTiming(Float64Array.from(expected.files['vfr_h264.mp4'].times));
  assert.equal(vfr.vfr, true);
  assert.ok(vfr.maxDt > 2.5 * vfr.minDt);
});

test('nearestIndex', () => {
  const t = Float64Array.from([0, 0.1, 0.2, 0.5, 0.9]);
  assert.equal(nearestIndex(t, -1), 0);
  assert.equal(nearestIndex(t, 0.04), 0);
  assert.equal(nearestIndex(t, 0.06), 1);
  assert.equal(nearestIndex(t, 0.2), 2);
  assert.equal(nearestIndex(t, 0.36), 3);
  assert.equal(nearestIndex(t, 0.71), 4);
  assert.equal(nearestIndex(t, 99), 4);
  assert.equal(nearestIndex(new Float64Array(0), 1), -1);
});
