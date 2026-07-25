'use strict';

const test = require('tape');
const { invertConditionalGotos } = require('../src/conditionInverterCfg');

function block(id, successors = [], instruction = 'nop') {
  return {
    id,
    successors,
    instructions: [{ instruction }],
  };
}

test('condition inverter retains backedge state when paths merge', (t) => {
  const conditional = block('conditional', ['target', 'start'], { op: 'ifne', arg: 'target' });
  const cfg = {
    blocks: new Map([
      ['conditional', conditional],
      ['start', block('start', ['loopEntry', 'direct'])],
      ['direct', block('direct', ['merge'])],
      ['merge', block('merge', ['target'])],
      ['target', block('target')],
      ['loopEntry', block('loopEntry', ['loopBody'])],
      ['loopBody', block('loopBody', ['merge', 'loopEntry'])],
    ]),
  };

  const result = invertConditionalGotos(cfg);
  t.equal(result.fixed, 1, 'path reaching the merge with a backedge is detected');
  t.equal(conditional.instructions[0].instruction.op, 'ifeq', 'conditional is inverted');
  t.end();
});
