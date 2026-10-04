// node --test: the recorded run is found under the current pool or, after a redeploy, under previous.<mode>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecordedRun } from '../src/lib/recorded.ts';

const K = 'e2e_F9_x';
const OLD = '0x493c14a92da0905b06a91a1e87a75d4bff75e4a6';
const NEW = '0x690d8a8499974bea8d655948034aaf981dc30214';

test('record under the current pool', () => {
  const h = findRecordedRun({ pools: { mock: { pool: NEW, [K]: { coverId: 3 } } } }, 'mock', K);
  assert.deepEqual(h, { run: { coverId: 3 }, pool: NEW, earlier: false });
});

test('record only under previous.mock: found, with the earlier pool address', () => {
  const doc = { pools: { mock: { pool: NEW } }, previous: { mock: [{ pool: OLD, [K]: { coverId: 3 } }] } };
  const h = findRecordedRun(doc, 'mock', K);
  assert.equal(h.pool, OLD);
  assert.equal(h.earlier, true);
  assert.equal(h.run.coverId, 3);
});

test('newest previous entry that has the record wins; missing record throws', () => {
  const doc = {
    pools: { mock: { pool: NEW } },
    previous: { mock: [{ pool: '0xa', [K]: { coverId: 1 } }, { pool: '0xb', [K]: { coverId: 2 } }, { pool: '0xc' }] },
  };
  assert.equal(findRecordedRun(doc, 'mock', K).run.coverId, 2);
  assert.throws(() => findRecordedRun(doc, 'mock', 'nope'), /no recorded run/);
});
