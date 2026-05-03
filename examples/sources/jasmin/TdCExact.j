.version 50 0
.class public super TdCExact
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
    .end code
.end method

; Exact standalone copy of td.c(Lvl;)V from the transformed Dekobloko class.
; It intentionally keeps unresolved vl/wb references; assembly and CFR do not
; need the referenced classes to exist for this control-flow reduction.
.method public static c : (Lvl;)V
    .code stack 4 locals 14
L0:     aload_0
L1:     getfield Field vl I B
L4:     istore_2
L5:     aload_0
L6:     getfield Field vl p I
L9:     istore_3
L10:    aload_0
L11:    getfield Field vl b I
L14:    istore        4
L16:    aload_0
L17:    getfield Field vl o I
L20:    istore        5
L22:    getstatic Field wb Zb [I
L25:    astore        6
L27:    aload_0
L28:    getfield Field vl z I
L31:    istore        7
L33:    aload_0
L34:    getfield Field vl w [B
L37:    astore        8
L39:    aload_0
L40:    getfield Field vl E I
L43:    istore        9
L45:    aload_0
L46:    getfield Field vl e I
L49:    istore        10
L51:    iload         10
L53:    istore        11
L55:    aload_0
L56:    getfield Field vl m I
L59:    iconst_1
L60:    iadd
L61:    istore        12
L63:    iload_3
L64:    ifle L117
L67:    iload         10
L69:    ifeq L358
L72:    iload_3
L73:    iconst_1
L74:    if_icmpeq L95
L77:    aload         8
L79:    iload         9
L81:    iload_2
L82:    bastore
L83:    iinc          3 -1
L86:    iinc          9 1
L89:    iinc          10 -1
L92:    goto L67
L95:    iload         10
L97:    ifne L105
L100:   iconst_1
L101:   istore_3
L102:   goto L358
L105:   aload         8
L107:   iload         9
L109:   iload_2
L110:   bastore
L111:   iinc          9 1
L114:   iinc          10 -1
L117:   iload         4
L119:   iload         12
L121:   if_icmpne L129
L124:   iconst_0
L125:   istore_3
L126:   goto L358
L129:   iload         5
L131:   i2b
L132:   istore_2
L133:   aload         6
L135:   iload         7
L137:   iaload
L138:   istore        7
L140:   iload         7
L142:   i2b
L143:   istore_1
L144:   iload         7
L146:   bipush        8
L148:   ishr
L149:   istore        7
L151:   iinc          4 1
L154:   iload_1
L155:   iload         5
L157:   if_icmpeq L188
L160:   iload_1
L161:   istore        5
L163:   iload         10
L165:   ifne L173
L168:   iconst_1
L169:   istore_3
L170:   goto L358
L173:   aload         8
L175:   iload         9
L177:   iload_2
L178:   bastore
L179:   iinc          9 1
L182:   iinc          10 -1
L185:   goto L117
L188:   iload         4
L190:   iload         12
L192:   if_icmpne L220
L195:   iload         10
L197:   ifne L205
L200:   iconst_1
L201:   istore_3
L202:   goto L358
L205:   aload         8
L207:   iload         9
L209:   iload_2
L210:   bastore
L211:   iinc          9 1
L214:   iinc          10 -1
L217:   goto L117
L220:   iconst_2
L221:   istore_3
L222:   aload         6
L224:   iload         7
L226:   iaload
L227:   istore        7
L229:   iload         7
L231:   i2b
L232:   istore_1
L233:   iload         7
L235:   bipush        8
L237:   ishr
L238:   istore        7
L240:   iinc          4 1
L243:   iload         4
L245:   iload         12
L247:   if_icmpeq L63
L250:   iload_1
L251:   iload         5
L253:   if_icmpeq L262
L256:   iload_1
L257:   istore        5
L259:   goto L63
L262:   iconst_3
L263:   istore_3
L264:   aload         6
L266:   iload         7
L268:   iaload
L269:   istore        7
L271:   iload         7
L273:   i2b
L274:   istore_1
L275:   iload         7
L277:   bipush        8
L279:   ishr
L280:   istore        7
L282:   iinc          4 1
L285:   iload         4
L287:   iload         12
L289:   if_icmpeq L63
L292:   iload_1
L293:   iload         5
L295:   if_icmpeq L304
L298:   iload_1
L299:   istore        5
L301:   goto L63
L304:   aload         6
L306:   iload         7
L308:   iaload
L309:   istore        7
L311:   iload         7
L313:   i2b
L314:   istore_1
L315:   iload         7
L317:   bipush        8
L319:   ishr
L320:   istore        7
L322:   iinc          4 1
L325:   iload_1
L326:   sipush        255
L329:   iand
L330:   iconst_4
L331:   iadd
L332:   istore_3
L333:   aload         6
L335:   iload         7
L337:   iaload
L338:   istore        7
L340:   iload         7
L342:   i2b
L343:   istore        5
L345:   iload         7
L347:   bipush        8
L349:   ishr
L350:   istore        7
L352:   iinc          4 1
L355:   goto L63
L358:   aload_0
L359:   getfield Field vl f I
L362:   istore        13
L364:   aload_0
L365:   dup
L366:   getfield Field vl f I
L369:   iload         11
L371:   iload         10
L373:   isub
L374:   iadd
L375:   putfield Field vl f I
L378:   aload_0
L379:   getfield Field vl f I
L382:   iload         13
L384:   if_icmpge L387
L387:   aload_0
L388:   iload_2
L389:   putfield Field vl I B
L392:   aload_0
L393:   iload_3
L394:   putfield Field vl p I
L397:   aload_0
L398:   iload         4
L400:   putfield Field vl b I
L403:   aload_0
L404:   iload         5
L406:   putfield Field vl o I
L409:   aload         6
L411:   putstatic Field wb Zb [I
L414:   aload_0
L415:   iload         7
L417:   putfield Field vl z I
L420:   aload_0
L421:   aload         8
L423:   putfield Field vl w [B
L426:   aload_0
L427:   iload         9
L429:   putfield Field vl E I
L432:   aload_0
L433:   iload         10
L435:   putfield Field vl e I
L438:   return
    .end code
.end method
.end class
