.version 50 0
.class public super DeadStaticBoolFlag
.super java/lang/Object

; The "FLAG" field is a static boolean used as the obfuscator's debug flag.
; Initial value is false (Java default). Some other class might in principle
; write to it, but for this fixture we declare it always-false and let the
; pass eliminate dead conditionals downstream.
.field static FLAG Z

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
    .end code
.end method

; Models a common opaque static-flag guard shape:
;   - getstatic FLAG; istore N    at method entry
;   - iload N; ifne FAR / ifeq FAR    used as opaque guards
;
; If FLAG is always false, every iload N pushes 0; ifne never branches and
; ifeq always branches.
.method public static work : (I)I
    .code stack 2 locals 3
L0:     getstatic Field DeadStaticBoolFlag FLAG Z
L3:     istore_2
        ; iload 2; ifne TGT  =>  always falls through (eliminated entirely)
L4:     iload_2
L5:     ifne LSkipReturn5
L8:     iconst_5
L9:     ireturn
        ; iload 2; ifeq TGT  =>  always branches (becomes goto)
LSkipReturn5:
L12:    iload_2
L13:    ifeq LReturnZero
L16:    iconst_m1
L17:    ireturn
LReturnZero:
L20:    iconst_0
L21:    ireturn
    .end code
.end method
.end class
