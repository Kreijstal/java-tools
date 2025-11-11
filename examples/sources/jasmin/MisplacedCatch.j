.version 55 0
.class public super MisplacedCatch
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
L5:     
        .linenumbertable
            L0 1
        .end linenumbertable
    .end code
.end method

.method public static funnel : (I)I
    .code stack 3 locals 2
        .catch java/lang/IllegalArgumentException from L0 to L17 using L18
L0:     iload_0
L1:     ifge L14
L4:     new java/lang/IllegalArgumentException
L7:     dup
L8:     ldc "negative"
L10:    invokespecial Method java/lang/IllegalArgumentException <init> (Ljava/lang/String;)V
L12:    goto L18

        .stack stack_1 Object java/lang/IllegalArgumentException
L13:    athrow

        .stack same
L14:    iload_0
L15:    iconst_1
L16:    iadd
L17:    ireturn

        .stack stack_1 Object java/lang/IllegalArgumentException
L18:    astore_1
L19:    iload_0
L20:    iconst_1
L21:    isub
L22:    ireturn
L23:    
        .linenumbertable
            L0 5
            L4 6
            L14 8
            L18 9
            L19 10
        .end linenumbertable
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 3 locals 1
L0:     getstatic Field java/lang/System out Ljava/io/PrintStream;
L3:     aload_0
L4:     arraylength
L5:     iconst_1
L6:     isub
L7:     invokestatic Method MisplacedCatch funnel (I)I
L10:    invokevirtual Method java/io/PrintStream println (I)V
L13:    return
L14:    
        .linenumbertable
            L0 15
            L13 16
        .end linenumbertable
    .end code
.end method
.sourcefile "MisplacedCatch.java"
.end class
