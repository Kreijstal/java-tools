const { computeAccessFlags } = require('./access_flags');

const referenceKinds = new Set(['Method', 'InterfaceMethod', 'Field']);

function ensureArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseSpecialFloatingLiteral(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const match = raw.match(/^([+-]?)(Infinity|NaN)([fFdD]?)$/);
  if (!match) {
    return null;
  }

  const [, signPart, literal, suffix] = match;
  const normalizedSuffix = suffix ? suffix.toLowerCase() : '';
  const type = normalizedSuffix === 'f' ? 'Float' : 'Double';

  let value;
  if (literal.toLowerCase() === 'nan') {
    value = Number.NaN;
  } else {
    const signMultiplier = signPart === '-' ? -1 : 1;
    value = signMultiplier === -1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  if (type === 'Float') {
    value = Math.fround(value);
  }

  return { value, type };
}

function parseMaybeInt(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }

  return value;
}

function normalizeLabel(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    return value.lbl ?? value.label ?? value.defaultLabel ?? value.default ?? value.name ?? (typeof value.toString === 'function' ? value.toString() : null);
  }

  return value;
}

function normalizeLookupPairs(pairs = []) {
  return pairs.map(entry => {
    if (Array.isArray(entry) && entry.length >= 2) {
      return [parseMaybeInt(entry[0]), normalizeLabel(entry[1])];
    }

    if (entry && typeof entry === 'object') {
      const key = 'key' in entry ? entry.key : entry[0];
      const label = entry.lbl ?? entry.label ?? entry[1];
      return [parseMaybeInt(key), normalizeLabel(label)];
    }

    return entry;
  });
}

function buildWideArg(body) {
  if (typeof body === 'string') {
    return body;
  }

  if (!body || typeof body !== 'object') {
    return null;
  }

  const parts = [];

  if (body.instr) {
    parts.push(body.instr);
  }

  if (body.index != null) {
    parts.push(String(body.index));
  }

  if (body.varnum != null) {
    parts.push(String(body.varnum));
  }

  if (body.arg != null) {
    parts.push(String(body.arg));
  }

  if (body.const != null) {
    parts.push(String(body.const));
  }

  if (body.incr != null) {
    parts.push(String(body.incr));
  }

  if (body.value != null) {
    parts.push(String(body.value));
  }

  return parts.length ? parts.join(' ') : null;
}

function convertCodeItem(item, invokeDynamicMap) {
  if (!item) return null;

  if (item.instruction && (item.instruction.op === 'ldc' || item.instruction.op === 'ldc_w' || item.instruction.op === 'ldc2_w')) {
    const argStr = item.instruction.arg;
    if (typeof argStr === 'string') {
      const trimmedArg = argStr.trim();
      const specialFloatingLiteral = parseSpecialFloatingLiteral(trimmedArg);
      if (specialFloatingLiteral) {
        item.instruction.arg = specialFloatingLiteral;
        return item;
      }
      const longLiteralMatch = trimmedArg.match(/^(-?\d+)[lL]$/);

      if (longLiteralMatch) {
        try {
          item.instruction.arg = BigInt(longLiteralMatch[1]);
        } catch (e) {
          // Leave as string if the literal overflows BigInt parsing expectations
        }
        return item;
      }

      if (item.instruction.op === 'ldc2_w' && /^-?\d+$/.test(trimmedArg)) {
        try {
          item.instruction.arg = BigInt(trimmedArg);
        } catch (e) {
          // Leave as string if parsing fails
        }
        return item;
      }

      // Check for string literals
      if (trimmedArg.startsWith('"') && trimmedArg.endsWith('"')) {
        try {
          item.instruction.arg = JSON.parse(trimmedArg);
        } catch (e) {
          // Leave as string if parsing fails
        }
      } else if (/[fF]$/.test(trimmedArg)) {
        const floatVal = parseFloat(trimmedArg);
        if (!isNaN(floatVal)) {
          item.instruction.arg = {
            value: Math.fround(floatVal),
            type: 'Float'
          };
        }
      } else if (trimmedArg.includes('e') || trimmedArg.includes('E') || trimmedArg.includes('.')) {
        const doubleVal = parseFloat(trimmedArg);
        if (!isNaN(doubleVal)) {
          item.instruction.arg = {
            value: doubleVal,
            type: 'Double'
          };
        }
      } else {
        const numVal = Number(trimmedArg);
        if (Number.isInteger(numVal)) {
          item.instruction.arg = numVal;
        }
      }
    }
  }

  // Handle invokedynamic instructions
  if (item.instruction && item.instruction.op === 'invokedynamic') {
    const argStr = item.instruction.arg;
    if (typeof argStr === 'string' && invokeDynamicMap && invokeDynamicMap[argStr]) {
      const invokeDynamicInfo = invokeDynamicMap[argStr];
      item.instruction.arg = {
        bootstrap_method_attr_index: invokeDynamicInfo.bootstrap_method_attr_index,
        nameAndType: invokeDynamicInfo.nameAndType
      };
    }
  }

  // Normalize multianewarray operands
  if (item.instruction && item.instruction.op === 'multianewarray') {
    const { cls, dims } = item.instruction;
    const normalizedDims = dims == null
      ? null
      : typeof dims === 'bigint'
        ? dims.toString()
        : String(dims);
    item.instruction = {
      op: 'multianewarray',
      arg: [
        cls !== undefined ? cls : null,
        normalizedDims
      ]
    };
  }

  if (item.instruction && item.instruction.op === 'lookupswitch') {
    const { instruction } = item;
    const defaultLabel = instruction.defaultLabel ?? instruction.defaultLbl ?? instruction.default_label ?? null;
    const normalizedPairs = normalizeLookupPairs(instruction.pairs);
    item.instruction = {
      op: 'lookupswitch',
      arg: {
        defaultLabel,
        pairs: normalizedPairs
      }
    };
    return item;
  }

  if (item.instruction && item.instruction.op === 'wide') {
    const { instruction } = item;
    const argValue = buildWideArg(instruction.body ?? instruction.arg);
    item.instruction = {
      op: 'wide',
      arg: argValue
    };
    return item;
  }

  if (item.instruction && Array.isArray(item.instruction.arg)) {
    const [kind, owner, nameAndType] = item.instruction.arg;
    if (referenceKinds.has(kind) && Array.isArray(nameAndType) && nameAndType.length >= 2) {
      const [name, descriptor] = nameAndType;
      item.instruction.arg = [
        kind,
        owner,
        [
          parseStringLiteral(name),
          descriptor
        ]
      ];
    }
  }

  return item;
}

function convertAttribute(attribute, invokeDynamicMap) {
  if (!attribute) return null;

  if (attribute.type === 'code') {
    const code = attribute.code;
    const exceptionTable = [];
    const convertedItems = [];
    ensureArray(code.codeItems).forEach((item) => {
      if (item && item.type === 'catch') {
        exceptionTable.push({
          startLbl: item.fromLbl ?? item.fromLabel ?? item.from,
          endLbl: item.toLbl ?? item.toLabel ?? item.to,
          handlerLbl: item.usingLbl ?? item.handlerLabel ?? item.handler,
          catchType: item.clsref === 'any' ? 'any' : item.clsref,
        });
        return;
      }
      const converted = convertCodeItem(item, invokeDynamicMap);
      if (converted) {
        convertedItems.push(converted);
      }
    });

    if (Array.isArray(code.exception_table)) {
      code.exception_table.forEach((entry) => {
        exceptionTable.push({
          startLbl: entry.fromLbl ?? entry.startLbl ?? entry.start,
          endLbl: entry.toLbl ?? entry.endLbl ?? entry.end,
          handlerLbl: entry.usingLbl ?? entry.handlerLbl ?? entry.handler,
          catchType: entry.clsref ?? entry.catchType ?? entry.catch_type ?? 'any',
        });
      });
    }

    return {
      type: 'code',
      code: {
        long: code.long,
        stackSize: code.stackSize,
        localsSize: code.localsSize,
        codeItems: convertedItems,
        exceptionTable,
        attributes: code.attributes.map(attr => convertAttribute(attr, invokeDynamicMap)).filter(Boolean)
      }
    };
  }

  if (attribute.type === 'linenumbertable') {
    return attribute; // Structure is the same
  }

  if (attribute.type === 'attribute' && attribute.attribute.type === 'sourcefile') {
      return attribute;
  }

  return attribute;
}

function convertClsitem(item, invokeDynamicMap) {
  if (!item) return null;

  switch (item.type) {
    case 'field': {
      const field = item.field || {};
      const flags = Array.isArray(field.flags) ? field.flags : [];
      return {
        type: 'field',
        field: {
          flags,
          accessFlags: computeAccessFlags(flags, 'field'),
          name: parseStringLiteral(field.name),
          descriptor: field.descriptor,
          value: field.value ?? null,
          attrs: field.attrs ?? null
        }
      };
    }
    case 'method':
      const method = item.method || {};
      const methodFlags = Array.isArray(method.flags) ? method.flags : [];
      return {
        type: 'method',
        method: {
          flags: methodFlags,
          accessFlags: computeAccessFlags(methodFlags, 'method'),
          name: parseStringLiteral(method.name),
          descriptor: method.descriptor,
          attributes: Array.isArray(method.attributes)
            ? method.attributes.map(attr => convertAttribute(attr, invokeDynamicMap)).filter(Boolean)
            : []
        }
      };
    case 'const': {
      const constValue = item.constValue;
      if (Array.isArray(constValue)) {
        const tag = constValue[0];
        if ((tag === 'Field' || tag === 'Method' || tag === 'InterfaceMethod') && Array.isArray(constValue[2]) && constValue[2].length >= 2) {
          constValue[2] = [
            parseStringLiteral(constValue[2][0]),
            constValue[2][1]
          ];
        } else if (tag === 'NameAndType' && constValue.length >= 3) {
          constValue[1] = parseStringLiteral(constValue[1]);
        }
      }

      return item;
    }
    case 'attribute':
      return convertAttribute(item, invokeDynamicMap);
    default:
      return item;
  }
}

function parseMethodHandleSpec(spec) {
  if (!Array.isArray(spec) || spec.length < 2) {
    return null;
  }

  const [kind, target] = spec;
  if (!Array.isArray(target) || target.length < 3) {
    return null;
  }

  const [, className, nameAndType] = target;
  if (!Array.isArray(nameAndType) || nameAndType.length < 2) {
    return null;
  }

  return {
    kind,
    reference: {
      className,
      nameAndType: {
        name: nameAndType[0],
        descriptor: nameAndType[1]
      }
    }
  };
}

function parseStringLiteral(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }

  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return raw;
    }
  }

  return raw;
}

function convertConstToBootstrapMethod(constItem, methodHandleMap) {
  // Convert InvokeDynamic const to bootstrap method structure
  if (constItem.constValue && constItem.constValue[0] === 'InvokeDynamic') {
    const [, bootstrapSpec] = constItem.constValue;

    let methodHandleValue = null;
    const arguments = [];

    if (Array.isArray(bootstrapSpec)) {
      const [methodHandleInfo, bootstrapArgs] = bootstrapSpec;
      methodHandleValue = parseMethodHandleSpec(methodHandleInfo);

      if (
        bootstrapArgs &&
        Array.isArray(bootstrapArgs) &&
        Array.isArray(bootstrapArgs[0])
      ) {
        for (const arg of bootstrapArgs[0]) {
          if (Array.isArray(arg) && arg.length >= 2) {
            const [argType, rawValue] = arg;
            if (argType === 'String') {
              arguments.push({
                type: 'String',
                value: parseStringLiteral(rawValue)
              });
            } else if (argType === 'MethodType') {
              arguments.push({
                type: 'MethodType',
                value: rawValue
              });
            } else if (argType === 'Class') {
              arguments.push({
                type: 'Class',
                value: rawValue
              });
            }
          } else if (typeof arg === 'string') {
            const handle = methodHandleMap ? methodHandleMap.get(arg) : null;
            if (handle) {
              arguments.push({
                type: 'MethodHandle',
                value: handle.value
              });
            }
          }
        }
      }
    }

    const method_ref = methodHandleValue
      ? {
          type: 'MethodHandle',
          value: methodHandleValue
        }
      : null;

    return {
      method_ref,
      arguments
    };
  }

  return null;
}

function extractMethodKeyFromDirective(line) {
  const rest = line.replace(/^\.method\s+/, '');
  const colonIndex = rest.lastIndexOf(':');
  if (colonIndex === -1) {
    return null;
  }
  const descriptor = rest.slice(colonIndex + 1).trim();
  const beforeColon = rest.slice(0, colonIndex).trim();
  if (!descriptor || !beforeColon) {
    return null;
  }
  const tokens = beforeColon.split(/\s+/);
  const methodName = tokens[tokens.length - 1];
  if (!methodName) {
    return null;
  }
  return `${methodName}:${descriptor}`;
}

function buildMethodLineMap(sourceText) {
  const lineInfos = sourceText.split(/\r?\n/).map((text, index) => ({ text, index }));
  const map = new Map();
  let currentKey = null;
  let inCode = false;

  lineInfos.forEach(({ text, index }) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.startsWith('.method')) {
      currentKey = extractMethodKeyFromDirective(trimmed);
      if (currentKey && !map.has(currentKey)) {
        map.set(currentKey, []);
      }
      inCode = false;
      return;
    }
    if (!currentKey) {
      return;
    }
    if (trimmed.startsWith('.end method')) {
      currentKey = null;
      inCode = false;
      return;
    }
    if (trimmed.startsWith('.code')) {
      inCode = true;
      return;
    }
    if (trimmed.startsWith('.end code')) {
      inCode = false;
      return;
    }
    if (!inCode) {
      return;
    }
    const bucket = map.get(currentKey);
    if (bucket) {
      bucket.push({ lineNumber: index, text });
    }
  });

  return map;
}

function annotateCodeItemsWithSource(method, methodLines) {
  if (!Array.isArray(methodLines) || methodLines.length === 0) {
    return;
  }
  const codeAttribute = (method.attributes || []).find((attr) => attr.type === 'code');
  if (!codeAttribute || !codeAttribute.code || !Array.isArray(codeAttribute.code.codeItems)) {
    return;
  }

  const codeItems = codeAttribute.code.codeItems;
  const assigned = new WeakSet();
  const nextInstruction = () => {
    for (let i = 0; i < codeItems.length; i += 1) {
      const candidate = codeItems[i];
      if (
        candidate &&
        candidate.instruction &&
        !assigned.has(candidate) &&
        candidate.type !== 'catch'
      ) {
        assigned.add(candidate);
        return candidate;
      }
    }
    return null;
  };

  const nextCatch = () => {
    for (let i = 0; i < codeItems.length; i += 1) {
      const candidate = codeItems[i];
      if (candidate && candidate.type === 'catch' && !assigned.has(candidate)) {
        assigned.add(candidate);
        return candidate;
      }
    }
    return null;
  };

  methodLines.forEach(({ lineNumber, text }) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.startsWith('.catch')) {
      const catchItem = nextCatch();
      if (catchItem) {
        catchItem.loc = {
          line: lineNumber,
          column: Math.max(0, text.indexOf('.catch')),
        };
      }
      return;
    }
    if (trimmed.startsWith('.')) {
      return;
    }
    let instructionText = trimmed;
    let column = Math.max(0, text.indexOf(trimmed));
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex !== -1) {
      const afterColon = trimmed.slice(colonIndex + 1).trim();
      if (!afterColon) {
        return;
      }
      instructionText = afterColon;
      const idx = text.indexOf(afterColon);
      column = idx === -1 ? column : idx;
    }
    if (!instructionText) {
      return;
    }
    const instructionItem = nextInstruction();
    if (instructionItem) {
      instructionItem.loc = {
        line: lineNumber,
        column,
      };
    }
  });
}

function annotateClassesWithSource(convertedClasses, sourceText) {
  const methodLineMap = buildMethodLineMap(sourceText);
  convertedClasses.forEach((cls) => {
    cls.items.forEach((item) => {
      if (item.type !== 'method' || !item.method) {
        return;
      }
      const key = `${item.method.name}:${item.method.descriptor}`;
      const methodLines = methodLineMap.get(key);
      annotateCodeItemsWithSource(item.method, methodLines);
    });
  });
}

function convertKrak2AstToClassAst(krak2Ast, options = {}) {
  const { sourceText } = typeof options === 'string' ? { sourceText: options } : options;
  if (!krak2Ast || !krak2Ast.classes) {
    return { classes: [] };
  }

  const convertedClasses = krak2Ast.classes.map(classDef => {
    const bootstrapEntries = [];
    const methodHandleMap = new Map();
    const nonConstItems = [];
    const invokeDynamicEntries = [];

    // Collect MethodHandle constants for lookup
    for (const item of classDef.items) {
      if (item.type === 'const' && item.constValue && item.constValue[0] === 'MethodHandle') {
        const handleValue = parseMethodHandleSpec(item.constValue[1]);
        if (handleValue) {
          methodHandleMap.set(item.ref, {
            type: 'MethodHandle',
            value: handleValue
          });
        }
      }
    }

    // First pass: collect InvokeDynamic consts in order
    for (const item of classDef.items) {
      if (item.type === 'const' && item.constValue && item.constValue[0] === 'InvokeDynamic') {
        const bootstrapMethod = convertConstToBootstrapMethod(item, methodHandleMap);
        if (bootstrapMethod) {
          const key = JSON.stringify(bootstrapMethod);
          bootstrapEntries.push({ key, method: bootstrapMethod });

          const invokeDynamicInfo = Array.isArray(item.constValue)
            ? item.constValue[2]
            : null;

          let nameAndType = null;
          if (Array.isArray(invokeDynamicInfo) && invokeDynamicInfo.length >= 2) {
            nameAndType = {
              name: invokeDynamicInfo[0],
              descriptor: invokeDynamicInfo[1]
            };
          }

          invokeDynamicEntries.push({
            ref: item.ref,
            key,
            nameAndType
          });
        }
      } else if (item.type === 'const' && item.constValue && item.constValue[0] === 'MethodHandle') {
        // Skip MethodHandle consts from items—they are represented via bootstrap methods
        continue;
      } else {
        nonConstItems.push(item);
      }
    }

    let bootstrapMethods = [];
    const bootstrapIndexMap = new Map();
    if (bootstrapEntries.length > 0) {
      const seenBootstrapKeys = new Set();
      const dedupedEntries = [];
      for (let i = bootstrapEntries.length - 1; i >= 0; i--) {
        const entry = bootstrapEntries[i];
        if (seenBootstrapKeys.has(entry.key)) {
          continue;
        }

        seenBootstrapKeys.add(entry.key);
        dedupedEntries.push(entry);
      }

      bootstrapMethods = dedupedEntries.map(entry => entry.method);

      dedupedEntries.forEach((entry, index) => {
        bootstrapIndexMap.set(entry.key, index);
      });
    }

    // Build the invokeDynamicMap with correct indices after reversal
    const invokeDynamicMap = {};
    for (const entry of invokeDynamicEntries) {
      const bootstrapIndex = bootstrapIndexMap.get(entry.key);
      if (bootstrapIndex === undefined) {
        continue;
      }

      const mappedEntry = {
        bootstrap_method_attr_index: bootstrapIndex
      };

      if (entry.nameAndType) {
        mappedEntry.nameAndType = entry.nameAndType;
      }

      invokeDynamicMap[entry.ref] = mappedEntry;
    }

    const result = {
      version: classDef.version,
      flags: classDef.flags,
      className: classDef.className,
      superClassName: classDef.superClass,
      interfaces: classDef.interfaces,
      items: nonConstItems.map(item => convertClsitem(item, invokeDynamicMap)).filter(Boolean)
    };
    
    // Only add bootstrapMethods if there are any
    if (bootstrapMethods.length > 0) {
      result.bootstrapMethods = bootstrapMethods;
    }
    
    return result;
  });

  if (sourceText) {
    annotateClassesWithSource(convertedClasses, sourceText);
  }

  return {
    classes: convertedClasses
  };
}

module.exports = { convertKrak2AstToClassAst };
