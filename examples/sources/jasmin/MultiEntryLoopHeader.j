.version 50 0
.class public super MultiEntryLoopHeader
.super java/lang/Object

.field public static A Z

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
    .end code
.end method

; Reduced model of the Dekobloko qc.b(IZ)Z "v1 == null" cluster.
;
; Shape:
;   - Several different predecessor branches enter cloned loop preheaders.
;   - Each preheader initializes the same loop index, loads arr[index],
;     checks a synthetic static boolean flag, then splits to shared null and
;     non-null bodies.
;   - CFR tends to print this as:
;       if (v == null) ** GOTO lblNull
;       ** GOTO lblNonNull
;
; The method returns:
;   - 100 + state[0] when arr[0] is null
;   - 200 + arr[0].hashCode() when arr[0] is non-null
;   - 300 when the synthetic flag A is true
;   - 400 when limit <= 0
.method public static trick : ([Ljava/lang/Object;[II)I
    .code stack 4 locals 6
L0:     iload_2
L1:     ifle LExitEmpty
L4:     iload_2
L5:     iconst_1
L6:     if_icmpeq LHeaderFromLimitOne
L9:     iload_2
L10:    iconst_2
L11:    if_icmpeq LHeaderFromLimitTwo
L14:    goto LHeaderFromDefault

LHeaderFromLimitOne:
L17:    iconst_0
L18:    istore_3
L19:    aload_0
L20:    iload_3
L21:    aaload
L22:    astore        4
L24:    aload         4
L26:    getstatic Field MultiEntryLoopHeader A Z
L29:    ifne LSyntheticExit
L32:    ifnull LNullBody
L35:    goto LNonNullBody

LHeaderFromLimitTwo:
L38:    iconst_0
L39:    istore_3
L40:    aload_0
L41:    iload_3
L42:    aaload
L43:    astore        4
L45:    aload         4
L47:    getstatic Field MultiEntryLoopHeader A Z
L50:    ifne LSyntheticExit
L53:    ifnull LNullBody
L56:    goto LNonNullBody

LHeaderFromDefault:
L59:    iconst_0
L60:    istore_3
L61:    aload_0
L62:    iload_3
L63:    aaload
L64:    astore        4
L66:    aload         4
L68:    getstatic Field MultiEntryLoopHeader A Z
L71:    ifne LSyntheticExit
L74:    ifnull LNullBody
L77:    goto LNonNullBody

LNullBody:
L80:    aload_1
L81:    iload_3
L82:    dup2
L83:    iaload
L84:    iconst_1
L85:    iadd
L86:    iastore
L87:    bipush        100
L89:    aload_1
L90:    iload_3
L91:    iaload
L92:    iadd
L93:    ireturn

LNonNullBody:
L94:    sipush        200
L97:    aload         4
L99:    invokevirtual Method java/lang/Object hashCode ()I
L102:   iadd
L103:   ireturn

LSyntheticExit:
L104:   sipush        300
L107:   ireturn

LExitEmpty:
L108:   sipush        400
L111:   ireturn
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 5 locals 3
L0:     iconst_1
L1:     anewarray java/lang/Object
L4:     astore_1
L5:     iconst_1
L6:     newarray int
L8:     astore_2
L9:     getstatic Field java/lang/System out Ljava/io/PrintStream;
L12:    aload_1
L13:    aload_2
L14:    iconst_2
L15:    invokestatic Method MultiEntryLoopHeader trick ([Ljava/lang/Object;[II)I
L18:    invokevirtual Method java/io/PrintStream println (I)V
L21:    return
    .end code
.end method

; Closer model of qc.b(IZ)Z:
;   - duplicated entries all initialize i = 0 and load arr[i]
;   - null and non-null bodies do work, then rejoin at a shared latch
;   - latch increments i and loops back into another shared header
;   - static A is a synthetic break/loop poison flag
.method public static trickLoop : ([Ljava/lang/Object;[II)I
    .code stack 4 locals 7
L200:   iconst_0
L201:   istore        5
L203:   iload_2
L204:   ifle LLoopExit
L207:   iload_2
L208:   iconst_1
L209:   if_icmpeq LLoopHeaderA
L212:   iload_2
L213:   iconst_2
L214:   if_icmpeq LLoopHeaderB
L217:   goto LLoopHeaderC

LLoopHeaderA:
L220:   iconst_0
L221:   istore_3
L222:   aload_0
L223:   iload_3
L224:   aaload
L225:   astore        4
L227:   aload         4
L229:   getstatic Field MultiEntryLoopHeader A Z
L232:   ifne LLoopSyntheticExit
L235:   ifnull LLoopNullBody
L238:   goto LLoopNonNullBody

LLoopHeaderB:
L241:   iconst_0
L242:   istore_3
L243:   aload_0
L244:   iload_3
L245:   aaload
L246:   astore        4
L248:   aload         4
L250:   getstatic Field MultiEntryLoopHeader A Z
L253:   ifne LLoopSyntheticExit
L256:   ifnull LLoopNullBody
L259:   goto LLoopNonNullBody

LLoopHeaderC:
L262:   iconst_0
L263:   istore_3
L264:   aload_0
L265:   iload_3
L266:   aaload
L267:   astore        4
L269:   aload         4
L271:   getstatic Field MultiEntryLoopHeader A Z
L274:   ifne LLoopSyntheticExit
L277:   ifnull LLoopNullBody
L280:   goto LLoopNonNullBody

LLoopNullBody:
L283:   aload_1
L284:   iload_3
L285:   dup2
L286:   iaload
L287:   iconst_1
L288:   iadd
L289:   iastore
L290:   iinc          5 10
L293:   goto LLoopLatch

LLoopNonNullBody:
L296:   iload         5
L298:   aload         4
L300:   invokevirtual Method java/lang/Object hashCode ()I
L303:   bipush        7
L305:   iand
L306:   iadd
L307:   istore        5
L309:   goto LLoopLatch

LLoopLatch:
L312:   iinc          3 1
L315:   iload_3
L316:   iload_2
L317:   if_icmpge LLoopDone
L320:   aload_0
L321:   iload_3
L322:   aaload
L323:   astore        4
L325:   aload         4
L327:   getstatic Field MultiEntryLoopHeader A Z
L330:   ifne LLoopSyntheticExit
L333:   ifnull LLoopNullBody
L336:   goto LLoopNonNullBody

LLoopDone:
L339:   iload         5
L341:   ireturn

LLoopSyntheticExit:
L342:   sipush        300
L345:   ireturn

LLoopExit:
L346:   sipush        400
L349:   ireturn
    .end code
.end method
.end class
