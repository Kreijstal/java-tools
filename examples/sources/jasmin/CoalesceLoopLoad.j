.version 50 0
.class public super CoalesceLoopLoad
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
    .end code
.end method

; Reduced fixture for the P3 "load/goto/load" coalesce pattern.
;
; The method body is a hand-crafted version of what multi-entry-normalize
; produces when it splits a small loop preheader: two paths reach the same
; loop body label, both performing an identical LOAD of the loop counter
; immediately before the join. Preheader path 1 ends with `iload 1; goto T2`,
; preheader path 2 falls into `T1: iload 1; T2: <use>`. Without coalescing,
; CFR cannot structure this cleanly and emits ** GOTO markers.
;
; After coalesce-loop-load, the preheader's `iload 1; goto T2` becomes
; `goto T1` and only the T1 LOAD remains.
.method public static trick : (I)I
    .code stack 2 locals 2
L0:     iload_0
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_0
L6:     iconst_1
L7:     if_icmpne LSecond
        ; preheader path 1 — falls into T1
L10:    iconst_2
L11:    istore_1
L12:    goto LT1
        ; preheader path 2 — ends with iload 1; goto T2 (the P3 trigger)
LSecond:
L15:    iconst_3
L16:    istore_1
L17:    iload_1
L18:    goto LT2
        ; T1: identical LOAD
LT1:
L21:    iload_1
        ; T2: use that consumes the load (returns iload_1 + 1 here)
LT2:
L23:    iconst_1
L24:    iadd
L25:    ireturn
LExit:
L26:    iconst_0
L27:    ireturn
    .end code
.end method

; Multi-jump variant of the P3 pattern: THREE preheader paths each end
; with `iload 1; goto T2`, plus the T1 fallthrough load. After
; coalesce-loop-load relaxation, every `iload 1; goto T2` becomes
; `goto T1`, leaving the single T1 LOAD as the only remaining iload.
.method public static trick3 : (I)I
    .code stack 2 locals 2
L0:     iload_0
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_0
L6:     iconst_1
L7:     if_icmpeq LP1
L10:    iload_0
L11:    iconst_2
L12:    if_icmpeq LP2
        ; path 3 — ends with iload 1; goto LT2
L15:    iconst_3
L16:    istore_1
L17:    iload_1
L18:    goto LT2
        ; path 1 — ends with iload 1; goto LT2
LP1:
L21:    iconst_4
L22:    istore_1
L23:    iload_1
L24:    goto LT2
        ; path 2 — ends with iload 1; goto LT2
LP2:
L27:    iconst_5
L28:    istore_1
L29:    iload_1
L30:    goto LT2
        ; T1 fallthrough — reached only by some preheader fallthrough goto
        ; T1 load (the canonical surviving load)
LFall:
L33:    iconst_0
L34:    istore_1
L35:    goto LT1
LT1:
L38:    iload_1
        ; T2 — the use site
LT2:
L40:    iconst_1
L41:    iadd
L42:    ireturn
LExit:
L43:    iconst_0
L44:    ireturn
    .end code
.end method
; aload_0 variant — slot 0 is `this`, never reassigned. Coalesce should
; recognize aload_0 as a preheader-safe load and fold the duplicate.
.method public trickAload0 : (I)Ljava/lang/Object;
    .code stack 2 locals 2
L0:     iload_1
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_1
L6:     iconst_1
L7:     if_icmpne LSecond
        ; preheader path 1 — falls through into LT1
L10:    nop
L11:    goto LT1
        ; preheader path 2 — ends with `aload_0; goto LT2`
LSecond:
L14:    aload_0
L15:    goto LT2
LT1:
L18:    aload_0
LT2:
L20:    areturn
LExit:
L21:    aconst_null
L22:    areturn
    .end code
.end method

; getstatic variant — both sides read the same static field. Coalesce
; should fold the duplicate getstatic.
.field public static FIELD I

.method public static trickGetstatic : (I)I
    .code stack 2 locals 1
L0:     iload_0
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_0
L6:     iconst_1
L7:     if_icmpne LSecond
L10:    nop
L11:    goto LT1
LSecond:
L14:    getstatic Field CoalesceLoopLoad FIELD I
L15:    goto LT2
LT1:
L18:    getstatic Field CoalesceLoopLoad FIELD I
LT2:
L20:    iconst_1
L21:    iadd
L22:    ireturn
LExit:
L23:    iconst_0
L24:    ireturn
    .end code
.end method

; iconst_3 variant — both sides push the same nullary constant.
.method public static trickIconst : (I)I
    .code stack 2 locals 1
L0:     iload_0
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_0
L6:     iconst_1
L7:     if_icmpne LSecond
L10:    nop
L11:    goto LT1
LSecond:
L14:    iconst_3
L15:    goto LT2
LT1:
L18:    iconst_3
LT2:
L20:    iconst_1
L21:    iadd
L22:    ireturn
LExit:
L23:    iconst_0
L24:    ireturn
    .end code
.end method

; bipush variant — both sides push the same byte literal.
.method public static trickBipush : (I)I
    .code stack 2 locals 1
L0:     iload_0
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_0
L6:     iconst_1
L7:     if_icmpne LSecond
L10:    nop
L11:    goto LT1
LSecond:
L14:    bipush 42
L15:    goto LT2
LT1:
L18:    bipush 42
LT2:
L20:    iconst_1
L21:    iadd
L22:    ireturn
LExit:
L23:    iconst_0
L24:    ireturn
    .end code
.end method

; ldc variant — both sides push the same string constant.
.method public static trickLdc : (I)Ljava/lang/String;
    .code stack 1 locals 1
L0:     iload_0
L1:     iconst_0
L2:     if_icmple LExit
L5:     iload_0
L6:     iconst_1
L7:     if_icmpne LSecond
L10:    nop
L11:    goto LT1
LSecond:
L14:    ldc "hello"
L15:    goto LT2
LT1:
L18:    ldc "hello"
LT2:
L20:    areturn
LExit:
L21:    aconst_null
L22:    areturn
    .end code
.end method

.end class
