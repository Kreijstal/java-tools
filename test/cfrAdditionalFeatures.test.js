'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

const ADDITIONAL_FEATURES_JASMIN = `.version 52 0
.class public super org/benf/cfr/tests/AdditionalFeatureTest
.super java/lang/Object

.field public static final READY Z= 1

.method public <init> : ()V
    .code stack 1 locals 1
Linit0: aload_0
Linit1: invokespecial Method java/lang/Object <init> ()V
Linit2: return
    .end code
.end method

.method public chooseInt : (Z)I
    .code stack 1 locals 2
L0: iload_1
L1: ifeq Lfalse
L4: bipush 10
L6: goto Lend
Lfalse: bipush 20
Lend: ireturn
Ldone:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L0 to Ldone
            1 is flag Z from L0 to Ldone
        .end localvariabletable
    .end code
.end method

.method public both : (ZZ)Z
    .code stack 1 locals 3
L10: iload_1
L11: ifeq LbothFalse
L14: iload_2
L15: ifeq LbothFalse
L18: iconst_1
L19: goto LbothEnd
LbothFalse: iconst_0
LbothEnd: ireturn
LbothDone:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L10 to LbothDone
            1 is left Z from L10 to LbothDone
            2 is right Z from L10 to LbothDone
        .end localvariabletable
    .end code
.end method

.method public either : (ZZ)Z
    .code stack 1 locals 3
L30: iload_1
L31: ifne LeitherTrue
L34: iload_2
L35: ifeq LeitherFalse
LeitherTrue: iconst_1
L39: goto LeitherEnd
LeitherFalse: iconst_0
LeitherEnd: ireturn
LeitherDone:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L30 to LeitherDone
            1 is left Z from L30 to LeitherDone
            2 is right Z from L30 to LeitherDone
        .end localvariabletable
    .end code
.end method

.method public condAssignNoDup : (ZZ)Z
    .code stack 2 locals 4
Lcad0: iload 2
Lcad2: ifeq Lcad25
Lcad5: iload 1
Lcad7: iload 2
Lcad9: istore 3
Lcad11: iload 3
Lcad13: if_icmpeq Lcad20
Lcad16: iconst_0
Lcad17: goto Lcad21
Lcad20: iconst_1
Lcad21: nop
Lcad22: goto Lcad27
Lcad25: nop
Lcad26: iconst_0
Lcad27: nop
Lcad28: ifeq Lcad35
Lcad31: iconst_1
Lcad32: goto Lcad53
Lcad35: nop
Lcad36: iload 2
Lcad38: ifeq Lcad50
Lcad41: iload 1
Lcad43: istore 3
Lcad45: iload 3
Lcad47: goto Lcad52
Lcad50: nop
Lcad51: iconst_0
Lcad52: nop
Lcad53: nop
Lcad54: ireturn
LcadDone:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from Lcad0 to LcadDone
            1 is a Z from Lcad0 to LcadDone
            2 is b Z from Lcad0 to LcadDone
            3 is c Z from Lcad11 to LcadDone
        .end localvariabletable
    .end code
.end method

.method public guard : (Z)V
    .code stack 3 locals 2
L40: iload_1
L41: ifeq LguardFalse
L44: iconst_0
L45: goto LguardJoin
LguardFalse: iconst_1
LguardJoin: ifeq LguardDone
L49: new java/lang/RuntimeException
L52: dup
L53: ldc "bad"
L55: invokespecial Method java/lang/RuntimeException <init> (Ljava/lang/String;)V
L58: athrow
LguardDone: return
LguardEnd:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L40 to LguardEnd
            1 is ok Z from L40 to LguardEnd
        .end localvariabletable
    .end code
.end method

.method public printChoice : (ZLjava/io/PrintStream;Ljava/lang/String;Ljava/lang/String;)V
    .code stack 2 locals 5
L65: aload_2
L66: iload_1
L67: ifeq LchoiceFalse
L70: aload_3
L71: goto LchoiceJoin
LchoiceFalse: aload 4
LchoiceJoin: invokevirtual Method java/io/PrintStream print (Ljava/lang/String;)V
L76: return
LchoiceEnd:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L65 to LchoiceEnd
            1 is flag Z from L65 to LchoiceEnd
            2 is out Ljava/io/PrintStream; from L65 to LchoiceEnd
            3 is yes Ljava/lang/String; from L65 to LchoiceEnd
            4 is no Ljava/lang/String; from L65 to LchoiceEnd
        .end localvariabletable
    .end code
.end method

.method public bounds : (I)V
    .code stack 2 locals 2
L80: iload_1
L81: iconst_0
L82: if_icmpge LboundsSecond
L85: iconst_1
L86: goto LboundsJoin
LboundsSecond: iload_1
L89: bipush 100
L91: if_icmpge LboundsHigh
L94: iconst_0
L95: goto LboundsInnerJoin
LboundsHigh: iconst_1
LboundsInnerJoin: nop
LboundsJoin: nop
L99: ifeq LboundsDone
L102: new java/lang/RuntimeException
L105: dup
L106: ldc "bounds"
L108: invokespecial Method java/lang/RuntimeException <init> (Ljava/lang/String;)V
L111: athrow
LboundsDone: return
LboundsEnd:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L80 to LboundsEnd
            1 is value I from L80 to LboundsEnd
        .end localvariabletable
    .end code
.end method

.method public countDownOnce : (I)I
    .code stack 2 locals 3
L50: iconst_0
L51: istore_2
Lloop: iload_2
L53: iconst_1
L54: iadd
L55: istore_2
L56: iinc 1 -1
L59: iload_1
L60: ifgt Lloop
L63: iload_2
L64: ireturn
LdoneLoop:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L50 to LdoneLoop
            1 is n I from L50 to LdoneLoop
            2 is count I from Lloop to LdoneLoop
        .end localvariabletable
    .end code
.end method

.method public sumFor : (I)I
    .code stack 2 locals 4
L170: iconst_0
L171: istore_3
L172: iconst_0
L173: istore_2
LforLoop: iload_2
L175: iload_1
L176: if_icmpge LforEnd
L179: iload_3
L180: iload_2
L181: iadd
L182: istore_3
L183: iinc 2 1
L186: goto LforLoop
LforEnd: iload_3
L190: ireturn
LdoneFor:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L170 to LdoneFor
            1 is n I from L170 to LdoneFor
            2 is i I from L172 to LdoneFor
            3 is sum I from L170 to LdoneFor
        .end localvariabletable
    .end code
.end method

.method public words : ()[Ljava/lang/String;
    .code stack 4 locals 2
L70: iconst_2
L71: anewarray java/lang/String
L74: dup
L75: iconst_0
L76: ldc "alpha"
L78: aastore
L79: dup
L80: iconst_1
L81: ldc "beta"
L83: aastore
L84: astore_1
L85: aload_1
L86: areturn
LdoneWords:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L70 to LdoneWords
            1 is words [Ljava/lang/String; from L85 to LdoneWords
        .end localvariabletable
    .end code
.end method

.method public greet : (Ljava/lang/String;)Ljava/lang/String;
    .code stack 2 locals 2
L90: new java/lang/StringBuilder
L93: dup
L94: invokespecial Method java/lang/StringBuilder <init> ()V
L97: ldc "Hello "
L99: invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
L102: aload_1
L103: invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
L106: ldc "!"
L108: invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
L111: invokevirtual Method java/lang/StringBuilder toString ()Ljava/lang/String;
L114: areturn
LdoneGreet:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L90 to LdoneGreet
            1 is name Ljava/lang/String; from L90 to LdoneGreet
        .end localvariabletable
    .end code
.end method

.method public syncPrint : (Ljava/lang/Object;)V
    .code stack 2 locals 4
        .catch java/lang/Throwable from LsyncBody to LsyncExit using LsyncHandler
L120: aload_1
L121: dup
L122: astore_2
L123: monitorenter
LsyncBody: getstatic Field java/lang/System out Ljava/io/PrintStream;
L127: ldc "locked"
L129: invokevirtual Method java/io/PrintStream print (Ljava/lang/String;)V
LsyncExit: aload_2
L132: monitorexit
L133: return
LsyncHandler: astore_3
L136: aload_2
L137: monitorexit
L138: aload_3
L139: athrow
LdoneSync:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L120 to LdoneSync
            1 is lock Ljava/lang/Object; from L120 to LdoneSync
        .end localvariabletable
    .end code
.end method

.method public echoLines : (Ljava/io/BufferedReader;)V
    .code stack 2 locals 3
LechoLoop: nop
LechoRead: aload_1
LechoCall: invokevirtual Method java/io/BufferedReader readLine ()Ljava/lang/String;
LechoStore: astore_2
LechoLoad: aload_2
LechoNull: aconst_null
LechoIf: if_acmpeq LechoDone
LechoOut: getstatic Field java/lang/System out Ljava/io/PrintStream;
LechoLine: aload_2
LechoPrint: invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
LechoBack: goto LechoLoop
LechoDone: return
LechoEnd:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from LechoLoop to LechoEnd
            1 is reader Ljava/io/BufferedReader; from LechoLoop to LechoEnd
            2 is line Ljava/lang/String; from LechoLoad to LechoEnd
        .end localvariabletable
    .end code
.end method

.method public throwsIt : ()V
    .code stack 0 locals 1
L150: return
L151:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from L150 to L151
        .end localvariabletable
    .end code
    .exceptions java/io/IOException
.end method

.method public static varargs acceptAll : ([Ljava/lang/String;)V
    .code stack 0 locals 1
L160: return
L161:
        .localvariabletable
            0 is args [Ljava/lang/String; from L160 to L161
        .end localvariabletable
    .end code
.end method

.method public releaseResource : (Ljava/io/ByteArrayInputStream;Ljava/lang/Throwable;)V
    .code stack 2 locals 4
        .catch java/lang/Throwable from LtwrClose to LtwrAfterClose using LtwrHandler
LtwrStart: aload_1
LtwrNull: aconst_null
LtwrIfNull: if_acmpeq LtwrDone
LtwrPrimary: aload_2
LtwrPrimaryNull: aconst_null
LtwrIfPrimaryNull: if_acmpeq LtwrDirect
LtwrClose: aload_1
LtwrCall: invokevirtual Method java/io/ByteArrayInputStream close ()V
LtwrAfterClose: goto LtwrJoin
LtwrHandler: astore_3
LtwrSuppressedPrimary: aload_2
LtwrSuppressedThrown: aload_3
LtwrAddSuppressed: invokevirtual Method java/lang/Throwable addSuppressed (Ljava/lang/Throwable;)V
LtwrAfterSuppressed: goto LtwrJoin
LtwrJoin: goto LtwrDone
LtwrDirect: aload_1
LtwrDirectCall: invokevirtual Method java/io/ByteArrayInputStream close ()V
LtwrDone: return
LtwrEnd:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/AdditionalFeatureTest; from LtwrStart to LtwrEnd
            1 is resource Ljava/io/ByteArrayInputStream; from LtwrStart to LtwrEnd
            2 is primary Ljava/lang/Throwable; from LtwrStart to LtwrEnd
            3 is closeFailure Ljava/lang/Throwable; from LtwrHandler to LtwrAfterSuppressed
        .end localvariabletable
    .end code
.end method
.sourcefile "AdditionalFeatureTest.java"
.end class
`;

const CONSTRUCTOR_FEATURES_JASMIN = `.version 52 0
.class public super org/benf/cfr/tests/CtorFeatureTest
.super org/benf/cfr/tests/BaseCtor

.method public <init> : (I)V
    .code stack 2 locals 2
L0: aload_0
L1: iload_1
L2: invokespecial Method org/benf/cfr/tests/BaseCtor <init> (I)V
L5: return
Ldone0:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/CtorFeatureTest; from L0 to Ldone0
            1 is value I from L0 to Ldone0
        .end localvariabletable
    .end code
.end method

.method public <init> : ()V
    .code stack 2 locals 1
L10: aload_0
L11: iconst_0
L12: invokespecial Method org/benf/cfr/tests/CtorFeatureTest <init> (I)V
L15: return
Ldone1:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/CtorFeatureTest; from L10 to Ldone1
        .end localvariabletable
    .end code
.end method
.sourcefile "CtorFeatureTest.java"
.end class
`;

// Reduced from dekobloko qk.run (dekobloko-work issues #4 and #13). The
// synchronized region has two distinct exits, and the normal exit computes a
// ring-buffer write length whose shorter branch must skip the tail assignment.
// Losing either piece produces valid-looking but incorrect Java: wait() runs
// without the monitor, or `write - read` is always overwritten by
// `capacity - read`.
const SYNC_WRITER_REGRESSION_JASMIN = `.version 52 0
.class public super org/benf/cfr/tests/SyncWriterRegression
.super java/lang/Object

.field private write I
.field private read I
.field private capacity I
.field private closed Z

.method public <init> : ()V
    .code stack 1 locals 1
Linit0: aload_0
Linit1: invokespecial Method java/lang/Object <init> ()V
Linit2: return
    .end code
.end method

.method public nextLength : (Z)I
    .code stack 3 locals 7
        .catch any from Lbody to LafterEarlyRelease using Lhandler
        .catch any from Lwait to LafterNormalRelease using Lhandler
        .catch any from Lhandler to LhandlerRelease using Lhandler
L0: iload_1
L1: istore 6
L2: aload_0
L3: dup
L4: astore_3
L5: monitorenter
Lbody: aload_0
L7: getfield Field org/benf/cfr/tests/SyncWriterRegression write I
L10: aload_0
L11: getfield Field org/benf/cfr/tests/SyncWriterRegression read I
L14: if_icmpne Lcompute
L17: aload_0
L18: getfield Field org/benf/cfr/tests/SyncWriterRegression closed Z
L21: ifeq Lwait
LearlyRelease: aload_3
L25: monitorexit
LafterEarlyRelease: iload 6
L28: ifeq Lclosed
Lwait: aload_0
L32: invokevirtual Method java/lang/Object wait ()V
Lcompute: aload_0
L36: getfield Field org/benf/cfr/tests/SyncWriterRegression read I
L39: istore_2
L40: aload_0
L41: getfield Field org/benf/cfr/tests/SyncWriterRegression read I
L44: aload_0
L45: getfield Field org/benf/cfr/tests/SyncWriterRegression write I
L48: if_icmpgt Lwrapped
L51: aload_0
L52: getfield Field org/benf/cfr/tests/SyncWriterRegression write I
L55: aload_0
L56: getfield Field org/benf/cfr/tests/SyncWriterRegression read I
L59: isub
L60: istore 4
L62: iload 6
L64: ifeq LnormalRelease
Lwrapped: aload_0
L68: getfield Field org/benf/cfr/tests/SyncWriterRegression capacity I
L71: aload_0
L72: getfield Field org/benf/cfr/tests/SyncWriterRegression read I
L75: isub
L76: istore 4
LnormalRelease: aload_3
L80: monitorexit
LafterNormalRelease: iload 4
L83: ireturn
Lclosed: iconst_m1
L85: ireturn
Lhandler: astore 5
L88: aload_3
L89: monitorexit
LhandlerRelease: aload 5
L92: athrow
    .end code
.end method
.sourcefile "SyncWriterRegression.java"
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

function decompileFixture(tempDir, name, source) {
  const classPath = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classPath);
  return decompileClassFile(classPath);
}

test('CFR-JS reconstructs additional expression and declaration features', (t) => {
  t.plan(21);
  withTempDir('cfr-additional-', (tempDir) => {
    const source = decompileFixture(tempDir, 'AdditionalFeatureTest', ADDITIONAL_FEATURES_JASMIN);

    t.notOk(/stack-underflow/.test(source), 'decompilation does not underflow the operand stack');
    t.notOk(/^\s*\/\/\s*(if|goto|monitorenter|monitorexit)\b/m.test(source), 'supported additional features do not fall back to raw bytecode comments');
    t.match(source, /public static final boolean READY = true;/, 'boolean constant values are rendered as booleans');
    t.match(source, /public int chooseInt\(boolean flag\) \{\s*return flag \? 10 : 20;\s*}/, 'conditional value branches are reconstructed as ternary returns');
    t.match(source, /public boolean both\(boolean left, boolean right\) \{\s*return left && right;\s*}/, 'short-circuit boolean AND returns are reconstructed');
    t.match(source, /public boolean either\(boolean left, boolean right\) \{\s*return left \|\| right;\s*}/, 'short-circuit boolean OR returns are reconstructed');
    t.match(source, /public boolean condAssignNoDup\(boolean a, boolean b\) \{\s*boolean c;\s*return b && a == \(c = b\) \|\| b && \(c = a\);\s*}/, 'frontend assignment-expression boolean condition is reconstructed');
    t.match(source, /public void guard\(boolean ok\) \{\s*if \(!ok\) \{\s*throw new RuntimeException\("bad"\);\s*}\s*}/, 'materialized boolean guard branches are reconstructed');
    t.match(source, /public void printChoice\(boolean flag, PrintStream out, String yes, String no\) \{\s*out\.print\(flag \? yes : no\);\s*}/, 'stack ternary values survive into following calls');
    t.match(source, /public void bounds\(int value\) \{\s*if \(\(?value < 0\)? \|\| value >= 100\) \{\s*throw new RuntimeException\("bounds"\);\s*}\s*}/, 'nested materialized boolean guards simplify to boolean expressions');
    t.match(source, /public int countDownOnce\(int n\) \{\s*int count = 0;\s*do \{\s*count = count \+ 1;\s*n--;\s*} while \(n > 0\);\s*return count;\s*}/, 'back-edge conditional loops are reconstructed as do/while');
    t.match(source, /public int sumFor\(int n\) \{\s*int sum = 0;\s*for \(int i = 0; i < n; i\+\+\) \{\s*sum = sum \+ i;\s*}\s*return sum;\s*}/, 'counting loops are reconstructed as for loops');
    t.match(source, /public String\[\] words\(\) \{\s*String\[\] words = new String\[\]\{"alpha", "beta"\};\s*return words;\s*}/, 'object array initialisation is condensed');
    t.match(source, /public String greet\(String name\) \{\s*return "Hello " \+ name \+ "!";\s*}/, 'StringBuilder append chains are reconstructed as string concatenation');
    t.match(source, /public void syncPrint\(Object lock\) \{\s*synchronized \(lock\) \{\s*System\.out\.print\("locked"\);\s*}\s*}/, 'monitorenter/monitorexit regions are reconstructed as synchronized blocks');
    t.match(source, /public void echoLines\(BufferedReader reader\) \{[\s\S]*?while \(true\) \{\s*(?:String )?line = reader\.readLine\(\);\s*if \(line == null\) \{\s*break;\s*}\s*System\.out\.println\(line\);\s*}/, 'guarded loops with assignment before the condition are reconstructed');
    t.match(source, /public void throwsIt\(\) throws IOException \{\s*}/, 'declared checked exceptions are emitted in method headers');
    t.match(source, /public static void acceptAll\(String\.\.\. args\) \{\s*}/, 'varargs methods use ellipsis syntax');
    t.match(source, /public void releaseResource\(ByteArrayInputStream resource, Throwable primary\) \{\s*if \(resource != null\) \{\s*resource\.close\(\);\s*}\s*}/, 'try-with-resources release graph lowers to guarded close');
    t.notOk(/addSuppressed|Ltwr|\/\/\s*goto/.test(source), 'try-with-resources release scaffolding is consumed');
    t.notOk(/new StringBuilder\(\)\.append/.test(source), 'string builder implementation detail is hidden');
  });
});

test('CFR-JS reconstructs constructor delegation calls', (t) => {
  t.plan(5);
  withTempDir('cfr-constructors-', (tempDir) => {
    const source = decompileFixture(tempDir, 'CtorFeatureTest', CONSTRUCTOR_FEATURES_JASMIN);

    t.notOk(/stack-underflow/.test(source), 'constructor decompilation does not underflow the operand stack');
    t.match(source, /public class CtorFeatureTest extends org\.benf\.cfr\.tests\.BaseCtor/, 'custom superclass is preserved');
    t.match(source, /public CtorFeatureTest\(int value\) \{\s*super\(value\);\s*}/, 'super constructor calls are rendered as super(...)');
    t.match(source, /public CtorFeatureTest\(\) \{\s*this\(0\);\s*}/, 'same-class constructor calls are rendered as this(...)');
    t.notOk(/this\.BaseCtor|this\.CtorFeatureTest/.test(source), 'constructor calls are not emitted as illegal receiver-qualified calls');
  });
});

test('CFR-JS preserves synchronized multi-exit ring-buffer selection', (t) => {
  t.plan(6);
  withTempDir('cfr-sync-writer-', (tempDir) => {
    const source = decompileFixture(tempDir, 'SyncWriterRegression', SYNC_WRITER_REGRESSION_JASMIN);

    t.notOk(/^\s*\/\/\s*(?:monitorenter|monitorexit)\b/m.test(source),
      'monitor operations do not fall back to comments');
    t.match(source, /synchronized \([^)]*\) \{[\s\S]*?this\.wait\(\);[\s\S]*?\n\s*}/,
      'wait remains inside the reconstructed synchronized block');
    const contiguous = source.match(/\b(\w+) = [^;\n]*\.write - [^;\n]*\.read;/);
    t.ok(contiguous, 'contiguous pending-byte length is retained');
    const lengthLocal = contiguous && contiguous[1];
    const wrappedPattern = lengthLocal
      ? new RegExp(`\\b${lengthLocal} = [^;\\n]*\\.capacity - [^;\\n]*\\.read;`)
      : /$a/;
    const wrapped = source.match(wrappedPattern);
    t.ok(wrapped, 'wrapped pending-byte length is retained');
    const branchGap = contiguous && wrapped
      ? source.slice(contiguous.index + contiguous[0].length, wrapped.index)
      : '';
    t.match(branchGap, /if \([^)]*== 0\) \{[\s\S]*?break [^;]+;/,
      'normal branch skips the wrapped-length overwrite');
    t.notOk(lengthLocal && new RegExp(
      `\\.write - [^;\\n]*\\.read;\\s*${lengthLocal} = [^;\\n]*\\.capacity`).test(source),
    'the two assignments cannot fall through unconditionally');
  });
});
