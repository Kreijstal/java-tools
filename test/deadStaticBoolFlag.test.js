'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const { runDeadStaticBoolFlag, discoverDeadStaticFlags } = require('../src/passes/deadStaticBoolFlag');
const { parseKrak2Assembly } = require('../src/parsing/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/parsing/convert_krak2_ast');

function astWith(codeItems, exceptionTable = [], descriptor = '(I)V') {
  return {
    classes: [
      {
        className: 'Demo',
        items: [
          {
            type: 'method',
            method: {
              name: 'f',
              descriptor,
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

function astWithClasses(classes) {
  return { classes };
}

function staticField(name, descriptor) {
  return {
    type: 'field',
    field: {
      flags: ['public', 'static'],
      name,
      descriptor,
      value: null,
    },
  };
}

function methodWith(name, codeItems) {
  return {
    type: 'method',
    method: {
      name,
      descriptor: '()V',
      attributes: [{ type: 'code', code: { codeItems, exceptionTable: [], attributes: [] } }],
    },
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

test('dead-flag: can preserve branch shape with a constant false load', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifeq', arg: 'L99' } },
    { labelDef: 'L8:', instruction: 'return' },
    { labelDef: 'L99:', instruction: 'return' },
  ]);
  const r = runDeadStaticBoolFlag(ast, { flags: 'client.A', preserveBranchShape: true });
  t.equal(r.eliminated, 1);
  const items = code(ast).codeItems.filter((it) => it && it.instruction);
  const ops = items.map((it) => (typeof it.instruction === 'string' ? it.instruction : it.instruction.op));
  t.deepEqual(ops, ['getstatic', 'istore', 'iconst_0', 'ifeq', 'return', 'return']);
  t.equal(items[3].instruction.arg, 'L99');
  t.end();
});

test('dead-flag: preserve branch shape can require any array parameter', (t) => {
  const codeItems = [
    { labelDef: 'L0:', instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { labelDef: 'L3:', instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'L6:', instruction: { op: 'iload', arg: '5' } },
    { labelDef: 'L7:', instruction: { op: 'ifeq', arg: 'L99' } },
    { labelDef: 'L8:', instruction: 'return' },
    { labelDef: 'L99:', instruction: 'return' },
  ];
  const arrayAst = astWith(JSON.parse(JSON.stringify(codeItems)), [], '(I[B)V');
  const scalarAst = astWith(JSON.parse(JSON.stringify(codeItems)), [], '(II)V');

  const options = {
    flags: 'client.A',
    preserveBranchShape: true,
    preserveBranchShapeRequireArrayParameter: true,
  };
  t.equal(runDeadStaticBoolFlag(arrayAst, options).eliminated, 1);
  t.deepEqual(realInstrs(arrayAst), ['getstatic', 'istore', 'iconst_0', 'ifeq', 'return', 'return']);

  t.equal(runDeadStaticBoolFlag(scalarAst, options).eliminated, 1);
  const scalarItems = code(scalarAst).codeItems.filter((it) => it && it.instruction);
  t.deepEqual(scalarItems.map((it) => (typeof it.instruction === 'string' ? it.instruction : it.instruction.op)),
    ['getstatic', 'istore', 'goto', 'return', 'return']);
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

test('dead-flag: preserves labels referenced by switches outside the binding range', (t) => {
  const ast = astWith([
    { instruction: { op: 'getstatic', arg: ['Field', 'jn', ['u', 'Z']] } },
    { instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'Lguard:', instruction: { op: 'iload', arg: '5' } },
    { instruction: { op: 'ifne', arg: 'Lret' } },
    { instruction: 'iconst_1' },
    { instruction: { op: 'istore', arg: '5' } },
    { instruction: { op: 'tableswitch', labels: ['Lguard'], defaultLbl: 'Lret' } },
    { labelDef: 'Lret:', instruction: 'return' },
  ]);
  const result = runDeadStaticBoolFlag(ast, { flags: 'jn.u' });
  t.equal(result.eliminated, 0, 'external switch target prevents removal of the referenced label');
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

test('dead-flag discovery: finds zero int field with no writes', (t) => {
  const ast = astWithClasses([
    {
      className: 'Chess',
      items: [
        staticField('G', 'I'),
        methodWith('f', [
          { instruction: { op: 'getstatic', arg: ['Field', 'Chess', ['G', 'I']] } },
          { instruction: 'istore_1' },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifne', arg: 'Lret' } },
          { instruction: 'return' },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
  ]);
  const r = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.ok(r.fields.includes('Chess.G'));
  t.end();
});

test('dead-flag discovery: mutually gated zero sentinel cycle is opt-in', (t) => {
  const ast = astWithClasses([
    {
      className: 'Main',
      items: [
        staticField('J', 'I'),
        methodWith('writeJ', [
          { instruction: { op: 'getstatic', arg: ['Field', 'Flags', ['L', 'Z']] } },
          { instruction: { op: 'ifeq', arg: 'Lret' } },
          { instruction: 'iconst_1' },
          { instruction: { op: 'putstatic', arg: ['Field', 'Main', ['J', 'I']] } },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
    {
      className: 'Flags',
      items: [
        staticField('L', 'Z'),
        methodWith('writeL', [
          { instruction: { op: 'getstatic', arg: ['Field', 'Main', ['J', 'I']] } },
          { instruction: 'istore_2' },
          { instruction: 'iload_2' },
          { instruction: { op: 'ifeq', arg: 'Lret' } },
          { instruction: 'iconst_1' },
          { instruction: { op: 'putstatic', arg: ['Field', 'Flags', ['L', 'Z']] } },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
  ]);
  const conservative = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.notOk(conservative.fields.includes('Main.J'), 'default rejects the fixed-point cycle');
  t.ok(conservative.rejected.includes('Main.J'));
  t.deepEqual(conservative.cyclicDependencies, ['Flags.L', 'Main.J']);

  const experimental = discoverDeadStaticFlags(ast, {
    allowIntFlags: true,
    allowMutuallyGuardedFalseCycles: true,
  });
  t.ok(experimental.fields.includes('Main.J'), 'explicit option enables the fixed-point proof');
  t.notOk(experimental.fields.includes('Flags.L'), 'dependency-only guard is not returned without a consumer');
  t.end();
});

test('dead-flag discovery: rejects unguarded write', (t) => {
  const ast = astWithClasses([
    {
      className: 'Main',
      items: [
        staticField('J', 'I'),
        methodWith('writeJ', [
          { instruction: 'iconst_1' },
          { instruction: { op: 'putstatic', arg: ['Field', 'Main', ['J', 'I']] } },
          { instruction: 'return' },
        ]),
      ],
    },
  ]);
  const r = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.notOk(r.fields.includes('Main.J'));
  t.end();
});

test('dead-flag discovery: accepts same-field value under a different dead guard', (t) => {
  const ast = astWithClasses([
    {
      className: 'client',
      items: [
        staticField('A', 'Z'),
        methodWith('consume', [
          { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
          { instruction: 'istore_1' },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifne', arg: 'Lret' } },
          { instruction: 'return' },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
    {
      className: 'hn',
      items: [staticField('j', 'Z')],
    },
    {
      className: 'Writer',
      items: [
        methodWith('toggleA', [
          { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
          { instruction: 'istore_1' },
          { instruction: { op: 'getstatic', arg: ['Field', 'hn', ['j', 'Z']] } },
          { instruction: { op: 'ifeq', arg: 'Lret' } },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifeq', arg: 'Ltrue' } },
          { instruction: 'iconst_0' },
          { instruction: { op: 'goto', arg: 'Lstore' } },
          { labelDef: 'Ltrue:', instruction: 'iconst_1' },
          { labelDef: 'Lstore:', instruction: { op: 'putstatic', arg: ['Field', 'client', ['A', 'Z']] } },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
  ]);
  const r = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.ok(r.fields.includes('client.A'));
  t.notOk(r.rejected.includes('client.A'));
  t.end();
});

test('dead-flag discovery: rejects writes guarded by the same field', (t) => {
  const ast = astWithClasses([
    {
      className: 'client',
      items: [
        staticField('A', 'Z'),
        methodWith('consume', [
          { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
          { instruction: 'istore_1' },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifne', arg: 'Lret' } },
          { instruction: 'return' },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
        methodWith('toggleA', [
          { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
          { instruction: 'istore_1' },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifeq', arg: 'Lret' } },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifeq', arg: 'Ltrue' } },
          { instruction: 'iconst_0' },
          { instruction: { op: 'goto', arg: 'Lstore' } },
          { labelDef: 'Ltrue:', instruction: 'iconst_1' },
          { labelDef: 'Lstore:', instruction: { op: 'putstatic', arg: ['Field', 'client', ['A', 'Z']] } },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
  ]);
  const r = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.notOk(r.fields.includes('client.A'));
  t.ok(r.rejected.includes('client.A'));
  t.end();
});

test('dead-flag discovery: accepts terminal self-increment int sentinel when enabled', (t) => {
  const ast = astWithClasses([
    {
      className: 'client',
      items: [
        staticField('G', 'I'),
        methodWith('consume', [
          { instruction: { op: 'getstatic', arg: ['Field', 'client', ['G', 'I']] } },
          { instruction: 'istore_1' },
          { instruction: 'iload_1' },
          { instruction: { op: 'ifne', arg: 'Lret' } },
          { instruction: 'return' },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
    {
      className: 'Writer',
      items: [
        methodWith('bumpAtTail', [
          { instruction: { op: 'getstatic', arg: ['Field', 'client', ['G', 'I']] } },
          { instruction: 'istore_3' },
          { instruction: { op: 'getstatic', arg: ['Field', 'wi', ['g', 'Z']] } },
          { instruction: { op: 'ifeq', arg: 'Lret' } },
          { instruction: { op: 'iinc', varnum: '3', incr: '1' } },
          { instruction: 'iload_3' },
          { instruction: { op: 'putstatic', arg: ['Field', 'client', ['G', 'I']] } },
          { instruction: { op: 'goto', arg: 'Lret' } },
          { labelDef: 'Ldead:', instruction: 'athrow' },
          { labelDef: 'Lret:', instruction: 'return' },
        ]),
      ],
    },
  ]);
  const disabled = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.notOk(disabled.fields.includes('client.G'));
  const enabled = discoverDeadStaticFlags(ast, {
    allowIntFlags: true,
    allowTerminalSelfIncrementFlags: true,
  });
  t.ok(enabled.fields.includes('client.G'));
  t.end();
});

// The "this write is unreachable" proof used to accept any earlier `ifeq` on a
// candidate field whose branch target sat textually after the `putstatic`.
// Textual order is not dominance: any goto, switch arm or exception-handler
// edge can re-enter the region with the guard already bypassed, and the write
// then executes. That is how `qd.Nb = wg.f` got deleted -- a live write
// silently removed, leaving a genuinely dynamic field folded to false.
test('dead-flag discovery: rejects a write reachable through a guard-bypassing edge', (t) => {
  const consume = methodWith('consume', [
    { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
    { instruction: 'istore_1' },
    { instruction: 'iload_1' },
    { instruction: { op: 'ifne', arg: 'Lret' } },
    { instruction: 'return' },
    { labelDef: 'Lret:', instruction: 'return' },
  ]);
  const ast = astWithClasses([
    { className: 'client', items: [staticField('A', 'Z'), consume] },
    // hn.j is never written, so it is a candidate always-false flag and its
    // `ifeq` is the guard the old textual check happily accepted.
    { className: 'hn', items: [staticField('j', 'Z')] },
    // Dyn.d is written unguarded, so it is not a candidate. Its branch is just
    // an ordinary edge -- and it jumps straight past the guard into the store.
    {
      className: 'Dyn',
      items: [staticField('d', 'Z'), methodWith('set', [
        { instruction: 'iconst_1' },
        { instruction: { op: 'putstatic', arg: ['Field', 'Dyn', ['d', 'Z']] } },
        { instruction: 'return' },
      ])],
    },
    {
      className: 'Writer',
      items: [methodWith('toggleA', [
        { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
        { instruction: 'istore_1' },
        { instruction: { op: 'getstatic', arg: ['Field', 'Dyn', ['d', 'Z']] } },
        { instruction: { op: 'ifne', arg: 'Lbypass' } },
        { instruction: { op: 'getstatic', arg: ['Field', 'hn', ['j', 'Z']] } },
        { instruction: { op: 'ifeq', arg: 'Lret' } },
        { instruction: 'iload_1' },
        { instruction: { op: 'ifeq', arg: 'Ltrue' } },
        { instruction: 'iconst_0' },
        { instruction: { op: 'goto', arg: 'Lstore' } },
        { labelDef: 'Ltrue:', instruction: 'iconst_1' },
        { instruction: { op: 'goto', arg: 'Lstore' } },
        // Reached without ever evaluating the hn.j guard.
        { labelDef: 'Lbypass:', instruction: 'iconst_1' },
        { labelDef: 'Lstore:', instruction: { op: 'putstatic', arg: ['Field', 'client', ['A', 'Z']] } },
        { labelDef: 'Lret:', instruction: 'return' },
      ])],
    },
  ]);
  const r = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.notOk(r.fields.includes('client.A'),
    'a write the guard does not dominate keeps the field alive');
  t.ok(r.rejected.includes('client.A'),
    'the field is explicitly rejected rather than silently accepted');
  t.end();
});

// A write that can only ever store zero cannot make the field true, so it needs
// no reachability argument at all -- the CFG proof must not be the only way in.
test('dead-flag discovery: accepts an unguarded write that can only store zero', (t) => {
  const ast = astWithClasses([
    {
      className: 'client',
      items: [staticField('A', 'Z'), methodWith('consume', [
        { instruction: { op: 'getstatic', arg: ['Field', 'client', ['A', 'Z']] } },
        { instruction: 'istore_1' },
        { instruction: 'iload_1' },
        { instruction: { op: 'ifne', arg: 'Lret' } },
        { instruction: 'return' },
        { labelDef: 'Lret:', instruction: 'return' },
      ])],
    },
    {
      className: 'Writer',
      items: [methodWith('clearA', [
        { instruction: 'iconst_0' },
        { instruction: { op: 'putstatic', arg: ['Field', 'client', ['A', 'Z']] } },
        { instruction: 'return' },
      ])],
    },
  ]);
  const r = discoverDeadStaticFlags(ast, { allowIntFlags: true });
  t.ok(r.fields.includes('client.A'),
    'a zero-only write does not defeat the always-false proof');
  t.notOk(r.rejected.includes('client.A'),
    'the zero-only write is not counted as a rejection either');
  t.end();
});
