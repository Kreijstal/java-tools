.class public LocalPropagation
.super java/lang/Object

.method public static compute : ()I
    .code stack 3 locals 1
L0:     iconst_5
L1:     istore_0
L2:     iload_0
L3:     bipush 7
L4:     iadd
L5:     ireturn
L6:
    .end code
.end method

.method public static branch : ()I
    .code stack 3 locals 1
L0:     iconst_5
L1:     istore_0
L2:     goto L6
L5:     iconst_0
L6:     iload_0
L7:     bipush 5
L8:     if_icmpeq L14
L11:    iconst_0
L12:    ireturn
L14:    iconst_1
L15:    ireturn
L16:
    .end code
.end method
.end class
