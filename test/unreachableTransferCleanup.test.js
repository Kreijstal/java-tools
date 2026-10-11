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
    'while(more()){try{if(stop())continue;}finally{cleanup();}break;}'])
    assert.equal(clean(source).source, source);
});

test('protected scopes, overriding finally exits and quoted braces stay intact', () => {
  const source = 'Outer:while(more()){try{work("{break;}");continue Outer;break;}finally{cleanup();if(stop())break Outer;}}';
  const result = clean(source);
  assert.equal(result.transfersRemoved, 1);
  assert.equal(result.source, 'Outer:while(more()){try{work("{break;}");continue Outer;}finally{cleanup();if(stop())break Outer;}}');
  assert.equal(clean('while(more()){try{continue;}finally{cleanup();}break;}').source,
    'while(more()){try{continue;}finally{cleanup();}}', 'an unconditional pending continue cannot reach the following break');
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

test('nested endless loops remove newly exposed dead transfers to a fixed point', () => {
  const source = 'Outer:while(flag){while(true){while(true){continue Outer;}break;}break;}';
  const result = clean(source);
  assert.equal(result.transfersRemoved, 2);
  assert.equal(result.source, 'Outer:while(flag){while(true){while(true){continue Outer;}}}');
  assert.equal(clean(result.source).transfersRemoved, 0);
  const reachable = 'Outer:while(flag){while(true){while(true){if(stop())break;continue Outer;}break;}break;}';
  assert.equal(clean(reachable).source, reachable, 'genuine nested exits still reach the later breaks');
});

test('complete alternatives prove only transfers after two abrupt arms unreachable', () => {
  const source = 'Outer:while(flag){if(choice){while(true){break Outer;}}else{while(true){continue Outer;}}break;}';
  assert.equal(clean(source).transfersRemoved, 1);
  assert.equal(clean(source).source, source.replace('}break;}', '}}'));
  for (const reachable of ['while(flag){if(choice){while(true){if(stop())break;}}else{return;}break;}',
    'while(flag){if(choice){Exit:{break Exit;}}else{return;}break;}',
    'while(flag){if(choice){return;}break;}']) assert.equal(clean(reachable).source, reachable);
});

test('synthetic literal return footers preserve complete protected completion', () => {
  const source = 'try{if(accepted){event(0,mask);return true;}event(1,mask);return false;}catch(IllegalStateException failure){event(2,mask);throw failure;}finally{event(3,mask);if(mode==1)return false;if(mode==2)throw OVERRIDE;}return false;';
  const result = clean(source);
  assert.equal(result.transfersRemoved, 1);
  assert.equal(result.source, source.slice(0, -13));
  for (const reachable of ['try{if(choice)return true;work();}catch(E failure){return false;}return false;',
    'try{return true;}catch(E failure){work();}return false;',
    'try{work();}finally{Exit:{break Exit;}}return false;',
    'try{return true;}catch(E failure){throw failure;}return callback();',
    'try{return true;}catch(E failure){throw failure;}return /* retained */ false;']) assert.equal(clean(reachable).source, reachable);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-return-footer-'));
  const run = (command, args) => {const output = spawnSync(command, args, {encoding: 'utf8'});assert.equal(output.status, 0, output.stderr || output.stdout);return output.stdout.trim();};
  try {
    fs.writeFileSync(path.join(temporary, 'ProtectedFooter.java'), `public class ProtectedFooter {
static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();static StringBuilder trace;
static void event(int stage,int mask){trace.append(stage);if((mask&(1<<stage))!=0)throw FAILURE;}
static boolean next(boolean accepted,int mask,int mode){${result.source}}
static boolean oracle(boolean accepted,int mask,int mode){Throwable pending=null;try{event(accepted?0:1,mask);}catch(IllegalStateException failure){try{event(2,mask);pending=failure;}catch(Throwable replacement){pending=replacement;}}boolean finallyFailed=false;try{event(3,mask);}catch(Throwable replacement){pending=replacement;finallyFailed=true;}if(!finallyFailed){if(mode==1)return false;if(mode==2)pending=OVERRIDE;}if(pending!=null)throw (RuntimeException)pending;return accepted;}
static String take(boolean readable,boolean accepted,int mask,int mode){trace=new StringBuilder();String value;try{value=""+(readable?next(accepted,mask,mode):oracle(accepted,mask,mode));}catch(Throwable failure){value=failure==FAILURE?"failure":failure==OVERRIDE?"override":"unexpected";}return value+":"+trace;}
public static void main(String[] args){int cases=0;for(boolean accepted:new boolean[]{false,true})for(int mask=0;mask<16;mask++)for(int mode=0;mode<3;mode++){if(!take(true,accepted,mask,mode).equals(take(false,accepted,mask,mode)))throw new AssertionError();cases++;}System.out.println(cases);}}
`);
    run('javac', ['--release', '8', '-d', temporary, path.join(temporary, 'ProtectedFooter.java')]);
    assert.equal(run('java', ['-cp', temporary, 'ProtectedFooter']), '96');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

test('a reconstructed endless scan compiles and preserves effects and failures', () => {
  const source = 'int index=0;while(enter){while(true){if(index>=stop)return trace.toString();switch(index){case 0:event(index++,fail);break;default:event(index++,fail);} }break;}return trace.toString();';
  const next = clean(source);
  assert.equal(next.transfersRemoved, 1);
  const nestedSource = 'int index=0;Outer:while(enter){while(true){while(true){if(index>=stop)return trace.toString();event(index++,fail);continue Outer;}break;}break;}return trace.toString();';
  const nested = clean(nestedSource);
  assert.equal(nested.transfersRemoved, 2);
  const alternatives = clean('int index=0;Outer:while(enter){if(index%2==0){while(true){if(index>=stop)return trace.toString();event(index++,fail);continue Outer;}}else{while(true){if(index>=stop)return trace.toString();event(index++,fail);continue Outer;}}break;}return trace.toString();');
  assert.equal(alternatives.transfersRemoved, 1);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-transfer-native-'));
  const run = (command, args) => {const result = spawnSync(command, args, {encoding: 'utf8'});assert.equal(result.status, 0, result.stderr || result.stdout);return result.stdout.trim();};
  try {
    fs.writeFileSync(path.join(temporary, 'EndlessScan.java'), `public class EndlessScan {
static StringBuilder trace;static void event(int index,int fail){trace.append(index);if(index==fail)throw new IllegalStateException();}
static String next(boolean enter,int stop,int fail){${next.source}}
static String nested(boolean enter,int stop,int fail){${nested.source}}
static String alternatives(boolean enter,int stop,int fail){${alternatives.source}}
static String oracle(boolean enter,int stop,int fail){if(enter)for(int index=0;index<stop;index++)event(index,fail);return trace.toString();}
static String take(int variant,boolean enter,int stop,int fail){trace=new StringBuilder();try{return variant==0?oracle(enter,stop,fail):variant==1?next(enter,stop,fail):variant==2?nested(enter,stop,fail):alternatives(enter,stop,fail);}catch(IllegalStateException exception){return "failure:"+trace;}}
public static void main(String[] args){int cases=0;for(boolean enter:new boolean[]{false,true})for(int stop=-1;stop<5;stop++)for(int fail=-1;fail<5;fail++){for(int variant=1;variant<4;variant++)if(!take(variant,enter,stop,fail).equals(take(0,enter,stop,fail)))throw new AssertionError();cases++;}System.out.println(cases+" scan cases");}}
`);
    run('javac', ['--release', '8', '-d', temporary, path.join(temporary, 'EndlessScan.java')]);
    assert.equal(run('java', ['-cp', temporary, 'EndlessScan']), '72 scan cases');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
