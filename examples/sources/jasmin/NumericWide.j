.class public NumericWide
.super java/lang/Object

.method public static sumAll : ()J
    .code stack 4 locals 0
L0:     lconst_1
L1:     lconst_1
L2:     ladd
L3:     lconst_1
L4:     ladd
L5:     lreturn
L6:
    .end code
.end method

.method public static mixFloat : ()F
    .code stack 3 locals 0
L0:     fconst_1
L1:     fconst_2
L2:     fadd
L3:     fconst_1
L4:     fsub
L5:     freturn
L6:
    .end code
.end method

.method public static mixDouble : ()D
    .code stack 4 locals 0
L0:     dconst_1
L1:     dconst_1
L2:     dadd
L3:     dconst_1
L4:     dadd
L5:     dreturn
L6:
    .end code
.end method
.end class
