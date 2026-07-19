'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

const STRUCTURED_FEATURES_JASMIN = `.version 52 0
.class public super org/benf/cfr/tests/StructuredFeatureTest
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
Linit0: aload_0
Linit1: invokespecial Method java/lang/Object <init> ()V
Linit2: return
    .end code
.end method

.method public abs : (I)I
    .code stack 1 locals 2
L0: iload_1
L1: ifge L8
L4: iload_1
L5: ineg
L6: ireturn
L8: iload_1
L9: ireturn
L10:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/StructuredFeatureTest; from L0 to L10
            1 is value I from L0 to L10
        .end localvariabletable
    .end code
.end method

.method public static printChoice : (Z)V
    .code stack 2 locals 1
L20: iload_0
L21: ifeq L40
L24: getstatic Field java/lang/System out Ljava/io/PrintStream;
L27: ldc "yes"
L29: invokevirtual Method java/io/PrintStream print (Ljava/lang/String;)V
L32: goto L48
L40: getstatic Field java/lang/System out Ljava/io/PrintStream;
L43: ldc "no"
L45: invokevirtual Method java/io/PrintStream print (Ljava/lang/String;)V
L48: return
L49:
        .localvariabletable
            0 is flag Z from L20 to L49
        .end localvariabletable
    .end code
.end method

.method public static literalTrue : ()I
    .code stack 2 locals 0
Lliteral0: bipush 51
Lliteral1: bipush 49
Lliteral2: if_icmplt LliteralElse
Lliteral3: bipush 7
Lliteral4: ireturn
LliteralElse: bipush 9
LliteralElseReturn: ireturn
    .end code
.end method

.method public sumDown : (I)I
    .code stack 2 locals 3
L60: iconst_0
L61: istore_2
L62: iload_1
L63: ifle L77
L66: iload_2
L67: iload_1
L68: iadd
L69: istore_2
L70: iinc 1 -1
L73: goto L62
L77: iload_2
L78: ireturn
L79:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/StructuredFeatureTest; from L60 to L79
            1 is n I from L60 to L79
            2 is sum I from L62 to L79
        .end localvariabletable
    .end code
.end method

.method public makeArray : ()[I
    .code stack 4 locals 2
L90: iconst_3
L91: newarray int
L93: dup
L94: iconst_0
L95: iconst_1
L96: iastore
L97: dup
L98: iconst_1
L99: iconst_2
L100: iastore
L101: dup
L102: iconst_2
L103: iconst_3
L104: iastore
L105: astore_1
L106: aload_1
L107: areturn
L108:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/StructuredFeatureTest; from L90 to L108
            1 is values [I from L106 to L108
        .end localvariabletable
    .end code
.end method

.method public greater : (JJ)Z
    .code stack 4 locals 5
L120: lload_1
L121: lload_3
L122: lcmp
L123: ifle L130
L126: iconst_1
L127: goto L131
L130: iconst_0
L131: ireturn
L132:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/StructuredFeatureTest; from L120 to L132
            1 is left J from L120 to L132
            3 is right J from L120 to L132
        .end localvariabletable
    .end code
.end method

.method public widen : (I)J
    .code stack 2 locals 2
L140: iload_1
L141: i2l
L142: lreturn
L143:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/StructuredFeatureTest; from L140 to L143
            1 is value I from L140 to L143
        .end localvariabletable
    .end code
.end method

.method public makeGrid : (II)[[I
    .code stack 2 locals 3
L150: iload_1
L151: iload_2
L152: multianewarray [[I 2
L155: areturn
L156:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/StructuredFeatureTest; from L150 to L156
            1 is rows I from L150 to L156
            2 is cols I from L150 to L156
        .end localvariabletable
    .end code
.end method
.sourcefile "StructuredFeatureTest.java"
.end class
`;


const SWITCH_FEATURES_JASMIN = `.version 52 0
.class public super org/benf/cfr/tests/SwitchFeatureTest
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
Linit0: aload_0
Linit1: invokespecial Method java/lang/Object <init> ()V
Linit2: return
    .end code
.end method

.method public dispatch : (I)I
    .code stack 1 locals 2
L0: iload_1
L1: tableswitch 1
Lcase0
Lcase1
default : Ldefault
Lcase0: bipush 10
Lcase0b: ireturn
Lcase1: bipush 20
Lcase1b: ireturn
Ldefault: iconst_m1
Ldefaultb: ireturn
Lend:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/SwitchFeatureTest; from L0 to Lend
            1 is key I from L0 to Lend
        .end localvariabletable
    .end code
.end method

.method public lookup : (I)I
    .code stack 1 locals 2
L20: iload_1
L21: lookupswitch
10 : Lten
100 : Lhundred
default : LlookupDefault
Lten: iconst_1
Ltenb: ireturn
Lhundred: iconst_2
Lhundredb: ireturn
LlookupDefault: iconst_m1
LlookupDefaultb: ireturn
LlookupEnd:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/SwitchFeatureTest; from L20 to LlookupEnd
            1 is key I from L20 to LlookupEnd
        .end localvariabletable
    .end code
.end method

.method public syntheticSwitch : (I)V
    .code stack 2 locals 2
Ls0: iload_1
Ls1: iconst_0
Ls2: if_icmpeq LsCase0
Ls3: iload_1
Ls4: iconst_1
Ls5: if_icmpeq LsCase1
Ls6: goto LsDefault
LsCase0: getstatic Field java/lang/System out Ljava/io/PrintStream;
LsCase0b: ldc "zero"
LsCase0c: invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
LsCase0d: goto LsEnd
LsCase1: getstatic Field java/lang/System out Ljava/io/PrintStream;
LsCase1b: ldc "one"
LsCase1c: invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
LsCase1d: goto LsEnd
LsDefault: getstatic Field java/lang/System out Ljava/io/PrintStream;
LsDefaultb: ldc "other"
LsDefaultc: invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
LsDefaultd: goto LsEnd
LsEnd: return
LsDone:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/SwitchFeatureTest; from Ls0 to LsDone
            1 is key I from Ls0 to LsDone
        .end localvariabletable
    .end code
.end method
.sourcefile "SwitchFeatureTest.java"
.end class
`;

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function decompileStructuredFeatureFixture(tempDir) {
  const classPath = path.join(tempDir, 'StructuredFeatureTest.class');
  assembleJasminSource(STRUCTURED_FEATURES_JASMIN, classPath);
  return decompileClassFile(classPath);
}

test('CFR-JS reconstructs structured if, if/else, while, arrays, comparisons, and casts', (t) => {
  t.plan(14);
  withTempDir('cfr-structured-', (tempDir) => {
    const source = decompileStructuredFeatureFixture(tempDir);

    t.notOk(/stack-underflow/.test(source), 'decompilation does not underflow the operand stack');
    t.notOk(/^\s*\/\/\s*(if|goto|tableswitch|lookupswitch)\b/m.test(source), 'supported structured features do not fall back to raw control-flow comments');
    t.match(source, /public int abs\(int value\) \{\s*if \(value < 0\) \{\s*return -value;\s*}\s*return value;\s*}/, 'simple if-return is structured');
    t.match(source, /public static void printChoice\(boolean flag\) \{\s*if \(flag\) \{\s*System\.out\.print\("yes"\);\s*} else \{\s*System\.out\.print\("no"\);\s*}\s*}/, 'if/else print branch is structured');
    t.match(source, /public static int literalTrue\(\) \{\s*return 7;\s*}/, 'a true literal comparison emits its selected body directly');
    t.notOk(/51\s*>=\s*49|return 9;/.test(source), 'the constant condition and dead else body are omitted');
    t.match(source, /public int sumDown\(int n\) \{\s*int sum = 0;\s*while \(n > 0\) \{\s*sum = sum \+ n;\s*n--;\s*}\s*return sum;\s*}/, 'while loop with iinc is structured');
    t.match(source, /public int\[\] makeArray\(\) \{\s*int\[\] values = new int\[\]\{1, 2, 3\};\s*return values;\s*}/, 'primitive array literal stores are condensed');
    t.match(source, /public boolean greater\(long left, long right\) \{\s*return left > right;\s*}/, 'lcmp boolean return is reconstructed');
    t.match(source, /public long widen\(int value\) \{\s*return \(long\)value;\s*}/, 'primitive conversion casts are rendered');
    t.match(source, /public int\[\]\[\] makeGrid\(int rows, int cols\) \{\s*return new int\[rows\]\[cols\];\s*}/, 'multianewarray is rendered as a multi-dimensional array allocation');
    t.notOk(/return 1;|return 0;/.test(source), 'boolean returns are rendered as boolean expressions');
    t.notOk(/new int\[3\]\[/.test(source), 'array initialisation does not leak raw indexed stores');
    t.notOk(/compare\(/.test(source), 'comparison helper placeholder is not emitted');
  });
});


function decompileSwitchFeatureFixture(tempDir) {
  const classPath = path.join(tempDir, 'SwitchFeatureTest.class');
  assembleJasminSource(SWITCH_FEATURES_JASMIN, classPath);
  return decompileClassFile(classPath);
}

test('CFR-JS reconstructs tableswitch and lookupswitch blocks', (t) => {
  t.plan(9);
  withTempDir('cfr-switch-', (tempDir) => {
    const source = decompileSwitchFeatureFixture(tempDir);

    t.notOk(/^\s*\/\/\s*(tableswitch|lookupswitch)\b/m.test(source), 'switch bytecode does not fall back to raw comments');
    t.match(source, /public int dispatch\(int key\) \{\s*switch \(key\) \{\s*case 1:\s*return 10;\s*case 2:\s*return 20;\s*default:\s*return -1;\s*}\s*}/, 'tableswitch is reconstructed with its non-zero low key');
    t.match(source, /public int lookup\(int key\) \{\s*switch \(key\) \{\s*case 10:\s*return 1;\s*case 100:\s*return 2;\s*default:\s*return -1;\s*}\s*}/, 'lookupswitch is reconstructed as a switch statement');
    t.match(source, /public void syntheticSwitch\(int key\) \{\s*switch \(key\) \{\s*case 0:\s*System\.out\.println\("zero"\);\s*break;\s*case 1:\s*System\.out\.println\("one"\);\s*break;\s*default:\s*System\.out\.println\("other"\);\s*}\s*}/, 'if-chain switch lowering is reconstructed as a switch statement');
    t.match(source, /case 1:/, 'tableswitch low case is emitted');
    t.match(source, /case 2:/, 'tableswitch contiguous case is emitted');
    t.match(source, /case 10:/, 'lookupswitch sparse case is emitted');
    t.match(source, /case 100:/, 'lookupswitch second sparse case is emitted');
    t.match(source, /default:/, 'default switch label is emitted');
  });
});

test('CFR-JS reports state-machine fallback structurally', (t) => {
  t.plan(3);
  withTempDir('cfr-state-machine-diagnostic-', (tempDir) => {
    const classPath = path.join(tempDir, 'StructuredFeatureTest.class');
    const diagnostics = [];
    assembleJasminSource(STRUCTURED_FEATURES_JASMIN, classPath);
    const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
    process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
    let source;
    try {
      source = decompileClassFile(classPath, { diagnostics, forceOwnedStructurer: true });
    } finally {
      if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    }

    t.ok(source.includes('stateLoop: while (true)'), 'forced fallback emits the state-machine form');
    t.ok(diagnostics.length > 0, 'fallback is reported without parsing generated source');
    t.ok(diagnostics.every((item) => item.kind === 'stateMachineFallback'
      && item.reason === 'forced by CFR_JS_FORCE_STATE_MACHINE'), 'diagnostics retain method-level fallback reasons');
  });
});
