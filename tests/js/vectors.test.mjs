// 確認 tests/vectors/ 裡提交的向量檔，和目前的 JS 程式碼產生出來的一模一樣。
// 改了核心演算法卻忘了重新產生向量時，這個測試會失敗。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT } from './helpers.mjs';

test('測試向量是最新的', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'gen_vectors.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stderr || r.stdout || '').trim());
});
