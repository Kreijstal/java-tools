'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {decompileClassFile, _internals: {formatBlock}} = require('../src/decompiler/cfr');

test('late synthesized return footers compile after protected complete returns', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-late-return-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, {encoding: 'utf8', timeout: 30000});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    const native = path.join(temporary, 'native'), readable = path.join(temporary, 'readable');
    fs.mkdirSync(native); fs.mkdirSync(readable);
    const body = `try{
if((value<=0||128<=value)&&(value<160||255<value)){
if(value!=0){for(int i=0;i<values.length;i++){int selected=values[i];event();if(~value==~selected)return true;}}
if(mode>=1)return false;event();return false;}return true;
}catch(RuntimeException failure){throw new IllegalArgumentException(failure);}`;
    const fixture = `public class ProtectedComplete {
static int calls, failAt; static int[] values={128,1000};
public static void reset(int fail){calls=0;failAt=fail;}public static int count(){return calls;}
static void event(){if(calls++==failAt)throw new IllegalStateException("pending");}
public static boolean check(int value,int mode){${body}}
}`;
    const driver = `public class Driver {
public static void main(String[] args){int count=0;for(int value:new int[]{-1,0,65,128,160,255,256,1000})for(int mode=-1;mode<3;mode++)for(int fail=-1;fail<4;fail++){
ProtectedComplete.reset(fail);String result;
try{result=""+ProtectedComplete.check(value,mode);}catch(Throwable failure){result=failure.getClass().getName()+":"+failure.getCause().getClass().getName();}
System.out.println(value+":"+mode+":"+fail+":"+result+":"+ProtectedComplete.count());count++;}System.out.println(count);}}
`;
    fs.writeFileSync(path.join(native, 'ProtectedComplete.java'), fixture);
    fs.writeFileSync(path.join(temporary, 'Driver.java'), driver);
    run('javac', ['--release', '8', '-d', native, path.join(native, 'ProtectedComplete.java'), path.join(temporary, 'Driver.java')]);
    const source = decompileClassFile(path.join(native, 'ProtectedComplete.class'));
    fs.writeFileSync(path.join(readable, 'ProtectedComplete.java'), source);
    run('javac', ['--release', '8', '-d', readable, path.join(readable, 'ProtectedComplete.java'), path.join(temporary, 'Driver.java')]);
    assert.equal(run('java', ['-cp', readable, 'Driver']), run('java', ['-cp', native, 'Driver']));
    // Final emission must also clean a footer appended after reconstruction.
    const late = formatBlock('public static boolean check(int value,int mode)', [...body.split('\n'), 'return false;']);
    fs.writeFileSync(path.join(readable, 'ProtectedComplete.java'), fixture.replace(`public static boolean check(int value,int mode){${body}}`, late));
    run('javac', ['--release', '8', '-d', readable, path.join(readable, 'ProtectedComplete.java'), path.join(temporary, 'Driver.java')]);
    assert.equal(run('java', ['-cp', readable, 'Driver']), run('java', ['-cp', native, 'Driver']));
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
