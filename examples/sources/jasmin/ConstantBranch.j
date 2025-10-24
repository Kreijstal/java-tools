.class public ConstantBranch
.super java/lang/Object

.method public static test : ()I
    .code stack 2 locals 0
L0:     iconst_1
L1:     iconst_1
L2:     iadd
L3:     iconst_2
L4:     if_icmpeq L10
L7:     iconst_0
L8:     ireturn
L10:    iconst_1
L11:    ireturn
L12:
    .end code
.end method
.end class
