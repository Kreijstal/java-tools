'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {removeUnreachableControlTransfers: clean} = require('../src/decompiler/unreachableTransferCleanup');

test('unconditional transfers expose only an unreachable following transfer', () => {
  const source = 'Outer:while(more()){continue Outer;break;}';
  assert.equal(clean(source).source, 'Outer:while(more()){continue Outer;}');
  assert.equal(clean(source).transfersRemoved, 1);
  assert.equal(clean(clean(source).source).transfersRemoved, 0);
});

test('conditional exits, later work and declarations stay intact', () => {
  for (const source of ['while(more()){if(stop())continue;break;}',
    'while(more()){if(stop())return;break;}',
    'while(more()){continue;work();break;}',
    'while(more()){continue;int retained=read();break;}',
    'while(more()){try{continue;}finally{cleanup();}break;}'])
    assert.equal(clean(source).source, source);
});

test('protected scopes, overriding finally exits and quoted braces stay intact', () => {
  const source = 'Outer:while(more()){try{work("{break;}");continue Outer;break;}finally{cleanup();if(stop())break Outer;}}';
  const result = clean(source);
  assert.equal(result.transfersRemoved, 1);
  assert.equal(result.source, 'Outer:while(more()){try{work("{break;}");continue Outer;}finally{cleanup();if(stop())break Outer;}}');
});

test('comments, captured bodies and unsupported source are not rewritten blindly', () => {
  assert.equal(clean('while(more()){continue; /* retained */ break;}').source,
    'while(more()){continue; /* retained */ }');
  for (const source of ['Runnable action=()->{while(more()){continue;break;}};',
    'while(more()){continue;break /* retained */;}', 'while(more()){continue;break;',
    'while(more()){continue;\\u0062reak;}'])
    assert.equal(clean(source).source, source);
});
