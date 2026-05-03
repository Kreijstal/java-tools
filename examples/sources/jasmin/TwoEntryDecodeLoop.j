.version 49 0
.class public super TwoEntryDecodeLoop
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
    .end code
.end method
; Reduced model of td.c(Lvl;)V's two-entry decode loop.
;
; Shape:
;   LState:
;     if pending <= 0 goto LDecode
;     while budget != 0:
;       if pending != 1: emit, pending--, budget--, goto LDrain
;       emit one, budget--, fall into LDecode
;   LDecode:
;     if input == limit: exit
;     read next symbol
;     ...
;     goto LDecode
;     goto LState
;
; CFR tends to dislike the initial jump from LState into the inner LDecode
; header, because LDecode also has its own backedges.
.method public static trick : ([I[IIII)I
    .code stack 4 locals 9
L0:     iload_2
L1:     istore        5       ; pending run length
L3:     iload_3
L4:     istore        6       ; input index
L6:     iconst_0
L7:     istore        7       ; output index
L9:     iload         4
L11:    istore        8       ; output budget

LState:
L13:    iload         5
L15:    ifle LDecode

LDrain:
L18:    iload         8
L20:    ifeq LExit
L23:    iload         5
L25:    iconst_1
L26:    if_icmpeq LDrainOne
L29:    aload_1
L30:    iload         7
L32:    bipush        7
L33:    iastore
L34:    iinc          5 -1
L37:    iinc          7 1
L40:    iinc          8 -1
L43:    goto LDrain

LDrainOne:
L46:    iload         8
L48:    ifne LDrainOneEmit
L51:    iconst_1
L52:    istore        5
L54:    goto LExit

LDrainOneEmit:
L57:    aload_1
L58:    iload         7
L60:    bipush        7
L61:    iastore
L62:    iinc          7 1
L65:    iinc          8 -1

LDecode:
L68:    iload         6
L70:    aload_0
L71:    arraylength
L72:    if_icmpne LRead
L75:    iconst_0
L76:    istore        5
L78:    goto LExit

LRead:
L81:    aload_0
L82:    iload         6
L84:    iaload
L85:    istore_3
L86:    iinc          6 1
L89:    iload_3
L90:    ifne LNonZero
L93:    iconst_2
L94:    istore        5
L96:    goto LState

LNonZero:
L99:    iload_3
L100:   iconst_1
L101:   if_icmpne LDecode
L104:   iconst_3
L105:   istore        5
L107:   goto LState

LExit:
L110:   iload         7
L112:   ireturn
    .end code
.end method
.method public static main : ([Ljava/lang/String;)V
    .code stack 6 locals 3
L0:     iconst_3
L1:     newarray int
L3:     astore_1
L4:     aload_1
L5:     iconst_0
L6:     iconst_0
L7:     iastore
L8:     aload_1
L9:     iconst_1
L10:    iconst_2
L11:    iastore
L12:    aload_1
L13:    iconst_2
L14:    iconst_1
L15:    iastore
L16:    bipush        16
L18:    newarray int
L20:    astore_2
L21:    getstatic Field java/lang/System out Ljava/io/PrintStream;
L24:    aload_1
L25:    aload_2
L26:    iconst_0
L27:    iconst_0
L28:    bipush        16
L30:    invokestatic Method TwoEntryDecodeLoop trick ([I[IIII)I
L33:    invokevirtual Method java/io/PrintStream println (I)V
L36:    return
    .end code
.end method
.end class
