.class public LocalPropagation
.super java/lang/Object

.method public static sum : ()I
    .code stack 3 locals 2
L0:     bipush 5
L2:     istore_0
L3:     bipush 7
L5:     istore_1
L6:     iload_0
L7:     iload_1
L8:     iadd
L9:     ireturn
L10:
    .end code
.end method

.method public static branch : ()I
    .code stack 3 locals 1
L0:     iconst_1
L1:     istore_0
L2:     iload_0
L3:     iconst_1
L4:     if_icmpne L10
L7:     bipush 7
L8:     ireturn
L10:    iconst_0
L11:    ireturn
L12:
    .end code
.end method
.end class
