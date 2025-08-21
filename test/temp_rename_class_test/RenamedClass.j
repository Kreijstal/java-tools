.version 61 0
.class public super RenamedClass
.super java/lang/Object
.method public <init> : ()V
    .code stack 1 locals 1
L0:    aload_0
L1:    invokespecial Method java/lang/Object <init> ()V
L4:    return
L5:
        .linenumbertable
            L0 1
        .end linenumbertable
    .end code
.end method

.method public toString : ()Ljava/lang/String;
    .code stack 1 locals 1
L0:    ldc "This is the ClassToRename"
L2:    areturn
L3:
        .linenumbertable
            L0 3
        .end linenumbertable
    .end code
.end method
.sourcefile "RenamedClass.java"
.end class