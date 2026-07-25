.version 50 0
.class public super CfrBadLabelLoop
.super java/lang/Object

; Minimal reduction of td.c(Lvl;)V's remaining CFR bad-label case.
; CFR 0.152 emits "** GOTO" because L30 has two entries:
;   - a forward jump from before the while-like loop
;   - fallthrough from inside the loop
; The post-loop iinc keeps the region from being discarded. Plain nops or
; immediate returns do not reproduce the CFR failure.
.method public static c : (I)V
    .code stack 1 locals 1
L0:     iload_0
L1:     ifle L30
L4:     iload_0
L5:     ifeq L40
L8:     iload_0
L9:     ifne L4
L30:    iinc          0 0
L40:    iinc          0 0
L42:    return
    .end code
.end method
.end class
