'use strict';

const test = require('tape');
const { inferQuadrants, runRasterClipContinuation } = require('../src/passes/rasterClipContinuation');

function pair(prefix, xOp = 'iflt', yOp = 'ifge') {
  const x = `${prefix}x`;
  const y = `${prefix}y`;
  const scan = `${prefix}scan`;
  const done = `${prefix}done`;
  return [
    { labelDef: `${prefix}entry:`, instruction: 'return' },
    { labelDef: `${x}Start:`, instruction: 'dup' },
    { labelDef: `${x}Store:`, instruction: { op: 'istore', arg: '1' } },
    { labelDef: `${x}Cond:`, instruction: { op: xOp, arg: `${y}Start` } },
    { labelDef: `${x}Adjust:`, instruction: 'iconst_0' },
    { labelDef: `${x}Zero:`, instruction: { op: 'goto', arg: done } },
    { labelDef: `${y}Start:`, instruction: 'dup' },
    { labelDef: `${y}Store:`, instruction: { op: 'istore', arg: '2' } },
    { labelDef: `${y}Cond:`, instruction: { op: yOp, arg: scan } },
    { labelDef: `${y}Adjust:`, instruction: 'iconst_0' },
    { labelDef: `${y}Zero:`, instruction: { op: 'goto', arg: done } },
    { labelDef: `${scan}:`, instruction: 'iconst_1' },
    { labelDef: `${done}:`, instruction: 'return' },
  ];
}

function methodAst(pairCount) {
  const codeItems = [];
  for (let i = 0; i < pairCount; i += 1) codeItems.push(...pair(`Q${i}_`));
  return {
    classes: [{
      className: 'Raster',
      items: [{
        type: 'method',
        method: {
          name: 'draw',
          descriptor: '()V',
          attributes: [{
            type: 'code',
            code: {
              localsSize: '3',
              codeItems,
              exceptionTable: [],
              attributes: [],
            },
          }],
        },
      }],
    }],
  };
}

test('raster-clip-continuation: infers and rewrites four clip-pair quadrants', (t) => {
  const ast = methodAst(4);
  const code = ast.classes[0].items[0].method.attributes[0].code;

  t.equal(inferQuadrants(code.codeItems).length, 4);
  t.deepEqual(runRasterClipContinuation(ast), { changed: true, fired: 4 });
  t.equal(code.localsSize, 4);
  t.ok(code.codeItems.some((item) => item.instruction && item.instruction.op === 'ifeq'));
  t.end();
});

test('raster-clip-continuation: requires full four-quadrant raster when inferred', (t) => {
  const ast = methodAst(3);
  const code = ast.classes[0].items[0].method.attributes[0].code;

  t.equal(inferQuadrants(code.codeItems).length, 3);
  t.deepEqual(runRasterClipContinuation(ast), { changed: false, fired: 0 });
  t.equal(code.localsSize, '3');
  t.end();
});

