.version 61 0
.class public super ClassRenamingTestRunner
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

.method public static main : ([Ljava/lang/String;)V
    .code stack 2 locals 2
L0:    new RenamedClass
L3:    dup
L4:    invokespecial Method RenamedClass <init> ()V
L7:    astore_1
L8:    getstatic Field java/lang/System out Ljava/io/PrintStream;
L11:    aload_1
L12:    invokevirtual Method RenamedClass toString ()Ljava/lang/String;
L15:    invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
L18:    return
L19:
        .linenumbertable
            L0 3
            L8 4
            L18 5
        .end linenumbertable
    .end code
.end method
.sourcefile "ClassRenamingTestRunner.java"
.end class