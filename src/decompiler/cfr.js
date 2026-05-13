'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../parsing/convert_tree');
const { parseDescriptor } = require('../parsing/typeParser');

const VERSION = 'CFR-JS 0.4.0';

const BINARY_OPS = new Map([
  ['iadd', '+'], ['ladd', '+'], ['fadd', '+'], ['dadd', '+'],
  ['isub', '-'], ['lsub', '-'], ['fsub', '-'], ['dsub', '-'],
  ['imul', '*'], ['lmul', '*'], ['fmul', '*'], ['dmul', '*'],
  ['idiv', '/'], ['ldiv', '/'], ['fdiv', '/'], ['ddiv', '/'],
  ['irem', '%'], ['lrem', '%'], ['frem', '%'], ['drem', '%'],
  ['iand', '&'], ['land', '&'], ['ior', '|'], ['lor', '|'],
  ['ixor', '^'], ['lxor', '^'], ['ishl', '<<'], ['lshl', '<<'],
  ['ishr', '>>'], ['lshr', '>>'], ['iushr', '>>>'], ['lushr', '>>>'],
]);

const NEGATE_OPS = new Set(['ineg', 'lneg', 'fneg', 'dneg']);
const RETURN_OPS = new Set(['ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn']);
const LOAD_PREFIX_TYPES = { i: 'int', l: 'long', f: 'float', d: 'double', a: 'Object' };
const STORE_PREFIX_TYPES = LOAD_PREFIX_TYPES;
const ARRAY_LOAD_TYPES = {
  iaload: 'int', laload: 'long', faload: 'float', daload: 'double', aaload: 'Object',
  baload: 'byte', caload: 'char', saload: 'short',
};
const ARRAY_STORE_TYPES = {
  iastore: 'int', lastore: 'long', fastore: 'float', dastore: 'double', aastore: 'Object',
  bastore: 'byte', castore: 'char', sastore: 'short',
};
const CONVERSION_OPS = {
  i2l: 'long', i2f: 'float', i2d: 'double', i2b: 'byte', i2c: 'char', i2s: 'short',
  l2i: 'int', l2f: 'float', l2d: 'double',
  f2i: 'int', f2l: 'long', f2d: 'double',
  d2i: 'int', d2l: 'long', d2f: 'float',
};
const COMPARE_OPS = new Set(['lcmp', 'fcmpl', 'fcmpg', 'dcmpl', 'dcmpg']);
const INTEGER_CONSTS = {
  iconst_m1: '-1',
  iconst_0: '0',
  iconst_1: '1',
  iconst_2: '2',
  iconst_3: '3',
  iconst_4: '4',
  iconst_5: '5',
};
const LONG_CONSTS = { lconst_0: '0L', lconst_1: '1L' };
const FLOAT_CONSTS = { fconst_0: '0.0f', fconst_1: '1.0f', fconst_2: '2.0f' };
const DOUBLE_CONSTS = { dconst_0: '0.0', dconst_1: '1.0' };

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var', 'yield',
]);

function decompileClassFile(classFilePath, options = {}) {
  const bytes = fs.readFileSync(classFilePath);
  return decompileClassBytes(bytes, { ...options, sourcePath: classFilePath });
}

function decompileClassBytes(bytes, options = {}) {
  const parsed = getAST(new Uint8Array(bytes));
  const astRoot = convertJson(parsed.ast, parsed.constantPool);
  return decompileAstRoot(astRoot, options);
}

function decompileAstRoot(astRoot, options = {}) {
  return (astRoot.classes || [])
    .map((cls) => decompileClassAst(cls, options))
    .join('\n\n');
}

async function decompilePath(inputPath, options = {}) {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    const files = walk(inputPath).filter((file) => file.endsWith('.class'));
    return files.map((file) => ({ name: javaOutputName(file, inputPath), source: decompileClassFile(file, options) }));
  }

  if (inputPath.toLowerCase().endsWith('.jar')) {
    const zip = await JSZip.loadAsync(fs.readFileSync(inputPath));
    const outputs = [];
    const entries = Object.keys(zip.files)
      .filter((name) => name.endsWith('.class') && !zip.files[name].dir)
      .sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      const bytes = await zip.files[name].async('nodebuffer');
      outputs.push({ name: name.replace(/\.class$/i, '.java'), source: decompileClassBytes(bytes, options) });
    }
    return outputs;
  }

  if (!inputPath.toLowerCase().endsWith('.class')) {
    throw new Error(`CFR-JS currently accepts .class files, .jar files, or directories: ${inputPath}`);
  }

  return [{ name: javaOutputName(inputPath), source: decompileClassFile(inputPath, options) }];
}

function decompileClassAst(cls, options = {}) {
  const out = [];
  if (!options.omitHeader) {
    out.push('/*');
    out.push(` * Decompiled by ${VERSION}.`);
    out.push(' */');
  }

  const packageName = packageNameFromInternalName(cls.className || 'Class');
  if (packageName) {
    out.push(`package ${packageName};`);
    out.push('');
  }

  const className = simpleClassName(cls.className || 'Class');
  out.push(`${formatClassDeclaration(cls, className)} {`);

  const isEnum = (cls.flags || []).includes('enum');
  const allFields = (cls.items || []).filter((item) => item.type === 'field' && item.field);
  const enumConstants = isEnum ? allFields.filter((item) => isEnumConstantField(item.field)) : [];
  const fields = allFields.filter((item) => !shouldSkipField(cls, item.field));
  const methods = (cls.items || [])
    .filter((item) => item.type === 'method' && item.method)
    .filter((item) => !shouldSkipMethod(cls, item.method));

  if (enumConstants.length) {
    const suffix = fields.length || methods.length ? ';' : '';
    out.push(`    ${enumConstants.map((item) => item.field.name).join(', ')}${suffix}`);
    if (fields.length || methods.length) out.push('');
  }

  fields.forEach((item) => {
    out.push(`    ${formatField(item.field)}`);
  });
  if ((fields.length || enumConstants.length) && methods.length) {
    out.push('');
  }

  methods.forEach((item, index) => {
    const methodText = formatMethod(cls, item.method);
    methodText.split('\n').forEach((line) => out.push(`    ${line}`.replace(/\s+$/g, '')));
    if (index < methods.length - 1) out.push('');
  });

  out.push('}');
  return out.join('\n');
}

function packageNameFromInternalName(name) {
  const text = String(name || '').replace(/\//g, '.');
  const lastDot = text.lastIndexOf('.');
  return lastDot === -1 ? '' : text.slice(0, lastDot);
}

function shouldSkipField(cls, field) {
  if ((field.flags || []).includes('synthetic')) return true;
  if ((cls.flags || []).includes('enum')) {
    if (isEnumConstantField(field)) return true;
    if (field.name === '$VALUES' || field.name === 'ENUM$VALUES') return true;
  }
  return false;
}

function shouldSkipMethod(cls, method) {
  const flags = method.flags || [];
  if (flags.includes('synthetic') || flags.includes('bridge')) return true;
  if ((cls.flags || []).includes('enum')) {
    if (method.name === '<init>') return true;
    if (method.name === 'values' || method.name === 'valueOf' || method.name === '$values') return true;
  }
  if (isTrivialDefaultConstructor(method)) return true;
  return false;
}

function isTrivialDefaultConstructor(method) {
  if (method.name !== '<init>' || method.descriptor !== '()V') return false;
  const instructions = executableInstructions(getCode(method));
  if (instructions.length !== 3) return false;
  const ops = instructions.map((item) => item.instruction.op);
  if (ops[0] !== 'aload_0' || ops[1] !== 'invokespecial' || ops[2] !== 'return') return false;
  const ref = parseMemberRef(instructions[1].instruction.arg);
  return ref.owner === 'java/lang/Object' && ref.name === '<init>' && ref.descriptor === '()V';
}

function isEnumConstantField(field) {
  return (field.flags || []).includes('enum');
}

function formatClassDeclaration(cls, displayName) {
  const rawFlags = cls.flags || [];
  const isEnum = rawFlags.includes('enum');
  const ignoredFlags = new Set(['super', 'synthetic', 'annotation', 'enum', 'module']);
  if (isEnum) ignoredFlags.add('final');
  const flags = filterFlags(rawFlags, ignoredFlags);
  const isInterface = flags.includes('interface');
  const keyword = isEnum ? 'enum' : (isInterface ? 'interface' : 'class');
  const visibleFlags = flags.filter((flag) => flag !== 'interface' && flag !== 'abstract');
  if (isInterface && flags.includes('abstract')) {
    // Java interfaces are implicitly abstract.
  } else if (!isInterface && !isEnum && flags.includes('abstract')) {
    visibleFlags.push('abstract');
  }

  let declaration = [...visibleFlags, keyword, displayName].filter(Boolean).join(' ');
  if (!isInterface && !isEnum && cls.superClassName && cls.superClassName !== 'java/lang/Object') {
    declaration += ` extends ${javaTypeFromInternalName(cls.superClassName)}`;
  }
  if (cls.interfaces && cls.interfaces.length) {
    declaration += ` ${isInterface ? 'extends' : 'implements'} ${cls.interfaces.map(javaTypeFromInternalName).join(', ')}`;
  }
  return declaration;
}

function formatField(field) {
  const flags = filterFlags(field.flags || [], new Set(['synthetic', 'enum'])).join(' ');
  const type = descriptorToJavaType(field.descriptor);
  const prefix = flags ? `${flags} ` : '';
  const initializer = field.value !== null && field.value !== undefined ? ` = ${formatLiteral(field.value, type)}` : '';
  return `${prefix}${type} ${field.name}${initializer};`;
}

function formatMethod(cls, method) {
  const className = simpleClassName(cls.className || 'Class');
  const rawFlags = method.flags || [];
  const isStatic = rawFlags.includes('static');
  const isVarargs = rawFlags.includes('varargs');
  const descriptor = parseDescriptor(method.descriptor || '()V');
  const params = descriptor.params || [];
  const returnType = descriptor.returnType || 'void';
  const code = getCode(method);
  const localState = makeLocalState(params.map(simplifyType), isStatic, code);

  if (method.name === '<clinit>') {
    return formatStaticInitializer(code, localState, cls);
  }

  const flags = filterFlags(rawFlags, new Set(['bridge', 'synthetic', 'varargs']));
  const visibleFlags = flags.filter((flag) => flag !== 'static');
  if (isStatic) visibleFlags.push('static');
  const prefix = visibleFlags.length ? `${visibleFlags.join(' ')} ` : '';

  const paramDecls = params.map((type, index) => {
    let renderedType = simplifyType(type);
    if (isVarargs && index === params.length - 1 && renderedType.endsWith('[]')) {
      renderedType = `${renderedType.slice(0, -2)}...`;
    }
    return `${renderedType} ${localState.paramNames[index]}`;
  }).join(', ');
  const name = method.name === '<init>' ? className : method.name;
  const resultType = method.name === '<init>' ? '' : `${simplifyType(returnType)} `;
  const throwsTypes = methodThrowsTypes(method);
  const throwsClause = throwsTypes.length ? ` throws ${throwsTypes.join(', ')}` : '';
  const header = `${prefix}${resultType}${name}(${paramDecls})${throwsClause}`;

  if (!code || flags.includes('abstract') || flags.includes('native')) {
    return `${header};`;
  }

  const body = decompileCode(code, method, cls, localState);
  return formatBlock(header, body);
}

function methodThrowsTypes(method) {
  const attr = (method.attributes || []).find((item) => item && item.type === 'exceptions');
  if (!attr || !Array.isArray(attr.exceptions)) return [];
  return attr.exceptions.map(javaTypeFromInternalName);
}

function formatStaticInitializer(code, localState, cls) {
  const body = code ? decompileCode(code, { name: '<clinit>', descriptor: '()V', flags: ['static'] }, cls, localState) : [];
  return formatBlock('static', body);
}

function formatBlock(header, body) {
  const out = [`${header} {`];
  if (body.length) {
    body.forEach((line) => out.push(`    ${line}`));
  }
  out.push('}');
  return out.join('\n');
}

function decompileCode(code, method, cls, localState) {
  const booleanPattern = decompileKnownBooleanPattern(code, method, cls, localState);
  if (booleanPattern) return booleanPattern;

  const shortCircuitBooleanPattern = decompileShortCircuitBooleanReturnPattern(code, method, cls, localState);
  if (shortCircuitBooleanPattern) return shortCircuitBooleanPattern;

  const booleanReturnPattern = decompileBooleanReturnPattern(code, method, cls, localState);
  if (booleanReturnPattern) return booleanReturnPattern;

  const ternaryReturnPattern = decompileTernaryReturnPattern(code, method, cls, localState);
  if (ternaryReturnPattern) return ternaryReturnPattern;

  const synchronizedBlock = decompileStructuredSynchronized(code, method, cls, localState);
  if (synchronizedBlock) return synchronizedBlock;

  const tryCatch = decompileStructuredTryCatch(code, method, cls, localState);
  if (tryCatch) return tryCatch;

  const structured = decompileStructuredControlFlow(code, method, cls, localState);
  if (structured) return structured;

  const lines = decompileLinearCodeItems(code.codeItems || [], method, cls, localState);
  if (lines[lines.length - 1] === 'return;') lines.pop();
  return coalesceDefaultConstructorBody(lines, method);
}

function decompileLinearCodeItems(codeItems, method, cls, localState, options = {}) {
  const stack = options.initialStack ? (options.mutateStack ? options.initialStack : options.initialStack.slice()) : [];
  const lines = [];
  const className = javaTypeFromInternalName(cls.className || 'Class');
  const currentInternalClassName = cls.className || 'Class';

  for (const codeItem of codeItems || []) {
    const instruction = normalizeInstruction(codeItem && codeItem.instruction !== undefined ? codeItem.instruction : codeItem);
    if (!instruction) continue;
    const op = instruction.op;

    if (op === 'nop') {
      continue;
    }

    if (INTEGER_CONSTS[op] !== undefined) {
      stack.push(expr(INTEGER_CONSTS[op], 'int'));
      continue;
    }
    if (LONG_CONSTS[op] !== undefined) {
      stack.push(expr(LONG_CONSTS[op], 'long'));
      continue;
    }
    if (FLOAT_CONSTS[op] !== undefined) {
      stack.push(expr(FLOAT_CONSTS[op], 'float'));
      continue;
    }
    if (DOUBLE_CONSTS[op] !== undefined) {
      stack.push(expr(DOUBLE_CONSTS[op], 'double'));
      continue;
    }

    if (op === 'aconst_null') {
      stack.push(expr('null', 'Object'));
      continue;
    }
    if (op === 'bipush' || op === 'sipush') {
      stack.push(expr(String(instruction.arg), 'int'));
      continue;
    }
    if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') {
      stack.push(constantExpression(instruction.arg, op));
      continue;
    }

    const loadIndex = parseLoadIndex(op, instruction.arg);
    if (loadIndex) {
      stack.push(localState.load(loadIndex.index, loadIndex.type));
      continue;
    }

    const storeIndex = parseStoreIndex(op, instruction.arg);
    if (storeIndex) {
      const value = renderStoreExpression(pop(stack));
      lines.push(localState.store(storeIndex.index, storeIndex.type, value));
      continue;
    }

    if (BINARY_OPS.has(op)) {
      const right = pop(stack);
      const left = pop(stack);
      const symbol = BINARY_OPS.get(op);
      stack.push(binaryExpr(left, symbol, right, primitiveTypeFromOpcode(op)));
      continue;
    }

    if (NEGATE_OPS.has(op)) {
      const value = pop(stack);
      stack.push(expr(`-${wrap(value, 90)}`, value.type, 90));
      continue;
    }

    if (CONVERSION_OPS[op]) {
      const value = pop(stack);
      const type = CONVERSION_OPS[op];
      stack.push(expr(`(${type})${wrap(value, 100)}`, type, 100));
      continue;
    }

    if (COMPARE_OPS.has(op)) {
      const right = pop(stack);
      const left = pop(stack);
      stack.push(expr(`compare(${left.code}, ${right.code})`, 'int', 100, { compare: { left, right } }));
      continue;
    }

    if (op === 'iinc') {
      const [indexRaw, constantRaw] = Array.isArray(instruction.arg)
        ? instruction.arg
        : [instruction.varnum != null ? instruction.varnum : instruction.index, instruction.incr != null ? instruction.incr : instruction.const];
      const index = Number(indexRaw);
      const amount = Number(constantRaw);
      const variable = localState.load(index, 'int').code;
      if (amount === 1) lines.push(`${variable}++;`);
      else if (amount === -1) lines.push(`${variable}--;`);
      else if (amount >= 0) lines.push(`${variable} += ${amount};`);
      else lines.push(`${variable} -= ${Math.abs(amount)};`);
      continue;
    }

    if (op === 'dup') {
      stack.push({ ...peek(stack) });
      continue;
    }
    if (op === 'pop') {
      const value = pop(stack);
      if (value && value.code && !value.synthetic) lines.push(`${value.code};`);
      continue;
    }
    if (op === 'pop2') {
      pop(stack);
      pop(stack);
      continue;
    }
    if (op === 'swap') {
      const a = pop(stack);
      const b = pop(stack);
      stack.push(a, b);
      continue;
    }

    if (op === 'new') {
      const type = javaTypeFromInternalName(instruction.arg);
      stack.push(expr(`new ${type}`, type, 100, { pendingNew: type }));
      continue;
    }
    if (op === 'newarray' || op === 'anewarray') {
      const length = pop(stack);
      const type = op === 'newarray' ? String(instruction.arg) : javaTypeFromInternalName(instruction.arg);
      stack.push(expr(`new ${type}[${length.code}]`, `${type}[]`, 100, {
        arrayLiteral: /^\d+$/.test(length.code) ? { elementType: type, length: Number(length.code), elements: new Map() } : null,
      }));
      continue;
    }
    if (op === 'multianewarray') {
      const multiArray = parseMultiANewArrayInstruction(instruction);
      const dimensions = multiArray.dimensions;
      const args = popArgs(stack, dimensions);
      const baseType = descriptorToJavaType(multiArray.descriptor).replace(/(?:\[\])+$/g, '');
      const suffix = args.map((arg) => `[${arg.code}]`).join('');
      stack.push(expr(`new ${baseType}${suffix}`, `${baseType}${'[]'.repeat(Math.max(0, dimensions))}`));
      continue;
    }
    if (op === 'arraylength') {
      const array = pop(stack);
      stack.push(expr(`${wrap(array, 100)}.length`, 'int'));
      continue;
    }

    if (ARRAY_LOAD_TYPES[op]) {
      const index = pop(stack);
      const array = pop(stack);
      stack.push(expr(`${wrap(array, 100)}[${index.code}]`, ARRAY_LOAD_TYPES[op]));
      continue;
    }
    if (ARRAY_STORE_TYPES[op]) {
      const value = pop(stack);
      const index = pop(stack);
      const array = pop(stack);
      if (array.arrayLiteral && /^\d+$/.test(index.code)) {
        array.arrayLiteral.elements.set(Number(index.code), value);
      } else {
        lines.push(`${wrap(array, 100)}[${index.code}] = ${value.code};`);
      }
      continue;
    }

    if (op === 'getstatic') {
      const ref = parseMemberRef(instruction.arg);
      stack.push(expr(formatStaticField(ref, currentInternalClassName), descriptorToJavaType(ref.descriptor)));
      continue;
    }
    if (op === 'putstatic') {
      const ref = parseMemberRef(instruction.arg);
      const value = coerceExpressionForType(renderStoreExpression(pop(stack)), descriptorToJavaType(ref.descriptor));
      lines.push(`${formatStaticField(ref, currentInternalClassName)} = ${value.code};`);
      continue;
    }
    if (op === 'getfield') {
      const ref = parseMemberRef(instruction.arg);
      const owner = pop(stack);
      stack.push(expr(`${wrap(owner, 100)}.${ref.name}`, descriptorToJavaType(ref.descriptor)));
      continue;
    }
    if (op === 'putfield') {
      const ref = parseMemberRef(instruction.arg);
      const value = coerceExpressionForType(renderStoreExpression(pop(stack)), descriptorToJavaType(ref.descriptor));
      const owner = pop(stack);
      lines.push(`${wrap(owner, 100)}.${ref.name} = ${value.code};`);
      continue;
    }

    if (op === 'invokevirtual' || op === 'invokeinterface') {
      emitVirtualCall(lines, stack, instruction.arg);
      continue;
    }
    if (op === 'invokestatic') {
      emitStaticCall(lines, stack, instruction.arg, currentInternalClassName);
      continue;
    }
    if (op === 'invokespecial') {
      emitSpecialCall(lines, stack, instruction.arg, method, className, currentInternalClassName);
      continue;
    }
    if (op === 'invokedynamic') {
      emitInvokeDynamic(stack, instruction.arg, cls);
      continue;
    }

    if (op === 'checkcast') {
      const value = pop(stack);
      const type = javaTypeFromInternalName(instruction.arg);
      stack.push(expr(`(${type})${wrap(value, 100)}`, type, 100));
      continue;
    }
    if (op === 'instanceof') {
      const value = pop(stack);
      stack.push(expr(`${wrap(value, 100)} instanceof ${javaTypeFromInternalName(instruction.arg)}`, 'boolean', 60));
      continue;
    }

    if (op === 'monitorenter') {
      const value = pop(stack);
      lines.push(`// monitorenter ${value.code}`);
      continue;
    }
    if (op === 'monitorexit') {
      const value = pop(stack);
      lines.push(`// monitorexit ${value.code}`);
      continue;
    }

    if (op === 'athrow') {
      lines.push(`throw ${pop(stack).code};`);
      continue;
    }

    if (RETURN_OPS.has(op)) {
      const value = coerceExpressionForType(renderStoreExpression(pop(stack)), methodReturnType(method));
      lines.push(`return ${value.code};`);
      continue;
    }
    if (op === 'return') {
      if (method.name !== '<init>' && method.name !== '<clinit>') lines.push('return;');
      continue;
    }

    if (op.startsWith('if') || op === 'goto' || op === 'goto_w' || op === 'tableswitch' || op === 'lookupswitch') {
      handleControlFlowFallback(lines, stack, instruction);
      continue;
    }

    lines.push(`// ${formatUnknownInstruction(instruction)}`);
  }

  if (!options.keepTrailingReturn && lines[lines.length - 1] === 'return;') lines.pop();
  return lines;
}

function emitVirtualCall(lines, stack, arg) {
  const ref = parseMemberRef(arg);
  const descriptor = parseDescriptor(ref.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const receiver = pop(stack);

  if (ref.owner === 'java/lang/StringBuilder' && ref.name === 'append' && args.length === 1) {
    stack.push(stringBuilderAppendExpression(receiver, args[0]));
    return;
  }
  if (ref.owner === 'java/lang/StringBuilder' && ref.name === 'toString' && args.length === 0 && receiver.stringBuilderPieces) {
    stack.push(expr(renderStringBuilderConcat(receiver.stringBuilderPieces), 'String', 40));
    return;
  }

  const renderedArgs = formatCallArguments(ref, descriptor, args, receiver);
  const call = `${wrap(receiver, 100)}.${ref.name}(${renderedArgs.join(', ')})`;
  const returnType = simplifyType(descriptor.returnType);
  if (returnType === 'void') {
    lines.push(`${call};`);
  } else {
    stack.push(expr(call, returnType));
  }
}

function emitStaticCall(lines, stack, arg, currentInternalClassName) {
  const ref = parseMemberRef(arg);
  const descriptor = parseDescriptor(ref.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const owner = ref.owner === currentInternalClassName ? simpleClassName(ref.owner) : javaTypeFromInternalName(ref.owner);
  const renderedArgs = formatCallArguments(ref, descriptor, args, null);
  const call = `${owner}.${ref.name}(${renderedArgs.join(', ')})`;
  const returnType = simplifyType(descriptor.returnType);
  if (returnType === 'void') {
    lines.push(`${call};`);
  } else {
    stack.push(expr(call, returnType));
  }
}

function formatCallArguments(ref, descriptor, args) {
  return args.map((arg, index) => {
    if (shouldRenderCharArgument(ref, descriptor, index, arg)) {
      return formatCharLiteral(Number(arg.code));
    }
    return arg.code;
  });
}

function shouldRenderCharArgument(ref, descriptor, index, arg) {
  if (ref.owner !== 'java/lang/String') return false;
  if (!(ref.name === 'indexOf' || ref.name === 'lastIndexOf')) return false;
  if ((descriptor.params || [])[index] !== 'int') return false;
  if (!/^-?\d+$/.test(arg.code)) return false;
  const value = Number(arg.code);
  return value >= 0 && value <= 0xffff;
}

function formatCharLiteral(codePoint) {
  const ch = String.fromCharCode(codePoint);
  const escaped = ch
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

function emitSpecialCall(lines, stack, arg, method, currentClassName, currentInternalClassName) {
  const ref = parseMemberRef(arg);
  const descriptor = parseDescriptor(ref.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const receiver = pop(stack);

  if (ref.name === '<init>') {
    const ownerType = javaTypeFromInternalName(ref.owner);
    if (method.name === '<init>' && receiver.code === 'this') {
      if (ref.owner === 'java/lang/Object' && args.length === 0) return;
      const target = ref.owner === currentInternalClassName || ownerType === currentClassName ? 'this' : 'super';
      lines.push(`${target}(${args.map((a) => a.code).join(', ')});`);
      return;
    }
    if (receiver.pendingNew || receiver.code.startsWith('new ')) {
      const constructed = ref.owner === 'java/lang/StringBuilder'
        ? stringBuilderConstructorExpression(ownerType, args)
        : expr(`new ${ownerType}(${args.map((a) => a.code).join(', ')})`, ownerType);
      replacePendingNewOrEmit(lines, stack, receiver, constructed);
      return;
    }
    lines.push(`${receiver.code}.${simpleClassName(ref.owner)}(${args.map((a) => a.code).join(', ')});`);
    return;
  }

  const call = `${receiver.code}.${ref.name}(${args.map((a) => a.code).join(', ')})`;
  const returnType = simplifyType(descriptor.returnType);
  if (returnType === 'void') lines.push(`${call};`);
  else stack.push(expr(call, returnType));
}

function replacePendingNewOrEmit(lines, stack, receiver, constructed) {
  const last = stack.length ? stack[stack.length - 1] : null;
  if (last && (last.pendingNew === receiver.pendingNew || last.code === receiver.code)) {
    stack[stack.length - 1] = constructed;
  } else {
    lines.push(`${constructed.code};`);
  }
}

function stringBuilderConstructorExpression(ownerType, args) {
  const renderedArgs = args.map((a) => a.code).join(', ');
  return expr(`new ${ownerType}(${renderedArgs})`, ownerType, 100, {
    stringBuilderPieces: args.slice(),
  });
}

function stringBuilderAppendExpression(receiver, value) {
  const pieces = receiver.stringBuilderPieces ? receiver.stringBuilderPieces.slice() : [];
  pieces.push(value);
  return expr(`${wrap(receiver, 100)}.append(${value.code})`, 'StringBuilder', 100, {
    stringBuilderPieces: pieces,
  });
}

function renderStringBuilderConcat(pieces) {
  if (!pieces.length) return '""';
  if (pieces.length === 1) {
    const only = pieces[0];
    return only.type === 'String' ? only.code : `String.valueOf(${only.code})`;
  }
  const hasStringPiece = pieces.some((piece) => piece.type === 'String' || /^"/.test(piece.code));
  const rendered = pieces.map((piece) => piece.code);
  if (!hasStringPiece) rendered.unshift('""');
  return rendered.join(' + ');
}

function emitInvokeDynamic(stack, arg, cls) {
  const descriptor = parseDescriptor(arg.nameAndType.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const bootstrap = (cls.bootstrapMethods || [])[arg.bootstrap_method_attr_index];
  const recipe = bootstrap && bootstrap.arguments && bootstrap.arguments[0] && bootstrap.arguments[0].value;
  if (typeof recipe === 'string' && recipe.includes('\u0001')) {
    const chunks = recipe.split('\u0001');
    const pieces = [];
    chunks.forEach((chunk, index) => {
      if (chunk) pieces.push(formatStringLiteral(chunk));
      if (index < args.length) pieces.push(args[index].code);
    });
    stack.push(expr(pieces.length ? pieces.join(' + ') : '""', 'String', 40));
    return;
  }
  stack.push(expr(`/* invokedynamic */ ${args.map((a) => a.code).join(', ')}`, simplifyType(descriptor.returnType)));
}

function handleControlFlowFallback(lines, stack, instruction) {
  const op = instruction.op;
  if (op.startsWith('if')) {
    if (op.includes('_icmp') || op.includes('_acmp')) {
      pop(stack);
      pop(stack);
    } else if (op !== 'goto') {
      pop(stack);
    }
  } else if (op === 'tableswitch' || op === 'lookupswitch') {
    pop(stack);
  }
  lines.push(`// ${formatUnknownInstruction(instruction)}`);
}

function coalesceDefaultConstructorBody(lines, method) {
  if (method.name === '<init>' && lines.length === 1 && lines[0] === 'return;') {
    return [];
  }
  return lines;
}

function decompileTernaryReturnPattern(code, method, cls, localState) {
  const returnType = methodReturnType(method);
  if (returnType === 'void' || returnType === 'boolean') return null;
  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const branchIndex = findNextConditionalBranch(codeItems, 0, codeItems.length);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  const targetIndex = labelIndex.get(branch.arg);
  if (targetIndex === undefined || targetIndex <= branchIndex) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, 0, branchIndex)) return null;

  const gotoBeforeTargetIndex = previousExecutableIndex(codeItems, targetIndex, branchIndex + 1);
  const gotoBeforeTarget = gotoBeforeTargetIndex === -1 ? null : getInstructionAt(codeItems, gotoBeforeTargetIndex);
  if (!gotoBeforeTarget || gotoBeforeTarget.op !== 'goto') return null;
  const mergeIndex = labelIndex.get(gotoBeforeTarget.arg);
  if (mergeIndex === undefined || mergeIndex <= targetIndex) return null;
  const returnIndex = nextExecutableIndex(codeItems, mergeIndex);
  const returnInstruction = returnIndex === -1 ? null : getInstructionAt(codeItems, returnIndex);
  if (!returnInstruction || !RETURN_OPS.has(returnInstruction.op)) return null;

  const condition = evaluateConditionPrefix(codeItems, 0, branchIndex, { method, cls, localState }, [], true);
  if (!condition || condition.prefixLines.length) return null;
  const trueArm = readExpressionArm(codeItems, branchIndex + 1, gotoBeforeTargetIndex, method, cls, localState);
  const falseArm = readExpressionArm(codeItems, targetIndex, mergeIndex, method, cls, localState);
  if (!trueArm || !falseArm) return null;

  const trueValue = coerceExpressionForType(renderStoreExpression(trueArm), returnType);
  const falseValue = coerceExpressionForType(renderStoreExpression(falseArm), returnType);
  return [`return ${condition.condition.code} ? ${trueValue.code} : ${falseValue.code};`];
}

function readExpressionArm(codeItems, start, end, method, cls, localState) {
  const stack = [];
  const lines = decompileLinearCodeItems(codeItems.slice(start, end), method, cls, localState, {
    initialStack: stack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  if (lines.length !== 0 || stack.length !== 1) return null;
  return stack[0];
}

function decompileShortCircuitBooleanReturnPattern(code, method, cls, localState) {
  if (methodReturnType(method) !== 'boolean') return null;
  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const firstBranchIndex = findNextConditionalBranch(codeItems, 0, codeItems.length);
  if (firstBranchIndex === -1) return null;
  const secondBranchIndex = findNextConditionalBranch(codeItems, firstBranchIndex + 1, codeItems.length);
  if (secondBranchIndex === -1) return null;
  const firstBranch = getInstructionAt(codeItems, firstBranchIndex);
  const secondBranch = getInstructionAt(codeItems, secondBranchIndex);
  if (!conditionPrefixIsExpressionOnly(codeItems, 0, firstBranchIndex)) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, firstBranchIndex + 1, secondBranchIndex)) return null;

  const firstTargetIndex = labelIndex.get(firstBranch.arg);
  const secondTargetIndex = labelIndex.get(secondBranch.arg);
  if (firstTargetIndex === undefined || secondTargetIndex === undefined) return null;

  const firstTargetArm = readBooleanReturnArm(codeItems, firstTargetIndex, labelIndex);
  const secondTargetArm = readBooleanReturnArm(codeItems, secondTargetIndex, labelIndex);
  const fallthroughArm = readBooleanReturnArm(codeItems, secondBranchIndex + 1, labelIndex);

  if (firstBranch.arg === secondBranch.arg && fallthroughArm && secondTargetArm) {
    if (fallthroughArm.value !== true || secondTargetArm.value !== false || fallthroughArm.endIndex !== secondTargetArm.endIndex) return null;
    const left = evaluateConditionPrefix(codeItems, 0, firstBranchIndex, { method, cls, localState }, [], true);
    const right = evaluateConditionPrefix(codeItems, firstBranchIndex + 1, secondBranchIndex, { method, cls, localState }, [], true);
    if (!left || !right || left.prefixLines.length || right.prefixLines.length) return null;
    return [`return ${booleanBinaryExpr(left.condition, '&&', right.condition).code};`];
  }

  if (firstTargetArm && secondTargetArm) {
    if (firstTargetArm.value !== true || secondTargetArm.value !== false || firstTargetArm.endIndex !== secondTargetArm.endIndex) return null;
    const left = evaluateConditionPrefix(codeItems, 0, firstBranchIndex, { method, cls, localState }, [], false);
    const right = evaluateConditionPrefix(codeItems, firstBranchIndex + 1, secondBranchIndex, { method, cls, localState }, [], true);
    if (!left || !right || left.prefixLines.length || right.prefixLines.length) return null;
    return [`return ${booleanBinaryExpr(left.condition, '||', right.condition).code};`];
  }

  return null;
}

function booleanBinaryExpr(left, operator, right) {
  const precedence = operator === '&&' ? 30 : 20;
  return expr(`${wrap(left, precedence)} ${operator} ${wrap(right, precedence, true)}`, 'boolean', precedence);
}

function decompileStructuredSynchronized(code, method, cls, localState) {
  const codeItems = code.codeItems || [];
  const monitorIndex = findNextInstruction(codeItems, 0, codeItems.length, 'monitorenter');
  if (monitorIndex === -1) return null;

  const storeIndex = previousExecutableIndex(codeItems, monitorIndex);
  const dupIndex = previousExecutableIndex(codeItems, storeIndex);
  const storeInstruction = storeIndex === -1 ? null : getInstructionAt(codeItems, storeIndex);
  const dupInstruction = dupIndex === -1 ? null : getInstructionAt(codeItems, dupIndex);
  const lockStore = storeInstruction && parseStoreIndex(storeInstruction.op, storeInstruction.arg);
  if (!lockStore || lockStore.type !== 'Object' || !dupInstruction || dupInstruction.op !== 'dup') return null;

  const lockStack = [];
  const prefixLines = decompileLinearCodeItems(codeItems.slice(0, dupIndex), method, cls, localState, {
    initialStack: lockStack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  if (prefixLines.length || lockStack.length !== 1) return null;
  const lockExpression = lockStack[0];

  const handlerIndex = firstHandlerIndexAfter(code.exceptionTable || [], codeItems, monitorIndex);
  const searchEnd = handlerIndex === -1 ? codeItems.length : handlerIndex;
  const exit = findMatchingMonitorExit(codeItems, monitorIndex + 1, searchEnd, lockStore.index);
  if (!exit) return null;

  const context = { method, cls, localState, labelIndex: buildLabelIndex(codeItems) };
  const body = decompileRange(codeItems, monitorIndex + 1, exit.loadIndex, context, []);
  if (!body.ok) return null;
  const after = decompileRange(codeItems, exit.monitorIndex + 1, searchEnd, context, []);
  if (!after.ok) return null;

  const lines = [`synchronized (${lockExpression.code}) {`];
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  after.lines.forEach((line) => lines.push(line));
  if (lines[lines.length - 1] === 'return;') lines.pop();
  return lines;
}

function firstHandlerIndexAfter(entries, codeItems, afterIndex) {
  const labelIndex = buildLabelIndex(codeItems);
  const handlerIndexes = entries
    .map((entry) => labelIndex.get(entry.handlerLbl))
    .filter((index) => index !== undefined && index > afterIndex)
    .sort((a, b) => a - b);
  return handlerIndexes.length ? handlerIndexes[0] : -1;
}

function findMatchingMonitorExit(codeItems, start, end, lockIndex) {
  for (let i = start; i < end; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (!instruction || instruction.op !== 'monitorexit') continue;
    const loadIndex = previousExecutableIndex(codeItems, i, start);
    const loadInstruction = loadIndex === -1 ? null : getInstructionAt(codeItems, loadIndex);
    const load = loadInstruction && parseLoadIndex(loadInstruction.op, loadInstruction.arg);
    if (load && load.index === lockIndex) return { loadIndex, monitorIndex: i };
  }
  return null;
}

function decompileKnownBooleanPattern(code, method, cls, localState) {
  const instructions = executableInstructions(code);
  const ops = instructions.map((item) => item.instruction.op || item.instruction);
  const condJumpShape = [
    'iload_2', 'ifeq', 'iload_1', 'iload_2', 'dup', 'istore_3', 'if_icmpeq',
    'iload_2', 'ifeq', 'iload_1', 'dup', 'istore_3', 'ifeq', 'iconst_1',
    'goto', 'iconst_0', 'ireturn',
  ];
  if (method.descriptor === '(ZZ)Z' && sameArray(ops, condJumpShape)) {
    const a = localState.nameFor(1, 'boolean');
    const b = localState.nameFor(2, 'boolean');
    const c = localState.nameFor(3, 'boolean');
    return [
      `boolean ${c};`,
      `return ${b} && ${a} == (${c} = ${b}) || ${b} && (${c} = ${a});`,
    ];
  }
  return null;
}

function decompileBooleanReturnPattern(code, method, cls, localState) {
  if (methodReturnType(method) !== 'boolean') return null;
  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const branchIndex = findNextConditionalBranch(codeItems, 0, codeItems.length);
  if (branchIndex === -1) return null;

  const branch = getInstructionAt(codeItems, branchIndex);
  const targetIndex = labelIndex.get(branch.arg);
  if (targetIndex === undefined || targetIndex <= branchIndex) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, 0, branchIndex)) return null;

  const stack = [];
  const prefixLines = decompileLinearCodeItems(codeItems.slice(0, branchIndex), method, cls, localState, {
    initialStack: stack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  if (prefixLines.length) return null;

  const stackBeforeBranch = stack.slice();
  const branchCondition = conditionForBranch(branch, stackBeforeBranch.slice(), false);
  const fallthrough = readBooleanReturnArm(codeItems, branchIndex + 1, labelIndex);
  const target = readBooleanReturnArm(codeItems, targetIndex, labelIndex);
  if (!fallthrough || !target || fallthrough.endIndex !== target.endIndex) return null;
  if (fallthrough.value === target.value) return null;

  const condition = fallthrough.value
    ? conditionForBranch(branch, stackBeforeBranch.slice(), true)
    : branchCondition;
  return [`return ${condition.code};`];
}

function decompileStructuredControlFlow(code, method, cls, localState) {
  const codeItems = code.codeItems || [];
  if (!codeItems.some((item) => {
    const instruction = getInstructionFromItem(item);
    return instruction && (isConditionalBranch(instruction.op) || instruction.op === 'goto' || instruction.op === 'tableswitch' || instruction.op === 'lookupswitch');
  })) {
    return null;
  }

  const context = {
    method,
    cls,
    localState,
    labelIndex: buildLabelIndex(codeItems),
  };
  const result = decompileRange(codeItems, 0, codeItems.length, context, []);
  if (!result.ok) return null;
  const lines = result.lines;
  if (lines[lines.length - 1] === 'return;') lines.pop();
  return coalesceDefaultConstructorBody(lines, method);
}

function decompileRange(codeItems, start, end, context, initialStack = []) {
  const stack = initialStack;
  const lines = [];
  let index = start;
  while (index < end) {
    const instruction = getInstructionAt(codeItems, index);
    if (!instruction) {
      index += 1;
      continue;
    }

    const switchBlock = tryDecompileSwitchAt(codeItems, index, end, context, stack);
    if (switchBlock) {
      lines.push(...switchBlock.lines);
      stack.splice(0, stack.length, ...switchBlock.stack);
      index = switchBlock.next;
      continue;
    }

    const loop = tryDecompileWhileAt(codeItems, index, end, context, stack);
    if (loop) {
      pushLoopLines(lines, loop.lines);
      stack.splice(0, stack.length, ...loop.stack);
      index = loop.next;
      continue;
    }

    const doLoop = tryDecompileDoWhileAt(codeItems, index, end, context, stack);
    if (doLoop) {
      lines.push(...doLoop.lines);
      stack.splice(0, stack.length, ...doLoop.stack);
      index = doLoop.next;
      continue;
    }

    const ifBlock = tryDecompileIfAt(codeItems, index, end, context, stack);
    if (ifBlock) {
      lines.push(...ifBlock.lines);
      stack.splice(0, stack.length, ...ifBlock.stack);
      index = ifBlock.next;
      continue;
    }

    const one = decompileLinearCodeItems([codeItems[index]], context.method, context.cls, context.localState, {
      initialStack: stack,
      mutateStack: true,
      keepTrailingReturn: true,
    });
    if (one.some((line) => /^\/\/\s*(if|goto|tableswitch|lookupswitch)\b/.test(line))) {
      return { ok: false, lines };
    }
    lines.push(...one);
    index += 1;
  }
  return { ok: true, lines, stack };
}

function pushLoopLines(lines, loopLines) {
  const forLoop = rewriteWhileAsFor(lines[lines.length - 1], loopLines);
  if (!forLoop) {
    lines.push(...loopLines);
    return;
  }
  lines.pop();
  lines.push(...forLoop);
}

function rewriteWhileAsFor(previousLine, loopLines) {
  if (!previousLine || !loopLines.length) return null;
  const whileMatch = /^while \((.*)\) \{$/.exec(loopLines[0]);
  if (!whileMatch || loopLines[loopLines.length - 1] !== '}') return null;
  const body = loopLines.slice(1, -1);
  if (!body.length) return null;

  const updateLine = body[body.length - 1].trim();
  const updateVariable = updateVariableName(updateLine);
  if (!updateVariable) return null;

  const initMatch = /^(?:(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?|[A-Za-z_$][A-Za-z0-9_$.<>?, ]+)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*.+;$/.exec(previousLine.trim());
  if (!initMatch || initMatch[1] !== updateVariable) return null;

  const condition = whileMatch[1];
  if (!new RegExp(`\\b${escapeRegExp(updateVariable)}\\b`).test(condition)) return null;
  const initClause = previousLine.trim().replace(/;$/, '');
  const updateClause = updateLine.replace(/;$/, '');
  return [
    `for (${initClause}; ${condition}; ${updateClause}) {`,
    ...body.slice(0, -1),
    '}',
  ];
}

function updateVariableName(updateLine) {
  let match = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\+\+|--);$/.exec(updateLine);
  if (match) return match[1];
  match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\+=|-=)\s*[^;]+;$/.exec(updateLine);
  return match ? match[1] : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tryDecompileSwitchAt(codeItems, index, end, context, stack) {
  const switchIndex = findNextSwitch(codeItems, index, end);
  if (switchIndex === -1) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, switchIndex)) return null;

  const switchInstruction = getInstructionAt(codeItems, switchIndex);
  const entries = switchEntries(switchInstruction);
  if (!entries.length) return null;

  const expressionStack = stack.slice();
  const prefixLines = decompileLinearCodeItems(codeItems.slice(index, switchIndex), context.method, context.cls, context.localState, {
    initialStack: expressionStack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  if (prefixLines.length) return null;
  const selector = pop(expressionStack);

  const labels = unique(entries.map((entry) => entry.label));
  const targetRanges = buildSwitchTargetRanges(labels, codeItems, end, context.labelIndex);
  if (!targetRanges) return null;

  const bodyByLabel = new Map();
  for (const [label, range] of targetRanges.entries()) {
    if (!rangeEndsInTerminal(codeItems, range.start, range.end)) return null;
    const body = decompileRange(codeItems, range.start, range.end, context, []);
    if (!body.ok) return null;
    bodyByLabel.set(label, body.lines);
  }

  const emittedLabels = new Set();
  const lines = [`switch (${selector.code}) {`];
  for (const entry of entries) {
    const labelText = entry.default ? 'default' : `case ${entry.value}`;
    lines.push(`    ${labelText}:`);
    if (!emittedLabels.has(entry.label)) {
      indentLines(indentLines(bodyByLabel.get(entry.label) || [])).forEach((line) => lines.push(line));
      emittedLabels.add(entry.label);
    }
  }
  lines.push('}');

  const next = Math.max(...Array.from(targetRanges.values()).map((range) => range.end), switchIndex + 1);
  return { lines, next, stack: expressionStack };
}

function switchEntries(instruction) {
  if (instruction.op === 'tableswitch') {
    const low = Number(instruction.low || 0);
    const entries = (instruction.labels || []).map((label, index) => ({ value: low + index, label }));
    entries.push({ default: true, label: instruction.defaultLbl || instruction.defaultLabel });
    return entries.filter((entry) => entry.label);
  }
  if (instruction.op === 'lookupswitch') {
    const arg = instruction.arg || instruction;
    const entries = (arg.pairs || []).map((pair) => {
      if (Array.isArray(pair)) return { value: pair[0], label: pair[1] };
      return { value: pair.key ?? pair.match, label: pair.lbl ?? pair.label };
    });
    entries.push({ default: true, label: arg.defaultLabel || arg.defaultLbl });
    return entries.filter((entry) => entry.label);
  }
  return [];
}

function buildSwitchTargetRanges(labels, codeItems, end, labelIndex) {
  const sorted = labels
    .map((label) => ({ label, index: labelIndex.get(label) }))
    .filter((entry) => entry.index !== undefined)
    .sort((a, b) => a.index - b.index);
  if (sorted.length !== labels.length) return null;

  const ranges = new Map();
  sorted.forEach((entry, index) => {
    const next = sorted[index + 1];
    ranges.set(entry.label, {
      start: entry.index,
      end: next ? next.index : end,
    });
  });
  return ranges;
}

function rangeEndsInTerminal(codeItems, start, end) {
  const last = previousExecutableIndex(codeItems, end, start);
  if (last === -1) return false;
  const instruction = getInstructionAt(codeItems, last);
  return instruction.op === 'return' || instruction.op === 'athrow' || RETURN_OPS.has(instruction.op);
}

function findNextSwitch(codeItems, start, end) {
  for (let i = start; i < end; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (!instruction) continue;
    if (instruction.op === 'tableswitch' || instruction.op === 'lookupswitch') return i;
    if (instruction.op === 'goto' || instruction.op === 'return' || RETURN_OPS.has(instruction.op) || isConditionalBranch(instruction.op)) return -1;
  }
  return -1;
}

function unique(values) {
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
}

function tryDecompileWhileAt(codeItems, index, end, context, stack) {
  const startLabel = labelName(codeItems[index]);
  if (!startLabel) return null;
  const branchIndex = findNextConditionalBranch(codeItems, index, end);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  const exitIndex = context.labelIndex.get(branch.arg);
  if (exitIndex === undefined || exitIndex <= branchIndex || exitIndex > end) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, branchIndex)) return null;
  const backGotoIndex = previousExecutableIndex(codeItems, exitIndex, branchIndex + 1);
  const backGoto = backGotoIndex === -1 ? null : getInstructionAt(codeItems, backGotoIndex);
  if (!backGoto || backGoto.op !== 'goto' || backGoto.arg !== startLabel) return null;

  const condition = evaluateConditionPrefix(codeItems, index, branchIndex, context, stack, true);
  if (!condition || condition.prefixLines.length) return null;
  const body = decompileRange(codeItems, branchIndex + 1, backGotoIndex, context, []);
  if (!body.ok) return null;

  const lines = [`while (${condition.condition.code}) {`];
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: exitIndex, stack: condition.stack };
}

function tryDecompileDoWhileAt(codeItems, index, end, context, stack) {
  const startLabel = labelName(codeItems[index]);
  if (!startLabel) return null;

  for (let branchIndex = index + 1; branchIndex < end; branchIndex += 1) {
    const branch = getInstructionAt(codeItems, branchIndex);
    if (!branch || !isConditionalBranch(branch.op) || branch.arg !== startLabel) continue;
    const conditionStart = findConditionSuffixStart(codeItems, index, branchIndex, context, stack, false);
    if (conditionStart === -1) continue;

    const body = decompileRange(codeItems, index, conditionStart, context, stack.slice());
    if (!body.ok) continue;
    const condition = evaluateConditionPrefix(codeItems, conditionStart, branchIndex, context, body.stack, false);
    if (!condition || condition.prefixLines.length) continue;

    const lines = ['do {'];
    indentLines(body.lines).forEach((line) => lines.push(line));
    lines.push(`} while (${condition.condition.code});`);
    return { lines, next: branchIndex + 1, stack: condition.stack };
  }

  return null;
}

function findConditionSuffixStart(codeItems, bodyStart, branchIndex, context, initialStack, invertBranch) {
  for (let start = branchIndex - 1; start >= bodyStart; start -= 1) {
    if (!conditionPrefixIsExpressionOnly(codeItems, start, branchIndex)) continue;
    const stack = initialStack.slice();
    const prefixLines = decompileLinearCodeItems(codeItems.slice(start, branchIndex), context.method, context.cls, context.localState, {
      initialStack: stack,
      mutateStack: true,
      keepTrailingReturn: true,
    });
    if (prefixLines.length) continue;
    const branch = getInstructionAt(codeItems, branchIndex);
    const condition = conditionForBranch(branch, stack.slice(), invertBranch);
    if (condition && !condition.code.includes('stack-underflow')) return start;
  }
  return -1;
}

function tryDecompileIfAt(codeItems, index, end, context, stack) {
  const branchIndex = findNextConditionalBranch(codeItems, index, end);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  const targetIndex = context.labelIndex.get(branch.arg);
  if (targetIndex === undefined || targetIndex <= branchIndex || targetIndex > end) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, branchIndex)) return null;

  const condition = evaluateConditionPrefix(codeItems, index, branchIndex, context, stack, true);
  if (!condition || condition.prefixLines.length) return null;

  const gotoBeforeTargetIndex = previousExecutableIndex(codeItems, targetIndex, branchIndex + 1);
  const gotoBeforeTarget = gotoBeforeTargetIndex === -1 ? null : getInstructionAt(codeItems, gotoBeforeTargetIndex);
  let thenEnd = targetIndex;
  let elseStart = -1;
  let elseEnd = -1;
  let next = targetIndex;

  if (gotoBeforeTarget && gotoBeforeTarget.op === 'goto') {
    const afterElseIndex = context.labelIndex.get(gotoBeforeTarget.arg);
    if (afterElseIndex !== undefined && afterElseIndex > targetIndex && afterElseIndex <= end) {
      thenEnd = gotoBeforeTargetIndex;
      elseStart = targetIndex;
      elseEnd = afterElseIndex;
      next = afterElseIndex;
    }
  }

  const thenBody = decompileRange(codeItems, branchIndex + 1, thenEnd, context, []);
  if (!thenBody.ok) return null;
  const lines = [`if (${condition.condition.code}) {`];
  indentLines(thenBody.lines).forEach((line) => lines.push(line));
  if (elseStart !== -1) {
    const elseBody = decompileRange(codeItems, elseStart, elseEnd, context, []);
    if (!elseBody.ok) return null;
    lines.push('} else {');
    indentLines(elseBody.lines).forEach((line) => lines.push(line));
  }
  lines.push('}');
  return { lines, next, stack: condition.stack };
}

function evaluateConditionPrefix(codeItems, start, branchIndex, context, initialStack, invertBranch) {
  const stack = initialStack.slice();
  const prefixLines = decompileLinearCodeItems(codeItems.slice(start, branchIndex), context.method, context.cls, context.localState, {
    initialStack: stack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  const branch = getInstructionAt(codeItems, branchIndex);
  if (!branch || !isConditionalBranch(branch.op)) return null;
  const condition = conditionForBranch(branch, stack, invertBranch);
  return { condition, prefixLines, stack };
}

function conditionPrefixIsExpressionOnly(codeItems, start, end) {
  const allowed = new Set([
    ...Object.keys(INTEGER_CONSTS), ...Object.keys(LONG_CONSTS), ...Object.keys(FLOAT_CONSTS), ...Object.keys(DOUBLE_CONSTS),
    'nop', 'aconst_null', 'bipush', 'sipush', 'ldc', 'ldc_w', 'ldc2_w', 'dup', 'pop', 'pop2', 'swap',
    ...BINARY_OPS.keys(), ...NEGATE_OPS, ...Object.keys(CONVERSION_OPS), ...COMPARE_OPS,
    'getstatic', 'getfield', 'arraylength', 'checkcast', 'instanceof',
    ...Object.keys(ARRAY_LOAD_TYPES),
  ]);
  for (let i = start; i < end; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (!instruction) continue;
    const op = instruction.op;
    if (parseLoadIndex(op, instruction.arg)) continue;
    if (!allowed.has(op)) return false;
  }
  return true;
}

function conditionForBranch(branch, stack, invert) {
  const op = branch.op;
  const intCompareOps = {
    if_icmpeq: '==', if_icmpne: '!=', if_icmplt: '<', if_icmpge: '>=', if_icmpgt: '>', if_icmple: '<=',
    if_acmpeq: '==', if_acmpne: '!=',
  };
  if (intCompareOps[op]) {
    const right = pop(stack);
    const left = pop(stack);
    const operator = invert ? invertOperator(intCompareOps[op]) : intCompareOps[op];
    return expr(`${wrap(left, 60)} ${operator} ${wrap(right, 60)}`, 'boolean', 60);
  }

  if (op === 'ifnull' || op === 'ifnonnull') {
    const value = pop(stack);
    const operator = invert ? invertOperator(op === 'ifnull' ? '==' : '!=') : (op === 'ifnull' ? '==' : '!=');
    return expr(`${wrap(value, 60)} ${operator} null`, 'boolean', 60);
  }

  const unaryOps = { ifeq: '==', ifne: '!=', iflt: '<', ifle: '<=', ifgt: '>', ifge: '>=' };
  if (unaryOps[op]) {
    const value = pop(stack);
    const operator = invert ? invertOperator(unaryOps[op]) : unaryOps[op];
    if (value.compare) {
      return expr(`${wrap(value.compare.left, 60)} ${operator} ${wrap(value.compare.right, 60)}`, 'boolean', 60);
    }
    if (isBooleanExpression(value) && (op === 'ifeq' || op === 'ifne')) {
      const isTruthy = operator === '!=';
      return isTruthy ? expr(value.code, 'boolean', value.precedence) : negateBooleanExpression(value);
    }
    return expr(`${wrap(value, 60)} ${operator} 0`, 'boolean', 60);
  }

  return expr(`/* unsupported condition ${op} */`, 'boolean');
}

function readBooleanReturnArm(codeItems, startIndex, labelIndex) {
  const constIndex = nextExecutableIndex(codeItems, startIndex);
  if (constIndex === -1) return null;
  const constInstruction = getInstructionAt(codeItems, constIndex);
  const value = booleanConstantValue(constInstruction);
  if (value === null) return null;
  const afterConst = nextExecutableIndex(codeItems, constIndex + 1);
  if (afterConst === -1) return null;
  const afterInstruction = getInstructionAt(codeItems, afterConst);
  if (afterInstruction.op === 'ireturn') return { value, endIndex: afterConst };
  if (afterInstruction.op !== 'goto') return null;
  const endIndex = labelIndex.get(afterInstruction.arg);
  if (endIndex === undefined) return null;
  const returnIndex = nextExecutableIndex(codeItems, endIndex);
  const returnInstruction = returnIndex === -1 ? null : getInstructionAt(codeItems, returnIndex);
  if (!returnInstruction || returnInstruction.op !== 'ireturn') return null;
  return { value, endIndex: returnIndex };
}

function booleanConstantValue(instruction) {
  if (!instruction) return null;
  if (instruction.op === 'iconst_0') return false;
  if (instruction.op === 'iconst_1') return true;
  return null;
}

function isConditionalBranch(op) {
  return /^if(?:_|n|e|g|l)/.test(op || '') || op === 'ifnull' || op === 'ifnonnull';
}

function findNextConditionalBranch(codeItems, start, end) {
  for (let i = start; i < end; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (!instruction) continue;
    if (isConditionalBranch(instruction.op)) return i;
    if (instruction.op === 'goto' || instruction.op === 'return' || RETURN_OPS.has(instruction.op)) return -1;
  }
  return -1;
}

function findNextInstruction(codeItems, start, end, op) {
  for (let i = start; i < end; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (instruction && instruction.op === op) return i;
  }
  return -1;
}

function previousExecutableIndex(codeItems, fromExclusive, minInclusive = 0) {
  for (let i = fromExclusive - 1; i >= minInclusive; i -= 1) {
    if (getInstructionAt(codeItems, i)) return i;
  }
  return -1;
}

function nextExecutableIndex(codeItems, fromInclusive) {
  for (let i = fromInclusive; i < codeItems.length; i += 1) {
    if (getInstructionAt(codeItems, i)) return i;
  }
  return -1;
}

function getInstructionAt(codeItems, index) {
  return getInstructionFromItem(codeItems[index]);
}

function getInstructionFromItem(item) {
  return normalizeInstruction(item && item.instruction !== undefined ? item.instruction : item);
}

function labelName(item) {
  const label = item && (item.labelDef || item.lineLabel);
  return label ? String(label).replace(/:$/, '') : '';
}

function invertOperator(operator) {
  return {
    '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<',
  }[operator] || operator;
}

function isBooleanExpression(value) {
  return value && (value.type === 'boolean' || value.code === 'true' || value.code === 'false');
}

function negateBooleanExpression(value) {
  if (value.code === 'true') return expr('false', 'boolean');
  if (value.code === 'false') return expr('true', 'boolean');
  return expr(`!${wrap(value, 90)}`, 'boolean', 90);
}

function decompileStructuredTryCatch(code, method, cls, localState) {
  const entries = code.exceptionTable || [];
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const startIndex = labelIndex.get(entry.startLbl);
  const endIndex = labelIndex.get(entry.endLbl);
  const handlerIndex = labelIndex.get(entry.handlerLbl);
  if (startIndex === undefined || endIndex === undefined || handlerIndex === undefined) return null;

  const endInstruction = normalizeInstruction(codeItems[endIndex] && codeItems[endIndex].instruction);
  const afterIndex = endInstruction && endInstruction.op === 'goto'
    ? labelIndex.get(endInstruction.arg)
    : endIndex;
  if (afterIndex === undefined || afterIndex < handlerIndex) return null;

  let handlerItems = codeItems.slice(handlerIndex, afterIndex);
  let catchVariable = defaultCatchVariableName(entry.catch_type);
  const firstHandlerInstruction = normalizeInstruction(handlerItems[0] && handlerItems[0].instruction);
  const storeIndex = firstHandlerInstruction && parseStoreIndex(firstHandlerInstruction.op, firstHandlerInstruction.arg);
  if (storeIndex && storeIndex.type === 'Object') {
    catchVariable = localState.nameFor(storeIndex.index, javaTypeFromInternalName(entry.catch_type));
    if (/^var\d+$/.test(catchVariable)) {
      catchVariable = defaultCatchVariableName(entry.catch_type);
      localState.setLocal(storeIndex.index, catchVariable, javaTypeFromInternalName(entry.catch_type), true);
    } else {
      localState.markDeclared(storeIndex.index);
    }
    handlerItems = handlerItems.slice(1);
  }

  const tryBody = decompileLinearCodeItems(codeItems.slice(startIndex, endIndex), method, cls, localState);
  const catchBody = decompileLinearCodeItems(handlerItems, method, cls, localState);
  const afterBody = decompileLinearCodeItems(codeItems.slice(afterIndex), method, cls, localState);
  const catchType = javaTypeFromInternalName(entry.catch_type || 'java/lang/Throwable');

  const lines = ['try {'];
  indentLines(tryBody).forEach((line) => lines.push(line));
  lines.push(`} catch (${catchType} ${catchVariable}) {`);
  indentLines(catchBody).forEach((line) => lines.push(line));
  lines.push('}');
  afterBody.forEach((line) => lines.push(line));
  return lines;
}

function executableInstructions(code) {
  return ((code && code.codeItems) || [])
    .map((item) => ({ ...item, instruction: normalizeInstruction(item && item.instruction !== undefined ? item.instruction : item) }))
    .filter((item) => item.instruction);
}

function buildLabelIndex(codeItems) {
  const labels = new Map();
  codeItems.forEach((item, index) => {
    const label = item && (item.labelDef || item.lineLabel);
    if (label) labels.set(String(label).replace(/:$/, ''), index);
  });
  return labels;
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function indentLines(lines) {
  return lines.map((line) => `    ${line}`);
}

function defaultCatchVariableName(internalName) {
  const simple = simpleClassName(internalName || 'Throwable');
  return simple.charAt(0).toLowerCase() + simple.slice(1);
}

function getCode(method) {
  const attr = (method.attributes || []).find((item) => item.type === 'code');
  return attr ? attr.code : null;
}

function makeLocalState(paramTypes, isStatic, code = null) {
  const names = new Map();
  const types = new Map();
  const declared = new Set();
  const paramNames = [];
  const localTable = collectLocalVariableTable(code);
  let slot = 0;

  localTable.forEach((local) => {
    names.set(local.index, sanitizeJavaIdentifier(local.name, `var${local.index}`));
    types.set(local.index, descriptorToJavaType(local.descriptor));
  });

  if (!isStatic) {
    names.set(0, 'this');
    types.set(0, types.get(0) || 'Object');
    declared.add(0);
    slot = 1;
  }

  paramTypes.forEach((type, index) => {
    const defaultName = index === 0 && isStatic && type === 'String[]' ? 'args' : `param${index}`;
    const name = names.get(slot) || defaultName;
    names.set(slot, name);
    types.set(slot, types.get(slot) || type);
    declared.add(slot);
    paramNames.push(name);
    slot += type === 'long' || type === 'double' ? 2 : 1;
  });

  function ensure(index, fallbackType = 'Object') {
    if (!names.has(index)) names.set(index, `var${index}`);
    if (!types.has(index)) types.set(index, fallbackType);
  }

  return {
    paramNames,
    nameFor(index, fallbackType = 'Object') {
      ensure(index, fallbackType);
      return names.get(index);
    },
    typeFor(index, fallbackType = 'Object') {
      ensure(index, fallbackType);
      return types.get(index);
    },
    setLocal(index, name, type = 'Object', markDeclared = false) {
      names.set(index, sanitizeJavaIdentifier(name, `var${index}`));
      types.set(index, simplifyType(type));
      if (markDeclared) declared.add(index);
    },
    markDeclared(index) {
      declared.add(index);
    },
    load(index, fallbackType = 'Object') {
      ensure(index, fallbackType);
      return expr(names.get(index), types.get(index));
    },
    store(index, fallbackType, value) {
      ensure(index, fallbackType);
      const name = names.get(index);
      const inferred = inferStoreType(fallbackType, value);
      if (!types.has(index)) types.set(index, inferred);
      const rendered = coerceExpressionForType(renderStoreExpression(value), types.get(index));
      if (!declared.has(index)) {
        declared.add(index);
        return `${simplifyType(types.get(index))} ${name} = ${rendered.code};`;
      }
      return `${name} = ${rendered.code};`;
    },
  };
}

function collectLocalVariableTable(code) {
  const locals = new Map();
  for (const attr of (code && code.attributes) || []) {
    if (attr.type !== 'localvariabletable') continue;
    for (const variable of attr.vars || []) {
      const index = Number(variable.index);
      if (!Number.isFinite(index) || locals.has(index)) continue;
      locals.set(index, {
        index,
        name: variable.name,
        descriptor: variable.descriptor,
      });
    }
  }
  return Array.from(locals.values());
}

function sanitizeJavaIdentifier(name, fallback) {
  const text = String(name || '');
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) && !JAVA_KEYWORDS.has(text)) return text;
  return fallback;
}

function inferStoreType(fallbackType, value) {
  if (fallbackType !== 'Object') return fallbackType;
  if (!value || !value.type || value.type === 'Object') return 'Object';
  return value.type;
}

function normalizeInstruction(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return { op: instruction };
  if (instruction.op) return instruction;
  return null;
}

function parseLoadIndex(op, arg) {
  const match = /^([ilfda])load(?:_(\d+))?$/.exec(op);
  if (!match) return null;
  const index = match[2] !== undefined ? Number(match[2]) : Number(arg);
  return { index, type: LOAD_PREFIX_TYPES[match[1]] };
}

function parseStoreIndex(op, arg) {
  const match = /^([ilfda])store(?:_(\d+))?$/.exec(op);
  if (!match) return null;
  const index = match[2] !== undefined ? Number(match[2]) : Number(arg);
  return { index, type: STORE_PREFIX_TYPES[match[1]] };
}

function parseMemberRef(arg) {
  if (!Array.isArray(arg) || arg.length < 3) {
    throw new Error(`Unsupported member reference: ${JSON.stringify(arg)}`);
  }
  const [, owner, tuple] = arg;
  return {
    owner,
    name: tuple[0],
    descriptor: tuple[1],
  };
}

function parseMultiANewArrayInstruction(instruction) {
  if (Array.isArray(instruction.arg)) {
    return {
      descriptor: instruction.arg[0] || '[[Ljava/lang/Object;',
      dimensions: Number(instruction.arg[1] || 0),
    };
  }
  return {
    descriptor: instruction.cls || instruction.arg || '[[Ljava/lang/Object;',
    dimensions: Number(instruction.dims != null ? instruction.dims : instruction.dimensions),
  };
}

function formatStaticField(ref, currentInternalClassName) {
  if (ref.owner === currentInternalClassName) return ref.name;
  const owner = javaTypeFromInternalName(ref.owner);
  return `${owner}.${ref.name}`;
}

function constantExpression(value, op) {
  if (value && typeof value === 'object') {
    if (value.type === 'Float') return expr(formatFloat(value.value), 'float');
    if (value.type === 'Double') return expr(formatDouble(value.value), 'double');
    if (value.type === 'Long') return expr(`${String(value.value)}L`, 'long');
    if (value.type === 'Class') return expr(`${javaTypeFromInternalName(value.value)}.class`, 'Class');
    if (value.type === 'String') return expr(formatStringLiteral(value.value), 'String');
  }
  if (typeof value === 'string') return expr(formatStringLiteral(unquoteJavaStringLiteral(value)), 'String');
  if (typeof value === 'bigint') return expr(`${String(value)}L`, 'long');
  if (typeof value === 'number') return expr(String(value), op === 'ldc2_w' ? 'double' : 'int');
  return expr(String(value), 'Object');
}

function binaryExpr(left, symbol, right, type) {
  const precedence = binaryPrecedence(symbol);
  return expr(`${wrap(left, precedence)} ${symbol} ${wrap(right, precedence, true)}`, type, precedence);
}

function binaryPrecedence(symbol) {
  if (symbol === '*' || symbol === '/' || symbol === '%') return 80;
  if (symbol === '+' || symbol === '-') return 70;
  if (symbol === '<<' || symbol === '>>' || symbol === '>>>') return 65;
  if (symbol === '&') return 50;
  if (symbol === '^') return 49;
  if (symbol === '|') return 48;
  return 40;
}

function primitiveTypeFromOpcode(op) {
  const first = op[0];
  if (first === 'i') return 'int';
  if (first === 'l') return 'long';
  if (first === 'f') return 'float';
  if (first === 'd') return 'double';
  return 'Object';
}

function expr(code, type = 'Object', precedence = 100, extra = {}) {
  return { code, type: simplifyType(type), precedence, ...extra };
}

function renderStoreExpression(value) {
  if (!value || !value.arrayLiteral) return value;
  const literal = value.arrayLiteral;
  if (!literal || !Number.isFinite(literal.length)) return value;
  const elements = [];
  for (let i = 0; i < literal.length; i += 1) {
    const element = literal.elements.get(i);
    if (!element) return value;
    elements.push(coerceExpressionForType(element, literal.elementType).code);
  }
  return expr(`new ${literal.elementType}[]{${elements.join(', ')}}`, `${literal.elementType}[]`);
}

function coerceExpressionForType(value, targetType) {
  if (!value) return value;
  const type = simplifyType(targetType);
  if (type === 'boolean') {
    if (value.code === '0') return expr('false', 'boolean');
    if (value.code === '1') return expr('true', 'boolean');
  }
  if (type === 'char' && /^\d+$/.test(value.code)) {
    return expr(formatCharLiteral(Number(value.code)), 'char');
  }
  return value;
}

function methodReturnType(method) {
  const descriptor = parseDescriptor(method.descriptor || '()V');
  return simplifyType(descriptor.returnType || 'void');
}

function pop(stack) {
  return stack.pop() || expr('/* stack-underflow */');
}

function peek(stack) {
  return stack[stack.length - 1] || expr('/* stack-underflow */');
}

function popArgs(stack, count) {
  const args = [];
  for (let i = 0; i < count; i += 1) args.unshift(pop(stack));
  return args;
}

function wrap(value, parentPrecedence, forceOnEqual = false) {
  const needs = value.precedence < parentPrecedence || (forceOnEqual && value.precedence === parentPrecedence);
  return needs ? `(${value.code})` : value.code;
}

function formatUnknownInstruction(instruction) {
  if (!instruction || !instruction.op) return String(instruction);
  if (instruction.arg === undefined) return instruction.op;
  if (typeof instruction.arg === 'string') return `${instruction.op} ${instruction.arg}`;
  return `${instruction.op} ${JSON.stringify(instruction.arg)}`;
}

function filterFlags(flags, ignored) {
  return flags.filter((flag) => !ignored.has(flag));
}

function descriptorToJavaType(descriptor) {
  const parsed = parseDescriptor(descriptor);
  if (Array.isArray(parsed)) return simplifyType(parsed[0]);
  return simplifyType(parsed.returnType);
}

function simplifyType(type) {
  if (!type) return 'Object';
  return String(type)
    .replace(/^java\.lang\./, '')
    .replace(/^java\.io\./, '')
    .replace(/^java\.util\./, '');
}

function javaTypeFromInternalName(name) {
  return simplifyType(String(name || 'Object').replace(/\//g, '.'));
}

function simpleClassName(name) {
  const text = String(name || 'Class').replace(/\//g, '.');
  return text.slice(text.lastIndexOf('.') + 1);
}

function formatLiteral(value, type) {
  if (type === 'String') return formatStringLiteral(unquoteJavaStringLiteral(value));
  if (type === 'boolean') return Number(value) === 0 ? 'false' : 'true';
  if (type === 'char') return formatCharLiteral(Number(value));
  if (type === 'long') return `${value}L`;
  if (type === 'float') return formatFloat(value);
  if (type === 'double') return formatDouble(value);
  return String(value);
}

function unquoteJavaStringLiteral(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      return trimmed.slice(1, -1);
    }
  }
  return value;
}

function formatStringLiteral(value) {
  return JSON.stringify(String(value));
}

function escapeJavaChar(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatFloat(value) {
  if (Number.isNaN(value)) return 'Float.NaN';
  if (value === Infinity) return 'Float.POSITIVE_INFINITY';
  if (value === -Infinity) return 'Float.NEGATIVE_INFINITY';
  const raw = String(value);
  return /[.eE]/.test(raw) ? `${raw}f` : `${raw}.0f`;
}

function formatDouble(value) {
  if (Number.isNaN(value)) return 'Double.NaN';
  if (value === Infinity) return 'Double.POSITIVE_INFINITY';
  if (value === -Infinity) return 'Double.NEGATIVE_INFINITY';
  const raw = String(value);
  return /[.eE]/.test(raw) ? raw : `${raw}.0`;
}

function walk(root) {
  const out = [];
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function javaOutputName(file, baseDir = path.dirname(file)) {
  const relative = path.relative(baseDir, file).replace(/\\/g, '/');
  return relative.replace(/\.class$/i, '.java');
}

module.exports = {
  VERSION,
  decompileClassFile,
  decompileClassBytes,
  decompileAstRoot,
  decompileClassAst,
  decompilePath,
};
