'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {FreeExtents} = require('../src/core/freeExtents');

test('split, alignment padding and coalescing agree with an independent interval model', () => {
  const pool = new FreeExtents();
  pool.release(9, 8191);
  let free = [[9, 8200]], live = [], state = 123456789;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let step = 0; step < 20000; step++) {
    if (live.length && random() % 3 === 0) {
      const [allocation] = live.splice(random() % live.length, 1);
      pool.release(allocation[0], allocation[1]);
      free.push([allocation[0], allocation[0] + allocation[1]]);
      free.sort((a, b) => a[0] - b[0]);
      free = free.reduce((out, interval) => {
        if (out.length && out.at(-1)[1] === interval[0]) out.at(-1)[1] = interval[1];
        else out.push(interval);
        return out;
      }, []);
    } else {
      const bytes = 1 + random() % 257, align = 2 ** (random() % 4);
      let expected = -1;
      for (let i = 0; i < free.length; i++) {
        const [start, end] = free[i], base = Math.ceil(start / align) * align;
        if (base + bytes > end) continue;
        expected = base;
        free.splice(i, 1, ...(base > start ? [[start, base]] : []),
          ...(base + bytes < end ? [[base + bytes, end]] : []));
        live.push([base, bytes]);
        break;
      }
      assert.equal(pool.take(bytes, align), expected, 'first fit at step ' + step);
    }
    assert.equal(pool.bytes, free.reduce((bytes, [start, end]) => bytes + end - start, 0));
  }
  for (const [base, bytes] of live) pool.release(base, bytes);
  assert.equal(pool.bytes, 8191);
  assert.equal(pool.root.base, 9);
  assert.equal(pool.root.bytes, 8191);
  assert.equal(pool.root.left, null);
  assert.equal(pool.root.right, null);
});

test('sorted releases keep the search tree balanced and reject overlapping frees', () => {
  const pool = new FreeExtents();
  for (let i = 0; i < 10000; i++) pool.release(8 + i * 16, 8);
  assert.ok(pool.root.height < 20);
  const free = pool.bytes;
  assert.throws(() => pool.release(8, 8), /Overlapping/);
  assert.throws(() => pool.release(9, 2), /Overlapping/);
  assert.equal(pool.bytes, free);
  for (let i = 0; i < 10000; i++) assert.equal(pool.take(8, 8), 8 + i * 16);
  assert.equal(pool.bytes, 0);
  assert.equal(pool.root, null);
});
