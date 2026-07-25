.version 52 0
.class public super org/benf/cfr/tests/TryTest1
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0: aload_0
L1: invokespecial Method java/lang/Object <init> ()V
L2: return
    .end code
.end method

.method public test1 : ()V
    .code stack 3 locals 2
        .catch java/lang/NoSuchFieldException from L10 to L30 using L40
L10: getstatic Field java/lang/System out Ljava/io/PrintStream;
L13: iconst_3
L14: invokevirtual Method java/io/PrintStream print (I)V
L17: new java/lang/NoSuchFieldException
L20: dup
L21: invokespecial Method java/lang/NoSuchFieldException <init> ()V
L24: athrow
L30: goto L60
L40: astore_1
L41: getstatic Field java/lang/System out Ljava/io/PrintStream;
L44: ldc "Finally!"
L46: invokevirtual Method java/io/PrintStream print (Ljava/lang/String;)V
L60: getstatic Field java/lang/System out Ljava/io/PrintStream;
L63: iconst_5
L64: invokevirtual Method java/io/PrintStream print (I)V
L67: return
L68:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/TryTest1; from L10 to L68
            1 is noSuchFieldException Ljava/lang/NoSuchFieldException; from L41 to L60
        .end localvariabletable
    .end code
.end method
.sourcefile "TryTest1.java"
.end class
