module.exports = {
  disassemble,parseClassFile
};

function disassemble(ast, constantPool) {
  const output = [];
  const constantPoolMap = {};
  for (let i = 1; i < constantPool.length; i++) {
    const entry = constantPool[i];
    if (entry) {
      constantPoolMap[i] = entry;
    }
  }

  // Helper functions
  function getUtf8(index) {
    const entry = constantPoolMap[index];
    if (entry && entry.tag === 1) {
      return entry.info.bytes;
    }
    return null;
  }

  function getClassName(index) {
    const entry = constantPoolMap[index];
    if (entry && entry.tag === 7) {
      const nameIndex = entry.info.name_index;
      const name = getUtf8(nameIndex);
      return name.replace(/\//g, ".");
    }
    return null;
  }

  function getNameAndType(index) {
    const entry = constantPoolMap[index];
    if (entry && entry.tag === 12) {
      const name = getUtf8(entry.info.name_index);
      const descriptor = getUtf8(entry.info.descriptor_index);
      return { name, descriptor };
    }
    return null;
  }

  function getMethodRef(index) {
    const entry = constantPoolMap[index];
    if (entry && entry.tag === 10) {
      const className = getClassName(entry.info.class_index);
      const nameAndType = getNameAndType(entry.info.name_and_type_index);
      return {
        className,
        name: nameAndType.name,
        descriptor: nameAndType.descriptor
      };
    }
    return null;
  }

  function getFieldRef(index) {
    const entry = constantPoolMap[index];
    if (entry && entry.tag === 9) {
      const className = getClassName(entry.info.class_index);
      const nameAndType = getNameAndType(entry.info.name_and_type_index);
      return {
        className,
        name: nameAndType.name,
        descriptor: nameAndType.descriptor
      };
    }
    return null;
  }

  function getInterfaceMethodRef(index) {
    const entry = constantPoolMap[index];
    if (entry && entry.tag === 11) {
      const className = getClassName(entry.info.class_index);
      const nameAndType = getNameAndType(entry.info.name_and_type_index);
      return {
        className,
        name: nameAndType.name,
        descriptor: nameAndType.descriptor
      };
    }
    return null;
  }

  function getAccessFlags(flags, context = "class") {
    const access = [];
    const flagMap = {
      class: {
        0x0001: "public",
        0x0010: "final",
        0x0020: "super",
        0x0200: "interface",
        0x0400: "abstract",
        0x1000: "synthetic",
        0x2000: "annotation",
        0x4000: "enum",
        0x8000: "module"
      },
      method: {
        0x0001: "public",
        0x0002: "private",
        0x0004: "protected",
        0x0008: "static",
        0x0010: "final",
        0x0020: "synchronized",
        0x0040: "bridge",
        0x0080: "varargs",
        0x0100: "native",
        0x0400: "abstract",
        0x0800: "strictfp",
        0x1000: "synthetic"
      },
      field: {
        0x0001: "public",
        0x0002: "private",
        0x0004: "protected",
        0x0008: "static",
        0x0010: "final",
        0x0040: "volatile",
        0x0080: "transient",
        0x1000: "synthetic",
        0x4000: "enum"
      }
    };

    for (const flag in flagMap[context]) {
      if (flags & flag) {
        access.push(flagMap[context][flag]);
      }
    }
    return access.join(" ");
  }

  // Output header
  if (ast.sourceFile) {
    output.push(`Compiled from "${ast.sourceFile}"`);
  }

  // Class declaration
  const classAccess = getAccessFlags(ast.accessFlags, "class");
  const className = ast.className;
  const superClassName = ast.superClassName;
  output.push(`${classAccess} class ${className} extends ${superClassName} {`);

  // Fields
  for (const field of ast.fields) {
    const fieldAccess = getAccessFlags(field.accessFlags, "field");
    const fieldDescriptor = field.descriptor;
    output.push(`  ${fieldDescriptor} ${field.name};`);
  }
  output.push("");

  // Methods
  for (const method of ast.methods) {
    const methodAccess = getAccessFlags(method.accessFlags, "method");
    const methodDescriptor = method.descriptor;
    const methodName = method.name;
    const exceptions = method.exceptions;

    // Simplify method signature for display purposes
    const returnType = methodDescriptor.substring(
      methodDescriptor.lastIndexOf(")") + 1
    );
    const methodSignature = `${methodAccess} ${returnType} ${methodName}(${methodDescriptor.substring(
      1,
      methodDescriptor.lastIndexOf(")")
    )});`;

    let methodLine = `  ${methodSignature}`;
    if (exceptions && exceptions.length > 0) {
      methodLine += ` throws ${exceptions.join(", ")}`;
    }
    output.push(methodLine);

    // Output Code:
    if (method.code) {
      const codeOutput = processMethod(method);
      codeOutput.split("\n").forEach((line) => output.push(`    ${line}`));
    }
    output.push("");
  }

  output.push("}");

  function processMethod(method) {
    const output = [];
    const instructions = method.code.instructions;

    // Process instructions
    for (const instr of instructions) {
      const pc = instr.pc;
      const opcodeName = instr.opcodeName;
      const operands = instr.operands;
      const comment = instr.comment;

      // Output the instruction
      let line = `${pc}: ${opcodeName}`;

      // Process operands
      if (opcodeName === "tableswitch") {
        // Handle 'tableswitch'
        line += "   { // ";
        line += `${operands.low} to ${operands.high}`;
        output.push(line);

        for (let i = 0; i < operands.jumpOffsets.length; i++) {
          const value = operands.low + i;
          const targetPc = operands.jumpOffsets[i];
          output.push(`  res        ${value}: ${targetPc}`);
        }
        const defaultPc = operands.default;
        output.push(`      default: ${defaultPc}`);
        output.push("     }");
        continue;
      } else if (
        opcodeName.startsWith("if") ||
        opcodeName === "goto" ||
        opcodeName === "jsr"
      ) {
        const targetPc = instr.pc + operands.branchoffset;
        line += `          ${targetPc}`;
      } else if (
        [
          "getstatic",
          "putstatic",
          "getfield",
          "putfield",
          "invokevirtual",
          "invokespecial",
          "invokestatic",
          "invokeinterface",
          "new",
          "anewarray",
          "checkcast",
          "instanceof"
        ].includes(opcodeName)
      ) {
        const index = operands.index;
        line += ` #${index}`;
        if (opcodeName === "invokeinterface") {
          // Also include count and zero operands
          line += `,  ${operands.count}`;
        }

        // Now, resolve the comment
        let commentText = "";
        if (
          opcodeName === "getfield" ||
          opcodeName === "putfield" ||
          opcodeName === "getstatic" ||
          opcodeName === "putstatic"
        ) {
          const fieldRef = getFieldRef(index);
          commentText = `Field ${fieldRef.className}.${fieldRef.name}:${fieldRef.descriptor}`;
        } else if (
          opcodeName === "invokevirtual" ||
          opcodeName === "invokespecial" ||
          opcodeName === "invokestatic"
        ) {
          const methodRef = getMethodRef(index);
          commentText = `Method ${methodRef.className}.${methodRef.name}:${methodRef.descriptor}`;
        } else if (opcodeName === "invokeinterface") {
          const methodRef = getInterfaceMethodRef(index);
          commentText = `InterfaceMethod ${methodRef.className}.${methodRef.name}:${methodRef.descriptor}`;
        } else if (
          opcodeName === "new" ||
          opcodeName === "anewarray" ||
          opcodeName === "checkcast" ||
          opcodeName === "instanceof"
        ) {
          const className = getClassName(index);
          commentText = `Class ${className}`;
        }
        if (commentText) {
          line = line.padEnd(40) + ` // ${commentText}`;
        }
      } else if (
        opcodeName === "ldc" ||
        opcodeName === "ldc_w" ||
        opcodeName === "ldc2_w"
      ) {
        const index = operands.index;
        line += ` #${index}`;

        const cpEntry = constantPoolMap[index];
        let commentText = "";
        if (cpEntry.tag === 8) {
          const stringValue = getUtf8(cpEntry.info.string_index);
          commentText = `String "${stringValue}"`;
        } else if (cpEntry.tag === 3) {
          commentText = `int ${cpEntry.info.bytes}`;
        } else if (cpEntry.tag === 4) {
          commentText = `float ${cpEntry.info.bytes}`;
        } else if (cpEntry.tag === 7) {
          const className = getClassName(cpEntry.info.name_index);
          commentText = `Class ${className}`;
        }
        if (commentText) {
          line = line.padEnd(40) + ` // ${commentText}`;
        }
      } else if ("index" in operands) {
        line += ` ${operands.index}`;
      } else if ("value" in operands) {
        line += ` ${operands.value}`;
      }

      output.push(line);
    }

    // Output exception table
    if (method.code.exceptionTable && method.code.exceptionTable.length > 0) {
      output.push("Exception table:");
      output.push("   from    to  target type");
      for (const exception of method.code.exceptionTable) {
        const startPc = exception.start_pc;
        const endPc = exception.end_pc;
        const handlerPc = exception.handler_pc;
        const catchTypeIndex = exception.catch_type;
        let catchTypeName = "any";
        if (catchTypeIndex !== 0) {
          catchTypeName = getClassName(catchTypeIndex);
        }
        output.push(
          `      ${startPc}    ${endPc}    ${handlerPc}   Class ${catchTypeName}`
        );
      }
    }

    return output.join("\n");
  }

  return output.join("\n");
}


function parseClassFile(jsonObject, opcodeNames) {
  const cpEntries = jsonObject.constant_pool.entries;
  const constantPool = []; // Use 1-based indexing for constant pool

  // Build the constant pool mapping
  for (let i = 1; i < cpEntries.length; i++) {
    constantPool[i] = cpEntries[i];
  }

  // Helper functions to resolve constant pool entries
  function getUtf8(index) {
    const entry = constantPool[index];
    if (entry && entry.tag === 1) {
      return entry.info.bytes;
    }
    return null;
  }

  function getClassName(index) {
    const entry = constantPool[index];
    if (entry && entry.tag === 7) {
      return getUtf8(entry.info.name_index).replace(/\//g, ".");
    }
    return null;
  }

  function getNameAndType(index) {
    const entry = constantPool[index];
    if (entry && entry.tag === 12) {
      const name = getUtf8(entry.info.name_index);
      const descriptor = getUtf8(entry.info.descriptor_index);
      return { name, descriptor };
    }
    return null;
  }

  function getMethodRef(index) {
    const entry = constantPool[index];
    if (entry && entry.tag === 10) {
      const className = getClassName(entry.info.class_index);
      const nameAndType = getNameAndType(entry.info.name_and_type_index);
      return {
        className,
        name: nameAndType.name,
        descriptor: nameAndType.descriptor
      };
    }
    return null;
  }

  function getFieldRef(index) {
    const entry = constantPool[index];
    if (entry && entry.tag === 9) {
      const className = getClassName(entry.info.class_index);
      const nameAndType = getNameAndType(entry.info.name_and_type_index);
      return {
        className,
        name: nameAndType.name,
        descriptor: nameAndType.descriptor
      };
    }
    return null;
  }

  function getInterfaceMethodRef(index) {
    const entry = constantPool[index];
    if (entry && entry.tag === 11) {
      const className = getClassName(entry.info.class_index);
      const nameAndType = getNameAndType(entry.info.name_and_type_index);
      return {
        className,
        name: nameAndType.name,
        descriptor: nameAndType.descriptor
      };
    }
    return null;
  }

  // Parse the class file
  const ast = {
    sourceFile: null,
    className: getClassName(jsonObject.this_class),
    superClassName: getClassName(jsonObject.super_class),
    accessFlags: jsonObject.access_flags,
    fields: [],
    methods: [],
    major_version: jsonObject.major_version,
    minor_version: jsonObject.minor_version
  };

  // Resolve source file name
  const sourceFileAttr = jsonObject.attributes.find(
    (attr) => getUtf8(attr.attribute_name_index.index) === "SourceFile"
  );
  if (sourceFileAttr) {
    ast.sourceFile = getUtf8(sourceFileAttr.info.sourcefile_index);
  }

  // Process fields
  for (const field of jsonObject.fields) {
    const fieldName = getUtf8(field.name_index);
    const fieldDescriptor = getUtf8(field.descriptor_index);
    ast.fields.push({
      name: fieldName,
      descriptor: fieldDescriptor,
      accessFlags: field.access_flags
    });
  }

  // Process methods
  for (const method of jsonObject.methods) {
    const methodName = getUtf8(method.name_index);
    const methodDescriptor = getUtf8(method.descriptor_index);
    const methodInfo = {
      name: methodName,
      descriptor: methodDescriptor,
      accessFlags: method.access_flags,
      code: null,
      exceptions: []
    };

    // Find the Code attribute
    const codeAttr = method.attributes.find(
      (attr) => getUtf8(attr.attribute_name_index.index) === "Code"
    );
    if (codeAttr) {
      const codeInfo = codeAttr.info;
      const instructions = [];
      let pc = 0;

      for (const inst of codeInfo.code.instructions) {
        const opcode = inst.instruction.opcode;
        const opcodeInfo = inst.instruction.info || {};
        const opcodeLength = opcodeInfo.length || 1;

        const instruction = {
          pc,
          opcode,
          opcodeName: opcodeNames[opcode], // To be resolved later
          operands: opcodeInfo,
          comment: null
        };

        // Resolve operands for specific opcodes
        if ("index" in opcodeInfo) {
          const index = opcodeInfo.index;
          if (
            opcode === 178 ||
            opcode === 179 ||
            opcode === 180 ||
            opcode === 181
          ) {
            // getstatic, putstatic, getfield, putfield
            const fieldRef = getFieldRef(index);
            instruction.comment = `Field ${fieldRef.className}.${fieldRef.name}:${fieldRef.descriptor}`;
          } else if (
            opcode === 182 ||
            opcode === 183 ||
            opcode === 184 ||
            opcode === 185
          ) {
            // invokevirtual, invokespecial, invokestatic, invokeinterface
            const methodRef =
              opcode === 185
                ? getInterfaceMethodRef(index)
                : getMethodRef(index);
            instruction.comment = `Method ${methodRef.className}.${methodRef.name}:${methodRef.descriptor}`;
          } else if (
            opcode === 187 ||
            opcode === 189 ||
            opcode === 192 ||
            opcode === 193
          ) {
            // new, anewarray, checkcast, instanceof
            const className = getClassName(index);
            instruction.comment = `Class ${className}`;
          } else if (opcode === 18 || opcode === 19 || opcode === 20) {
            // ldc, ldc_w, ldc2_w
            const cpEntry = constantPool[index];
            if (cpEntry) {
              if (cpEntry.tag === 8) {
                const stringValue = getUtf8(cpEntry.info.string_index);
                instruction.comment = `String "${stringValue}"`;
              } else if (cpEntry.tag === 3) {
                instruction.comment = `int ${cpEntry.info.bytes}`;
              } else if (cpEntry.tag === 4) {
                instruction.comment = `float ${cpEntry.info.bytes}`;
              } else if (cpEntry.tag === 7) {
                const className = getClassName(cpEntry.info.name_index);
                instruction.comment = `Class ${className}`;
              }
            }
          } else if (opcode === 197) {
            // multianewarray
            const className = getClassName(index);
            instruction.comment = `Class ${className}`;
          }
        }

        instructions.push(instruction);
        pc += opcodeLength; // Simplification; in reality, instruction lengths vary
      }

      methodInfo.code = {
        maxStack: codeInfo.max_stack,
        maxLocals: codeInfo.max_locals,
        codeLength: codeInfo.code_length,
        instructions,
        exceptionTable: codeInfo.exception_table,
        attributes: codeInfo.attributes
      };
    }

    // Process exceptions
    const exceptionsAttr = method.attributes.find(
      (attr) => getUtf8(attr.attribute_name_index.index) === "Exceptions"
    );
    if (exceptionsAttr) {
      const exceptionIndexes = exceptionsAttr.info.exception_index_table;
      for (const exceptionIndex of exceptionIndexes) {
        const exceptionName = getClassName(exceptionIndex);
        methodInfo.exceptions.push(exceptionName);
      }
    }

    ast.methods.push(methodInfo);
  }

  return { ast, constantPool };
}
