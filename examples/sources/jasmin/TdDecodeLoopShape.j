.version 49 0
.class public super TdDecodeLoopShape
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
    .end code
.end method

; Closer standalone model of td.c's loop shape.
; Locals intentionally mirror td.c:
;   2 current byte, 3 pending, 4 input index, 5 last byte, 6 int table,
;   7 table index, 8 output, 9 output index, 10 budget, 11 original budget,
;   12 limit.
.method public static trick : ([I[BIIIII)I
    .code stack 4 locals 13
L0:     iload_2
L1:     istore_3
L2:     iload_3
L3:     istore        4
L5:     iload         4
L7:     istore        5
L9:     iload         5
L11:    istore        7
L13:    iload         6
L15:    istore        10
L17:    aload_0
L18:    astore        6
L20:    aload_1
L21:    astore        8
L23:    iconst_0
L24:    istore        9
L26:    iload         10
L28:    istore        11
L30:    aload_0
L31:    arraylength
L32:    istore        12

LState:
L34:    iload_3
L35:    ifle LDecode
L38:    iload         10
L40:    ifeq LExit
L43:    iload_3
L44:    iconst_1
L45:    if_icmpeq LOne
L48:    aload         8
L50:    iload         9
L52:    iload_2
L53:    bastore
L54:    iinc          3 -1
L57:    iinc          9 1
L60:    iinc          10 -1
L63:    goto LStateDrain

LStateDrain:
L66:    iload         10
L68:    ifeq LExit
L71:    iload_3
L72:    iconst_1
L73:    if_icmpne LEmitMany
L76:    goto LOne

LEmitMany:
L79:    aload         8
L81:    iload         9
L83:    iload_2
L84:    bastore
L85:    iinc          3 -1
L88:    iinc          9 1
L91:    iinc          10 -1
L94:    goto LStateDrain

LOne:
L97:    iload         10
L99:    ifne LOneEmit
L102:   iconst_1
L103:   istore_3
L104:   goto LExit
LOneEmit:
L107:   aload         8
L109:   iload         9
L111:   iload_2
L112:   bastore
L113:   iinc          9 1
L116:   iinc          10 -1

LDecode:
L119:   iload         4
L121:   iload         12
L123:   if_icmpne LRead
L126:   iconst_0
L127:   istore_3
L128:   goto LExit

LRead:
L131:   iload         5
L133:   i2b
L134:   istore_2
L135:   aload         6
L137:   iload         7
L139:   iaload
L140:   istore        7
L142:   iload         7
L144:   i2b
L145:   istore_1
L146:   iload         7
L148:   bipush        8
L150:   ishr
L151:   istore        7
L153:   iinc          4 1
L156:   iload_1
L157:   iload         5
L159:   if_icmpeq LSame
L162:   iload_1
L163:   istore        5
L165:   iload         10
L167:   ifne LEmitDecoded
L170:   iconst_1
L171:   istore_3
L172:   goto LExit
LEmitDecoded:
L175:   aload         8
L177:   iload         9
L179:   iload_2
L180:   bastore
L181:   iinc          9 1
L184:   iinc          10 -1
L187:   goto LDecode

LSame:
L190:   iload         4
L192:   iload         12
L194:   if_icmpne LRun2
L197:   iload         10
L199:   ifne LSameEmit
L202:   iconst_1
L203:   istore_3
L204:   goto LExit
LSameEmit:
L207:   aload         8
L209:   iload         9
L211:   iload_2
L212:   bastore
L213:   iinc          9 1
L216:   iinc          10 -1
L219:   goto LDecode

LRun2:
L222:   iconst_2
L223:   istore_3
L224:   aload         6
L226:   iload         7
L228:   iaload
L229:   istore        7
L231:   iload         7
L233:   i2b
L234:   istore_1
L235:   iload         7
L237:   bipush        8
L239:   ishr
L240:   istore        7
L242:   iinc          4 1
L245:   iload         4
L247:   iload         12
L249:   if_icmpeq LState
L252:   iload_1
L253:   iload         5
L255:   if_icmpeq LRun3
L258:   iload_1
L259:   istore        5
L261:   goto LState

LRun3:
L264:   iconst_3
L265:   istore_3
L266:   goto LState

LExit:
L269:   iload         9
L271:   ireturn
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 8 locals 3
L0:     iconst_4
L1:     newarray int
L3:     astore_1
L4:     aload_1
L5:     iconst_0
L6:     iconst_0
L7:     iastore
L8:     aload_1
L9:     iconst_1
L10:    sipush        257
L13:    iastore
L14:    bipush        16
L16:    newarray byte
L18:    astore_2
L19:    getstatic Field java/lang/System out Ljava/io/PrintStream;
L22:    aload_1
L23:    aload_2
L24:    iconst_0
L25:    iconst_0
L26:    iconst_0
L27:    iconst_0
L28:    bipush        16
L30:    invokestatic Method TdDecodeLoopShape trick ([I[BIIIII)I
L33:    invokevirtual Method java/io/PrintStream println (I)V
L36:    return
    .end code
.end method
.end class
