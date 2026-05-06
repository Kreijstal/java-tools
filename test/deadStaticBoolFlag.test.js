'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const { runDeadStaticBoolFlag } = require('../src/deadStaticBoolFlag');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');

function astWith(codeItems, exceptionTable = []) {
  return {
    classes: [
      {
        className: 'Demo',
        items: [
          {
            type: 'method',
            method: {
              name: 'f',
              descriptor: '(I)V',
              attributes: [
                {
                  type: 'code',
                  code: { codeItems, exceptionTable, attributes: [] },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function code(ast) {
  return ast.classes[0].items[0].method.attributes[0].code;
}

function realInstrs(ast) {
  return code(ast).codeItems
    .filter((it) => it && it.instruction)
    .map((it) => (typeof it.instruction === 'string' ? it.instruction : it.instruction.op));
}

test('dead-flag: eliminates iload N; ifne TGT when N := always-false flag', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'jn', ['u', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L5:', instruction: 'iconst_0' },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifne', arg: 'L99' } },
    { labelDef: 'L8:', instruction: 'return' },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.ok(r.changed);
  t.equal(r.eliminated, 1);
  t.deepEqual(realInstrs(ast), ['getstatic', 'istore', 'iconst_0', 'return', 'return']);
  t.end();
});

test('dead-flag: rewrites iload N; ifeq TGT to goto TGT', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifeq', arg: 'L99' } },
    { labelDef: 'L8:', instruction: 'return' },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'client.A' });
  t.equal(r.eliminated, 1);
  // After: getstatic; istore; goto L99; return; return  (the iload is gone, ifeq -> goto L99)
  const items = code(ast).codeItems.filter((it) => it && it.instruction);
  const ops = items.map((it) => (typeof it.instruction === 'string' ? it.instruction : it.instruction.op));
  t.deepEqual(ops, ['getstatic', 'istore', 'goto', 'return', 'return']);
  t.equal(items[2].instruction.arg, 'L99');
  t.end();
});

test('dead-flag: refuses if local N is rewritten elsewhere', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'jn', ['u', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { instruction: 'iconst_1' },
    { instruction: { op: 'istore', arg: '5' } },  // re-store
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifne', arg: 'L99' } },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.equal(r.eliminated, 0, 'local 5 was overwritten — abort');
  t.end();
});

test('dead-flag: refuses if field not in always-false set', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'random', ['Bool', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifne', arg: 'L99' } },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.equal(r.eliminated, 0, 'random.Bool not in allowlist');
  t.end();
});

test('dead-flag: refuses if labelDef sits between iload and ifne (not flat)', (t) => {
  // A separate labelDef-only item between iload and ifne means another path
  // could land on the ifne with an unrelated stack value. Refuse.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'jn', ['u', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'Lstray:' },                                    // labelDef alone
    { instruction: { op: 'ifne', arg: 'L99' } },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.equal(r.eliminated, 0, 'labelDef between iload and ifne disqualifies');
  t.end();
});

test('dead-flag: handles numbered istore (istore_2) and numbered iload (iload_2)', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'jn', ['u', 'Z']] } },
    { labelDef: 'L3:', instruction: 'istore_2' },
    { labelDef: 'L6:', instruction: 'iload_2' },
    { labelDef: 'L7:', instruction: { op: 'ifne', arg: 'L99' } },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.equal(r.eliminated, 1);
  t.end();
});

test('dead-flag: end-to-end on DeadStaticBoolFlag.j fixture', (t) => {
  const fixturePath = path.join(__dirname, '..', 'examples', 'sources', 'jasmin', 'DeadStaticBoolFlag.j');
  const text = fs.readFileSync(fixturePath, 'utf8');
  const krak2 = parseKrak2Assembly(text);
  const astRoot = convertKrak2AstToClassAst(krak2, { sourceText: text });
  const r = runDeadStaticBoolFlag(astRoot, { flags: 'DeadStaticBoolFlag.FLAG' });
  t.ok(r.changed);
  t.equal(r.eliminated, 2, 'one ifne (deleted) + one ifeq (rewritten) = 2');
  t.end();
});

test('dead-flag: ignores non-Z descriptor', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'jn', ['u', 'I']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifne', arg: 'L99' } },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.equal(r.eliminated, 0, 'int descriptor I, not Z, must skip');
  t.end();
});
