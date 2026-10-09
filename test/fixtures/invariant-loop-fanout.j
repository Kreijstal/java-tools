.version 49 0
.class public super InvariantConditionalBackedgeFanout
.super java/lang/Object

.field public static FLAG I

.method public static fill : (I[I)[I
    .code stack 4 locals 5
        getstatic Field InvariantConditionalBackedgeFanout FLAG I
        istore 4
        iload_0
        newarray int
        astore_2
        iconst_0
        istore_3
Lfill:
        iload_3
        iload_0
        if_icmpge LafterFill
        aload_2
        iload_3
        bipush 10
        iastore
        iinc 3 1
        iload 4
        ifne LafterFill
        iload 4
        ifeq Lfill
        goto LafterFill
Ldead:
        aconst_null
        athrow
LafterFill:
        aload_1
        ifnull Lreturn
        iconst_0
        istore_3
Lcopy:
        iload_3
        iload_0
        if_icmpge Lreturn
        aload_2
        iload_3
        aload_1
        iload_3
        iaload
        iastore
        iinc 3 1
        goto Lcopy
Lreturn:
        aload_2
        areturn
    .end code
.end method
.end class
