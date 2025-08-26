.version 61 0
.class public super FullLifecycleApplet
.super java/applet/Applet
.field private message Ljava/lang/String;

.method public <init> : ()V
    .code stack 2 locals 1
L0:     aload_0
L1:     invokespecial Method java/applet/Applet <init> ()V
L4:     aload_0
L5:     ldc "Initializing..."
L7:     putfield Field FullLifecycleApplet message Ljava/lang/String;
L10:    return
L11:    
        .linenumbertable
            L0 9
            L4 10
            L10 11
        .end linenumbertable
    .end code
.end method

.method public init : ()V
    .code stack 2 locals 1
L0:     aload_0
L1:     ldc "Initialized"
L3:     putfield Field FullLifecycleApplet message Ljava/lang/String;
L6:     return
L7:     
        .linenumbertable
            L0 14
            L6 15
        .end linenumbertable
    .end code
.end method

.method public start : ()V
    .code stack 2 locals 1
L0:     aload_0
L1:     ldc "Started"
L3:     putfield Field FullLifecycleApplet message Ljava/lang/String;
L6:     return
L7:     
        .linenumbertable
            L0 18
            L6 19
        .end linenumbertable
    .end code
.end method

.method public paint : (Ljava/awt/Graphics;)V
    .code stack 4 locals 2
L0:     aload_1
L1:     aload_0
L2:     getfield Field FullLifecycleApplet message Ljava/lang/String;
L5:     bipush 20
L7:     bipush 20
L9:     invokevirtual Method java/awt/Graphics drawString (Ljava/lang/String;II)V
L12:    return
L13:    
        .linenumbertable
            L0 23
            L12 24
        .end linenumbertable
    .end code
.end method
.sourcefile "FullLifecycleApplet.java"
.end class
