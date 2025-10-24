.class public ExtendedNumbers
.super java/lang/Object

.method public static diffZero : ()J
    .code stack 2 locals 0
L0:     lconst_1
L1:     lconst_1
L2:     lsub
L3:     lreturn
L4:
    .end code
.end method

.method public static floatPair : ()F
    .code stack 2 locals 0
L0:     fconst_2
L1:     fconst_1
L2:     fsub
L3:     freturn
L4:
    .end code
.end method

.method public static doubleCancel : ()D
    .code stack 2 locals 0
L0:     dconst_1
L1:     dconst_1
L2:     dsub
L3:     dreturn
L4:
    .end code
.end method

.method public static compareLongs : ()I
    .code stack 4 locals 0
L0:     lconst_1
L1:     lconst_1
L2:     lcmp
L3:     ifeq L9
L6:     iconst_0
L7:     ireturn
L9:     iconst_1
L10:    ireturn
L11:
    .end code
.end method
.end class
