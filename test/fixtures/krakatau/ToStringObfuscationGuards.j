.version 52 0
.class public super GuardedToString
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
LguardInit0: aload_0
LguardInit1: invokespecial Method java/lang/Object <init> ()V
LguardInit2: return
    .end code
.end method

.method public toString : ()Ljava/lang/String;
    .code stack 2 locals 2
Lguard0: new java/lang/IllegalStateException
Lguard1: dup
Lguard2: invokespecial Method java/lang/IllegalStateException <init> ()V
Lguard3: athrow
LguardHandler: astore_1
LguardHandler1: aload_1
LguardHandler2: athrow
LguardEnd:
    .catch java/lang/RuntimeException from Lguard0 to LguardHandler using LguardHandler
    .end code
.end method
.end class

.version 52 0
.class public super SafeToString
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
LsafeInit0: aload_0
LsafeInit1: invokespecial Method java/lang/Object <init> ()V
LsafeInit2: return
    .end code
.end method

.method public toString : ()Ljava/lang/String;
    .code stack 1 locals 1
Lsafe0: ldc "safe"
Lsafe1: areturn
    .end code
.end method
.end class
