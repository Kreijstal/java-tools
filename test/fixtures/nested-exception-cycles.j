.version 49 0
.class public super NestedExceptionCycles
.super java/lang/Object

.method public static compute : (III)I
    .code stack 4 locals 5
    .catch java/lang/RuntimeException from Louter to Lreturn using Lhandler
        iconst_0
        istore_3
        iconst_0
        istore 4
Louter:
        iload_1
        ifne Lsecond
Lfirst:
        iinc 3 1
        iload 4
        iload_3
        iload_2
        iconst_1
        invokestatic Method Effects next (IIII)I
        istore 4
        iload_3
        iload_0
        if_icmpge Lreturn
        iload_3
        iconst_3
        iand
        ifeq Lsecond
        goto Ltail
Lsecond:
        iinc 3 1
        iload 4
        iload_3
        iload_2
        bipush 7
        invokestatic Method Effects next (IIII)I
        istore 4
        iload_3
        iload_0
        if_icmpge Lreturn
        iload_3
        iconst_1
        iand
        ifne Lfirst
Ltail:
        goto Louter
Lreturn:
        iload 4
        iload_3
        sipush 1000
        imul
        iadd
        ireturn
Lhandler:
        pop
        sipush -30000
        iload 4
        iadd
        ireturn
    .end code
.end method
.end class
