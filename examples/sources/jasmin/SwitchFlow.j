.version 65 0
.class public super SwitchFlow
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

.method public static dispatch : (I)I
    .code stack 1 locals 1
L0:     iload_0
L1:     tableswitch 0
            L28
            L30
            L32
            default : L34

        .stack same
L28:    iconst_0
L29:    ireturn

        .stack same
L30:    iconst_1
L31:    ireturn

        .stack same
L32:    iconst_2
L33:    ireturn

        .stack same
L34:    iconst_m1
L35:    ireturn
L36:    
        .linenumbertable
            L0 3
            L28 5
            L30 7
            L32 9
            L34 11
        .end linenumbertable
    .end code
.end method

.method public static lookup : (I)I
    .code stack 1 locals 1
L0:     iload_0
L1:     lookupswitch
            10 : L28
            20 : L31
            default : L34

        .stack same
L28:    bipush 10
L30:    ireturn

        .stack same
L31:    bipush 20
L33:    ireturn

        .stack same
L34:    iconst_m1
L35:    ireturn
L36:    
        .linenumbertable
            L0 16
            L28 18
            L31 20
            L34 22
        .end linenumbertable
    .end code
.end method
.sourcefile "SwitchFlow.java"
.end class
