'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
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

test('literal infinite loops retain every break that can reach their endpoint', () => {
  for (const source of ['while(more()){while(true){if(stop())break;}break;}',
    'while(more()){Loop:while(true){while(more()){break Loop;}}break;}',
    'while(more()){while(true){if(false)break;}break;}',
    'while(more()){while(flag){work();}break;}',
    'while(more()){for(;flag;){work();}break;}',
    'while(more()){do{work();}while(flag);break;}',
    'while(more()){while(Boolean.TRUE){work();}break;}']) assert.equal(clean(source).source, source);
  for (const loop of ['while(true)', 'while((true))', 'for(;;)', 'do']) {
    const source = `while(more()){${loop}{switch(choice()){case 1:break;default:return;}work();}${loop === 'do' ? 'while(true);' : ''}break;}`;
    assert.equal(clean(source).transfersRemoved, 1, source);
  }
});

test('a reconstructed endless scan compiles and preserves effects and failures', () => {
  const source = 'int index=0;while(enter){while(true){if(index>=stop)return trace.toString();switch(index){case 0:event(index++,fail);break;default:event(index++,fail);} }break;}return trace.toString();';
  const next = clean(source);
  assert.equal(next.transfersRemoved, 1);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-transfer-native-'));
  const run = (command, args) => {const result = spawnSync(command, args, {encoding: 'utf8'});assert.equal(result.status, 0, result.stderr || result.stdout);return result.stdout.trim();};
  try {
    fs.writeFileSync(path.join(temporary, 'EndlessScan.java'), `public class EndlessScan {
static StringBuilder trace;static void event(int index,int fail){trace.append(index);if(index==fail)throw new IllegalStateException();}
static String next(boolean enter,int stop,int fail){${next.source}}
static String oracle(boolean enter,int stop,int fail){if(enter)for(int index=0;index<stop;index++)event(index,fail);return trace.toString();}
static String take(boolean readable,boolean enter,int stop,int fail){trace=new StringBuilder();try{return readable?next(enter,stop,fail):oracle(enter,stop,fail);}catch(IllegalStateException exception){return "failure:"+trace;}}
public static void main(String[] args){int cases=0;for(boolean enter:new boolean[]{false,true})for(int stop=-1;stop<5;stop++)for(int fail=-1;fail<5;fail++){if(!take(true,enter,stop,fail).equals(take(false,enter,stop,fail)))throw new AssertionError();cases++;}System.out.println(cases+" scan cases");}}
`);
    run('javac', ['--release', '8', '-d', temporary, path.join(temporary, 'EndlessScan.java')]);
    assert.equal(run('java', ['-cp', temporary, 'EndlessScan']), '72 scan cases');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
