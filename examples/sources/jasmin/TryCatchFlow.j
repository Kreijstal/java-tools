.version 65 0
.class public super TryCatchFlow
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

.method public static withException : (I)I
    .code stack 1 locals 2
        .catch java/lang/Exception from L0 to L1 using L2
L0:     iload_0
L1:     ireturn

        .stack stack_1 Object java/lang/Exception
L2:     astore_1
L3:     iconst_0
L4:     ireturn
L5:     
        .linenumbertable
            L0 4
            L2 5
            L3 6
        .end linenumbertable
    .end code
.end method
.sourcefile "TryCatchFlow.java"
.end class
