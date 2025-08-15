.version 65 0
.class public super WideInstructionDemo
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
        aload_0
        invokespecial Method java/lang/Object <init> ()V
        return
    .end code
.end method

.method public static wideLdc : ()V
    .code stack 1 locals 257
        sipush 256
        wide istore 256
        return
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 1 locals 1
        invokestatic Method WideInstructionDemo wideLdc ()V
        return
    .end code
.end method
