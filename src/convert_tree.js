/**
 * Converts a parsed Java class AST to a structured format suitable for disassembly
 * @param {Object} inputJson - The parsed Java class structure from jvm_parser
 * @param {Array} constantPool - The constant pool entries from the class file
 * @returns {Object} A structured representation of the class with methods, fields, and metadata
 */
function resolveConstant(index, constantPool) {
  const entry = constantPool[index];
  if (!entry) return { value: null, type: "unknown" };
  switch (entry.tag) {
    case 1: // Utf8
      return { value: entry.info.bytes, type: "Utf8" };
    case 3: // Integer
      return { value: entry.info.bytes | 0, type: "Integer" };
    case 4: // Float
      const floatView = new DataView(new ArrayBuffer(4));
      floatView.setUint32(0, entry.info.bytes, false);
      return { value: floatView.getFloat32(0, false), type: "Float" };
    case 5: // Long
      let longValue = (BigInt(entry.info.high_bytes) << 32n) | BigInt(entry.info.low_bytes);
      if (longValue >= (1n << 63n)) {
        longValue -= (1n << 64n);
      }
      return {
        value: longValue,
        type: "Long"
      };
    case 6: // Double
      const doubleHigh = BigInt(entry.info.high_bytes);
      const doubleLow = BigInt(entry.info.low_bytes);
      const doubleBits = (doubleHigh << 32n) | doubleLow;
      const doubleView = new DataView(new ArrayBuffer(8));
      doubleView.setBigUint64(0, doubleBits, false);
      return {
        value: doubleView.getFloat64(0, false),
        type: "Double"
      };
    case 7: // Class
      return {
        value: resolveConstant(entry.info.name_index, constantPool).value,
        type: "Class"
      };
    case 8: // String
      return {
        value: resolveConstant(entry.info.string_index, constantPool).value,
        type: "String"
      };
    case 9: // Fieldref
    case 10: // Methodref
    case 11: // InterfaceMethodref
      const className = resolveConstant(entry.info.class_index, constantPool).value;
      const nameAndType = resolveConstant(
        entry.info.name_and_type_index, constantPool
      ).value;
      return {
        value: { className, nameAndType },
        type:
          entry.tag === 9
            ? "Fieldref"
            : entry.tag === 10
            ? "Methodref"
            : "InterfaceMethodref"
      };
    case 12: // NameAndType
      const name = resolveConstant(entry.info.name_index, constantPool).value;
      const descriptor = resolveConstant(entry.info.descriptor_index, constantPool).value;
      return { value: { name, descriptor }, type: "NameAndType" };
    case 15: // MethodHandle
      const kindMap = {1: "getField", 2: "getStatic", 3: "putField", 4: "putStatic", 5: "invokeVirtual", 6: "invokeStatic", 7: "invokeSpecial", 8: "newInvokeSpecial", 9: "invokeInterface"};
      const referenceKind = kindMap[entry.info.reference_kind];
      const reference = resolveConstant(entry.info.reference_index, constantPool);
      return { value: { kind: referenceKind, reference: reference.value }, type: "MethodHandle" };
    case 16: // MethodType
      const methodDescriptor = resolveConstant(entry.info.descriptor_index, constantPool).value;
      return { value: methodDescriptor, type: "MethodType" };
    case 18: // InvokeDynamic
      const bootstrapMethodAttrIndex = entry.info.bootstrap_method_attr_index;
      const nameAndTypeDynamic = resolveConstant(entry.info.name_and_type_index, constantPool).value;
      return { value: { bootstrap_method_attr_index: bootstrapMethodAttrIndex, nameAndType: nameAndTypeDynamic}, type: "InvokeDynamic" };
    default:
      return { value: null, type: "unknown" };
  }
}

function formatConst(entry, index, constantPool, cls) {
  if (!entry) return "";
  let line = `.const [_${index}] =`;

  switch(entry.tag) {
      case 18: // InvokeDynamic
          if (!cls.bootstrapMethods) return "";
          const bsmIndex = entry.info.bootstrap_method_attr_index;
          const bsm = cls.bootstrapMethods[bsmIndex];
          if (!bsm) return "";
          const nameAndType = resolveConstant(entry.info.name_and_type_index, constantPool).value;

          line += ` InvokeDynamic ${formatInstructionArg(bsm.method_ref.value.reference.nameAndType.name)} ${bsm.arguments.map(a => formatInstructionArg(a.value)).join(' ')} : ${nameAndType.name} ${nameAndType.descriptor}`;
          break;
      case 15: // MethodHandle
          const methodHandle = resolveConstant(index, constantPool).value;
          if (!methodHandle) return "";
          const refConst = methodHandle.reference;
          if (!refConst) return "";
          line += ` MethodHandle ${methodHandle.kind} Method ${refConst.className.replace(/\./g, '/')} ${refConst.nameAndType.name} ${refConst.nameAndType.descriptor}`;
          break;
      default:
          return "";
  }
  return line;
}


function convertJson(inputJson, constantPool) {
  // Map accessFlags to flags based on context (class, method, or field)
  const accessFlagMap = {
    class: {
      1: "public",
      16: "final",
      32: "super",
      512: "interface",
      1024: "abstract",
      4096: "enum",
      8192: "module",
      16384: "synthetic"
    },
    method: {
      1: "public",
      2: "private",
      4: "protected",
      8: "static",
      16: "final",
      32: "synchronized",
      64: "bridge",
      128: "varargs",
      256: "native",
      1024: "abstract",
      2048: "strictfp",
      4096: "synthetic"
    },
    field: {
      1: "public",
      2: "private",
      4: "protected",
      8: "static",
      16: "final",
      64: "volatile",
      128: "transient",
      4096: "enum",
      8192: "synthetic"
    }
  };

  const outputJson = {
    classes: [
      {
        version: [
          {
            major: inputJson.major_version.toString(),
            minor: inputJson.minor_version.toString()
          }
        ],
        flags: getFlags(inputJson.accessFlags, "class"),
        className: inputJson.className.replace(/\./g, "/"),
        superClassName: inputJson.superClassName
          ? inputJson.superClassName.replace(/\./g, "/")
          : null,
        interfaces: [], // Assuming no interfaces, adjust if needed
        items: []
      }
    ]
  };

  function getFlags(accessFlags, context) {
    const flags = [];
    for (const [flagValue, flagName] of Object.entries(
      accessFlagMap[context]
    )) {
      if (accessFlags & flagValue) {
        flags.push(flagName);
      }
    }
    return flags;
  }

  // Convert fields
  inputJson.fields.forEach((field) => {
    const fieldItem = {
      type: "field",
      field: {
        flags: getFlags(field.accessFlags, "field"),
        name: field.name,
        descriptor: field.descriptor,
        value: null, // Assuming no value, adjust if needed
        attrs: null // Assuming no attrs, adjust if needed
      }
    };
    outputJson.classes[0].items.push(fieldItem);
  });

  // Convert methods
  inputJson.methods.forEach((method) => {
    const methodItem = {
      type: "method",
      method: {
        flags: getFlags(method.accessFlags, "method"),
        name: method.name,
        descriptor: method.descriptor,
        attributes: []
      }
    };

    // Convert code attribute if exists
    if (method.code) {
      const codeAttr = {
        type: "code",
        code: {
          long: false, // Assuming not long, adjust if needed
          stackSize: method.code.maxStack.toString(),
          localsSize: method.code.maxLocals.toString(),
          codeItems: [],
          exceptionTable: [],
          attributes: []
        }
      };

      // Build a map for labels to program counters
      const labelMap = {};
      //let latest;
      method.code.instructions.forEach((instr, idx) => {
        labelMap[instr.pc] = `L${instr.pc}`;
        //latest=instr.pc;
      });
      labelMap[method.code.codeLength] = `L${method.code.codeLength}`;

      // Convert instructions
      method.code.instructions.forEach((instr) => {
        const codeItem = {};
        const labelDef = `L${instr.pc}:`;
        codeItem.labelDef = labelDef;

        // Handle different opcodes
        switch (instr.opcodeName) {
          case "invokespecial":
          case "invokevirtual":
          case "invokestatic":
          case "invokeinterface":
            const methodRef = resolveConstant(instr.operands.index, constantPool);
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: [
                instr.opcodeName === "invokeinterface"
                  ? "InterfaceMethod"
                  : "Method",
                methodRef.value.className.replace(/\./g, "/"),
                [
                  methodRef.value.nameAndType.name,
                  methodRef.value.nameAndType.descriptor
                ]
              ]
            };
            if (instr.opcodeName === "invokeinterface") {
              codeItem.instruction.count = instr.operands.count.toString();
            }
            break;

          case "invokedynamic":
            const invokeDynamicRef = resolveConstant(instr.operands.index, constantPool);
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: invokeDynamicRef.value
            };
            break;

          case "getfield":
          case "putfield":
          case "getstatic":
          case "putstatic":
            const fieldRef = resolveConstant(instr.operands.index, constantPool);
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: [
                "Field",
                fieldRef.value.className.replace(/\./g, "/"),
                [
                  fieldRef.value.nameAndType.name,
                  fieldRef.value.nameAndType.descriptor
                ]
              ]
            };
            break;

          case "ldc":
          case "ldc_w":
          case "ldc2_w":
            const ldcConstant = resolveConstant(instr.operands.index, constantPool);
            let arg;
            switch (ldcConstant.type) {
              case "Class":
                arg = ["Class", ldcConstant.value];
                break;
              case "String":
                arg = JSON.stringify(ldcConstant.value);
                break;
              case "Long":
                arg = ldcConstant.value.toString() + "L";
                break;
              default:
                arg = ldcConstant.value;
            }
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: arg
            };
            break;

          case "goto":
          case "ifnonnull":
          case "ifne":
          case "if_icmpge":
          case "if_icmpgt":
          case "ifnull":
          case "ifeq":
          case "if_icmpeq":
          case "if_icmpne":
          case "if_icmplt":
          case "if_icmple":
          case "if_acmpeq":
          case "if_acmpne":
          case "iflt":
          case "ifle":
          case "ifgt":
          case "ifge":
            const targetPc = instr.pc + instr.operands.branchoffset;
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: labelMap[targetPc]
            };
            break;

          case "tableswitch":
            const defaultPc = instr.pc + instr.operands.default;
            const jumpOffsets = instr.operands.jumpOffsets.map(
              (offset) => labelMap[instr.pc + offset]
            );
            codeItem.instruction = {
              op: "tableswitch",
              low: instr.operands.low.toString(),
              labels: jumpOffsets,
              defaultLbl: "L" + instr.operands.default
            };
            break;

          case "iinc":
            codeItem.instruction = {
              op: "iinc",
              varnum: instr.operands.index.toString(),
              incr: instr.operands.const.toString()
            };
            break;

          case "new":
          case "checkcast":
          case "instanceof":
          case "anewarray":
            const classInfo = resolveConstant(instr.operands.index, constantPool);
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: classInfo.value.replace(/\./g, "/")
            };
            break;

          case "newarray":
            const atypeMap = {
              4: "boolean",
              5: "char",
              6: "float",
              7: "double",
              8: "byte",
              9: "short",
              10: "int",
              11: "long"
            };
            codeItem.instruction = {
              op: "newarray",
              arg: atypeMap[instr.operands.atype]
            };
            break;

          case "multianewarray":
            const mclassInfo = resolveConstant(instr.operands.index, constantPool);
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: [mclassInfo.value.replace(/\./g, "/"), instr.operands.dimensions.toString()]
            };
            break;

          case "astore":
          case "aload":
          case "istore":
          case "iload":
          case "lstore":
          case "lload":
          case "fstore":
          case "fload":
          case "dstore":
          case "dload":
            // Instructions that take a local variable index
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: instr.operands.index.toString()
            };
            break;

          case "bipush":
            // Push byte value onto stack
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: instr.operands.byte.toString()
            };
            break;

          case "sipush":
            // Push short value onto stack
            codeItem.instruction = {
              op: instr.opcodeName,
              arg: instr.operands.value.toString()
            };
            break;

          default:
            // Handle wide instructions (ending with "_w")
            if (instr.opcodeName.endsWith("_w")) {
              const baseInstruction = instr.opcodeName.slice(0, -2); // Remove "_w" suffix
              if (baseInstruction === "iinc") {
                // iinc_w has both index and const operands
                codeItem.instruction = {
                  op: "wide",
                  arg: `${baseInstruction} ${instr.operands.index} ${instr.operands.const}`
                };
              } else {
                // Other wide instructions only have index operand
                codeItem.instruction = {
                  op: "wide",
                  arg: `${baseInstruction} ${instr.operands.index}`
                };
              }
            } else {
              // For simple instructions without operands
              codeItem.instruction = instr.opcodeName;
            }
            break;
        }

        codeAttr.code.codeItems.push(codeItem);
      });

      codeAttr.code.codeItems.push({
        labelDef: labelMap[method.code.codeLength] + ":",
        instruction: null
      });

      // Handle exception table entries
      if (method.code.exceptionTable && method.code.exceptionTable.length > 0) {
        codeAttr.code.exceptionTable = method.code.exceptionTable.map((ex) => {
          const catchTypeIndex = ex.catch_type;
          const catchType = catchTypeIndex === 0
            ? "any"
            : resolveConstant(catchTypeIndex, constantPool).value.replace(/\./g, "/");

          return {
            start_pc: ex.start_pc,
            end_pc: ex.end_pc,
            handler_pc: ex.handler_pc,
            catch_type: catchType,
          };
        });
      }

      // Convert attributes
      if (method.code.attributes) {
        method.code.attributes.forEach((attr) => {
          const attrName = resolveConstant(
            attr.attribute_name_index.index, constantPool
          ).value;
          if (attrName === "LineNumberTable") {
            const lineAttr = {
              type: "linenumbertable",
              lines: []
            };
            attr.info.line_number_table.forEach((line) => {
              const label = labelMap[line.start_pc];
              const lineNumber = line.line_number.toString();
              lineAttr.lines.push({
                label,
                lineNumber
              });
            });
            codeAttr.code.attributes.push(lineAttr);
          } else if (attrName === "LocalVariableTable") {
            const varAttr = {
              type: "localvariabletable",
              vars: []
            };
            attr.info.local_variable_table.forEach((varInfo) => {
              const varName = resolveConstant(varInfo.name_index, constantPool).value;
              const varDescriptor = resolveConstant(
                varInfo.descriptor_index, constantPool
              ).value;
              const varItem = {
                index: varInfo.index.toString(),
                name: varName,
                descriptor: varDescriptor,
                startLbl: labelMap[varInfo.start_pc],
                endLbl: labelMap[varInfo.start_pc + varInfo.length]
              };
              varAttr.vars.push(varItem);
            });
            codeAttr.code.attributes.push(varAttr);
          }
        });
      }

      methodItem.method.attributes.push(codeAttr);
    }

    // Convert exceptions
    if (method.exceptions && method.exceptions.length > 0) {
      const exAttr = {
        type: "exceptions",
        exceptions: method.exceptions.map((exceptionName) =>
          exceptionName.replace(/\./g, "/")
        )
      };
      methodItem.method.attributes.push(exAttr);
    }

    outputJson.classes[0].items.push(methodItem);
  });

  // Add sourcefile attribute
  outputJson.classes[0].items.push({
    type: "attribute",
    attribute: {
      type: "sourcefile",
      value: `"${inputJson.sourceFile}"`
    }
  });

  const bootstrapMethodsAttr = inputJson.attributes.find(
    (attr) => resolveConstant(attr.attribute_name_index.index, constantPool).value === "BootstrapMethods"
  );

  if (bootstrapMethodsAttr) {
    outputJson.classes[0].bootstrapMethods = bootstrapMethodsAttr.info.bootstrap_methods.map((bsm) => {
      return {
        method_ref: resolveConstant(bsm.bootstrap_method_ref, constantPool),
        arguments: bsm.bootstrap_arguments.map(argIndex => resolveConstant(argIndex, constantPool))
      };
    });
  }

  return outputJson;
}

/**
 * Formats a single instruction for display
 * @param {Object|String} instr - The instruction to format
 * @returns {String} Formatted instruction string
 */
function formatInstruction(instr) {
  if (!instr) {
    return "null";
  }
  if (typeof instr === "string") {
    return instr;
  } else if (instr.op === "tableswitch") {
    // Prioritize tableswitch check
    const labelsStr = instr.labels
      .map((label) => `            ${label}`)
      .join("\n");
    return `${instr.op} ${instr.low}\n${labelsStr}\n            default : ${instr.defaultLbl}`; // Format tableswitch with labels and default label
  } else if (instr.op === "iinc") {
    // Handle iinc instruction with arguments
    return `${instr.op} ${instr.varnum} ${instr.incr}`;
  } else if (instr.op !== undefined && instr.arg !== undefined) {
    const argStr = formatInstructionArg(instr.arg);
    if (instr.op === "invokeinterface" && instr.count !== undefined) {
      return `${instr.op} ${argStr} ${instr.count}`; // Include the count for invokeinterface
    } else {
      return `${instr.op} ${argStr}`;
    }
  } else {
    return instr.op || "";
  }
}

/**
 * Formats instruction arguments for display
 * @param {*} arg - The argument to format
 * @returns {String} Formatted argument string
 */
function formatInstructionArg(arg) {
  if (typeof arg === "string") {
    return arg;
  } else if (Array.isArray(arg)) {
    // Recursively format each item and join with spaces
    return arg.map(formatInstructionArg).join(" ");
  } else if (typeof arg === "object") {
    // For object arguments, check if it's a sourcefile attribute
    if (arg.type === "sourcefile") {
      return arg.value; // Return the value directly without further formatting
    } else {
      // For other object arguments, format their values
      return Object.values(arg).map(formatInstructionArg).join(" ");
    }
  } else {
    return String(arg);
  }
}

/**
 * Converts a structured class representation into assembly-like textual format
 * @param {Object} cls - The class object with methods, fields, flags, and other class metadata
 * @returns {String} Assembly-like representation of the class suitable for debugging/analysis
 */
function unparseDataStructures(cls, constantPool) {
  function formatCodeAttribute(attr) {
    if (attr.type === "linenumbertable") {
      const lines = [
        `        .linenumbertable`,
        ...attr.lines.map(
          (line) => `            ${line.label} ${line.lineNumber}`
        ),
        `        .end linenumbertable`
      ];
      return lines.join("\n");
    } else if (attr.type === "localvariabletable") {
      const vars = [
        `        .localvariabletable`,
        ...attr.vars.map(
          (v) =>
            `            ${v.index} is ${v.name} ${v.descriptor} from ${v.startLbl} to ${v.endLbl}`
        ),
        `        .end localvariabletable`
      ];
      return vars.join("\n");
    }
    // Add more cases as needed
    return "";
  }

  return ((cls) => {
      // Include the .version directive if present
      const headerLines = [];

      if (cls.version && cls.version.length > 0) {
        headerLines.push(
          `.version ${cls.version[0].major} ${cls.version[0].minor}`
        );
      }

      headerLines.push(`.class ${cls.flags.join(" ")} ${cls.className}`);
      headerLines.push(`.super ${cls.superClassName}`);

      // Handle interfaces
      if (cls.interfaces && cls.interfaces.length > 0) {
        headerLines.push(
          cls.interfaces.map((iface) => `.implements ${iface}`).join("\n")
        );
      }

      // Fields
      const fields = cls.items
        .filter((item) => item.type === "field")
        .map((item) => {
          const field = item.field;
          return `.field ${field.name} ${field.descriptor};`;
        })
        .join("\n\n");

      // Methods
      const methods = cls.items
        .filter((item) => item.type === "method")
        .map((item) => {
          const method = item.method;
          const methodHeader = `.method ${method.flags.join(" ")} ${
            method.name
          } : ${method.descriptor}`;

          // Code attribute
          const codeAttribute = method.attributes.find(
            (attr) => attr.type === "code"
          );
          let codeSection = "";
          if (codeAttribute && codeAttribute.code) {
            const codeLines = [
              `    .code stack ${codeAttribute.code.stackSize} locals ${codeAttribute.code.localsSize}`,
              ...codeAttribute.code.codeItems.flatMap((ci) => {
                let line = "";
                if (ci.labelDef) {
                  line += `${ci.labelDef}`;
                }
                if (ci.instruction) {
                  if (line.length > 0) {
                    line += "    ";
                  }
                  line += formatInstruction(ci.instruction);
                }
                if (ci.type === "catch") {
                  line = `    .catch ${ci.clsref} from ${ci.fromLbl} to ${ci.toLbl} using ${ci.usingLbl}`;
                }
                return line ? [line] : [];
              }),
              ...codeAttribute.code.attributes.map((attr) =>
                formatCodeAttribute(attr)
              ),
              `    .end code`
            ];
            codeSection = codeLines.join("\n");
          }

          // Exceptions
          const exceptionsAttribute = method.attributes.find(
            (attr) => attr.type === "exceptions"
          );
          let exceptionsSection = "";
          if (exceptionsAttribute) {
            exceptionsSection = `    .exceptions ${exceptionsAttribute.exceptions.join(
              " "
            )}`;
          }

          return [methodHeader, codeSection, exceptionsSection, `.end method`]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n");

      // Source file
      const sourceFileAttribute = cls.items.find(
        (item) => item.attribute && item.attribute.type === "sourcefile"
      );
      let sourceFileLine = "";
      if (sourceFileAttribute) {
        sourceFileLine = `.sourcefile ${sourceFileAttribute.attribute.value}`;
      }

      const constLines = constantPool.map((entry, index) => formatConst(entry, index, constantPool, cls)).filter(Boolean).join('\n');

      // Combine all parts
      return [
        headerLines.filter(Boolean).join("\n"),
        fields,
        methods,
        sourceFileLine,
        constLines,
        `.end class`
      ]
        .filter(Boolean)
        .join("\n");
    })(cls);
}

module.exports={unparseDataStructures,convertJson,formatInstruction};
