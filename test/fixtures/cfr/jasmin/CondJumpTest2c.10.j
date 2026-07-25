.version 52 0
.class public super org/benf/cfr/tests/CondJumpTest2c
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0: aload_0
L1: invokespecial Method java/lang/Object <init> ()V
L2: return
    .end code
.end method

.method public test : (ZZ)Z
    .code stack 3 locals 4
L0: iload_2
L1: ifeq L11
L4: iload_1
L5: iload_2
L6: dup
L7: istore_3
L8: if_icmpeq L21
L11: iload_2
L12: ifeq L25
L15: iload_1
L16: dup
L17: istore_3
L18: ifeq L25
L21: iconst_1
L22: goto L26
L25: iconst_0
L26: ireturn
L27:
        .localvariabletable
            0 is this Lorg/benf/cfr/tests/CondJumpTest2c; from L0 to L27
            1 is a Z from L0 to L27
            2 is b Z from L0 to L27
            3 is c Z from L8 to L25
        .end localvariabletable
    .end code
.end method
.sourcefile "CondJumpTest2c.java"
.end class
