.class public Fib
.super java/lang/Object

.method public static test : (I)J
    .code stack 4 locals 5
L0:     iload_0
L1:     iconst_0
L2:     if_icmpeq L56
L5:     iload_0
L6:     iconst_1
L7:     if_icmpeq L62
L10:    lconst_0
L11:    lstore_1
L12:    lconst_1
L13:    lstore_3
L14:    iconst_2
L15:    istore_0
L16:    goto L20
L20:    iload_0
L21:    sipush 100
L24:    if_icmpgt L44
L27:    lload_1
L28:    lload_3
L29:    ladd
L30:    lstore_1
L31:    lload_3
L32:    lload_1
L33:    lsub
L34:    lstore_3
L35:    iinc 0 1
L38:    goto L20
L44:    lload_3
L45:    lreturn
L56:    lconst_0
L57:    lreturn
L62:    lconst_1
L63:    lreturn
L64:
    .end code
.end method
.end class
