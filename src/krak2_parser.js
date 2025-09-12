const P = require('parsimmon');

function createUnsignedParser(bits) {
    const max = (1n << BigInt(bits)) - 1n; // Maximum value for unsigned integer
    return (r) =>
      r.INT_LITERAL.chain((num) => {
        if (num >= 0n && num <= max) {
          return P.succeed(num);
        } else {
          return P.fail(`Value out of range for u${bits}`);
        }
      });
  }

  function createSignedParser(bits) {
    const min = -(1n << (BigInt(bits) - 1n)); // Minimum value for signed integer
    const max = (1n << (BigInt(bits) - 1n)) - 1n; // Maximum value for signed integer
    return (r) =>
      r.INT_LITERAL.chain((num) => {
        if (num >= min && num <= max) {
          return P.succeed(num);
        } else {
          return P.fail(`Value out of range for i${bits}`);
        }
      });
  }

  const flagTokens = [
    "abstract",
    "annotation",
    "bridge",
    "enum",
    "final",
    "interface",
    "mandated",
    "module",
    "native",
    "open",
    "private",
    "protected",
    "public",
    "static",
    "static_phase",
    "strict",
    "strictfp",
    "super",
    "synchronized",
    "synthetic",
    "transient",
    "transitive",
    "varargs",
    "volatile"
  ];

  const mhtagTokens = [
    "getField",
    "getStatic",
    "putField",
    "putStatic",
    "invokeVirtual",
    "invokeStatic",
    "invokeSpecial",
    "newInvokeSpecial",
    "invokeInterface"
  ];

  const noArgInstructions = [
    "iload_0",
    "iload_1",
    "iload_2",
    "iload_3",
    "astore_0",
    "astore_1",
    "astore_2",
    "astore_3",
    "aaload",
    "aastore",
    "aconst_null",
    "aload_0",
    "aload_1",
    "aload_2",
    "aload_3",
    "areturn",
    "arraylength",
    "athrow",
    "baload",
    "bastore",
    "caload",
    "castore",
    "d2f",
    "d2i",
    "d2l",
    "dadd",
    "daload",
    "dastore",
    "dcmpg",
    "dcmpl",
    "dconst_0",
    "dconst_1",
    "ddiv",
    "dload_0",
    "dload_1",
    "dload_2",
    "dload_3",
    "dmul",
    "dneg",
    "drem",
    "dreturn",
    "dstore_0",
    "dstore_1",
    "dstore_2",
    "dstore_3",
    "dsub",
    "dup",
    "dup2",
    "dup2_x1",
    "dup2_x2",
    "dup_x1",
    "dup_x2",
    "f2d",
    "f2i",
    "f2l",
    "fadd",
    "faload",
    "fastore",
    "fcmpg",
    "fcmpl",
    "fconst_0",
    "fconst_1",
    "fconst_2",
    "fdiv",
    "fload_0",
    "fload_1",
    "fload_2",
    "fload_3",
    "fmul",
    "fneg",
    "frem",
    "freturn",
    "fstore_0",
    "fstore_1",
    "fstore_2",
    "fstore_3",
    "fsub",
    "i2b",
    "i2c",
    "i2d",
    "i2f",
    "i2l",
    "i2s",
    "iadd",
    "iaload",
    "iand",
    "iastore",
    "iconst_0",
    "iconst_1",
    "iconst_2",
    "iconst_3",
    "iconst_4",
    "iconst_5",
    "iconst_m1",
    "idiv",
    "imul",
    "ineg",
    "ior",
    "irem",
    "ireturn",
    "ishl",
    "ishr",
    "istore_0",
    "istore_1",
    "istore_2",
    "istore_3",
    "isub",
    "iushr",
    "ixor",
    "l2d",
    "l2f",
    "l2i",
    "ladd",
    "laload",
    "land",
    "lastore",
    "lcmp",
    "lconst_0",
    "lconst_1",
    "ldiv",
    "lload_0",
    "lload_1",
    "lload_2",
    "lload_3",
    "lmul",
    "lneg",
    "lor",
    "lrem",
    "lreturn",
    "lshl",
    "lshr",
    "lstore_0",
    "lstore_1",
    "lstore_2",
    "lstore_3",
    "lsub",
    "lushr",
    "lxor",
    "monitorenter",
    "monitorexit",
    "nop",
    "pop",
    "pop2",
    "return",
    "saload",
    "sastore",
    "swap"
  ];

  const u8Instructions = [
    "aload",
    "astore",
    "dload",
    "dstore",
    "fload",
    "fstore",
    "iload",
    "istore",
    "lload",
    "lstore",
    "ret"
  ];

  const i8Instructions = ["bipush"];

  const clsrefInstructions = [
    "anewarray",
    "checkcast",
    "instanceof",
    "multianewarray",
    "new"
  ];

  const lblInstructions = [
    "goto",
    "goto_w",
    "if_acmpeq",
    "if_acmpne",
    "if_icmpeq",
    "if_icmpge",
    "if_icmpgt",
    "if_icmple",
    "if_icmplt",
    "if_icmpne",
    "ifeq",
    "ifge",
    "ifgt",
    "ifle",
    "iflt",
    "ifne",
    "ifnonnull",
    "ifnull",
    "jsr",
    "jsr_w"
  ];

  const refOrTaggedConstInstructions = [
    "getfield",
    "getstatic",
    "invokedynamic",
    "invokespecial",
    "invokestatic",
    "invokevirtual",
    "putfield",
    "putstatic"
  ];

  const ldcInstructions = ["ldc2_w", "ldc_w", "ldc"];

  const newarrayTypes = [
    "boolean",
    "char",
    "float",
    "double",
    "byte",
    "short",
    "int",
    "long"
  ];

const Lang = P.createLanguage({
    // Whitespace and Comments
    whitespace: () => P.regexp(/[ \t]+/).desc("whitespace"),
    comment: () =>
      P.string(";")
        .then(P.regexp(/[^\n]*/))
        .desc("comment"),
    ws: (r) => P.alt(r.whitespace, r.comment).many(),

    // NL Parser: One or more newlines with optional comments or whitespace
    NL: (r) =>
      P.seq(r.ws, P.regexp(/\n/).atLeast(1), r.ws).atLeast(1).desc("NL"),
    // WORD Parser
    WORD: () =>
      P.regexp(/(?:[a-zA-Z_$\(<]|\[[A-Z\[])[\w$;/\[\(\)<>*+-]*/).desc("WORD"),

    // REF Parser
    REF: () => P.regexp(/\[[a-z0-9_]+\]/).desc("REF"),

    // BSREF Parser
    BSREF: () => P.regexp(/\[bs:[a-z0-9_]+\]/).desc("BSREF"),

    // LABEL_DEF Parser
    LABEL_DEF: () => P.regexp(/L\w+:/).desc("LABEL_DEF"),

    // INT_LITERAL Parser
    INT_LITERAL: () =>
      P.regexp(/[+-]?(?:0x[0-9a-fA-F]+|[1-9][0-9]*|0)/).desc("INT_LITERAL"),

    // DOUBLE_LITERAL Parser
    DOUBLE_LITERAL: () =>
      P.alt(
        P.regexp(/[+-]Infinity/),
        P.regexp(/[+-]NaN(?:<0x[0-9a-fA-F]{16}>)?/),
        P.regexp(/[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?/),
        P.regexp(/[+-]?\d+[eE][+-]?\d+/),
        P.regexp(/[+-]?0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]+)?(?:p[+-]?\d+)/)
      ).desc("DOUBLE_LITERAL"),
    LONG_LITERAL: () =>
      P.regexp(/[+-]?(?:0x[0-9a-fA-F]+|[1-9][0-9]*|0)L/).desc("LONG_LITERAL"),
    FLOAT_LITERAL: () =>
      P.alt(
        P.regexp(/[+-]Infinityf/),
        P.regexp(/[+-]NaN(?:<0x[0-9a-fA-F]{8}>)?f/),
        P.regexp(/[+-]?\d*\.?\d+[eE][+-]?\d+f/),
        P.regexp(/[+-]?\d*\.?\d+f/),
        P.regexp(/[+-]?0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]+)?(?:p[+-]?\d+)f/)
      ).desc("FLOAT_LITERAL"),
    STRING_LITERAL: () =>
      P.alt(
        P.regexp(
          /b?"(?:[^"\\\n]|\\[\\nrt"'\\]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\x[0-9a-fA-F]{2})*"/
        ),
        P.regexp(
          /b?'(?:[^'\\\n]|\\[\\nrt"'\\]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\x[0-9a-fA-F]{2})*'/
        )
      ).desc("STRING_LITERAL"),
    u8: (r) => createUnsignedParser(8)(r),
    u16: (r) => createUnsignedParser(16)(r),
    u32: (r) => createUnsignedParser(32)(r),
    u64: (r) => createUnsignedParser(64)(r),

    // Signed integer parsers
    i8: (r) => createSignedParser(8)(r),
    i16: (r) => createSignedParser(16)(r),
    i32: (r) => createSignedParser(32)(r),
    i64: (r) => createSignedParser(64)(r),

    flags: (r) => P.alt(...flagTokens.map(P.string)).sepBy(P.whitespace),
    lbl: (r) =>
      r.WORD.chain((word) => {
        if (word.startsWith("L") && word[0] === "L") {
          return P.succeed(word);
        } else {
          return P.fail("Not a valid lbl");
        }
      }).desc("lbl"),

    // New parsers
    utf: (r) => P.alt(r.WORD, r.STRING_LITERAL).desc("utf"),

    utfref: (r) => P.alt(r.REF, r.utf).desc("utfref"),

    clsref: (r) => P.alt(r.REF, r.utf).desc("clsref"),

    single: (r) => P.alt(r.REF, r.utf).desc("single"),

    natref: (r) =>
      P.alt(r.REF, P.seq(r.utf.skip(r.ws), r.utfref)).desc("natref"),

    mhtag: () => P.alt(...mhtagTokens.map(P.string)).desc("mhtag"),

    ref_or_tagged_const: (r) =>
      P.alt(r.REF, r.tagged_const).desc("ref_or_tagged_const"),

    mhnotref: (r) =>
      P.seq(r.mhtag.skip(r.ws), r.ref_or_tagged_const).desc("mhnotref"),

    tagged_const: (r) =>
      P.alt(
        P.seq(P.string("Utf8").skip(r.ws), r.utf),
        P.seq(P.string("Int").skip(r.ws), r.i32),
        P.seq(P.string("Float").skip(r.ws), r.FLOAT_LITERAL),
        P.seq(P.string("Long").skip(r.ws), r.LONG_LITERAL),
        P.seq(P.string("Double").skip(r.ws), r.DOUBLE_LITERAL),
        P.seq(P.string("Class").skip(r.ws), r.utfref),
        P.seq(P.string("String").skip(r.ws), r.utfref),
        P.seq(P.string("MethodType").skip(r.ws), r.utfref),
        P.seq(P.string("MethodHandle").skip(r.ws), r.mhnotref),  // Move before Method to avoid conflicts
        P.seq(P.string("Module").skip(r.ws), r.utfref),
        P.seq(P.string("Package").skip(r.ws), r.utfref),
        P.seq(P.string("Field").skip(r.ws), r.clsref.skip(r.ws), r.natref),
        P.seq(P.string("Method").skip(r.ws), r.clsref.skip(r.ws), r.natref),
        P.seq(
          P.string("InterfaceMethod").skip(r.ws),
          r.clsref.skip(r.ws),
          r.natref
        ),
        P.seq(
          P.string("NameAndType").skip(r.ws),
          r.utfref.skip(r.ws),
          r.utfref
        ),
        P.seq(P.string("Dynamic").skip(r.ws), r.bsref.skip(r.ws), r.natref),
        P.seq(
          P.string("InvokeDynamic").skip(r.ws),
          r.bsref.skip(r.ws),
          r.natref
        )
      ).desc("tagged_const"),

    bs_args: (r) =>
      P.seq(r.ref_or_tagged_const.many().skip(r.ws), P.string(":")).desc(
        "bs_args"
      ),

    bsref: (r) =>
      P.alt(r.BSREF, P.seq(r.mhnotref.skip(r.ws), r.bs_args)).desc("bsref"),

    ref_or_tagged_bootstrap: (r) =>
      P.alt(
        r.BSREF,
        P.seq(P.string("Bootstrap").skip(r.ws), r.REF.skip(r.ws), r.bs_args),
        P.seq(
          P.string("Bootstrap").skip(r.ws),
          r.mhnotref.skip(r.ws),
          r.bs_args
        )
      ).desc("ref_or_tagged_bootstrap"),

    ldc_rhs: (r) =>
      P.alt(
        r.FLOAT_LITERAL,
        r.DOUBLE_LITERAL,
        r.LONG_LITERAL,
        r.STRING_LITERAL,
        r.REF,
        r.tagged_const,
        r.INT_LITERAL
      ).desc("ldc_rhs"),
    instruction: (r) =>
      P.alt(
        r.noArgInstruction,
        r.u8Instruction,
        r.i8Instruction,
        r.newarrayInstruction,  // Move before clsrefInstruction to avoid "new" vs "newarray" conflict
        r.multianewarrayInstruction,  // Move before clsrefInstruction to avoid conflicts
        r.clsrefInstruction,
        r.lblInstruction,
        r.refOrTaggedConstInstruction,
        r.ldcInstruction,
        r.i16Instruction,
        r.lookupswitchInstruction,
        r.tableswitchInstruction,
        r.wideInstruction,
        r.iincInstruction
      ).desc("instruction"),

    // No-argument instructions
    noArgInstruction: () =>
      P.alt(...noArgInstructions.map(P.string)).desc("No-Argument Instruction"),

    // u8 argument instructions
    u8Instruction: (r) =>
      P.alt(
        ...u8Instructions.map((instr) =>
          P.seqMap(P.string(instr).skip(r.ws), r.u8, (op, arg) => ({ op, arg }))
        )
      ).desc("u8 Instruction"),

    // i8 argument instructions
    i8Instruction: (r) =>
      P.seqMap(P.string("bipush").skip(r.ws), r.i8, (op, arg) => ({
        op,
        arg
      })).desc("i8 Instruction"),

    // iinc instruction (special case with u8 and i8)
    iincInstruction: (r) =>
      P.seqMap(
        P.string("iinc").skip(r.ws),
        r.u8.skip(r.ws),
        r.i8,
        (op, varnum, incr) => ({ op, varnum, incr })
      ).desc("iinc Instruction"),

    // clsref instructions
    clsrefInstruction: (r) =>
      P.alt(
        ...clsrefInstructions.map((instr) =>
          P.seqMap(P.string(instr).skip(r.ws), r.clsref, (op, arg) => ({
            op,
            arg
          }))
        )
      ).desc("clsref Instruction"),

    // multianewarray instruction (clsref u8)
    multianewarrayInstruction: (r) =>
      P.seqMap(
        P.string("multianewarray").skip(r.ws),
        r.clsref.skip(r.ws),
        r.u8,
        (op, cls, dims) => ({ op, cls, dims })
      ).desc("multianewarray Instruction"),

    // lbl instructions
    lblInstruction: (r) =>
      P.alt(
        ...lblInstructions.map((instr) =>
          P.seqMap(P.string(instr).skip(r.ws), r.lbl, (op, arg) => ({
            op,
            arg
          }))
        )
      ).desc("Label Instruction"),

    // ref_or_tagged_const instructions
    refOrTaggedConstInstruction: (r) =>
      P.alt(
        ...refOrTaggedConstInstructions.map((instr) =>
          P.seqMap(
            P.string(instr).skip(r.ws),
            r.ref_or_tagged_const,
            (op, arg) => ({ op, arg })
          )
        ),
        // Handle optional u8 for "invokeinterface"
        P.seqMap(
          P.string("invokeinterface").skip(r.ws),
          r.ref_or_tagged_const.skip(r.ws),
          r.u8.atMost(1), // u8 is optional
          (op, arg, count) => ({ op, arg, count: count[0] || null })
        )
      ).desc("ref_or_tagged_const Instruction"),

    // ldc instructions
    ldcInstruction: (r) =>
      P.alt(
        ...ldcInstructions.map((instr) =>
          P.seqMap(
            P.string(instr).skip(r.ws),
            r.ldc_rhs.skip(r.ws),
            (op, arg) => ({ op, arg })
          )
        )
      ).desc("ldc Instruction"),

    // newarray instruction
    newarrayInstruction: (r) =>
      P.seqMap(
        P.string("newarray").skip(r.ws),
        P.alt(...newarrayTypes.map(P.string)),
        (op, arg) => ({ op, arg })
      ).desc("newarray Instruction"),

    // i16 argument instruction
    i16Instruction: (r) =>
      P.seqMap(P.string("sipush").skip(r.ws), r.i16, (op, arg) => ({
        op,
        arg
      })).desc("i16 Instruction"),

    // lookupswitch instruction
    lookupswitchInstruction: (r) =>
      P.seqMap(
        P.string("lookupswitch").skip(r.ws),
        r.NL,
        r.lookupPairs.atLeast(0),
        P.string("default").skip(r.ws).skip(P.string(":")).skip(r.ws),
        r.lbl,
        (op, _, pairs, __, defaultLbl) => ({ op, pairs, defaultLbl })
      ).desc("lookupswitch Instruction"),

    lookupPairs: (r) =>
      P.seqMap(
        r.i32.skip(r.ws).skip(P.string(":")).skip(r.ws),
        r.lbl.skip(r.NL),
        (key, lbl) => ({ key, lbl })
      ),

    // tableswitch instruction
    tableswitchInstruction: (r) =>
      P.seqMap(
        P.string("tableswitch").skip(r.ws),
        r.i32.skip(r.ws).skip(r.NL),
        r.tableLabels.atLeast(1),
        P.string("default").skip(r.ws).skip(P.string(":")).skip(r.ws),
        r.lbl,
        (op, low, labels, _, defaultLbl) => ({
          op,
          low,
          labels,
          defaultLbl
        })
      ).desc("tableswitch Instruction"),

    tableLabels: (r) => r.lbl.skip(r.NL),

    // wide instruction
    wideInstruction: (r) =>
      P.seqMap(
        P.string("wide").skip(r.ws),
        r.wideInstructionBody,
        (op, body) => ({ op, body })
      ).desc("wide Instruction"),

    wideInstructionBody: (r) =>
      P.alt(
        P.seqMap(
          P.alt(
            P.string("aload"),
            P.string("astore"),
            P.string("dload"),
            P.string("dstore"),
            P.string("fload"),
            P.string("fstore"),
            P.string("iload"),
            P.string("istore"),
            P.string("lload"),
            P.string("lstore"),
            P.string("ret")
          ).skip(r.ws),
          r.u16,
          (instr, arg) => ({ instr, arg })
        ),
        P.seqMap(
          P.string("iinc").skip(r.ws),
          r.u16.skip(r.ws),
          r.i16,
          (instr, varnum, incr) => ({ instr, varnum, incr })
        )
      ).desc("wide Instruction Body"),

    // vtype Parser
    vtype: (r) =>
      P.alt(
        P.string("Float"),
        P.string("Integer"),
        P.string("Long"),
        P.string("Null"),
        P.seqMap(P.string("Object").skip(r.ws), r.clsref, (_, cls) => ({
          type: "Object",
          cls
        })),
        P.string("Top"),
        P.seqMap(P.string("Uninitialized").skip(r.ws), r.lbl, (_, lbl) => ({
          type: "Uninitialized",
          lbl
        })),
        P.string("UninitializedThis")
      ).desc("vtype"),

    // stack_map_item Parser
    stack_map_item: (r) =>
      P.alt(
        P.string("same").result({ type: "same" }),
        P.seqMap(P.string("stack_1").skip(r.ws), r.vtype, (_, vtype) => ({
          type: "stack_1",
          vtype
        })),
        P.seqMap(
          P.string("stack_1_extended").skip(r.ws),
          r.vtype,
          (_, vtype) => ({ type: "stack_1_extended", vtype })
        ),
        P.seqMap(P.string("chop").skip(r.ws), r.u8, (_, num) => ({
          type: "chop",
          num
        })),
        P.string("same_extended").result({ type: "same_extended" }),
        P.seqMap(
          P.string("append").skip(r.ws),
          r.vtype.many1(),
          (_, vtypes) => ({ type: "append", vtypes })
        ),
        P.seqMap(
          P.string("full").skip(r.ws).skip(r.NL),
          P.string("locals").skip(r.ws),
          r.vtype.many().skip(r.NL),
          P.string("stack").skip(r.ws),
          r.vtype.many().skip(r.NL),
          P.string(".end").skip(r.ws).skip(P.string("stack")),
          (_, __, locals, ___, stack, ____) => ({ type: "full", locals, stack })
        )
      ).desc("stack_map_item"),

    // code_directive Parser
    code_directive: (r) =>
      P.alt(
        P.seqMap(
          P.string(".catch").skip(r.ws),
          r.clsref.skip(r.ws),
          P.string("from").skip(r.ws),
          r.lbl.skip(r.ws),
          P.string("to").skip(r.ws),
          r.lbl.skip(r.ws),
          P.string("using").skip(r.ws),
          r.lbl,
          (_, clsref, __, fromLbl, ___, toLbl, ____, usingLbl) => ({
            type: "catch",
            clsref,
            fromLbl,
            toLbl,
            usingLbl
          })
        ),
        P.seqMap(
          P.string(".stack").skip(r.ws),
          r.stack_map_item,
          (_, item) => ({ type: "stack", item })
        )
      ).desc("code_directive"),

    // Line label parser
    line_label: () =>
      P.regexp(/L\d+:/).desc("line_label"),
    
    // code_item Parser
    code_item: (r) =>
      P.alt(
        // Label definition with optional instruction
        P.seqMap(
          r.LABEL_DEF.skip(r.ws),
          r.instruction.atMost(1),
          (labelDef, instr) => ({ labelDef, instruction: instr[0] || null })
        ),
        // Line label with instruction
        P.seqMap(
          r.line_label.skip(r.ws),
          r.instruction,
          (lineLabel, instr) => ({ lineLabel, instruction: instr })
        ),
        // Instruction without label
        r.instruction,
        // Code directive
        r.code_directive
      ).desc("code_item"),

    // code_attr Parser
    code_attr: (r) =>
      P.seqMap(
        P.string("long").skip(r.ws).atMost(1),
        P.string("stack").skip(r.ws),
        r.u16.skip(r.ws),
        P.string("locals").skip(r.ws),
        r.u16.skip(r.NL),
        r.code_item.skip(r.NL).atLeast(1),
        r.attribute.skip(r.NL).many(),
        P.string(".end").skip(r.ws).skip(P.string("code")),
        (
          longOpt,
          _,
          stackSize,
          __,
          localsSize,
          codeItems,
          attributes,
          ___
        ) => ({
          long: longOpt.length > 0,
          stackSize,
          localsSize,
          codeItems,
          attributes
        })
      ).desc("code_attr"),

    // attrbody Parser
    attrbody: (r) =>
      P.alt(
        P.seqMap(
          P.string(".annotationdefault").skip(r.ws),
          r.element_value,
          (_, value) => ({ type: "annotationdefault", value })
        ),
        P.string(".bootstrapmethods").result({ type: "bootstrapmethods" }),
        P.seqMap(P.string(".code").skip(r.ws), r.code_attr, (_, code) => ({
          type: "code",
          code
        })),
        P.seqMap(
          P.string(".constantvalue").skip(r.ws),
          r.ldc_rhs,
          (_, value) => ({ type: "constantvalue", value })
        ),
        P.string(".deprecated").result({ type: "deprecated" }),
        P.seqMap(
          P.string(".enclosing").skip(r.ws),
          P.string("method").skip(r.ws),
          r.clsref.skip(r.ws),
          r.natref,
          (_, __, cls, nat) => ({ type: "enclosingmethod", cls, nat })
        ),
        P.seqMap(
          P.string(".exceptions").skip(r.ws),
          r.clsref.many(),
          (_, exceptions) => ({ type: "exceptions", exceptions })
        ),
        P.seqMap(
          P.string(".innerclasses").skip(r.NL),
          P.seqMap(
            r.clsref.skip(r.ws),
            r.clsref.skip(r.ws),
            r.utfref.skip(r.ws),
            r.flags.skip(r.NL),
            (innerCls, outerCls, innerName, flags) => ({
              innerCls,
              outerCls,
              innerName,
              flags
            })
          ).many(),
          P.string(".end").skip(r.ws).skip(P.string("innerclasses")),
          (_, classes, __) => ({ type: "innerclasses", classes })
        ),
        P.seqMap(
          P.string(".linenumbertable").skip(r.ws),
          r.NL.atMost(1),
          P.seqMap(r.lbl.skip(r.ws), r.u16.skip(r.NL), (label, lineNumber) => ({
            label,
            lineNumber
          })).many(),
          P.string(".end").skip(r.ws).skip(P.string("linenumbertable")),
          (_, __, lines, ___) => ({ type: "linenumbertable", lines })
        ),
        P.seqMap(
          P.string(".localvariabletable").skip(r.NL),
          r.local_var_table_item.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("localvariabletable")),
          (_, vars, __) => ({ type: "localvariabletable", vars })
        ),
        P.seqMap(
          P.string(".localvariabletypetable").skip(r.NL),
          r.local_var_table_item.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("localvariabletypetable")),
          (_, vars, __) => ({ type: "localvariabletypetable", vars })
        ),
        P.seqMap(
          P.string(".methodparameters").skip(r.NL),
          r.method_parameter_item.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("methodparameters")),
          (_, params, __) => ({ type: "methodparameters", params })
        ),
        P.seqMap(P.string(".module").skip(r.ws), r.module, (_, module) => ({
          type: "module",
          module
        })),
        P.seqMap(
          P.string(".modulemainclass").skip(r.ws),
          r.clsref,
          (_, cls) => ({ type: "modulemainclass", cls })
        ),
        P.seqMap(
          P.string(".modulepackages").skip(r.ws),
          r.single.many(),
          (_, packages) => ({ type: "modulepackages", packages })
        ),
        P.seqMap(P.string(".nesthost").skip(r.ws), r.clsref, (_, cls) => ({
          type: "nesthost",
          cls
        })),
        P.seqMap(
          P.string(".nestmembers").skip(r.ws),
          r.clsref.many(),
          (_, members) => ({ type: "nestmembers", members })
        ),
        P.seqMap(
          P.string(".permittedsubclasses").skip(r.ws),
          r.clsref.many(),
          (_, subclasses) => ({ type: "permittedsubclasses", subclasses })
        ),
        P.seqMap(
          P.string(".record").skip(r.NL),
          r.record_item.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("record")),
          (_, records, __) => ({ type: "record", records })
        ),
        P.seqMap(
          P.string(".runtime").skip(r.ws),
          r.runtime_visibility.skip(r.ws),
          r.runtime_attr,
          (_, visibility, attr) => ({ type: "runtime", visibility, attr })
        ),
        P.seqMap(P.string(".signature").skip(r.ws), r.utfref, (_, sig) => ({
          type: "signature",
          sig
        })),
        P.seqMap(
          P.string(".sourcedebugextension").skip(r.ws),
          r.STRING_LITERAL,
          (_, value) => ({ type: "sourcedebugextension", value })
        ),
        P.seqMap(P.string(".sourcefile").skip(r.ws), r.utfref, (_, value) => ({
          type: "sourcefile",
          value
        })),
        P.string(".stackmaptable").result({ type: "stackmaptable" }),
        P.string(".synthetic").result({ type: "synthetic" })
      ).desc("attrbody"),

    // runtime_visibility Parser
    runtime_visibility: () =>
      P.alt(P.string("visible"), P.string("invisible")).desc(
        "runtime_visibility"
      ),

    // runtime_attr Parser
    runtime_attr: (r) =>
      P.alt(
        P.seqMap(
          P.string("annotations").skip(r.NL),
          r.annotation.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("annotations")),
          (_, annotations, __) => ({ type: "annotations", annotations })
        ),
        P.seqMap(
          P.string("paramannotations").skip(r.NL),
          r.param_annotation.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("paramannotations")),
          (_, paramAnnotations, __) => ({
            type: "paramannotations",
            paramAnnotations
          })
        ),
        P.seqMap(
          P.string("typeannotations").skip(r.NL),
          r.type_annotation.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("typeannotations")),
          (_, typeAnnotations, __) => ({
            type: "typeannotations",
            typeAnnotations
          })
        )
      ).desc("runtime_attr"),

    // annotation Parser
    annotation: (r) =>
      P.seqMap(r.annotation_sub, P.string("annotation"), (sub, _) => ({
        ...sub
      })).desc("annotation"),

    // annotation_sub Parser
    annotation_sub: (r) =>
      P.seqMap(
        r.utfref.skip(r.NL),
        P.seqMap(
          r.utfref.skip(r.ws).skip(P.string("=")).skip(r.ws),
          r.element_value.skip(r.NL),
          (name, value) => ({ name, value })
        ).many(),
        P.string(".end"),
        (typeName, elements, _) => ({ typeName, elements })
      ).desc("annotation_sub"),

    // element_value Parser
    element_value: (r) =>
      P.alt(
        P.seqMap(
          P.string("annotation").skip(r.ws),
          r.annotation,
          (_, annotation) => ({ type: "annotation", annotation })
        ),
        P.seqMap(
          P.string("array").skip(r.ws).skip(r.NL),
          r.element_value.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("array")),
          (_, values, __) => ({ type: "array", values })
        ),
        P.seqMap(P.string("boolean").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "boolean",
          value
        })),
        P.seqMap(P.string("byte").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "byte",
          value
        })),
        P.seqMap(P.string("char").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "char",
          value
        })),
        P.seqMap(P.string("class").skip(r.ws), r.utfref, (_, value) => ({
          type: "class",
          value
        })),
        P.seqMap(P.string("double").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "double",
          value
        })),
        P.seqMap(
          P.string("enum").skip(r.ws),
          r.utfref.skip(r.ws),
          r.utfref,
          (_, typeName, constName) => ({ type: "enum", typeName, constName })
        ),
        P.seqMap(P.string("float").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "float",
          value
        })),
        P.seqMap(P.string("int").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "int",
          value
        })),
        P.seqMap(P.string("long").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "long",
          value
        })),
        P.seqMap(P.string("short").skip(r.ws), r.ldc_rhs, (_, value) => ({
          type: "short",
          value
        })),
        P.seqMap(P.string("string").skip(r.ws), r.utfref, (_, value) => ({
          type: "string",
          value
        }))
      ).desc("element_value"),

    // local_var_table_item Parser
    local_var_table_item: (r) =>
      P.seqMap(
        r.u16.skip(r.ws),
        P.string("is").skip(r.ws),
        r.utfref.skip(r.ws),
        r.utfref.skip(r.ws),
        P.string("from").skip(r.ws),
        r.lbl.skip(r.ws),
        P.string("to").skip(r.ws),
        r.lbl,
        (index, _, name, descriptor, __, startLbl, ___, endLbl) => ({
          index,
          name,
          descriptor,
          startLbl,
          endLbl
        })
      ).desc("local_var_table_item"),

    // method_parameter_item Parser
    method_parameter_item: (r) =>
      P.seqMap(r.utfref.skip(r.ws), r.flags, (name, flags) => ({
        name,
        flags
      })).desc("method_parameter_item"),

    // module Parser
    module: (r) =>
      P.seqMap(
        r.utfref.skip(r.ws),
        r.flags.skip(r.ws),
        P.string("version").skip(r.ws),
        r.utfref.skip(r.NL),
        r.module_directives.many(),
        P.string(".end").skip(r.ws).skip(P.string("module")),
        (name, flags, _, version, directives, __) => ({
          name,
          flags,
          version,
          directives
        })
      ).desc("module"),

    // module_directives Parser
    module_directives: (r) =>
      P.alt(
        P.seqMap(
          P.string(".requires").skip(r.ws),
          r.single.skip(r.ws),
          r.flags.skip(r.ws),
          P.string("version").skip(r.ws),
          r.utfref.skip(r.NL),
          (_, moduleName, flags, __, version, ___) => ({
            type: "requires",
            moduleName,
            flags,
            version
          })
        ),
        P.seqMap(
          P.string(".exports").skip(r.ws),
          r.exports_item.skip(r.NL),
          (_, exportsItem) => ({
            type: "exports",
            exportsItem
          })
        ),
        P.seqMap(
          P.string(".opens").skip(r.ws),
          r.exports_item.skip(r.NL),
          (_, opensItem) => ({
            type: "opens",
            opensItem
          })
        ),
        P.seqMap(
          P.string(".uses").skip(r.ws),
          r.clsref.skip(r.NL),
          (_, cls) => ({
            type: "uses",
            cls
          })
        ),
        P.seqMap(
          P.string(".provides").skip(r.ws),
          r.clsref.skip(r.ws),
          P.string("with").skip(r.ws),
          r.clsref.skip(r.NL).many(),
          (_, service, __, implementations) => ({
            type: "provides",
            service,
            implementations
          })
        )
      ).desc("module_directives"),

    // exports_item Parser
    exports_item: (r) =>
      P.seqMap(
        r.single.skip(r.ws),
        r.flags.skip(r.ws),
        P.seq(P.string("to").skip(r.ws), r.single.skip(r.NL).many()).atMost(1),
        (packageName, flags, toClause) => ({
          packageName,
          flags,
          to: toClause.length > 0 ? toClause[0][1] : []
        })
      ).desc("exports_item"),

    // record_item Parser
    record_item: (r) =>
      P.seqMap(
        r.utfref.skip(r.ws),
        r.utfref.skip(r.ws),
        r.record_attrs.atMost(1),
        r.NL,
        (name, descriptor, attrs, _) => ({
          name,
          descriptor,
          attrs: attrs[0] || null
        })
      ).desc("record_item"),

    // record_attrs Parser
    record_attrs: (r) =>
      P.seqMap(
        P.string(".attributes").skip(r.ws).skip(r.NL),
        r.attribute.skip(r.NL).many(),
        P.string(".end").skip(r.ws).skip(P.string("attributes")),
        (_, attributes, __) => ({ attributes })
      ).desc("record_attrs"),

    // param_annotation Parser
    param_annotation: (r) =>
      P.seqMap(
        P.string(".paramannotation").skip(r.ws).skip(r.NL),
        r.annotation.skip(r.NL).many(),
        P.string(".end").skip(r.ws).skip(P.string("paramannotation")),
        (_, annotations, __) => ({ annotations })
      ).desc("param_annotation"),

    // type_annotation Parser
    type_annotation: (r) =>
      P.seqMap(
        P.string(".typeannotation").skip(r.ws),
        r.ta_target_info.skip(r.ws),
        r.ta_target_path.skip(r.ws),
        r.annotation_sub,
        P.string("typeannotation"),
        (_, targetInfo, targetPath, annotation, __) => ({
          targetInfo,
          targetPath,
          annotation
        })
      ).desc("type_annotation"),

    // ta_target_info Parser
    ta_target_info: (r) =>
      P.seqMap(
        r.u8.skip(r.ws),
        r.ta_target_info_body.skip(r.NL),
        (u8value, body) => ({ u8value, body })
      ).desc("ta_target_info"),

    // ta_target_info_body Parser
    ta_target_info_body: (r) =>
      P.alt(
        P.seqMap(P.string("typeparam").skip(r.ws), r.u8, (_, index) => ({
          type: "typeparam",
          index
        })),
        P.seqMap(P.string("super").skip(r.ws), r.u16, (_, index) => ({
          type: "super",
          index
        })),
        P.seqMap(
          P.string("typeparambound").skip(r.ws),
          r.u8.skip(r.ws),
          r.u8,
          (_, index1, index2) => ({ type: "typeparambound", index1, index2 })
        ),
        P.string("empty").result({ type: "empty" }),
        P.seqMap(P.string("methodparam").skip(r.ws), r.u8, (_, index) => ({
          type: "methodparam",
          index
        })),
        P.seqMap(P.string("throws").skip(r.ws), r.u16, (_, index) => ({
          type: "throws",
          index
        })),
        P.seqMap(
          P.string("localvar").skip(r.ws).skip(r.NL),
          r.localvar_info.skip(r.NL).many(),
          P.string(".end").skip(r.ws).skip(P.string("localvar")),
          (_, infos, __) => ({ type: "localvar", infos })
        ),
        P.seqMap(P.string("catch").skip(r.ws), r.u16, (_, index) => ({
          type: "catch",
          index
        })),
        P.seqMap(P.string("offset").skip(r.ws), r.lbl, (_, label) => ({
          type: "offset",
          label
        })),
        P.seqMap(
          P.string("typearg").skip(r.ws),
          r.lbl.skip(r.ws),
          r.u8,
          (_, label, index) => ({ type: "typearg", label, index })
        )
      ).desc("ta_target_info_body"),

    // localvar_info Parser
    localvar_info: (r) =>
      P.alt(
        P.string("nowhere").result({ type: "nowhere" }),
        P.seqMap(
          P.string("from").skip(r.ws),
          r.lbl.skip(r.ws),
          P.string("to").skip(r.ws),
          r.lbl,
          (_, fromLbl, __, toLbl) => ({ type: "range", fromLbl, toLbl })
        )
      ).desc("localvar_info"),

    // ta_target_path Parser
    ta_target_path: (r) =>
      P.seqMap(
        P.string(".typepath").skip(r.ws).skip(r.NL),
        P.seqMap(r.u8.skip(r.ws), r.u8.skip(r.NL), (kind, index) => ({
          kind,
          index
        })).many(),
        P.string(".end").skip(r.ws).skip(P.string("typepath")).skip(r.NL),
        (_, path, __) => ({ path })
      ).desc("ta_target_path"),

    // source_file Parser
    source_file: (r) =>
      r.ws.then(r.class_def.many()).skip(r.ws)
        .map((classes) => ({ classes }))
        .desc("source_file"),

    // class_def Parser
    class_def: (r) =>
      P.seqMap(
        P.seq(
          P.string(".version")
            .skip(r.ws)
            .then(r.u16)
            .skip(r.ws)
            .chain((major) => r.u16.map((minor) => ({ major, minor })))
            .skip(r.NL)
        ).atMost(1),
        P.string(".class").skip(r.ws),
        r.flags.skip(r.ws),
        r.clsref.skip(r.NL),
        P.string(".super").skip(r.ws),
        r.clsref.skip(r.NL),
        r.interface.many(),
        r.clsitem.sepBy(r.NL.many()),
        P.string(".end").skip(r.ws).skip(P.string("class")).skip(r.NL.atMost(1)),
        (
          versionOpt,
          _,
          flags,
          className,
          __,
          superClass,
          interfaces,
          items
        ) => ({
          version: versionOpt.length > 0 ? versionOpt[0] : null,
          flags,
          className,
          superClass,
          interfaces,
          items
        })
      ).desc("class_def"),

    // interface Parser
    interface: (r) =>
      P.seqMap(
        P.string(".implements").skip(r.ws),
        r.clsref.skip(r.NL),
        (_, interfaceName) => interfaceName
      ).desc("interface"),

    // clsitem Parser
    clsitem: (r) =>
      P.alt(
        P.seqMap(
          P.string(".bootstrap").skip(r.ws),
          r.BSREF.skip(r.ws).skip(P.string("=")).skip(r.ws),
          r.ref_or_tagged_bootstrap.skip(r.NL),
          (_, bsref, bootstrap) => ({ type: "bootstrap", bsref, bootstrap })
        ),
        P.seqMap(
          P.string(".const").skip(r.ws),
          r.REF.skip(r.ws).skip(P.string("=")).skip(r.ws),
          r.ref_or_tagged_const.skip(r.NL),
          (_, ref, constValue) => ({ type: "const", ref, constValue })
        ),
        P.seqMap(r.field, r.NL, (field, _) => ({ type: "field", field })),
        P.seqMap(r.method, r.NL, (method, _) => ({ type: "method", method })),
        P.seqMap(r.attribute, r.NL, (attribute, _) => ({
          type: "attribute",
          attribute
        }))
      ).desc("clsitem"),

    // field Parser
    field: (r) =>
      P.seqMap(
        P.string(".field").skip(r.ws),
        r.flags.skip(r.ws),
        r.utfref.skip(r.ws),
        r.utfref,
        P.seq(P.string("=").skip(r.ws), r.ldc_rhs).atMost(1),
        r.fieldattrs.atMost(1),
        (_, flags, name, descriptor, valueOpt, attrsOpt) => ({
          flags,
          name,
          descriptor,
          value: valueOpt.length > 0 ? valueOpt[0][1] : null,
          attrs: attrsOpt.length > 0 ? attrsOpt[0] : null
        })
      ).desc("field"),

    // fieldattrs Parser
    fieldattrs: (r) =>
      P.seqMap(
        P.string(".fieldattributes").skip(r.ws).skip(r.NL),
        r.attribute.skip(r.NL).many(),
        P.string(".end").skip(r.ws).skip(P.string("fieldattributes")),
        (_, attributes, __) => ({ attributes })
      ).desc("fieldattrs"),

    // method Parser
    method: (r) =>
      P.seqMap(
        P.string(".method").skip(r.ws),
        r.flags.skip(r.ws),
        r.utfref.skip(r.ws).skip(P.string(":")).skip(r.ws),
        r.utfref.skip(r.NL),
        r.attribute.skip(r.NL).many(),
        P.string(".end").skip(r.ws).skip(P.string("method")),
        (_, flags, name, descriptor, attributes, __) => ({
          flags,
          name,
          descriptor,
          attributes
        })
      ).desc("method"),

    // attribute Parser
    attribute: (r) =>
      P.alt(
        P.seqMap(
          P.string(".attribute").skip(r.ws),
          r.utfref.skip(r.ws),
          P.seq(P.string("length").skip(r.ws), r.u32.skip(r.ws)).atMost(1),
          r.STRING_LITERAL,
          (_, name, lengthOpt, value) => ({
            name,
            length: lengthOpt.length > 0 ? lengthOpt[0][1] : null,
            value
          })
        ),
        P.seqMap(
          P.string(".attribute").skip(r.ws),
          r.utfref.skip(r.ws),
          P.seq(P.string("length").skip(r.ws), r.u32.skip(r.ws)).atMost(1),
          r.attrbody,
          (_, name, lengthOpt, body) => ({
            name,
            length: lengthOpt.length > 0 ? lengthOpt[0][1] : null,
            body
          })
        ),
        r.attrbody // Assuming attrbody can appear on its own
      ).desc("attribute")
  });

module.exports = { Lang };
