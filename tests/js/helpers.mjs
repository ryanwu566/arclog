// 測試共用的小工具
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** 讀 tests/vectors/ 裡的共用測試向量。 */
export function vectors(name) {
  return JSON.parse(readFileSync(join(ROOT, 'tests', 'vectors', name), 'utf8'));
}

/**
 * 遞迴比較兩個值：數字容許 tol 的誤差，其餘必須完全相同。
 * 用來比對「JS 現在算出來的」和向量裡存的 expected。
 */
export function assertClose(actual, expected, tol = 1e-9, path = 'value') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path} 應為數字，得到 ${JSON.stringify(actual)}`);
    if (Number.isNaN(expected)) {
      assert.ok(Number.isNaN(actual), `${path} 應為 NaN`);
      return;
    }
    assert.ok(Math.abs(actual - expected) <= tol, `${path}：${actual} 和 ${expected} 相差 ${Math.abs(actual - expected)}（容許 ${tol}）`);
    return;
  }
  if (expected === null || typeof expected !== 'object') {
    assert.equal(actual, expected, path);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} 應為陣列`);
    assert.equal(actual.length, expected.length, `${path} 的長度`);
    expected.forEach((e, i) => assertClose(actual[i], e, tol, `${path}[${i}]`));
    return;
  }
  assert.ok(actual !== null && typeof actual === 'object', `${path} 應為物件`);
  for (const k of Object.keys(expected)) assertClose(actual[k], expected[k], tol, `${path}.${k}`);
}
