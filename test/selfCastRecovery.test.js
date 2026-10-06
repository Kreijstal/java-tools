'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {simplifySelfCasts} = require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails: finish} = require('../src/decompiler/cfr')._internals;
const options = {selfType: {sourceName: 'Owner', typeParameters: []}};
const fold = (source, extra = {}) => simplifySelfCasts(source, {...options, ...extra});

test('the final emitter removes exact erased self casts without changing ordinary receiver casts', () => {
  const source = '((Owner) (this)).field = 1; call((Owner) (this)); Owner other = (Owner) receiver;', body = [source];
  finish(body, [], [], {owner: 'Owner', fields: []});
  assert.equal(body.join('\n'), 'this.field = 1; call(this); Owner other = (Owner) receiver;');
  assert.equal(fold(body.join('\n')).castsRemoved, 0);
});

test('parentheses and repeated exact self casts collapse in expression positions', () => {
  const source = 'return (((Owner)(Owner)(this)));', result = fold(source, {retainDiagnostics: true});
  assert.equal(result.source, 'return this;'); assert.equal(result.castsRemoved, 2);
  assert.equal(result.expressionsSimplified, 1);
  for (const d of result.diagnostics.selections) {
    assert.equal(source.slice(d.thisRange.start, d.thisRange.end), 'this');
    for (const r of d.typeRanges) assert.equal(source.slice(r.start, r.end), 'Owner');
    for (const r of d.castRanges) assert.equal(source.slice(r.start, r.end), '(Owner)');
  }
  assert.equal(fold('return (sample.Owner) (this);', {selfType: {sourceName: 'sample.Owner', typeParameters: []}}).source, 'return this;');
});

test('call, constructor, control and monitor parentheses stay syntactically distinct', () => {
  for (const [source, expected] of [
    ['call((Owner)this);', 'call(this);'], ['new Holder((Owner)this);', 'new Holder(this);'],
    ['synchronized((Owner)this){use();}', 'synchronized(this){use();}'],
    ['if (((Owner)this).ready()) use(); else other();', 'if (this.ready()) use(); else other();'],
    ['while(((Owner)this).ready()){break;}', 'while(this.ready()){break;}'],
    ['return(Owner)this;', 'return this;'], ['if((Owner)this instanceof Parent) use();', 'if(this instanceof Parent) use();'],
  ]) assert.equal(fold(source).source, expected, source);
});

test('other static types, boxing, nullable receivers and qualified enclosing this remain', () => {
  const source = 'use((Parent)this);use((Child)this);use((Object)this);use((Owner)null);use((Owner)other);use((Owner)outer.value);use((Object)number);';
  assert.equal(fold(source).source, source);
  assert.equal(fold(source + 'use((Owner)this);').source, source + 'use(this);');
  assert.equal(fold('use((Owner)Outer.this);use((Owner)this);').source, 'use((Owner)Outer.this);use((Owner)this);');
  for (const selfType of [undefined, {}, {sourceName: 'Owner'}, {sourceName: 'Owner', typeParameters: ['T']}, {sourceName: 'Owner[]', typeParameters: []}]) assert.equal(fold('use((Owner)this);', {selfType}).castsRemoved, 0);
  assert.equal(fold('use((Owner<String>)this);').castsRemoved, 0);
});

test('nested execution, annotations, translated offsets and limits refuse', () => {
  for (const source of ['use((Owner)this); // comment\n', 'use((Owner)this);\\u000a', 'use((Owner)this);Runnable action=()->use();',
    'use((Owner)this);Object action=new Object(){};', 'use((@Anno Owner)this);', 'use((Owner)this);if(',
    'use((Owner)this);' + ' '.repeat(400001), 'use((Owner)this);'.repeat(1025)]) assert.equal(fold(source).source, source, source.slice(0, 80));
  assert.equal(fold('use((Owner)this);', {retainDiagnostics: 1}).castsRemoved, 0);
});

test('native exact self casts preserve overloads, field hiding, aliases, checks and protected completion', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'self-cast-native-'));
  const run = (command, args) => {const r = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();};
  const contexts = [s => s, s => `try{${s}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    s => `synchronized((Owner)this){event(6);if(!Thread.holdsLock(this))throw new AssertionError();${s}}`,
    s => `try{${s}}catch(ClassCastException failure){event(8);}finally{event(7);}`,
    s => `try{synchronized((Owner)this){event(6);${s}}}finally{event(7);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    s => `{${s}}`];
  const actions = `((Owner)(this)).value=seed;event(1);choice((Owner)(this));choice((Parent)this);if(((Owner)this).value!=seed)throw new AssertionError();Owner alias=(Owner)this;if(alias!=this)throw new AssertionError();Holder holder=new Holder((Owner)this);if(holder.owner!=this)throw new AssertionError();((Owner)this).value=((Owner)this).value+((Parent)this).value;event(2);Owner checked=(Owner)candidate;if(inject==1)throw FAILURE;if(checked!=null)checked.value=checked.value+1;boxed=(Object)Integer.valueOf(seed);if(inject==2)throw FAILURE;event(3);`;
  const oracle = `this.value=seed;event(1);choice(this);choice((Parent)this);if(this.value!=seed)throw new AssertionError();Owner alias=this;if(alias!=this)throw new AssertionError();Holder holder=new Holder(this);if(holder.owner!=this)throw new AssertionError();this.value=this.value+((Parent)this).value;event(2);Owner checked=(Owner)candidate;if(inject==1)throw FAILURE;if(checked!=null)checked.value=checked.value+1;boxed=(Object)Integer.valueOf(seed);if(inject==2)throw FAILURE;event(3);`;
  try {
    let methods = '';
    for (let i = 0; i < contexts.length; i++) {
      const source = contexts[i](actions) + 'return snapshot();', result = fold(source);
      assert.ok(result.castsRemoved >= 7);
      methods += `String old${i}(int seed,Parent candidate,int inject,int mode){${source}}\nString next${i}(int seed,Parent candidate,int inject,int mode){${result.source}}\nString oracle${i}(int seed,Parent candidate,int inject,int mode){${contexts[i](oracle)}return snapshot();}\n`;
    }
    const fixture = `class Parent{int value=17;}class Holder{Owner owner;Holder(Owner owner){this.owner=owner;}}public class Owner extends Parent{
int value,effects;Object boxed;StringBuilder trace;static final RuntimeException FAILURE=new IllegalStateException("failure"),OVERRIDE=new IllegalStateException("finally");
void event(int stage){effects=effects*31+stage;trace.append((char)('a'+stage));}void choice(Owner owner){if(owner!=this)throw new AssertionError();event(4);}void choice(Parent parent){if(parent!=this)throw new AssertionError();event(5);}String snapshot(){return value+":"+((Parent)this).value+":"+effects+":"+trace+":"+(boxed==null?"null":boxed);}
${methods}
String take(int kind,int variant,int seed,int candidateKind,int inject,int mode){value=seed^19;effects=seed;trace=new StringBuilder();boxed=null;Parent candidate=candidateKind==0?this:candidateKind==1?new Parent():null;String result;try{switch(kind){${contexts.map((_, i) => `case ${i}:result=variant==0?old${i}(seed,candidate,inject,mode):variant==1?next${i}(seed,candidate,inject,mode):oracle${i}(seed,candidate,inject,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){result=failure==FAILURE?"failure":failure==OVERRIDE?"override":failure.getClass().getName();}if(Thread.holdsLock(this))throw new AssertionError("monitor leaked");return result+":"+snapshot();}
public static void main(String[] args){int cases=0;Owner owner=new Owner();for(int kind=0;kind<6;kind++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int candidateKind=0;candidateKind<3;candidateKind++)for(int inject=0;inject<3;inject++)for(int mode=0;mode<3;mode++){String want=owner.take(kind,2,seed,candidateKind,inject,mode);for(int variant=0;variant<2;variant++){String got=owner.take(kind,variant,seed,candidateKind,inject,mode);if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+want+":"+got);}cases++;}System.out.println(cases+" independent cases / 6 contexts");}}
`;
    const file = path.join(temporary, 'Owner.java'); fs.writeFileSync(file, fixture); run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-Xmx128m', '-cp', temporary, 'Owner']), '810 independent cases / 6 contexts');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
