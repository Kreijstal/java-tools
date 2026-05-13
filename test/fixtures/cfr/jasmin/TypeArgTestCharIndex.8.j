.version 52 0
.class public super org/benf/cfr/tests/TypeArgTestCharIndex
.super java/lang/Object
.field private static final TEST Ljava/lang/String;= "src/main/java/com/example/Test.java"

.method public <init> : ()V
    .code stack 1 locals 1
L0: aload_0
L1: invokespecial Method java/lang/Object <init> ()V
L2: return
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 4 locals 1
L0: getstatic Field java/lang/System out Ljava/io/PrintStream;
L3: getstatic Field org/benf/cfr/tests/TypeArgTestCharIndex TEST Ljava/lang/String;
L6: getstatic Field org/benf/cfr/tests/TypeArgTestCharIndex TEST Ljava/lang/String;
L9: bipush 47
L11: invokevirtual Method java/lang/String lastIndexOf (I)I
L14: iconst_1
L15: iadd
L16: getstatic Field org/benf/cfr/tests/TypeArgTestCharIndex TEST Ljava/lang/String;
L19: bipush 46
L21: invokevirtual Method java/lang/String indexOf (I)I
L24: invokevirtual Method java/lang/String substring (II)Ljava/lang/String;
L27: invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
L30: return
L31:
        .localvariabletable
            0 is stringArray [Ljava/lang/String; from L0 to L31
        .end localvariabletable
    .end code
.end method
.sourcefile "TypeArgTestCharIndex.java"
.end class
