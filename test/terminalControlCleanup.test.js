'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {finalizeControlFrames: finish} = require('../src/decompiler/javaAstEmitter');

test('late fallthrough exits lose their unused frame while guards and actions remain', () => {
  const source = 'while(true){Phase:{if(more()){step();if(flag==0)continue;}else{done();break Phase;}}tail();break;}after();';
  const result = finish(source);
  assert.equal(result.breaksRemoved, 1);
  assert.equal(result.labelsRemoved, 1);
  assert.equal(result.blocksUnwrapped, 1);
  assert.equal(result.source, 'while(true){if(more()){step();if(flag==0)continue;}else{done();}tail();break;}after();');
  assert.deepEqual(finish(result.source), {source: result.source, breaksRemoved: 0,
    labelsRemoved: 0, jumpsUnlabeled: 0, blocksUnwrapped: 0});
});

test('cleanup retains declaration scopes and early exits that skip actions', () => {
  const source = 'Exit:{int value=read();if(skip())break Exit;if(pick()){use(value);break Exit;}}after();';
  const result = finish(source);
  assert.equal(result.breaksRemoved, 1);
  assert.equal(result.labelsRemoved, 0);
  assert.equal(result.source, 'Exit:{int value=read();if(skip())break Exit;if(pick()){use(value);}}after();');
  const scoped = finish('Exit:{int value=read();if(pick()){use(value);break Exit;}}after();');
  assert.equal(scoped.labelsRemoved, 1);
  assert.equal(scoped.blocksUnwrapped, 0);
  assert.equal(scoped.source, '{int value=read();if(pick()){use(value);}}after();');
});

test('protected completion and pending finally transfers remain opaque', () => {
  for (const source of [
    'Exit:{try{work();break Exit;}finally{cleanup();}}after();',
    'Exit:{try{return value();}finally{break Exit;}}after();',
    'Exit:{try{work();}catch(RuntimeException failure){break Exit;}}after();',
    'Exit:{synchronized(lock){work();break Exit;}}after();',
    'Exit:{while(more()){work();break Exit;}}after();',
    'Exit:{switch(key){default:break Exit;}}after();',
  ]) assert.equal(finish(source).source, source);
  const source = 'try{Exit:{if(pick()){work();break Exit;}}}finally{cleanup();}after();';
  assert.equal(finish(source).source, 'try{if(pick()){work();}}finally{cleanup();}after();');
});

test('ambiguous syntax, nested execution and diagnostics do not admit late cleanup', () => {
  for (const source of [
    'Exit:{work();break Exit;} // diagnostics\n',
    'Exit:{work();break Exit;}\\u000a',
    'Exit:{work();break Missing;}',
    'Exit:{class Inner{void run(){}}work();break Exit;}',
    'Exit:{work();break Exit;}Exit:{}',
    'Exit:{work();break Exit;}' + ' '.repeat(400001),
  ]) assert.equal(finish(source).source, source);
});
