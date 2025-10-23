.class public UnreachableCode
.super java/lang/Object

.method public static test : ()I
    .code stack 1 locals 1
        iconst_5
        ireturn
        ; This code is unreachable and should be removed
        iconst_1
        iadd
        pop
    .end code
.end method
.end class
