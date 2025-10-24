.class public Ackermann
.super java/lang/Object

.method public static test : (II)I
    .code stack 100 locals 2
L0:     iload_0
L1:     ifeq L28
L4:     iload_1
L5:     ifeq L38
L8:     iload_0
L9:     iconst_1
L10:    isub
L11:    iload_0
L12:    iload_1
L13:    iconst_1
L14:    isub
L15:    invokestatic Method Ackermann test (II)I
L18:    invokestatic Method Ackermann test (II)I
L21:    ireturn
L28:    iload_1
L29:    iconst_1
L30:    iadd
L31:    ireturn
L38:    iload_0
L39:    iconst_1
L40:    isub
L41:    iconst_1
L42:    invokestatic Method Ackermann test (II)I
L45:    ireturn
L46:
    .end code
.end method
.end class
