'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../parsing/convert_tree');
const { parseDescriptor } = require('../parsing/typeParser');
const { buildCfgFromCode, printTree } = require('./structurer');
const { structureMethod } = require('./exceptionStructurer');
const { listRegionSplitCandidates, applyRegionSplit } = require('../passes/regionSplit');
const { jreClassInfo } = require('../java-frontend/jreMetadata');
const { JavaParser } = require('../java-frontend/parser');
const { tokenizeJava } = require('../java-frontend/lexer');

const VERSION = 'CFR-JS 0.4.0';
const javaStatementParser = new JavaParser();

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

function rawConstantPoolValue(pool, index) {
  const entry = pool[index];
  if (!entry) return null;
  if (entry.tag === 1) return entry.info.bytes;
  if (entry.tag === 3) return entry.info.bytes | 0;
  if (entry.tag === 4) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, entry.info.bytes >>> 0, false);
    return view.getFloat32(0, false);
  }
  if (entry.tag === 5) {
    const bits = (BigInt(entry.info.high_bytes) << 32n) | BigInt(entry.info.low_bytes);
    return bits >= (1n << 63n) ? bits - (1n << 64n) : bits;
  }
  if (entry.tag === 6) {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, (BigInt(entry.info.high_bytes) << 32n) | BigInt(entry.info.low_bytes), false);
    return view.getFloat64(0, false);
  }
  if (entry.tag === 7) return rawConstantPoolValue(pool, entry.info.name_index);
  if (entry.tag === 8) return rawConstantPoolValue(pool, entry.info.string_index);
  return null;
}

function parseAnnotationValue(raw, pool) {
  if (!raw) return { kind: 'unknown', value: null };
  const tag = String.fromCharCode(Number(raw.tag));
  const value = raw.value || {};
  if (tag === 'e') return {
    kind: 'enum',
    type: rawConstantPoolValue(pool, value.type_name_index),
    name: rawConstantPoolValue(pool, value.const_name_index),
  };
  if (tag === 'c') return { kind: 'class', value: rawConstantPoolValue(pool, value.class_info_index) };
  if (tag === '@') return { kind: 'annotation', value: parseRawAnnotation(value.annotation_value, pool) };
  if (tag === '[') return { kind: 'array', values: (value.values || []).map((item) => parseAnnotationValue(item, pool)) };
  return { kind: tag, value: rawConstantPoolValue(pool, value.const_value_index) };
}

function parseRawAnnotation(annotation, pool) {
  const type = rawConstantPoolValue(pool, annotation.type_index);
  const elements = {};
  for (const pair of annotation.element_value_pairs || []) {
    elements[rawConstantPoolValue(pool, pair.element_name_index)] = parseAnnotationValue(pair.value, pool);
  }
  return { type: String(type || '').replace(/^L|;$/g, ''), elements };
}

function runtimeVisibleAnnotations(attributes, pool) {
  const attribute = (attributes || []).find((item) => item && item.attribute_name_index
    && item.attribute_name_index.name && item.attribute_name_index.name.info
    && item.attribute_name_index.name.info.bytes === 'RuntimeVisibleAnnotations');
  return attribute && attribute.info
    ? (attribute.info.annotations || []).map((annotation) => parseRawAnnotation(annotation, pool)) : [];
}

function convertParsedClass(parsed) {
  const converted = convertJson(parsed.ast, parsed.constantPool);
  const cls = (converted.classes || [])[0];
  if (!cls) return converted;
  cls.annotations = runtimeVisibleAnnotations(parsed.ast.attributes, parsed.constantPool);
  const convertedFields = (cls.items || []).filter((item) => item.type === 'field' && item.field);
  (parsed.ast.fields || []).forEach((field, index) => {
    if (convertedFields[index]) convertedFields[index].field.annotations =
      runtimeVisibleAnnotations(field.attributes, parsed.constantPool);
  });
  const convertedMethods = (cls.items || []).filter((item) => item.type === 'method' && item.method);
  (parsed.ast.methods || []).forEach((method, index) => {
    if (convertedMethods[index]) convertedMethods[index].method.annotations =
      runtimeVisibleAnnotations(method.attributes, parsed.constantPool);
  });
  return converted;
}

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
  const astRoot = convertParsedClass(parsed);
  return decompileAstRoot(astRoot, options);
}

function makeNormalControlFlowReducible(astRoot) {
  // Controlled node splitting is part of our structurer path, not a rewrite
  // intended for CFR/Vineflower. Recompute after every accepted split because
  // one method can contain more than one irreducible region.
  for (let i = 0; i < 64; i += 1) {
    const candidate = listRegionSplitCandidates(astRoot)[0];
    if (!candidate) break;
    const result = applyRegionSplit(astRoot, candidate);
    if (!result || !result.changed) break;
  }
}

function decompileAstRoot(astRoot, options = {}) {
  // Build the cross-class exception model from this root when the caller has not
  // supplied a wider one (a directory/jar run pre-builds it across every input
  // class so a call into any sibling resolves).
  const exceptionModel = options.exceptionModel || buildExceptionModel(astRoot.classes || []);
  const scopedOptions = { ...options, exceptionModel };
  return (astRoot.classes || [])
    .map((cls) => decompileClassAst(cls, scopedOptions))
    .join('\n\n');
}

async function decompilePath(inputPath, options = {}) {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    const profileBulk = process.env.CFR_JS_PROFILE_CLASSES === '1';
    const bulkStarted = Date.now();
    const files = walk(inputPath).filter((file) => file.endsWith('.class'));
    if (profileBulk) console.error(`[cfr-phase] walk ${Date.now() - bulkStarted}ms ${files.length} files`);
    // Parse every class once, build one exception model across all of them, then
    // decompile from the parsed ASTs so cross-class throws resolve.
    const parsed = files.map((file) => {
      const result = getAST(new Uint8Array(fs.readFileSync(file)));
      return { file, astRoot: convertParsedClass(result) };
    });
    if (profileBulk) console.error(`[cfr-phase] parse ${Date.now() - bulkStarted}ms`);
    const exceptionModel = buildExceptionModel(parsed.flatMap((entry) => entry.astRoot.classes || []));
    if (profileBulk) console.error(`[cfr-phase] model ${Date.now() - bulkStarted}ms`);
    // Decompile every class even when some panic: a DecompilationFallbackError
    // means "no valid Java for this class — emit nothing for it", not "abort the
    // whole input". Failures are collected on the returned array (`.failures`)
    // so the CLI can report all of them and still exit non-zero.
    const outputs = [];
    const failures = [];
    for (const { file, astRoot } of parsed) {
      const primaryClass = (astRoot.classes || [])[0];
      if (isEnumConstantBodyClass(primaryClass, exceptionModel)) continue;
      const started = Date.now();
      const diagnostics = [];
      if (process.env.CFR_JS_PROFILE_CLASSES === '1') console.error(`[cfr-class-start] ${file}`);
      try {
        outputs.push({
          name: javaOutputName(file, inputPath),
          source: decompileAstRoot(astRoot, { ...options, exceptionModel, diagnostics }),
          diagnostics,
        });
      } catch (err) {
        if (!(err instanceof DecompilationFallbackError)) throw err;
        failures.push({ name: javaOutputName(file, inputPath), reason: err.message, context: err.context });
      }
      if (process.env.CFR_JS_PROFILE_CLASSES === '1') {
        console.error(`[cfr-class-done] ${Date.now() - started}ms ${file}`);
      }
    }
    outputs.failures = failures;
    return outputs;
  }

  if (inputPath.toLowerCase().endsWith('.jar')) {
    const zip = await JSZip.loadAsync(fs.readFileSync(inputPath));
    const entries = Object.keys(zip.files)
      .filter((name) => name.endsWith('.class') && !zip.files[name].dir)
      .sort((a, b) => a.localeCompare(b));
    const parsed = [];
    for (const name of entries) {
      const bytes = await zip.files[name].async('nodebuffer');
      const result = getAST(new Uint8Array(bytes));
      parsed.push({ name, astRoot: convertParsedClass(result) });
    }
    const exceptionModel = buildExceptionModel(parsed.flatMap((entry) => entry.astRoot.classes || []));
    return parsed.filter(({ astRoot }) =>
      !isEnumConstantBodyClass((astRoot.classes || [])[0], exceptionModel)).map(({ name, astRoot }) => {
      const diagnostics = [];
      return {
        name: name.replace(/\.class$/i, '.java'),
        source: decompileAstRoot(astRoot, { ...options, exceptionModel, diagnostics }),
        diagnostics,
      };
    });
  }

  if (!inputPath.toLowerCase().endsWith('.class')) {
    throw new Error(`CFR-JS currently accepts .class files, .jar files, or directories: ${inputPath}`);
  }

  const diagnostics = [];
  return [{
    name: javaOutputName(inputPath),
    source: decompileClassFile(inputPath, { ...options, diagnostics }),
    diagnostics,
  }];
}

function decompileClassAst(cls, options = {}) {
  if (String(cls.className || '').endsWith('/package-info')) {
    return formatPackageInfoClass(cls, options);
  }
  if (isEnumConstantSubclass(cls)) {
    return `/* Enum constant implementation ${javaTypeFromInternalName(cls.className)} is emitted in ${javaTypeFromInternalName(cls.superClassName)}. */`;
  }
  const out = [];
  const requiredImports = options.requiredImports || new Set();
  const renderOptions = { ...options, requiredImports };
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
  const imports = [];
  if (classReferencesInternalPrefix(cls, 'java/io/')) imports.push('import java.io.*;');
  if (classReferencesInternalPrefix(cls, 'java/util/')) imports.push('import java.util.*;');

  const className = simpleClassName(cls.className || 'Class');
  const classDeclarationIndex = out.length;
  for (const annotation of cls.annotations || []) out.push(formatAnnotation(annotation));
  out.push(`${formatClassDeclaration(cls, className, options.exceptionModel)} {`);

  const isEnum = isSourceEnumClass(cls);
  const isInterface = (cls.flags || []).includes('interface');
  const allFields = (cls.items || []).filter((item) => item.type === 'field' && item.field);
  const enumConstants = isEnum ? allFields.filter((item) => isEnumConstantField(item.field)) : [];
  const enumConstantSpecs = isEnum ? recoverEnumConstantSpecs(cls, options.exceptionModel) : new Map();
  const fields = allFields.filter((item) => !shouldSkipField(cls, item.field));
  const interfaceInitializers = isInterface
    ? extractInterfaceFieldInitializers(cls, renderOptions)
    : { values: new Map(), consumedClinit: false };
  const methods = (cls.items || [])
    .filter((item) => item.type === 'method' && item.method)
    .filter((item) => !shouldSkipMethod(cls, item.method))
    .filter((item) => !(isEnum && item.method.name === '<clinit>'
      && enumClinitIsOnlyCompilerScaffolding(cls, enumConstants)));

  if (enumConstants.length) {
    const suffix = fields.length || methods.length ? ';' : '';
    enumConstants.forEach((item, index) => {
      const spec = enumConstantSpecs.get(item.field.name) || { args: [], bodyClass: null };
      const argumentSource = spec.args.length ? `(${spec.args.join(', ')})` : '';
      const bodyClass = spec.bodyClass && options.exceptionModel && options.exceptionModel.classInfo
        ? options.exceptionModel.classInfo.get(spec.bodyClass) : null;
      const bodyMethods = bodyClass ? (bodyClass.items || [])
        .filter((childItem) => childItem.type === 'method' && childItem.method
          && childItem.method.name !== '<init>' && !shouldSkipMethod(bodyClass, childItem.method)) : [];
      const separator = index === enumConstants.length - 1 ? suffix : ',';
      if (!bodyMethods.length) {
        out.push(`    ${item.field.name}${argumentSource}${separator}`);
      } else {
        out.push(`    ${item.field.name}${argumentSource} {`);
        bodyMethods.forEach((childItem, methodIndex) => {
          formatMethod(bodyClass, childItem.method, renderOptions).split('\n')
            .forEach((line) => out.push(`        ${line}`));
          if (methodIndex < bodyMethods.length - 1) out.push('');
        });
        out.push(`    }${separator}`);
      }
    });
    if (fields.length || methods.length) out.push('');
  }

  fields.forEach((item) => {
    for (const annotation of item.field.annotations || []) out.push(`    ${formatAnnotation(annotation)}`);
    out.push(`    ${formatField(item.field, cls.className)}`);
  });
  const syntheticConstructor = syntheticAbstractSubclassConstructor(cls, className, options.exceptionModel);
  if ((fields.length || enumConstants.length) && (methods.length || syntheticConstructor)) {
    out.push('');
  }

  if (syntheticConstructor) {
    out.push(`    ${syntheticConstructor}`);
    if (methods.length) out.push('');
  }

  methods.forEach((item, index) => {
    for (const annotation of item.method.annotations || []) out.push(`    ${formatAnnotation(annotation)}`);
    const methodText = formatMethod(cls, item.method, renderOptions);
    if (methodText.includes('$cfr$sneakyThrow(')) renderOptions.requiresSneakyThrow = true;
    methodText.split('\n').forEach((line) => out.push(`    ${line}`.replace(/\s+$/g, '')));
    if (index < methods.length - 1) out.push('');
  });

  if (renderOptions.requiresSneakyThrow) {
    if (methods.length) out.push('');
    out.push('    @SuppressWarnings("unchecked")');
    out.push(`    ${isInterface ? '' : 'private '}static <T extends Throwable> RuntimeException $cfr$sneakyThrow(Throwable throwable) throws T {`);
    out.push('        throw (T) throwable;');
    out.push('    }');
  }

  out.push('}');
  for (const requiredImport of requiredImports) imports.push(`import ${requiredImport};`);
  const uniqueImports = [...new Set(imports)];
  if (uniqueImports.length) out.splice(classDeclarationIndex, 0, ...uniqueImports, '');
  return out.join('\n');
}

function annotationDescriptorType(descriptor) {
  const value = String(descriptor || 'java/lang/Object');
  if (value.startsWith('[')) return descriptorToJavaType(value);
  return javaTypeFromInternalName(value.replace(/^L|;$/g, ''));
}

function formatAnnotationValue(value) {
  if (!value) return 'null';
  if (value.kind === 'enum') return `${annotationDescriptorType(value.type)}.${value.name}`;
  if (value.kind === 'class') return `${annotationDescriptorType(value.value)}.class`;
  if (value.kind === 'annotation') return formatAnnotation(value.value);
  if (value.kind === 'array') return `{${(value.values || []).map(formatAnnotationValue).join(', ')}}`;
  if (value.kind === 's') return formatStringLiteral(String(value.value));
  if (value.kind === 'C') return formatCharLiteral(Number(value.value));
  if (value.kind === 'Z') return Number(value.value) === 0 ? 'false' : 'true';
  if (value.kind === 'J') return `${String(value.value)}L`;
  if (value.kind === 'F') return formatFloat(value.value);
  if (value.kind === 'D') return formatDouble(value.value);
  return String(value.value);
}

function formatAnnotation(annotation) {
  const type = javaTypeFromInternalName(annotation.type || 'java/lang/annotation/Annotation');
  const entries = Object.entries(annotation.elements || {});
  if (!entries.length) return `@${type}`;
  if (entries.length === 1 && entries[0][0] === 'value') {
    return `@${type}(${formatAnnotationValue(entries[0][1])})`;
  }
  return `@${type}(${entries.map(([name, value]) =>
    `${name} = ${formatAnnotationValue(value)}`).join(', ')})`;
}

function isEnumConstantBodyClass(cls, model) {
  if (!cls || !(cls.flags || []).includes('enum') || !cls.superClassName
    || cls.superClassName === 'java/lang/Enum') return false;
  const parent = model && model.classInfo ? model.classInfo.get(cls.superClassName) : null;
  return Boolean(parent && (parent.flags || []).includes('enum'));
}

function constantInstructionSource(instruction) {
  if (!instruction) return null;
  if (instruction.op === 'aconst_null') return 'null';
  if (INTEGER_CONSTS[instruction.op] !== undefined) return INTEGER_CONSTS[instruction.op];
  if (LONG_CONSTS[instruction.op] !== undefined) return LONG_CONSTS[instruction.op];
  if (FLOAT_CONSTS[instruction.op] !== undefined) return FLOAT_CONSTS[instruction.op];
  if (DOUBLE_CONSTS[instruction.op] !== undefined) return DOUBLE_CONSTS[instruction.op];
  if (instruction.op === 'bipush' || instruction.op === 'sipush') return String(instruction.arg);
  if (instruction.op !== 'ldc' && instruction.op !== 'ldc_w' && instruction.op !== 'ldc2_w') return null;
  if (typeof instruction.arg === 'string') return formatStringLiteral(instruction.arg);
  if (instruction.arg && typeof instruction.arg === 'object' && 'value' in instruction.arg) {
    return String(instruction.arg.value);
  }
  return String(instruction.arg);
}

function recoverEnumConstantSpecs(cls, model) {
  const result = new Map();
  const clinit = (cls.items || []).find((item) => item.type === 'method' && item.method
    && item.method.name === '<clinit>');
  const instructions = executableInstructions(clinit && getCode(clinit.method));
  let construction = null;
  for (const item of instructions) {
    const instruction = getInstructionFromItem(item);
    if (!instruction) continue;
    if (instruction.op === 'new') {
      const createdClass = String(instruction.arg || '');
      const createdInfo = model && model.classInfo ? model.classInfo.get(createdClass) : null;
      if (createdClass === cls.className || (createdInfo && createdInfo.superClassName === cls.className)) {
        construction = { bodyClass: createdClass === cls.className ? null : createdClass, constants: [], args: [] };
      }
      continue;
    }
    if (!construction) continue;
    const constant = constantInstructionSource(instruction);
    if (constant != null) {
      construction.constants.push(constant);
      continue;
    }
    if (instruction.op === 'invokespecial') {
      let reference;
      try { reference = parseMemberRef(instruction.arg); } catch (_error) { continue; }
      if (reference.name !== '<init>') continue;
      const parameterCount = parseDescriptor(reference.descriptor).params.length;
      construction.args = construction.constants.slice(-parameterCount).slice(2);
      continue;
    }
    if (instruction.op === 'putstatic') {
      let reference;
      try { reference = parseMemberRef(instruction.arg); } catch (_error) { continue; }
      if (reference.owner === cls.className && reference.name !== '$VALUES' && reference.name !== 'ENUM$VALUES') {
        result.set(reference.name, construction);
      }
      construction = null;
    }
  }
  return result;
}

function enumClinitIsOnlyCompilerScaffolding(cls, enumConstants) {
  const constantNames = new Set(enumConstants.map((item) => item.field.name));
  const clinit = (cls.items || []).find((item) => item.type === 'method' && item.method
    && item.method.name === '<clinit>');
  const instructions = executableInstructions(clinit && getCode(clinit.method));
  if (!instructions.length) return false;
  const allowedSimple = new Set([
    'dup', 'aastore', 'anewarray', 'aconst_null', 'return',
    ...Object.keys(INTEGER_CONSTS), ...Object.keys(LONG_CONSTS),
    ...Object.keys(FLOAT_CONSTS), ...Object.keys(DOUBLE_CONSTS),
    'bipush', 'sipush', 'ldc', 'ldc_w', 'ldc2_w', 'new', 'invokespecial', 'getstatic', 'putstatic',
  ]);
  let sawValues = false;
  for (const item of instructions) {
    const instruction = getInstructionFromItem(item);
    if (!instruction || !allowedSimple.has(instruction.op)) return false;
    if (instruction.op !== 'putstatic') continue;
    let reference;
    try { reference = parseMemberRef(instruction.arg); } catch (_error) { return false; }
    if (reference.owner !== cls.className) return false;
    if (reference.name === '$VALUES' || reference.name === 'ENUM$VALUES') sawValues = true;
    else if (!constantNames.has(reference.name)) return false;
  }
  return sawValues;
}

function requireRenderedTypeImport(options, type) {
  if (!options || !options.requiredImports || typeof type !== 'string') return;
  const elementType = type.replace(/\[\]$/g, '');
  // CFR-JS emits one classfile per source file. A binary `$` name therefore
  // remains a legal top-level source identifier, not a member type that can be
  // imported through `Outer.Inner`.
  if (elementType.includes('$')) return;
  if (!elementType.includes('.')) return;
  // Import only when simplifyType actually renders the type by its simple name.
  // Nested javax types such as DataLine.Info and Mixer.Info remain fully
  // qualified in declarations; importing both merely creates an Info/Info
  // collision without shortening either reference.
  const renderedType = simplifyType(elementType);
  if (!renderedType.includes('.') && !elementType.startsWith('java.lang.')) {
    options.requiredImports.add(elementType);
  }
}

function qualifiedReferenceTypeFromDescriptor(descriptor) {
  const match = /^\[*L([^;]+);$/.exec(String(descriptor || ''));
  return match ? match[1].replace(/\//g, '.') : null;
}

function packageNameFromInternalName(name) {
  const text = String(name || '').replace(/\//g, '.');
  const lastDot = text.lastIndexOf('.');
  return lastDot === -1 ? '' : text.slice(0, lastDot);
}

function classReferencesInternalPrefix(cls, prefix) {
  const hasType = (value) => typeof value === 'string'
    && (value.startsWith(prefix) || value.includes(`L${prefix}`));
  if (hasType(cls.superClassName) || (cls.interfaces || []).some(hasType)) return true;
  for (const item of cls.items || []) {
    if (item.type === 'field' && item.field && hasType(item.field.descriptor)) return true;
    if (item.type !== 'method' || !item.method) continue;
    if (hasType(item.method.descriptor)) return true;
    for (const attr of item.method.attributes || []) {
      if (attr.type === 'exceptions' && (attr.exceptions || []).some(hasType)) return true;
      if (attr.type !== 'code' || !attr.code) continue;
      if ((attr.code.exceptionTable || []).some((entry) => hasType(entry.catch_type || entry.catchType))) {
        return true;
      }
      for (const codeAttr of attr.code.attributes || []) {
        if (codeAttr.type === 'localvariabletable'
          && (codeAttr.vars || []).some((variable) => hasType(variable.descriptor))) return true;
      }
      for (const codeItem of attr.code.codeItems || []) {
        const instruction = getInstructionFromItem(codeItem);
        if (!instruction) continue;
        if (['invokevirtual', 'invokespecial', 'invokestatic', 'invokeinterface'].includes(instruction.op)) {
          const member = parseMemberRef(instruction.arg);
          // Instance-call owners are represented by their receiver expression,
          // so importing (for example) PrintStream merely because println was
          // invoked adds an unused java.io import. Static owners are rendered
          // as source-level class names and do require the import.
          if ((instruction.op === 'invokestatic' && hasType(member.owner)) || hasType(member.descriptor)) return true;
        }
        if (['getfield', 'putfield', 'getstatic', 'putstatic'].includes(instruction.op)) {
          const member = parseMemberRef(instruction.arg);
          if ((instruction.op === 'getfield' || String(member.descriptor || '').startsWith('['))
            && hasType(member.descriptor)) return true;
        }
        if (['new', 'anewarray', 'checkcast', 'instanceof', 'multianewarray'].includes(instruction.op)) {
          const type = Array.isArray(instruction.arg) ? instruction.arg[0] : instruction.arg;
          if (hasType(type)) return true;
        }
      }
    }
  }
  return false;
}

function shouldSkipField(cls, field) {
  if (isSourceEnumClass(cls)) {
    if (isEnumConstantField(field)) return true;
    if (field.name === '$VALUES' || field.name === 'ENUM$VALUES') return true;
  }
  return false;
}

function shouldSkipMethod(cls, method) {
  const flags = method.flags || [];
  // A previous CFR-JS pass may already have materialized its checked-exception
  // escape helper. Calls remain and cause the canonical source helper to be
  // emitted once; retaining this method duplicates the Java signature.
  if (method.name === '$cfr$sneakyThrow'
    && method.descriptor === '(Ljava/lang/Throwable;)Ljava/lang/RuntimeException;'
    && flags.includes('static')) return true;
  const sourceRequiredSynthetic = flags.includes('synthetic')
    && (/^lambda\$/.test(String(method.name || '')) || /^access\$\d+$/.test(String(method.name || '')));
  if ((flags.includes('synthetic') && !sourceRequiredSynthetic) || flags.includes('bridge')) return true;
  if (isSourceEnumClass(cls)) {
    // Enum constants are reconstructed from this initializer before methods
    // are rendered; emitting javac's backing assignments again produces an
    // invalid duplicate static block.
    if (method.name === '<clinit>') return true;
    if (method.name === '<init>' && isTrivialEnumConstructor(method)) return true;
    if (method.name === 'values' || method.name === 'valueOf' || method.name === '$values') return true;
  }
  const constructorCount = (cls.items || []).filter((item) => item && item.type === 'method' && item.method && item.method.name === '<init>').length;
  if (constructorCount <= 1 && isTrivialDefaultConstructor(method)) return true;
  return false;
}

function bridgeCollidesInJavaSource(cls, method) {
  const parameterDescriptor = String(method.descriptor || '').split(')')[0];
  return (cls.items || []).some((item) => item.type === 'method' && item.method
    && item.method !== method
    && item.method.name === method.name
    && String(item.method.descriptor || '').split(')')[0] === parameterDescriptor);
}

function formatEnumConstants(cls, constants, options) {
  const clinit = (cls.items || []).find((item) => item.type === 'method'
    && item.method && item.method.name === '<clinit>');
  if (!clinit) return constants.map((item) => item.field.name);
  const code = getCode(clinit.method);
  if (!code) return constants.map((item) => item.field.name);
  const state = makeLocalState([], true, code, null, options.exceptionModel, options);
  const rendered = formatStaticInitializer(code, state, cls, options);
  const className = simpleClassName(cls.className || 'Enum');
  return constants.map((item) => {
    const fieldName = sourceFieldName(cls.className, item.field.name);
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}\\s*=\\s*(?:\\([^;=]+?\\)\\s*)*new\\s+([A-Za-z_$][A-Za-z0-9_$.]*)\\(([^;]*)\\);`);
    const match = pattern.exec(rendered);
    if (!match) return item.field.name;
    const instantiatedType = match[1];
    const args = splitSourceArguments(match[2]);
    const sourceArgs = args.slice(2);
    const head = sourceArgs.length ? `${item.field.name}(${sourceArgs.join(', ')})` : item.field.name;
    const subclass = findClassForRenderedType(instantiatedType, options.exceptionModel);
    if (!subclass || subclass.className === cls.className || !isEnumConstantSubclass(subclass)) return head;
    return formatEnumConstantSubclass(head, subclass, options);
  });
}

function extractInterfaceFieldInitializers(cls, options) {
  const result = { values: new Map(), consumedClinit: false };
  const clinit = (cls.items || []).find((item) => item.type === 'method'
    && item.method && item.method.name === '<clinit>');
  if (!clinit) return result;
  const code = getCode(clinit.method);
  if (!code) return result;
  const rendered = formatStaticInitializer(code,
    makeLocalState([], true, code, null, options.exceptionModel, options), cls, options);
  const body = rendered.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== 'static {' && line !== '}');
  const assignments = [];
  for (const line of body) {
    const assignment = parseOwnedStaticFieldAssignment(line, cls.className);
    if (!assignment) return result;
    assignments.push([assignment.name, assignment.valueSource]);
  }
  const fieldNames = new Set((cls.items || [])
    .filter((item) => item.type === 'field' && item.field)
    .map((item) => sourceFieldName(cls.className, item.field.name)));
  if (!assignments.length || assignments.some(([name]) => !fieldNames.has(name))) return result;
  for (const [name, value] of assignments) result.values.set(name, value);
  result.consumedClinit = true;
  return result;
}

function parseOwnedStaticFieldAssignment(source, ownerInternalName) {
  const parts = topLevelAssignmentParts(String(source));
  if (!parts) return null;
  let statement;
  try { statement = javaStatementParser.parseStatement(`${parts.left} = null;`); } catch (_error) { return null; }
  const assignment = statement && statement.kind === 'ExpressionStatement'
    ? statement.expression
    : null;
  if (!assignment || assignment.kind !== 'AssignmentExpression' || assignment.operator !== '=') return null;

  const targetPath = fieldAccessPath(assignment.left);
  if (!targetPath.length) return null;
  const name = targetPath[targetPath.length - 1];
  const ownerPath = javaTypeFromInternalName(ownerInternalName).split('.');
  const qualifier = targetPath.slice(0, -1);
  if (qualifier.length && qualifier.join('.') !== ownerPath.join('.')) return null;

  // The frontend parser proves the exact owned assignment target. Preserve the
  // already-rendered RHS: lambda/postfix parsing is intentionally irrelevant to
  // deciding whether this putstatic may become an interface field initializer.
  return parts.right ? { name, valueSource: parts.right } : null;
}

function fieldAccessPath(node) {
  if (!node) return [];
  if (node.kind === 'Identifier') return [node.name];
  if (node.kind !== 'FieldAccessExpression') return [];
  const target = fieldAccessPath(node.target);
  return target.length ? [...target, node.name] : [];
}

function topLevelAssignmentParts(source) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth -= 1;
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth -= 1;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth -= 1;
    else if (ch === '=' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0
      && source[index - 1] !== '=' && source[index + 1] !== '=') {
      const left = source.slice(0, index).trim();
      const right = source.slice(index + 1).trim();
      return {
        left,
        right: right.endsWith(';') ? right.slice(0, -1).trimEnd() : right,
      };
    }
  }
  return null;
}

function findClassForRenderedType(type, model) {
  if (!model || !model.classInfo) return null;
  const rendered = String(type || '');
  for (const [internalName, cls] of model.classInfo) {
    if (internalName === rendered.replace(/\./g, '/')
      || javaTypeFromInternalName(internalName) === rendered
      || simpleClassName(internalName) === rendered) return cls;
  }
  return null;
}

function formatEnumConstantSubclass(head, subclass, options) {
  const memberTexts = [];
  const fields = (subclass.items || [])
    .filter((item) => item.type === 'field' && item.field)
    .filter((item) => !shouldSkipField(subclass, item.field));
  for (const item of fields) {
    memberTexts.push(formatField(item.field, subclass.className, options.exceptionModel));
  }

  const methods = (subclass.items || [])
    .filter((item) => item.type === 'method' && item.method)
    .filter((item) => !shouldSkipMethod(subclass, item.method));
  for (const item of methods) {
    if (item.method.name === '<clinit>') continue;
    const rendered = formatMethod(subclass, item.method, {
      ...options,
      foldedSelfType: subclass.superClassName,
      staticOwnerAliases: new Map([[subclass.className, subclass.superClassName]]),
    });
    if (item.method.name !== '<init>') {
      memberTexts.push(rendered);
      continue;
    }
    const open = rendered.indexOf('{');
    const close = rendered.lastIndexOf('}');
    if (open < 0 || close <= open) continue;
    const body = rendered.slice(open + 1, close).split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^(?:super|this)\s*\(/.test(line));
    if (body.length) memberTexts.push(`{\n${body.map((line) => `    ${line}`).join('\n')}\n}`);
  }
  if (!memberTexts.length) return head;
  const body = memberTexts.map((text) => text.split('\n').map((line) => `        ${line}`).join('\n')).join('\n\n');
  return `${head} {\n${body}\n    }`;
}

function splitSourceArguments(source) {
  const args = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function isLambdaImplementationMethod(cls, method) {
  return (cls.bootstrapMethods || []).some((bootstrap) => {
    const bootstrapRef = bootstrap && bootstrap.method_ref && bootstrap.method_ref.value
      && bootstrap.method_ref.value.reference;
    if (!bootstrapRef || bootstrapRef.className !== 'java/lang/invoke/LambdaMetafactory') return false;
    const impl = bootstrap.arguments && bootstrap.arguments[1] && bootstrap.arguments[1].value;
    const ref = impl && impl.reference;
    return ref && ref.className === cls.className && ref.nameAndType
      && ref.nameAndType.name === method.name
      && ref.nameAndType.descriptor === method.descriptor;
  });
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

// ACC_ENUM also appears on the anonymous implementation classes used for enum
// constants with class bodies.  Those classes extend the real enum and cannot
// themselves be declared with Java's `enum` keyword; only the direct
// java/lang/Enum subclass has source-level enum syntax.
function isSourceEnumClass(cls) {
  return Boolean(cls)
    && (cls.flags || []).includes('enum')
    && cls.superClassName === 'java/lang/Enum';
}

function isEnumConstantSubclass(cls) {
  return Boolean(cls)
    && (cls.flags || []).includes('enum')
    && cls.superClassName !== 'java/lang/Enum';
}

function formatClassDeclaration(cls, displayName, model) {
  const rawFlags = cls.flags || [];
  const isEnum = rawFlags.includes('enum');
  const isAnnotation = rawFlags.includes('annotation');
  const ignoredFlags = new Set(['super', 'synthetic', 'annotation', 'enum', 'module']);
  if (isEnum) ignoredFlags.add('final');
  let flags = filterFlags(rawFlags, ignoredFlags);
  if (model && model.instantiatedTypes && model.instantiatedTypes.has(cls.className)) {
    flags = flags.filter((flag) => flag !== 'abstract');
  }
  const forceAbstract = hasUnimplementedAbstractMethods(cls, model)
    && !(model && model.instantiatedTypes && model.instantiatedTypes.has(cls.className));
  if (forceAbstract) {
    flags = flags.filter((flag) => flag !== 'final');
    if (!flags.includes('abstract')) flags.push('abstract');
  }
  const isInterface = flags.includes('interface');
  const keyword = isAnnotation ? '@interface' : (isEnum ? 'enum' : (isInterface ? 'interface' : 'class'));
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
  if (!isAnnotation && cls.interfaces && cls.interfaces.length) {
    declaration += ` ${isInterface ? 'extends' : 'implements'} ${cls.interfaces.map(javaTypeFromInternalName).join(', ')}`;
  }
  return declaration;
}

function formatField(field, owner, model, initializerOverride = undefined) {
  const ignoredFlags = new Set(['synthetic', 'enum']);
  // A JVM blank-final assignment can be expressed through receiver shapes that
  // javac does not recognize as a source-level definite-assignment to `this`
  // (notably `((Owner) this).field = value`). Preserve the data flow and make
  // the regenerated source compilable; ConstantValue-backed finals retain the
  // modifier.
  if ((field.flags || []).includes('final')
    && initializerOverride === undefined
    && (!(field.flags || []).includes('static') || field.value === null || field.value === undefined)) {
    ignoredFlags.add('final');
  }
  let visibleFlags = filterFlags(field.flags || [], ignoredFlags);
  if (hasSplitNestMates(owner, model)) visibleFlags = visibleFlags.filter((flag) => flag !== 'private');
  const flags = visibleFlags.join(' ');
  const type = descriptorToJavaType(field.descriptor);
  const prefix = flags ? `${flags} ` : '';
  const initializer = initializerOverride !== undefined
    ? ` = ${initializerOverride}`
    : (field.value !== null && field.value !== undefined ? ` = ${formatLiteral(field.value, type)}` : '');
  return `${prefix}${type} ${sourceFieldName(owner, field.name)}${initializer};`;
}

// Raised when the decompiler cannot produce valid Java for a method and would
// otherwise fall back to emitting bytecode as comments (raw `// goto`/`// if_*`/
// `// monitorenter` lines), placeholder statements (`stmt_N();`), or placeholder
// expressions (`/* unsupported condition */`, `/* stack-underflow */`). We refuse
// to ship such a "fake" method: fail hard instead. See assertNoFallback.
class DecompilationFallbackError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'DecompilationFallbackError';
    this.context = context;
  }
}

// Any full-line `//` comment in a rendered method body is a bytecode-as-comment
// fallback: every standalone comment line the emitter produces is a dropped JVM
// opcode (branch, switch, monitorenter/exit, wide, or otherwise unhandled). The
// emitter never emits legitimate line comments, so a blanket rule is both correct
// and future-proof against new fallback opcodes.
const FALLBACK_LINE_COMMENT = /^\s*\/\//;
// Placeholder expressions/statements the emitter substitutes when it cannot
// reconstruct a value or condition. These are invalid/fake even though some parse.
const FALLBACK_PLACEHOLDER = /\/\*\s*unsupported condition|\/\*\s*unresolved invokevirtual|\/\*\s*invokedynamic\s*\*\/|stack-underflow|\bstmt_\d+\(\)\s*;/;

// Scan a finalized method body for any fallback marker and hard-fail if present,
// so a logically-broken or lossy method is never written to disk.
function assertNoFallback(bodyLines, context = {}) {
  const lines = Array.isArray(bodyLines) ? bodyLines : String(bodyLines).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i]);
    if (FALLBACK_LINE_COMMENT.test(line) || FALLBACK_PLACEHOLDER.test(line)) {
      const where = `${context.className || '?'}.${context.methodName || '?'}${context.descriptor || ''}`;
      throw new DecompilationFallbackError(
        `cannot emit valid Java for ${where}: fallback marker at body line ${i + 1}: ${line.trim()}`,
        { ...context, marker: line.trim(), index: i });
    }
  }
}

function hasSplitNestMates(owner, model) {
  if (!owner || !model || !model.classInfo) return false;
  const nest = String(owner).split('$')[0];
  for (const name of model.classInfo.keys()) {
    if (name !== owner && String(name).split('$')[0] === nest) return true;
  }
  return false;
}

function privateMethodHasIncompatibleSubclassDeclaration(cls, method, model) {
  if (!(method.flags || []).includes('private') || !model || !model.classInfo) return false;
  const descriptor = String(method.descriptor || '');
  const parameterDescriptor = descriptor.split(')')[0];
  const returnDescriptor = descriptor.slice(descriptor.indexOf(')') + 1);
  for (const [internalName, candidate] of model.classInfo) {
    if (internalName === cls.className
      || !isReferenceTypeAssignable(internalName, cls.className, model)) continue;
    for (const item of candidate.items || []) {
      if (item.type !== 'method' || !item.method || item.method.name !== method.name) continue;
      const candidateDescriptor = String(item.method.descriptor || '');
      if (candidateDescriptor.split(')')[0] !== parameterDescriptor) continue;
      if (candidateDescriptor.slice(candidateDescriptor.indexOf(')') + 1) !== returnDescriptor) return true;
    }
  }
  return false;
}

function formatMethod(cls, method, options = {}) {
  const profileMethod = process.env.CFR_JS_PROFILE_METHODS === '1';
  const methodProfileStarted = Date.now();
  if (profileMethod) console.error(`[cfr-method-start] ${cls.className}.${method.name}${method.descriptor}`);
  const className = simpleClassName(cls.className || 'Class');
  const rawFlags = method.flags || [];
  const isStatic = rawFlags.includes('static');
  const isVarargs = rawFlags.includes('varargs');
  const isEnumConstructor = isSourceEnumClass(cls) && method.name === '<init>';
  const descriptor = parseDescriptor(method.descriptor || '()V');
  const params = descriptor.params || [];
  const returnType = descriptor.returnType || 'void';
  const code = getCode(method);
  let localState = makeLocalState(params.map(simplifyType), isStatic, code, null,
    options.exceptionModel, options);

  if ((cls.flags || []).includes('enum') && method.name === '<init>') {
    return formatEnumConstructor(cls, method, params, localState, options);
  }

  if (method.name === '<clinit>') {
    return formatStaticInitializer(code, localState, cls, options);
  }

  const materializeAbstract = rawFlags.includes('abstract')
    && options.exceptionModel && options.exceptionModel.instantiatedTypes
    && options.exceptionModel.instantiatedTypes.has(cls.className);
  const ignoredMethodFlags = new Set(['bridge', 'synthetic', 'varargs']);
  if (method.name === '<init>') ignoredMethodFlags.add('strictfp');
  let flags = filterFlags(rawFlags, ignoredMethodFlags);
  const isInterfaceMethodWithCode = (cls.flags || []).includes('interface') && code
    && method.name !== '<clinit>' && method.name !== '<init>';
  if (isInterfaceMethodWithCode) {
    flags = flags.filter((flag) => flag !== 'private' && flag !== 'protected');
    if (!isStatic && !flags.includes('default')) flags.push('default');
  }
  if (!isSourceEnumClass(cls)
    && hasSplitNestMates(cls.className, options.exceptionModel)
    && !privateMethodHasIncompatibleSubclassDeclaration(cls, method, options.exceptionModel)) {
    flags = flags.filter((flag) => flag !== 'private');
  }
  if (materializeAbstract) flags = flags.filter((flag) => flag !== 'abstract');
  const visibleFlags = flags.filter((flag) => flag !== 'static');
  if (isStatic) visibleFlags.push('static');
  const isDefaultInterfaceMethod = (cls.flags || []).includes('interface') && code
    && !isStatic && !flags.includes('abstract') && !flags.includes('native');
  if (isDefaultInterfaceMethod && !visibleFlags.includes('default')) visibleFlags.push('default');
  const prefix = visibleFlags.length ? `${visibleFlags.join(' ')} ` : '';

  const paramDecls = params.map((type, index) => {
    let renderedType = simplifyType(type);
    if (isVarargs && index === params.length - 1 && renderedType.endsWith('[]')) {
      renderedType = `${renderedType.slice(0, -2)}...`;
    }
    return `${renderedType} ${localState.paramNames[index]}`;
  }).join(', ');
  const name = method.name === '<init>' ? className : sourceMethodName(method.name);
  const resultType = method.name === '<init>' ? '' : `${simplifyType(returnType)} `;
  const throwsTypes = methodThrowsTypes(method);
  const throwsClause = throwsTypes.length ? ` throws ${throwsTypes.join(', ')}` : '';
  const header = `${prefix}${resultType}${name}(${paramDecls})${throwsClause}`;

  if (materializeAbstract) {
    return formatBlock(header, ['throw new AbstractMethodError();']);
  }
  if (!code || flags.includes('abstract') || flags.includes('native')) {
    return `${header};`;
  }

  const diagnosticsMark = Array.isArray(options.diagnostics) ? options.diagnostics.length : 0;
  let decompiledBody = decompileCode(code, method, cls, localState, options);
  // Per-type local splitting binds each load to the variant of the textually
  // preceding store, which is wrong when differently-typed stores merge at a
  // control-flow join (the untouched variants read as null). Re-emit with the
  // offending slots collapsed to one Object local until no hazards remain.
  const collapsedSlots = new Set();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const conflictSlots = localState.refConflictSlots();
    if (!conflictSlots.length) break;
    conflictSlots.forEach((slotIndex) => collapsedSlots.add(slotIndex));
    const retryState = makeLocalState(params.map(simplifyType), isStatic, code, new Set(collapsedSlots),
      options.exceptionModel, options);
    if (Array.isArray(options.diagnostics)) options.diagnostics.length = diagnosticsMark;
    const retryBody = decompileCode(code, method, cls, retryState, options);
    if (!retryBody) break;
    decompiledBody = retryBody;
    localState = retryState;
  }
  if (profileMethod) console.error(`[cfr-method-body] ${Date.now() - methodProfileStarted}ms ${cls.className}.${method.name}${method.descriptor}`);
  const body = pruneTopLevelUnreachableTail(decompiledBody);
  if (process.env.CFR_JS_DEBUG_LOCALS === '1') {
    console.error('[cfr-body-before-locals]', JSON.stringify(body));
  }
  removeImpossibleCheckedCatchBlocks(body, options.exceptionModel, code);
  ensureCheckedCatchReachability(body, code, options.exceptionModel);
  const constructorInvocation = method.name === '<init>'
    ? localState.takeConstructorInvocation()
    : null;
  const constructorCall = constructorInvocation && !isEnumConstructor
    ? `${constructorInvocation.target}(${constructorInvocation.args.join(', ')});`
    : null;
  rewriteDuplicateLocalDeclarations(body);
  hoistEscapingLocalDeclarations(body, localState);
  const missingDeclarations = localState.missingDeclarations(body);
  if (missingDeclarations.length) body.unshift(...missingDeclarations);
  const refinedBody = refineObjectLocalDeclarations(body, (name) => localState.refinedTypeForName(name));
  const normalizedBody = normalizeSyntheticVariableScopes(refinedBody);
  replaceArrayContents(body, normalizedBody);
  ensureMissingSyntheticDeclarations(body);
  widenExceptionLocalsUsedByInstanceof(body, options.exceptionModel);
  const needsUncheckedExceptionBoundary = methodThrowsTypes(method).length === 0
    && methodCallsUncaughtCheckedException(code, method, options.exceptionModel);
  if (profileMethod) console.error(`[cfr-method-normalized] ${Date.now() - methodProfileStarted}ms ${cls.className}.${method.name}${method.descriptor}`);
  if (needsUncheckedExceptionBoundary) {
    // Catch Throwable (not just Exception): some obfuscated sibling methods declare
    // `throws Throwable`, which `catch (Exception)` does not cover. Rethrow the unchecked
    // families (RuntimeException/Error) unchanged so their propagation semantics are
    // preserved; only genuinely-checked throwables get wrapped as RuntimeException.
    const wrapped = ['try {', ...indentLines(body), '} catch (RuntimeException | Error decompiledUncheckedException) {',
      '    throw decompiledUncheckedException;', '} catch (Throwable decompiledCheckedException) {',
      '    throw new RuntimeException(decompiledCheckedException);', '}'];
    body.splice(0, body.length, ...wrapped);
  }
  if (constructorCall) body.unshift(constructorCall);
  if (method.name === '<init>' && options.exceptionModel && options.exceptionModel.instantiatedTypes
    && options.exceptionModel.instantiatedTypes.has(cls.className) && rawFlags.includes('abstract') === false
    && (cls.flags || []).includes('abstract')) {
    const guard = [`if (getClass() == ${className}.class) {`, `    throw new InstantiationError("${className}");`, '}'];
    body.splice(constructorCall ? 1 : 0, 0, ...guard);
  }
  const methodResultType = methodReturnType(method);
  // A non-void method whose body ends in a try/catch needs a synthesized trailing
  // return only when control can actually fall off the end; when the body always
  // returns/throws (through nested if/else or a rethrowing boundary wrap) an added
  // return would be unreachable. `bodyCompletesAbruptly` decides this generally.
  if (methodResultType !== 'void' && body[body.length - 1] === '}' && body.some((line) => String(line).trim() === 'try {')
    && !bodyCompletesAbruptly(body)
    && !body.some((line) => /(?:stateLoop:|\bwhile\b|\bcontinue\b)/.test(String(line)))) {
    body.push(`return ${defaultValueForType(methodResultType)};`);
  }
  assertNoFallback(body, { className: cls.className, methodName: method.name, descriptor: method.descriptor });
  const result = formatBlock(header, body);
  if (profileMethod) console.error(`[cfr-method-done] ${Date.now() - methodProfileStarted}ms ${cls.className}.${method.name}${method.descriptor}`);
  return result;
}

function isTrivialEnumConstructor(method) {
  const allowed = new Set(['aload_0', 'aload_1', 'iload_2', 'invokespecial', 'return']);
  const instructions = executableInstructions(getCode(method)).map(getInstructionFromItem).filter(Boolean);
  return instructions.length > 0 && instructions.every((instruction) => allowed.has(instruction.op));
}

function formatEnumConstructor(cls, method, params, localState, options) {
  const visibleParams = params.slice(2);
  const paramDecls = visibleParams.map((type, index) =>
    `${simplifyType(type)} ${localState.paramNames[index + 2]}`).join(', ');
  const body = pruneTopLevelUnreachableTail(
    decompileCode(getCode(method), method, cls, localState, options));
  const missingDeclarations = localState.missingDeclarations(body);
  if (missingDeclarations.length) body.unshift(...missingDeclarations);
  body.splice(0, body.length, ...normalizeSyntheticVariableScopes(
    refineObjectLocalDeclarations(body, (name) => localState.refinedTypeForName(name))));
  ensureMissingSyntheticDeclarations(body);
  assertNoFallback(body, { className: cls.className, methodName: '<init>', descriptor: method.descriptor });
  return formatBlock(`private ${simpleClassName(cls.className)}(${paramDecls})`, body);
}

function methodThrowsTypes(method) {
  const attr = (method.attributes || []).find((item) => item && item.type === 'exceptions');
  if (!attr || !Array.isArray(attr.exceptions)) return [];
  return attr.exceptions.map(javaTypeFromInternalName);
}

// Well-known JDK unchecked exception roots. Anything transitively rooted here (or
// at RuntimeException/Error) needs no throws clause or handler; everything else
// that reaches Throwable/Exception is checked.
const JDK_UNCHECKED_EXCEPTIONS = new Set([
  'java/lang/RuntimeException', 'java/lang/Error',
  'java/lang/NullPointerException', 'java/lang/ArithmeticException',
  'java/lang/ArrayIndexOutOfBoundsException', 'java/lang/IndexOutOfBoundsException',
  'java/lang/StringIndexOutOfBoundsException', 'java/lang/ArrayStoreException',
  'java/lang/ClassCastException', 'java/lang/IllegalArgumentException',
  'java/lang/IllegalStateException', 'java/lang/IllegalMonitorStateException',
  'java/lang/NumberFormatException', 'java/lang/NegativeArraySizeException',
  'java/lang/UnsupportedOperationException', 'java/lang/AssertionError',
  'java/lang/StackOverflowError', 'java/lang/OutOfMemoryError',
  'java/util/ConcurrentModificationException', 'java/util/NoSuchElementException',
  'java/util/EmptyStackException',
]);

// A cross-class model of declared method throws + the class hierarchy, built once
// per decompile run over all input classes. Lets a caller detect that a call
// lands on a method whose bytecode declares a checked exception it must handle —
// the obfuscated bytecode omits the throws clause the JVM never enforces.
function buildExceptionModel(classes) {
  const methodThrows = new Map(); // `owner#name#descriptor` -> [internal throw names]
  const superOf = new Map();      // owner internal name -> superclass internal name
  const classInfo = new Map();    // owner internal name -> parsed class
  const sourceNameToInternal = new Map(); // rendered Java type -> owner internal name
  const instantiatedTypes = new Set();
  for (const cls of classes || []) {
    const owner = cls.className;
    if (!owner) continue;
    classInfo.set(owner, cls);
    sourceNameToInternal.set(javaTypeFromInternalName(owner), owner);
    if (cls.superClassName) superOf.set(owner, cls.superClassName);
    for (const item of cls.items || []) {
      if (item.type !== 'method' || !item.method) continue;
      const code = getCode(item.method);
      for (const codeItem of (code && code.codeItems) || []) {
        const instruction = getInstructionFromItem(codeItem);
        if (instruction && instruction.op === 'new' && typeof instruction.arg === 'string') {
          instantiatedTypes.add(instruction.arg);
        }
      }
      const attr = (item.method.attributes || []).find((a) => a && a.type === 'exceptions');
      if (attr && Array.isArray(attr.exceptions) && attr.exceptions.length) {
        methodThrows.set(`${owner}#${item.method.name}#${item.method.descriptor}`, attr.exceptions.slice());
      }
    }
  }
  return { methodThrows, superOf, classInfo, sourceNameToInternal, instantiatedTypes };
}

function hasUnimplementedAbstractMethods(cls, model) {
  if (!model || !model.classInfo || !cls || (cls.flags || []).includes('interface')) return false;
  const resolved = new Map();
  let current = cls;
  const seenClasses = new Set();
  while (current && !seenClasses.has(current.className)) {
    seenClasses.add(current.className);
    for (const item of current.items || []) {
      const method = item && item.type === 'method' ? item.method : null;
      if (!method || method.name === '<init>' || method.name === '<clinit>') continue;
      const flags = method.flags || [];
      if (flags.includes('static') || flags.includes('private')) continue;
      const key = `${method.name}#${method.descriptor}`;
      if (!resolved.has(key)) resolved.set(key, flags.includes('abstract'));
    }
    current = current.superClassName ? model.classInfo.get(current.superClassName) : null;
  }
  return [...resolved.values()].some(Boolean);
}

function syntheticAbstractSubclassConstructor(cls, displayName, model) {
  if (!hasUnimplementedAbstractMethods(cls, model)) return null;
  const hasConstructor = (cls.items || []).some((item) => item && item.type === 'method'
    && item.method && item.method.name === '<init>');
  if (hasConstructor || !cls.superClassName || !model || !model.classInfo) return null;
  const parent = model.classInfo.get(cls.superClassName);
  if (!parent) return null;
  const constructors = (parent.items || [])
    .filter((item) => item && item.type === 'method' && item.method && item.method.name === '<init>')
    .map((item) => item.method)
    .filter((method) => !(method.flags || []).includes('private'));
  if (!constructors.length || constructors.some((method) => method.descriptor === '()V')) return null;
  const descriptor = parseDescriptor(constructors[0].descriptor || '()V');
  const args = (descriptor.params || []).map((type) => defaultValueForType(simplifyType(type)));
  return `${displayName}() { super(${args.join(', ')}); }`;
}

// Walk an exception type up the (corpus) hierarchy; unchecked once it reaches a
// RuntimeException/Error root, checked once it reaches Throwable/Exception or a
// JDK type outside the known-unchecked set.
function isCheckedThrow(internalName, model) {
  let type = internalName;
  const seen = new Set();
  while (type && !seen.has(type)) {
    seen.add(type);
    if (JDK_UNCHECKED_EXCEPTIONS.has(type)) return false;
    if (type === 'java/lang/Throwable' || type === 'java/lang/Exception') return true;
    if (type === 'java/lang/Object') return false;
    const sup = (model && model.superOf && model.superOf.get(type))
      || (jreClassInfo(type) && jreClassInfo(type).superName);
    if (!sup) break; // hit the JDK boundary
    type = sup;
  }
  return true; // unresolved JDK exception not known-unchecked → treat as checked
}

function exceptionTypeAncestors(sourceType, model) {
  let type = String(sourceType || 'java.lang.Throwable').replace(/\./g, '/');
  const result = [];
  const seen = new Set();
  while (type && !seen.has(type)) {
    seen.add(type);
    result.push(type);
    type = (model && model.superOf && model.superOf.get(type))
      || (jreClassInfo(type) && jreClassInfo(type).superName);
  }
  if (!result.includes('java/lang/Throwable')) result.push('java/lang/Throwable');
  return result;
}

function commonExceptionSourceType(sourceTypes, model) {
  const types = sourceTypes.filter(Boolean);
  if (!types.length) return 'Throwable';
  const ancestry = types.map((type) => exceptionTypeAncestors(type, model));
  const common = ancestry[0].find((candidate) => ancestry.slice(1)
    .every((chain) => chain.includes(candidate))) || 'java/lang/Throwable';
  return javaTypeFromInternalName(common);
}

// Declared throws for owner.name:descriptor, resolving inherited declarations up
// the corpus hierarchy. Returns null when the method is unknown (e.g. a JDK call).
function resolveMethodThrows(owner, name, descriptor, model) {
  let current = owner;
  const seen = new Set();
  while (model && current && !seen.has(current)) {
    seen.add(current);
    const found = model.methodThrows.get(`${current}#${name}#${descriptor}`);
    if (found) return found;
    const sup = model.superOf.get(current);
    if (!sup) break;
    current = sup;
  }
  return resolveJdkMethodThrows(owner, name, descriptor);
}

function resolveJdkMethodThrows(owner, name, descriptor) {
  let current = owner;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const info = jreClassInfo(current);
    if (!info) return null;
    const candidates = [
      ...(info.methods.get(name) || []),
      ...(info.staticMethods.get(name) || []),
    ];
    const method = candidates.find((candidate) => candidate.descriptor === descriptor);
    if (method) return method.throwsTypes;
    current = info.superName;
  }
  return null;
}

const INVOKE_OPS = new Set(['invokevirtual', 'invokestatic', 'invokespecial', 'invokeinterface']);

// True when the method invokes a sibling method that declares a checked exception
// this method neither declares nor (broadly) catches. Such calls are javac errors
// unless the body is wrapped in an unchecked boundary. Complements the JDK pattern
// scan, which covers checked exceptions from standard-library calls/constructors.
function methodCallsUncaughtCheckedException(code, method, model) {
  if (!model || !code) return false;
  const declared = new Set(((method.attributes || []).find((a) => a && a.type === 'exceptions') || {}).exceptions || []);
  if (declared.has('java/lang/Throwable') || declared.has('java/lang/Exception')) return false;
  const covered = (type) => {
    let current = type;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (declared.has(current)) return true;
      current = model.superOf.get(current);
    }
    return false;
  };
  let hasExplicitThrow = false;
  const allocatedTypes = new Set();
  for (const item of code.codeItems || []) {
    const instruction = getInstructionFromItem(item);
    if (!instruction) continue;
    if (instruction.op === 'athrow') hasExplicitThrow = true;
    if (instruction.op === 'new' && typeof instruction.arg === 'string') allocatedTypes.add(instruction.arg);
    if (!INVOKE_OPS.has(instruction.op)) continue;
    let ref;
    try { ref = parseMemberRef(instruction.arg); } catch (err) { continue; }
    const throwsList = resolveMethodThrows(ref.owner, ref.name, ref.descriptor, model);
    if (!throwsList) continue;
    for (const type of throwsList) {
      if (isCheckedThrow(type, model) && !covered(type)) return true;
    }
  }
  if (hasExplicitThrow) {
    for (const type of allocatedTypes) {
      if (isCheckedThrow(type, model) && !covered(type)) return true;
    }
  }
  return false;
}

// Split a brace-balanced list of rendered Java lines into its top-level
// statements (each a sub-array of lines). A simple statement is one line ending
// in `;`; a compound statement spans from its `... {` head to the matching `}`.
function splitTopLevelStatements(lines) {
  const statements = [];
  let current = [];
  let depth = 0;
  for (const raw of lines) {
    const line = String(raw);
    current.push(line);
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) {
      if (current.some((entry) => String(entry).trim().length)) statements.push(current);
      current = [];
      depth = 0;
    }
  }
  if (current.some((entry) => String(entry).trim().length)) statements.push(current);
  return statements;
}

// Break a single compound statement (if/else, try/catch/finally, while, ...) into
// its `{ header, body }` segments. A segment opens on a `... {` line and its body
// runs until the matching `}`; a `} keyword {` line (else, catch, finally) both
// closes the previous body and opens the next.
function statementSegments(statement) {
  const segments = [];
  let body = null;
  let depth = 0;
  for (const raw of statement) {
    const line = String(raw);
    let running = depth;
    let minDepth = depth;
    for (const ch of line) {
      if (ch === '{') running += 1;
      else if (ch === '}') { running -= 1; if (running < minDepth) minDepth = running; }
    }
    const before = depth;
    depth = running;
    if (before === 0 && running >= 1) {
      body = [];
      segments.push({ header: line.trim(), body });
    } else if (minDepth === 0 && running >= 1) {
      body = [];
      segments.push({ header: line.trim(), body });
    } else if (running === 0) {
      body = null;
    } else if (body) {
      body.push(line);
    }
  }
  return segments;
}

// True when a rendered Java block (a brace-balanced line list) provably completes
// abruptly on every path — control can never fall off its end. Recurses through
// if/else, try/catch/finally, and infinite loops so a synthesized trailing
// `return` is only added where the body can actually fall through.
function bodyCompletesAbruptly(lines) {
  const statements = splitTopLevelStatements(lines);
  if (!statements.length) return false;
  return statementCompletesAbruptly(statements[statements.length - 1]);
}

function statementCompletesAbruptly(statement) {
  const trimmed = statement.map((line) => String(line).trim()).filter((line) => line.length);
  if (!trimmed.length) return false;
  const head = trimmed[0];
  if (/^(?:return|throw)\b/.test(head)) return true;
  if (/^if\s*\(/.test(head)) {
    const segments = statementSegments(statement);
    const last = segments[segments.length - 1];
    const hasElse = last && /^\}?\s*else\s*\{$/.test(last.header);
    if (!hasElse) return false; // an if with no final else can fall through
    return segments.every((segment) => bodyCompletesAbruptly(segment.body));
  }
  if (/^try\s*\{/.test(head)) {
    const segments = statementSegments(statement);
    const last = segments[segments.length - 1];
    if (last && /^\}?\s*finally\s*\{$/.test(last.header) && bodyCompletesAbruptly(last.body)) return true;
    return segments.every((segment) => bodyCompletesAbruptly(segment.body));
  }
  if (/^(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{/.test(head)) {
    const segments = statementSegments(statement);
    const body = segments.length ? segments[0].body : [];
    // An infinite loop completes abruptly unless a break can leave it. Any break
    // in the body is treated conservatively as a possible exit.
    return !body.some((line) => /\bbreak\b/.test(String(line)));
  }
  return false;
}

function formatStaticInitializer(code, localState, cls, options = {}) {
  const body = code ? decompileCode(code, { name: '<clinit>', descriptor: '()V', flags: ['static'] }, cls, localState, options) : [];
  const missingDeclarations = localState.missingDeclarations(body);
  if (missingDeclarations.length) body.unshift(...missingDeclarations);
  replaceArrayContents(body, normalizeSyntheticVariableScopes(body));
  assertNoFallback(body, { className: cls.className, methodName: '<clinit>', descriptor: '()V' });
  if (!body.length) return formatBlock('static', body);

  // Keep ordinary initializer bytecode in Java's actual static-initializer
  // construct. Moving every body into a helper changes the shape of <clinit>
  // and exposes a partially initialized class to runtimes while that helper is
  // executing. A JVM return inside a structured branch is represented as a
  // break from a labelled block because Java forbids return statements in an
  // initializer.
  const isVoidReturn = (line) => /^return\s*;$/.test(String(line).trim());
  const hasEarlyReturn = body.some(isVoidReturn);
  if (!bodyCompletesAbruptly(body)) {
    if (!hasEarlyReturn) return formatBlock('static', body);

    let label = '$cfr$clinit';
    const renderedBody = body.join('\n');
    while (renderedBody.includes(`${label}:`)) label += '$';
    const labelledBody = body.map((line) => {
      const text = String(line);
      if (!isVoidReturn(text)) return text;
      return `${text.slice(0, text.length - text.trimStart().length)}break ${label};`;
    });
    return formatBlock('static', [
      `${label}: {`,
      ...labelledBody.map((line) => `    ${line}`),
      '}',
    ]);
  }

  // Java rejects an initializer that provably cannot complete normally. Retain
  // a helper only for that source-language edge case.
  const methodNames = new Set((cls.items || [])
    .filter((item) => item && item.type === 'method' && item.method)
    .map((item) => item.method.name));
  let helperName = '$cfr$clinit';
  while (methodNames.has(helperName)) helperName += '$';
  return `${formatBlock('static', [`${helperName}();`])}\n\n${formatBlock(`private static void ${helperName}()`, body)}`;
}

function formatBlock(header, body) {
  const out = [`${header} {`];
  if (body.length) {
    body.forEach((line) => out.push(`    ${line}`));
  }
  out.push('}');
  return out.join('\n');
}

// A handler_pc reached from more than one distinct protected range is CFR's
// same-target row merging: one logical try/catch whose body javac split into
// several table rows. The legacy pattern structurers reconstruct only one of the
// rows and leave the other protected calls outside the try (wrong Java). Route
// such methods to the owned structurer, which merges the rows (or, failing that,
// falls back to the always-correct state machine).
function tableHasSharedHandler(exceptionTable) {
  const rangesByHandler = new Map();
  for (const entry of exceptionTable) {
    if (entry.start_pc === entry.handler_pc) continue; // self-handler, dropped later
    const key = entry.handler_pc;
    if (!rangesByHandler.has(key)) rangesByHandler.set(key, new Set());
    rangesByHandler.get(key).add(`${entry.start_pc}:${entry.end_pc}`);
  }
  for (const ranges of rangesByHandler.values()) if (ranges.size > 1) return true;
  return false;
}

function tableHasTrivialCheckedHandler(code) {
  const items = (code && code.codeItems) || [];
  const labels = buildLabelIndex(items);
  const unchecked = new Set(['java/lang/RuntimeException', 'java/lang/Error', 'any']);
  for (const entry of (code && code.exceptionTable) || []) {
    const catchType = entry.catch_type ?? entry.catchType;
    if (!catchType || catchType === 0 || unchecked.has(catchType)) continue;
    const handlerIndex = labels.get(entry.handlerLbl || entry.handlerLabel);
    if (handlerIndex === undefined) continue;
    const storeIndex = nextNonNopExecutableIndex(items, handlerIndex);
    const store = storeIndex < 0 ? null : getInstructionFromItem(items[storeIndex]);
    if (!store || !parseStoreIndex(store.op, store.arg)) continue;
    const nextIndex = nextNonNopExecutableIndex(items, storeIndex + 1);
    const next = nextIndex < 0 ? null : getInstructionFromItem(items[nextIndex]);
    if (next && (next.op === 'goto' || next.op === 'goto_w' || next.op === 'return')) return true;
  }
  return false;
}

function normalizeLargeIntegerDispatchers(codeItems) {
  if (!Array.isArray(codeItems) || codeItems.length <= 5000) return 0;
  let rewrites = 0;
  let labelIndex = buildLabelIndex(codeItems);
  for (let start = 0; start < codeItems.length; start += 1) {
    const match = matchIntegerDispatcher(codeItems, start, labelIndex);
    if (!match) continue;
    const first = codeItems[start] || {};
    const replacement = [{ ...first, instruction: loadInt(match.local) }, {
      instruction: { op: 'lookupswitch', arg: { pairs: match.pairs, defaultLabel: match.defaultLabel } },
    }];
    codeItems.splice(start, match.end - start, ...replacement);
    rewrites += 1;
    labelIndex = buildLabelIndex(codeItems);
    start += 1;
  }
  return rewrites;
}

function matchIntegerDispatcher(items, start, labelIndex) {
  const pairs = [];
  let selectorLocal = null;
  let scan = start;
  const visited = new Set();
  while (scan >= 0 && scan < items.length && !visited.has(scan)) {
    visited.add(scan);
    const parsed = parseIntegerDispatchTest(items, scan);
    if (!parsed) {
      const index = nextNonNopExecutableIndex(items, scan);
      const instruction = index < 0 ? null : getInstructionFromItem(items[index]);
      if (pairs.length >= 8 && instruction && (instruction.op === 'goto' || instruction.op === 'goto_w')) {
        return { local: selectorLocal, pairs, defaultLabel: instruction.arg, end: index + 1 };
      }
      const fallthroughLabel = items[scan] && String(items[scan].labelDef || '').replace(/:$/, '');
      if (pairs.length >= 8 && fallthroughLabel) {
        return { local: selectorLocal, pairs, defaultLabel: fallthroughLabel, end: scan };
      }
      if (process.env.CFR_JS_DEBUG_STRUCTURER === '1' && pairs.length >= 2) {
        console.error(`[cfr-dispatch-reject] cases=${pairs.length} index=${scan} op=${instruction && instruction.op}`);
      }
      return null;
    }
    if (selectorLocal == null) selectorLocal = parsed.local;
    if (selectorLocal !== parsed.local) {
      if (process.env.CFR_JS_DEBUG_STRUCTURER === '1' && pairs.length >= 2) {
        console.error(`[cfr-dispatch-reject] cases=${pairs.length} selector=${selectorLocal}->${parsed.local}`);
      }
      return null;
    }
    if (pairs.some((pair) => pair[0] === parsed.value)) {
      const existing = pairs.find((pair) => pair[0] === parsed.value);
      if (existing[1] !== parsed.caseLabel) return null;
    } else {
      pairs.push([parsed.value, parsed.caseLabel]);
    }
    if (parsed.nextLabel) {
      const next = labelIndex.get(parsed.nextLabel);
      if (next == null || next <= scan) return null;
      scan = next;
    } else {
      scan = parsed.end;
    }
  }
  return null;
}

function parseIntegerDispatchTest(items, start) {
  const stack = [];
  let index = start;
  for (let seen = 0; seen < 8 && index >= 0 && index < items.length; seen += 1) {
    const instruction = getInstructionFromItem(items[index]);
    if (!instruction || instruction.op === 'nop') {
      index += 1;
      continue;
    }
    const load = parseLoadIndex(instruction.op, instruction.arg);
    if (load && load.type === 'int') stack.push({ local: load.index, complement: false });
    else {
      const constant = integerInstructionValue(instruction);
      if (constant != null) stack.push({ constant });
      else if (instruction.op === 'ixor' && stack.length >= 2) {
        const right = stack.pop();
        const left = stack.pop();
        if (right.constant === -1 && left.local != null) stack.push({ ...left, complement: !left.complement });
        else if (left.constant === -1 && right.local != null) stack.push({ ...right, complement: !right.complement });
        else return null;
      } else if (instruction.op === 'if_icmpeq' || instruction.op === 'if_icmpne') {
        if (stack.length !== 2) return null;
        const right = stack.pop();
        const left = stack.pop();
        const selector = left.local != null ? left : right;
        const valueOperand = left.local != null ? right : left;
        if (selector.local == null || valueOperand.constant == null) return null;
        const value = selector.complement ? ~Number(valueOperand.constant) : Number(valueOperand.constant);
        if (instruction.op === 'if_icmpeq') {
          return { local: selector.local, value, caseLabel: instruction.arg, end: index + 1 };
        }
        const gotoIndex = nextNonNopExecutableIndex(items, index + 1);
        const next = gotoIndex < 0 ? null : getInstructionFromItem(items[gotoIndex]);
        if (!next || (next.op !== 'goto' && next.op !== 'goto_w')) return null;
        return { local: selector.local, value, caseLabel: next.arg, nextLabel: instruction.arg, end: gotoIndex + 1 };
      } else return null;
    }
    index += 1;
  }
  return null;
}

function integerInstructionValue(instruction) {
  if (instruction.op === 'iconst_m1') return -1;
  const match = /^iconst_([0-5])$/.exec(instruction.op || '');
  if (match) return Number(match[1]);
  if (instruction.op === 'bipush' || instruction.op === 'sipush') return Number(instruction.arg);
  if ((instruction.op === 'ldc' || instruction.op === 'ldc_w') && Number.isInteger(instruction.arg)) {
    return Number(instruction.arg);
  }
  return null;
}

function loadInt(index) {
  return Number(index) >= 0 && Number(index) <= 3 ? `iload_${Number(index)}` : { op: 'iload', arg: String(index) };
}

function decompileCode(code, method, cls, localState, options = {}) {
  // Linear emitters are also called by nested structuring strategies that have
  // their own option bags.  Keep the run-wide hierarchy on the shared local
  // state so expression coercion remains cross-class-aware in every path.
  localState.exceptionModel = options.exceptionModel || localState.exceptionModel;
  localState.currentInternalClassName = cls.className;
  localState.foldedSelfType = options.foldedSelfType || localState.foldedSelfType;
  localState.staticOwnerAliases = options.staticOwnerAliases || localState.staticOwnerAliases;
  const codeItemsForSelection = code.codeItems || [];
  let controlTransfers = 0;
  let hasSuppressedCleanup = false;
  let hasArrayLength = false;
  for (const item of codeItemsForSelection) {
    const instruction = getInstructionFromItem(item);
    if (!instruction) continue;
    if (instruction.op === 'arraylength') hasArrayLength = true;
    if (isConditionalBranch(instruction.op) || instruction.op === 'goto' || instruction.op === 'goto_w'
      || instruction.op === 'tableswitch' || instruction.op === 'lookupswitch') controlTransfers += 1;
    if (!String(instruction.op || '').startsWith('invoke')) continue;
    try {
      if (parseMemberRef(instruction.arg).name === 'addSuppressed') hasSuppressedCleanup = true;
    } catch (_err) {
      // invokedynamic and malformed references are irrelevant to this selector.
    }
  }
  const preferOwnedStructurer = options.forceOwnedStructurer === true
    || tableHasTrivialCheckedHandler(code)
    || (codeItemsForSelection.length > 128
      && !(hasArrayLength && !(code.exceptionTable || []).length
        && controlTransfers / codeItemsForSelection.length <= 0.05)
      && !hasSuppressedCleanup);
  if (process.env.CFR_JS_PROFILE_METHODS === '1') {
    console.error(`[cfr-selector] ${cls.className}.${method.name}${method.descriptor} items=${codeItemsForSelection.length} transfers=${controlTransfers} array=${hasArrayLength} suppressed=${hasSuppressedCleanup} owned=${preferOwnedStructurer}`);
  }
  const sequentialTryCatches = decompileStructuredSequentialTryCatches(code, method, cls, localState);
  if (usableDecompileLines(sequentialTryCatches)) return sequentialTryCatches;
  if (preferOwnedStructurer) {
    if (process.env.CFR_JS_PROFILE_METHODS === '1') console.error(`[cfr-owned-start] ${cls.className}.${method.name}${method.descriptor}`);
    const ownedStructured = decompileOwnedStructuredControlFlow(code, method, cls, localState, options);
    if (process.env.CFR_JS_PROFILE_METHODS === '1') console.error(`[cfr-owned-done] ${cls.className}.${method.name}${method.descriptor}`);
    if (ownedStructured) return ownedStructured;
  }

  const booleanPattern = decompileKnownBooleanPattern(code, method, cls, localState);
  if (usableDecompileLines(booleanPattern)) return booleanPattern;

  const shortCircuitBooleanPattern = decompileShortCircuitBooleanReturnPattern(code, method, cls, localState);
  if (usableDecompileLines(shortCircuitBooleanPattern)) return shortCircuitBooleanPattern;

  const booleanReturnPattern = decompileBooleanReturnPattern(code, method, cls, localState);
  if (usableDecompileLines(booleanReturnPattern)) return booleanReturnPattern;

  const ternaryReturnPattern = decompileTernaryReturnPattern(code, method, cls, localState);
  if (usableDecompileLines(ternaryReturnPattern)) return ternaryReturnPattern;

  const synchronizedBlock = decompileStructuredSynchronized(code, method, cls, localState);
  if (usableDecompileLines(synchronizedBlock)) return synchronizedBlock;

  const finallyBlock = decompileStructuredFinally(code, method, cls, localState);
  if (usableDecompileLines(finallyBlock)) return finallyBlock;

  const tryCatchFinally = decompileStructuredTryCatchFinally(code, method, cls, localState);
  if (usableDecompileLines(tryCatchFinally)) return tryCatchFinally;

  const structured = decompileStructuredControlFlow(code, method, cls, localState);
  const dropsExceptionTable = !hasSuppressedCleanup && (code.exceptionTable || []).length
    && !(structured || []).some((line) => localDeclarationsFromStatement(line).some((item) => item.inCatch));
  if (usableDecompileLines(structured) && !dropsExceptionTable) return structured;
  if (structured && process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
    console.error(`${cls.className}.${method.name}${method.descriptor}: legacy range output rejected (${structured.length} lines)`);
  }

  if (!preferOwnedStructurer) {
    const ownedStructured = decompileOwnedStructuredControlFlow(code, method, cls, localState, options);
    if (ownedStructured) return ownedStructured;
  }

  const tryCatch = decompileStructuredTryCatch(code, method, cls, localState);
  if (usableDecompileLines(tryCatch)) return tryCatch;

  const lines = decompileLinearCodeItems(code.codeItems || [], method, cls, localState);
  if (lines[lines.length - 1] === 'return;') lines.pop();
  return coalesceDefaultConstructorBody(lines, method);
}

function usableDecompileLines(lines) {
  // An empty structured candidate is not evidence that a non-empty bytecode
  // body was handled.  Let selection continue to the linear emitter; genuinely
  // empty methods still end there as an empty Java block.
  if (!Array.isArray(lines) || lines.length === 0
    || lines.some((line) => String(line).includes('stack-underflow'))) return false;
  // Reject any candidate that dropped an opcode to a bytecode-as-comment or a
  // placeholder. An earlier structurer (e.g. the legacy pattern-matcher
  // `decompileStructuredControlFlow`) that bails on a goto still returns lines with
  // a `// goto`/`// if_*` comment; accepting them here would ship broken Java and
  // skip the general Ramsey structurer (`decompileOwnedStructuredControlFlow`),
  // which structures every reducible CFG cleanly. Falling through to it is strictly
  // better for those methods (and no worse for the rest — the gate is the backstop).
  if (lines.some((line) => FALLBACK_LINE_COMMENT.test(String(line)) || FALLBACK_PLACEHOLDER.test(String(line)))) return false;
  if (hasUnreachableStatementAfterTerminal(lines)) return false;
  return true;
}

function hasUnreachableStatementAfterTerminal(lines) {
  let depth = 0;
  let terminalDepth = null;
  for (const raw of lines) {
    const line = String(raw);
    const leadingClosers = (line.match(/^\s*}+/) || [''])[0].replace(/[^}]/g, '').length;
    const lineDepth = Math.max(0, depth - leadingClosers);
    const trimmed = line.trim();
    if (terminalDepth != null) {
      if (lineDepth < terminalDepth || /^(?:case\b|default:|}\s*(?:else|catch|finally)\b)/.test(trimmed)) {
        terminalDepth = null;
      } else if (trimmed && !/^}/.test(trimmed)) {
        return true;
      }
    }
    if (/^(?:return(?:\s+.*)?;|throw\s+.*;)$/.test(trimmed)) terminalDepth = lineDepth;
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  }
  return false;
}

function widenExceptionLocalsUsedByInstanceof(lines, model) {
  const instanceofTypesByLocal = new Map();
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'InstanceofExpression') {
      if (node.expression && node.expression.kind === 'Identifier'
        && node.checkType && node.checkType.kind === 'ClassType' && node.checkType.name) {
        const name = node.expression.name;
        const tested = (node.checkType.packageName ? `${node.checkType.packageName}.` : '') + node.checkType.name;
        if (!instanceofTypesByLocal.has(name)) instanceofTypesByLocal.set(name, new Set());
        instanceofTypesByLocal.get(name).add(tested.replace(/\./g, '/'));
      }
      collect(node.expression);
      return;
    }
    if ((node.kind === 'UnsupportedExpression' || node.kind === 'UnsupportedStatement') && Array.isArray(node.tokens)) {
      for (let index = 1; index < node.tokens.length; index += 1) {
        if (node.tokens[index].text === 'instanceof' && node.tokens[index - 1].kind === 'identifier'
          && node.tokens[index + 1] && node.tokens[index + 1].kind === 'identifier') {
          const name = node.tokens[index - 1].text;
          if (!instanceofTypesByLocal.has(name)) instanceofTypesByLocal.set(name, new Set());
          instanceofTypesByLocal.get(name).add(node.tokens[index + 1].text.replace(/\./g, '/'));
        }
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'range' || key === 'tokens') continue;
      if (Array.isArray(value)) value.forEach(collect);
      else collect(value);
    }
  };
  for (const raw of lines) {
    if (!String(raw).includes('instanceof')) continue;
    try { collect(javaStatementParser.parseStatement(String(raw).trim())); } catch (_error) { /* ignore */ }
  }
  if (!instanceofTypesByLocal.size) return;
  const primitive = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
  // Declared type of every local in the body (including catch parameters).
  const declaredTypeOf = new Map();
  for (const raw of lines) {
    for (const declaration of localDeclarationsFromStatement(String(raw))) {
      if (!declaredTypeOf.has(declaration.name)) declaredTypeOf.set(declaration.name, declaration.type);
    }
  }
  // Rewrite the instanceof expression itself rather than widening the local's
  // declaration: `(Object) x instanceof T` is always legal Java for reference
  // x, while retyping the declaration to Object breaks every other use of the
  // local (field access, method calls) that relied on the declared type.
  for (const [name, testedTypes] of instanceofTypesByLocal) {
    const declared = declaredTypeOf.get(name);
    if (!declared || primitive.has(declared)) continue;
    const declaredType = declared.replace(/\./g, '/');
    const incompatible = [...testedTypes].filter(
      (testedType) => !isInstanceofTypeCompatible(declaredType, testedType, model));
    if (!incompatible.length) continue;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const testedType of incompatible) {
      const renderedTested = testedType.replace(/\//g, '.');
      const escapedTested = renderedTested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![\\w.$])${escapedName}[ \\t]+instanceof[ \\t]+${escapedTested}\\b`, 'g');
      for (let index = 0; index < lines.length; index += 1) {
        const line = String(lines[index]);
        if (!line.includes('instanceof')) continue;
        lines[index] = line.replace(pattern, `(Object) ${name} instanceof ${renderedTested}`);
      }
    }
  }
}

function isReferenceTypeAssignable(sourceType, targetType, model) {
  if (targetType === 'Object' || targetType === 'java/lang/Object' || sourceType === targetType) return true;
  const pending = [sourceType];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === targetType) return true;
    seen.add(current);
    const info = model && model.classInfo ? model.classInfo.get(current) : null;
    if (info) {
      if (info.superClassName) pending.push(info.superClassName);
      pending.push(...(info.interfaces || []));
    } else if (model && model.superOf) {
      pending.push(model.superOf.get(current));
    }
  }
  return false;
}

const JAVA_PRIMITIVE_TYPES = new Set([
  'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void',
]);

function internalNameForSourceType(type, model) {
  const rendered = simplifyType(type);
  if (model && model.sourceNameToInternal && model.sourceNameToInternal.has(rendered)) {
    return model.sourceNameToInternal.get(rendered);
  }
  const wellKnown = {
    Object: 'java/lang/Object',
    Cloneable: 'java/lang/Cloneable',
    Serializable: 'java/io/Serializable',
  };
  return wellKnown[rendered] || rendered.replace(/\./g, '/');
}

// Source expressions can be more specific than a bytecode descriptor's
// parameter or storage type.  A Java widening reference conversion needs no
// cast; forcing it through Object creates a real checkcast in the recompiled
// bytecode.  Arrays are covariant for reference components, and every array is
// assignable to Object, Cloneable, and Serializable.
function isSourceReferenceTypeAssignable(sourceType, targetType, model) {
  const source = simplifyType(sourceType);
  const target = simplifyType(targetType);
  if (source === target) return true;
  if (JAVA_PRIMITIVE_TYPES.has(source) || JAVA_PRIMITIVE_TYPES.has(target)) return false;

  const sourceIsArray = source.endsWith('[]');
  const targetIsArray = target.endsWith('[]');
  if (sourceIsArray && !targetIsArray) {
    return target === 'Object' || target === 'Cloneable' || target === 'Serializable'
      || target === 'java.lang.Object' || target === 'java.lang.Cloneable'
      || target === 'java.io.Serializable';
  }
  if (sourceIsArray !== targetIsArray) return false;
  if (sourceIsArray) {
    return isSourceReferenceTypeAssignable(source.slice(0, -2), target.slice(0, -2), model);
  }

  return isReferenceTypeAssignable(
    internalNameForSourceType(source, model),
    internalNameForSourceType(target, model),
    model,
  );
}

function isInstanceofTypeCompatible(sourceType, testedType, model) {
  if (isReferenceTypeAssignable(sourceType, testedType, model)
    || isReferenceTypeAssignable(testedType, sourceType, model)) return true;
  const sourceInfo = model && model.classInfo ? model.classInfo.get(sourceType) : null;
  const testedInfo = model && model.classInfo ? model.classInfo.get(testedType) : null;
  return Boolean(sourceInfo && (sourceInfo.flags || []).includes('interface'))
    || Boolean(testedInfo && (testedInfo.flags || []).includes('interface'));
}

// Checked catch types the bytecode exception table routes to even though no
// instruction in the protected range declares a matching throw.
//
// This is the one analysis behind two opposite-looking decisions, so it lives in
// one place. `ensureCheckedCatchReachability` injects an `if (false) throw (T)
// null;` anchor for these types to satisfy javac's reachability rule, while
// `removeImpossibleCheckedCatchBlocks` must *decline* to delete them: an
// unattributable row is evidence the obfuscator throws the type without
// declaring it, not evidence the handler is dead. Deriving both from this set
// keeps one pass from deleting what the other is about to vouch for.
function collectUnsupportedCheckedCatchTypes(code, model) {
  const unsupportedSourceTypes = new Set();
  if (!code || !(code.exceptionTable || []).length) return unsupportedSourceTypes;
  const generic = new Set([null, 0, 'any', 'java/lang/Throwable', 'java/lang/Exception',
    'java/lang/RuntimeException', 'java/lang/Error']);
  const entriesByType = new Map();
  for (const entry of code.exceptionTable || []) {
    const type = entry.catch_type ?? entry.catchType;
    if (generic.has(type)) continue;
    if (!entriesByType.has(type)) entriesByType.set(type, []);
    entriesByType.get(type).push(entry);
  }
  for (const [catchType, entries] of entriesByType) {
    // Reuse the canonical classifier here. The corpus hierarchy generally
    // stops at the JDK boundary, so a plain assignability walk cannot discover
    // that types such as NumberFormatException are RuntimeExceptions and would
    // inject a visible `if (false) throw ...` anchor unnecessarily.
    if (!isCheckedThrow(catchType, model)) continue;
    const supported = entries.every((entry) => (code.codeItems || []).some((item) => {
      if (!Number.isFinite(item.pc)
        || item.pc < entry.start_pc || item.pc >= entry.end_pc) return false;
      const instruction = getInstructionFromItem(item);
      if (!instruction) return false;
      if (instruction.op === 'new' && typeof instruction.arg === 'string') {
        return isAssignableExceptionType(instruction.arg, catchType, model);
      }
      if (!INVOKE_OPS.has(instruction.op)) return false;
      let ref;
      try { ref = parseMemberRef(instruction.arg); } catch (_error) { return false; }
      return (resolveMethodThrows(ref.owner, ref.name, ref.descriptor, model) || [])
        .some((type) => isAssignableExceptionType(type, catchType, model));
    }));
    if (!supported) unsupportedSourceTypes.add(javaTypeFromInternalName(catchType));
  }
  return unsupportedSourceTypes;
}

function ensureCheckedCatchReachability(lines, code, model) {
  if (!code || !(code.exceptionTable || []).length) return;
  const unsupportedSourceTypes = collectUnsupportedCheckedCatchTypes(code, model);
  if (!unsupportedSourceTypes.size) return;

  const insertions = [];
  for (let tryIndex = 0; tryIndex < lines.length; tryIndex += 1) {
    if (String(lines[tryIndex]).trim() !== 'try {') continue;
    const catchIndex = findMatchingCatchLine(lines, tryIndex);
    if (catchIndex < 0) continue;
    const declaration = localDeclarationsFromStatement(lines[catchIndex])[0];
    if (!declaration || !unsupportedSourceTypes.has(declaration.type)) continue;
    if (sourceRangeHasDeclaredThrower(lines, tryIndex + 1, catchIndex, declaration.type, model)) continue;
    insertions.push({ index: tryIndex + 1, type: declaration.type,
      indent: `${String(lines[tryIndex]).match(/^\s*/)[0]}    ` });
  }
  insertions.sort((a, b) => b.index - a.index);
  for (const insertion of insertions) {
    lines.splice(insertion.index, 0, `${insertion.indent}if (false) throw (${insertion.type}) null;`);
  }
}

function sourceRangeHasDeclaredThrower(lines, start, end, catchSourceType, model) {
  const declaredTypes = new Map();
  for (const line of lines) {
    for (const declaration of localDeclarationsFromStatement(String(line))) {
      if (!declaredTypes.has(declaration.name)) declaredTypes.set(declaration.name, declaration.type);
    }
  }
  for (let index = start; index < end; index += 1) {
    const line = String(lines[index]);
    // Chained reflection obscures the Field receiver's source type, but this
    // exact JDK declaration is unambiguous and carries checked throws metadata.
    if (/\.getInt\s*\(/.test(line)
      && throwsTypesCoverSourceCatch(
        resolveMethodThrows('java/lang/reflect/Field', 'getInt', '(Ljava/lang/Object;)I', model),
        catchSourceType, model)) return true;

    for (const call of line.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(([^;]*)/g)) {
      const receiver = call[1];
      const methodName = call[2];
      const ownerSourceType = declaredTypes.get(receiver);
      if (!ownerSourceType) continue;
      const arity = sourceArgumentCount(call[3]);
      const candidates = sourceMethodCandidates(ownerSourceType.replace(/\./g, '/'), methodName, arity, model);
      if (candidates.length && candidates.every((throwsTypes) =>
        throwsTypesCoverSourceCatch(throwsTypes, catchSourceType, model))) return true;
    }
  }
  return false;
}

function sourceArgumentCount(rawArguments) {
  const text = String(rawArguments || '');
  let depth = 0;
  let count = 0;
  let sawToken = false;
  for (const char of text) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0 && char === ')') break;
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) count += 1;
    else if (!/\s/.test(char)) sawToken = true;
  }
  return sawToken ? count + 1 : 0;
}

function sourceMethodCandidates(owner, name, arity, model) {
  const result = [];
  const pending = [owner];
  const seen = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const info = model && model.classInfo ? model.classInfo.get(current) : null;
    if (!info) continue;
    for (const item of info.items || []) {
      if (!item || item.type !== 'method' || !item.method || item.method.name !== name) continue;
      if ((parseDescriptor(item.method.descriptor || '()V').params || []).length !== arity) continue;
      result.push(methodThrowsTypes(item.method).map((type) => type.replace(/\./g, '/')));
    }
    if (info.superClassName) pending.push(info.superClassName);
    pending.push(...(info.interfaces || []));
  }
  return result;
}

function throwsTypesCoverSourceCatch(throwsTypes, catchSourceType, model) {
  const catchType = String(catchSourceType || '').replace(/\./g, '/');
  return (throwsTypes || []).some((type) => {
    const internal = String(type).replace(/\./g, '/');
    return internal === catchType || simpleClassName(internal) === simpleClassName(catchType)
      || isAssignableExceptionType(internal, catchType, model);
  });
}

// Remove a source-level checked catch only after control-flow reconstruction.
// Doing this to the bytecode exception table is tempting, but overlapping rows
// are also input to synchronized/region recovery and deleting one can make the
// emitted source less structured. Under this explicitly gated source-cleanup
// policy, a specific checked catch is live only when an emitted call declares
// that type. Broad unchecked/Throwable families remain conservative.
// True when some invoke inside a protected range for `catchSourceType` targets a
// method the exception model cannot resolve, so its throws clause is unknown
// rather than known-empty. `resolveMethodThrows` returns [] in both cases, and
// the model indexes only corpus classes, so every JDK callee lands here.
// Unknown must not be read as proof of no-throw.
function protectedRangeHasUnresolvableInvoke(code, catchSourceType, model) {
  if (!code || !(code.exceptionTable || []).length) return false;
  const catchSimpleName = simpleClassName(String(catchSourceType || '').replace(/\./g, '/'));
  const known = model && model.classInfo ? model.classInfo : null;
  for (const entry of code.exceptionTable || []) {
    const entryType = entry.catch_type ?? entry.catchType;
    if (!entryType || entryType === 'any' || entryType === 0
      || simpleClassName(String(entryType).replace(/\./g, '/')) !== catchSimpleName) continue;
    for (const item of code.codeItems || []) {
      const pc = Number(item && item.pc);
      if (!Number.isFinite(pc) || pc < entry.start_pc || pc >= entry.end_pc) continue;
      const instruction = getInstructionFromItem(item);
      if (!instruction || !INVOKE_OPS.has(instruction.op)) continue;
      let ref;
      try { ref = parseMemberRef(instruction.arg); } catch (_error) { return true; }
      if (!known || !known.has(ref.owner)) return true;
    }
  }
  return false;
}

function protectedBytecodeRangeHasDeclaredThrower(code, catchSourceType, model) {
  if (!code || !(code.exceptionTable || []).length) return false;
  const catchSimpleName = simpleClassName(String(catchSourceType || '').replace(/\./g, '/'));
  for (const entry of code.exceptionTable || []) {
    const entryType = entry.catch_type ?? entry.catchType;
    if (!entryType || entryType === 'any' || entryType === 0
      || simpleClassName(String(entryType).replace(/\./g, '/')) !== catchSimpleName) continue;
    for (const item of code.codeItems || []) {
      const pc = Number(item && item.pc);
      if (!Number.isFinite(pc) || pc < entry.start_pc || pc >= entry.end_pc) continue;
      const instruction = getInstructionFromItem(item);
      if (!instruction) continue;
      if (instruction.op === 'new' && typeof instruction.arg === 'string'
        && throwsTypesCoverSourceCatch([instruction.arg], catchSourceType, model)) return true;
      if (!INVOKE_OPS.has(instruction.op)) continue;
      let ref;
      try { ref = parseMemberRef(instruction.arg); } catch (_error) { continue; }
      if (throwsTypesCoverSourceCatch(
        resolveMethodThrows(ref.owner, ref.name, ref.descriptor, model),
        catchSourceType,
        model,
      )) return true;
    }
  }
  return false;
}

function removeImpossibleCheckedCatchBlocks(lines, model, code = null) {
  if (process.env.PIPELINE_EXPERIMENTAL_UNTHROWABLE_CATCH_DCE !== '1') return;
  // Types the exception table routes to without any declared thrower. javac
  // calls these unreachable, but that is exactly the obfuscator's undeclared
  // throw idiom, and normalizeStructuredCatchNodes now keeps their precise type
  // rather than widening it to Exception. Widening used to mask them from
  // isCheckedOnlyCatchSourceType below; without this guard the fix that
  // preserved these handlers would hand them straight to this pass to delete.
  const unattributableTypes = collectUnsupportedCheckedCatchTypes(code, model);
  // The set is keyed by whatever form javaTypeFromInternalName produced, while a
  // rendered catch may be written fully qualified. Compare on the simple name so
  // `InterruptedException` and `java.lang.InterruptedException` are one key.
  const unattributableSimpleNames = new Set(
    [...unattributableTypes].map((type) => simpleClassName(String(type).replace(/\./g, '/'))));
  for (let tryIndex = lines.length - 1; tryIndex >= 0; tryIndex -= 1) {
    if (String(lines[tryIndex]).trim() !== 'try {') continue;
    const catchIndex = findMatchingCatchLine(lines, tryIndex);
    if (catchIndex < 0) continue;
    const declaration = localDeclarationsFromStatement(lines[catchIndex])[0];
    if (!declaration || !isCheckedOnlyCatchSourceType(declaration.type, model)) continue;
    if (unattributableSimpleNames.has(
      simpleClassName(String(declaration.type).replace(/\./g, '/')))) continue;
    if (sourceRangeHasDeclaredThrower(lines, tryIndex + 1, catchIndex, declaration.type, model)) continue;
    if (protectedBytecodeRangeHasDeclaredThrower(code, declaration.type, model)) continue;
    // The exception model only indexes corpus classes, so resolveMethodThrows
    // answers [] for every JDK method — indistinguishable from "declares no
    // throws". javac compiles against the real JDK and knows better, so deleting
    // a handler on that silence produces code javac then rejects with
    // "unreported exception" (java.awt.MediaTracker.waitForAll in ck.<init>).
    // Treat an unresolvable callee as possibly-throwing.
    if (protectedRangeHasUnresolvableInvoke(code, declaration.type, model)) continue;

    let depth = 1;
    let catchEnd = -1;
    let hasFollowingClause = false;
    for (let index = catchIndex + 1; index < lines.length; index += 1) {
      const line = String(lines[index]);
      const trimmed = line.trim();
      if (depth === 1 && (/^}\s*catch\b/.test(trimmed) || /^}\s*finally\b/.test(trimmed))) {
        hasFollowingClause = true;
        break;
      }
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (depth === 0) {
        catchEnd = index;
        break;
      }
    }
    if (hasFollowingClause || catchEnd < 0) continue;

    // Retain a plain lexical block. Flattening it could collide with locals in
    // the surrounding method even though the catch itself is unreachable.
    const indent = (String(lines[tryIndex]).match(/^\s*/) || [''])[0];
    lines[tryIndex] = `${indent}{`;
    lines.splice(catchIndex, catchEnd - catchIndex + 1, `${indent}}`);
  }
}

function isCheckedOnlyCatchSourceType(sourceType, model) {
  const type = String(sourceType || '').replace(/\./g, '/');
  if (!type) return false;
  if (type === 'Throwable' || type === 'Exception' || type === 'Error'
    || type === 'java/lang/Throwable' || type === 'java/lang/Exception'
    || type === 'java/lang/Error') return false;
  for (const unchecked of JDK_UNCHECKED_EXCEPTIONS) {
    if (type === unchecked || (!type.includes('/') && type === simpleClassName(unchecked))) return false;
  }
  return isCheckedThrow(type, model);
}

function pruneTopLevelUnreachableTail(lines) {
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index]);
    const trimmed = line.trim();
    if (depth === 0 && /^(?:return(?:\s+.*)?;|throw\s+.*;)$/.test(trimmed)) {
      return lines.slice(0, index + 1);
    }
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
  }
  return lines;
}

function pruneBlockUnreachableStatements(lines) {
  const result = [];
  let depth = 0;
  let unreachableDepth = null;
  for (const raw of lines) {
    const line = String(raw);
    const leadingClosers = (line.match(/^\s*}+/) || [''])[0].replace(/[^}]/g, '').length;
    const lineDepth = Math.max(0, depth - leadingClosers);
    if (unreachableDepth != null && lineDepth >= unreachableDepth) {
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      continue;
    }
    if (unreachableDepth != null) unreachableDepth = null;
    result.push(line);
    if (/^(?:return(?:\s+.*)?;|throw\s+.*;)$/.test(line.trim())) unreachableDepth = lineDepth;
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  }
  return result;
}

function normalizeSyntheticVariableScopes(lines) {
  const used = new Set();
  const declarations = new Map();
  const declarationCounts = new Map();
  const resourceDeclarationCounts = new Map();
  const forcedForDeclarations = new Map();
  const minimumUseDepth = new Map();
  const lineDepths = [];
  const catchNames = new Set();
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index]);
    const leadingClosers = (line.match(/^\s*}+/) || [''])[0].replace(/[^}]/g, '').length;
    const lineDepth = Math.max(0, depth - leadingClosers);
    lineDepths.push(lineDepth);
    const parsedDeclarations = localDeclarationsFromStatement(line);
    for (const declaration of parsedDeclarations) {
      used.add(declaration.name);
      declarationCounts.set(declaration.name, (declarationCounts.get(declaration.name) || 0) + 1);
      if (declaration.inResource) {
        resourceDeclarationCounts.set(declaration.name, (resourceDeclarationCounts.get(declaration.name) || 0) + 1);
      }
      if (!declarations.has(declaration.name)) {
        declarations.set(declaration.name, { type: declaration.type, depth: lineDepth, index });
      }
      if (declaration.inFor) forcedForDeclarations.set(declaration.name, declaration.type);
    }
    const catchMatch = /catch\s*\([^)]*\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/.exec(line);
    if (catchMatch) catchNames.add(catchMatch[1]);
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  }

  depth = 0;
  for (const raw of lines) {
    const line = String(raw);
    const leadingClosers = (line.match(/^\s*}+/) || [''])[0].replace(/[^}]/g, '').length;
    const lineDepth = Math.max(0, depth - leadingClosers);
    for (const name of used) {
      const escaped = name.replace(/[^A-Za-z0-9_$]/g, '\\$&');
      if (new RegExp('\\b' + escaped + '\\b').test(line)) {
        minimumUseDepth.set(name, Math.min(minimumUseDepth.get(name) ?? Infinity, lineDepth));
      }
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  }


  const lifted = new Map();
  for (const name of used) {
    if (catchNames.has(name)) continue;
    const declaration = declarations.get(name);
    const declaredInFor = declaration && /\bfor\s*\(/.test(String(lines[declaration.index]));
    let scopeEnd = lines.length - 1;
    if (declaration && (declaration.depth > 0 || declaredInFor)) {
      for (let index = declaration.index + 1; index < lines.length; index += 1) {
        const closesDeclaringBlock = declaration.depth > 0 && lineDepths[index] < declaration.depth;
        const closesFor = declaredInFor && lineDepths[index] <= declaration.depth
          && /^\s*}/.test(String(lines[index]));
        if (closesDeclaringBlock || closesFor) {
          scopeEnd = index;
          break;
        }
      }
    }
    const escapedName = name.replace(/[^A-Za-z0-9_$]/g, '\\$&');
    const syntheticLocal = /^var\d+(?:_[A-Za-z0-9_$]+)?$/.test(name);
    const usedAfterDeclaration = declaration && new RegExp(`\\b${escapedName}\\b`)
      .test(lines.slice(declaration.index + 1).join('\n'));
    const usedOutsideScope = declaration && new RegExp(`\\b${escapedName}\\b`)
      .test(lines.slice(scopeEnd + 1).join('\n'));
    const declarationCount = declarationCounts.get(name) || 0;
    const duplicateNeedsLift = declarationCount > 1
      && (resourceDeclarationCounts.get(name) || 0) !== declarationCount;
    if (!declaration || duplicateNeedsLift
      || (minimumUseDepth.get(name) || 0) < declaration.depth
      || (syntheticLocal && (forcedForDeclarations.has(name)
        || (declaration.depth > 0 && usedAfterDeclaration)))
      || ((declaration.depth > 0 || forcedForDeclarations.has(name)) && usedOutsideScope)) {
      let type = declaration && declaration.type;
      if (!type) type = forcedForDeclarations.get(name);
      if (!type) {
        if (/_long$/.test(name)) type = 'long';
        else if (/_float$/.test(name)) type = 'float';
        else if (/_double$/.test(name)) type = 'double';
        else if (/_ref$|_[A-Z]/.test(name)) type = 'Object';
        else type = 'int';
      }
      lifted.set(name, type);
    }
  }
  if (!lifted.size) return lines;

  const rewritten = lines.map((raw) => {
    let line = String(raw);
    if (/catch\s*\(/.test(line)) return line;
    const declarationsOnLine = localDeclarationsFromStatement(line);
    for (const [name] of lifted) {
      const declaration = declarationsOnLine.find((item) => item.name === name);
      if (!declaration) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedType = declaration.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      line = line.replace(new RegExp(`\\b${escapedType}[ \\t]+${escaped}(?=[ \\t]*=)`), name);
    }
    return line;
  });
  const liftedDeclarations = [...lifted].map(([name, type]) => {
    return `${type} ${name} = ${defaultValueForType(type)};`;
  });
  return [...liftedDeclarations, ...rewritten];
}

function refineObjectLocalDeclarations(lines, resolveType) {
  if (typeof resolveType !== 'function') return lines;
  const declaredTypes = new Map();
  for (const raw of lines || []) {
    for (const declaration of localDeclarationsFromStatement(String(raw))) {
      if (!declaration.inCatch) declaredTypes.set(declaration.name, declaration.type);
    }
  }
  const arrayElementTypes = new Map();
  for (const raw of lines || []) {
    let statement;
    try { statement = javaStatementParser.parseStatement(String(raw).trim()); } catch (_error) { continue; }
    const expression = statement && statement.kind === 'ExpressionStatement' ? statement.expression : null;
    const tokens = expression && expression.kind === 'UnsupportedExpression' ? expression.tokens : null;
    if (!tokens || tokens.length < 5 || tokens[0].kind !== 'identifier' || tokens[1].text !== '='
      || tokens[2].kind !== 'identifier' || tokens[3].text !== '[' || tokens[tokens.length - 1].text !== ']') continue;
    const arrayType = declaredTypes.get(tokens[2].text);
    if (arrayType && arrayType.endsWith('[]')) arrayElementTypes.set(tokens[0].text, arrayType.slice(0, -2));
  }
  const refinements = new Map();
  for (const [name, declaredType] of declaredTypes) {
    if (declaredType !== 'Object') continue;
    const refinedType = arrayElementTypes.get(name) || resolveType(name);
    if (refinedType && refinedType !== 'Object') refinements.set(name, refinedType);
  }
  return (lines || []).map((raw) => {
    let line = String(raw);
    for (const [name, refinedType] of refinements) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      line = line.replace(new RegExp(`\\bObject[ \\t]+${escapedName}(?=[ \\t]*[=;,)])`),
        `${refinedType} ${name}`);
      // Retyping a declaration after emission must also bridge assignments
      // that were originally valid Object-to-Object stores. The verifier has
      // already established the concrete reference type at the later use.
      const assignment = new RegExp(`^(\\s*(?:${escapeRegExp(refinedType)}[ \\t]+)?${escapedName}[ \\t]*=[ \\t]*)([^;]+);$`);
      line = line.replace(assignment, (whole, prefix, value) => {
        const trimmed = value.trim();
        if (trimmed === 'null' || trimmed.startsWith(`(${refinedType})`)) return whole;
        return `${prefix}(${refinedType}) (Object) ${trimmed};`;
      });
    }
    return line;
  });
}

function ensureMissingSyntheticDeclarations(lines) {
  const text = lines.join('\n');
  const used = new Set(text.match(/\bvar\d+(?:_[A-Za-z0-9_$]+)?\b/g) || []);
  const missing = [];
  for (const name of used) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (lines.some((line) => localDeclarationsFromStatement(line).some((item) => item.name === name))) continue;
    let type = 'int';
    let value = '0';
    if (/_long$/.test(name)) { type = 'long'; value = '0L'; }
    else if (/_float$/.test(name)) { type = 'float'; value = '0.0f'; }
    else if (/_double$/.test(name)) { type = 'double'; value = '0.0'; }
    else if (/_ref$|_[A-Z]/.test(name)) { type = 'Object'; value = 'null'; }
    missing.push(`${type} ${name} = ${value};`);
  }
  if (missing.length) lines.unshift(...missing);
}

// Demote `Type name = ...` to `name = ...` by deleting the source range the type
// occupies, located with the Java lexer rather than a pattern match. A regex
// rewrite is unsafe here: synthetic names such as `dupTemp$13` contain `$`
// followed by digits, which a replacement string reinterprets as a capture-group
// backreference and splices the captured indentation into the middle of the name.
function stripDeclarationType(source, name, inFor) {
  const line = String(source);
  let tokens;
  try {
    ({ tokens } = tokenizeJava(line));
  } catch (_error) {
    return line;
  }
  if (!Array.isArray(tokens) || !tokens.length) return line;

  let typeStart = 0;
  if (inFor) {
    const forIndex = tokens.findIndex((token) => token.text === 'for');
    if (forIndex < 0) return line;
    const parenIndex = tokens.findIndex((token, index) => index > forIndex && token.text === '(');
    if (parenIndex < 0) return line;
    typeStart = parenIndex + 1;
  }

  const nameIndex = tokens.findIndex((token, index) => index >= typeStart
    && token.kind === 'identifier'
    && token.text === name
    && tokens[index + 1] && tokens[index + 1].text === '=');
  if (nameIndex <= typeStart) return line;

  return line.slice(0, tokens[typeStart].range.startOffset)
    + line.slice(tokens[nameIndex].range.startOffset);
}

function localDeclarationsFromStatement(source) {
  let statement;
  const trimmed = String(source).trim();
  const catchHeader = trimmed.startsWith('}') ? trimmed.slice(1).trim() : trimmed;
  try {
    statement = catchHeader.startsWith('catch (') && catchHeader.endsWith('{')
      ? javaStatementParser.parseStatement(`try {} ${catchHeader} }`)
      : javaStatementParser.parseStatement(trimmed);
  } catch (_error) {
    return [];
  }
  if (statement && statement.kind === 'TryStatement' && catchHeader.startsWith('catch (')) {
    return (statement.catches || []).map((item) => ({
      name: item.parameter.name,
      type: sourceTypeFromAst(item.parameter.parameterType),
      inFor: false,
      inCatch: true,
    }));
  }
  if (statement && statement.kind === 'TryStatement' && Array.isArray(statement.resources)) {
    const resources = [];
    for (const resource of statement.resources) {
      const text = resource && (resource.text || (resource.tokens || []).map((token) => token.text).join(' '));
      if (!text) continue;
      try {
        const declaration = javaStatementParser.parseStatement(`${text};`);
        if (!declaration || declaration.kind !== 'LocalVariableDeclarationStatement') continue;
        const baseType = sourceTypeFromAst(declaration.variableType);
        for (const item of declaration.declarators || []) {
          resources.push({
            name: item.name,
            type: `${baseType}${'[]'.repeat(Number(item.dimensions) || 0)}`,
            inFor: false,
            inCatch: false,
            inResource: true,
          });
        }
      } catch (_error) { /* malformed resources remain visible to the compiler */ }
    }
    return resources;
  }
  let declaration = statement;
  let inFor = false;
  if (statement && statement.kind === 'ForStatement') {
    declaration = statement.initializer;
    inFor = true;
  }
  if (!declaration || declaration.kind !== 'LocalVariableDeclarationStatement') return [];
  const baseType = sourceTypeFromAst(declaration.variableType);
  return (declaration.declarators || []).map((item) => ({
    name: item.name,
    type: `${baseType}${'[]'.repeat(Number(item.dimensions) || 0)}`,
    inFor,
    inCatch: false,
  }));
}

function hoistEscapingLocalDeclarations(lines, localState) {
  const depthBefore = [];
  const depthAfter = [];
  const depthMinimum = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    depthBefore[i] = depth;
    let minimum = depth;
    for (const ch of String(lines[i])) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      minimum = Math.min(minimum, depth);
    }
    depthMinimum[i] = minimum;
    depthAfter[i] = depth;
  }

  const hoisted = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    // A try-with-resources declaration is scoped to the try statement and is
    // required syntactically to remain a declaration. Brace-depth accounting
    // sees the header before the opening brace and can otherwise mistake its
    // body use (or a later resource reusing the same slot name) for an escaping
    // local, producing the illegal `try (name = new Resource())` form.
    if (/^\s*try\s*\(/.test(String(lines[i]))) continue;
    const declarations = localDeclarationsFromStatement(lines[i]);
    if (declarations.length !== 1) continue;
    const declaration = declarations[0];
    if (declaration.inCatch || declaration.inResource) continue;
    const scoped = declaration.inFor || depthBefore[i] > 0;
    if (!scoped) continue;
    const scopeDepth = declaration.inFor ? depthBefore[i] + 1 : depthBefore[i];
    let scopeEnd = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (depthMinimum[j] < scopeDepth) { scopeEnd = j + 1; break; }
    }
    const escaped = declaration.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usedLater = new RegExp(`\\b${escaped}\\b`).test(lines.slice(scopeEnd).join('\n'));
    if (!usedLater) continue;

    const type = localState.sourceTypeForName(declaration.name) || declaration.type;
    hoisted.set(declaration.name, type);
    lines[i] = stripDeclarationType(lines[i], declaration.name, declaration.inFor);
  }
  if (hoisted.size) {
    lines.unshift(...[...hoisted].map(([name, type]) => `${type} ${name} = ${defaultValueForType(type)};`));
  }
}

function rewriteDuplicateLocalDeclarations(lines) {
  const resourceNames = new Set();
  for (const line of lines) {
    for (const declaration of localDeclarationsFromStatement(line)) {
      if (declaration.inResource) resourceNames.add(declaration.name);
    }
  }
  // A state-machine fallback may lift a resource slot to method scope even
  // though the structured try header redeclares it. The lifted null is unused
  // and makes every resource declaration illegal, so remove it.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const declarations = localDeclarationsFromStatement(lines[i]);
    if (declarations.length !== 1 || declarations[0].inFor
      || declarations[0].inCatch || declarations[0].inResource) continue;
    if (resourceNames.has(declarations[0].name) && /^\S/.test(String(lines[i]))) lines.splice(i, 1);
  }

  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const declarations = localDeclarationsFromStatement(lines[i]);
    if (declarations.length !== 1) continue;
    const declaration = declarations[0];
    if (declaration.inCatch || declaration.inResource) continue;
    if (!seen.has(declaration.name)) { seen.add(declaration.name); continue; }
    lines[i] = stripDeclarationType(lines[i], declaration.name, declaration.inFor);
  }
}

function sourceTypeFromAst(type) {
  if (!type) return 'Object';
  if (type.kind === 'PrimitiveType') return type.name;
  if (type.kind === 'ClassType') {
    const enclosing = type.enclosingType ? `${sourceTypeFromAst(type.enclosingType)}.` : '';
    const qualified = type.packageName ? `${type.packageName}.` : '';
    const argumentsSource = (type.typeArguments || []).length
      ? `<${type.typeArguments.map(sourceTypeFromAst).join(', ')}>` : '';
    return `${qualified}${enclosing}${type.name}${argumentsSource}`;
  }
  if (type.kind === 'ArrayType') {
    return `${sourceTypeFromAst(type.componentType)}${'[]'.repeat(Number(type.dimensions) || 1)}`;
  }
  if (type.kind === 'ParameterizedType') {
    return `${sourceTypeFromAst(type.rawType)}<${(type.typeArguments || []).map(sourceTypeFromAst).join(', ')}>`;
  }
  if (type.kind === 'WildcardType') {
    if (!type.bound) return '?';
    return `? ${type.boundKind || 'extends'} ${sourceTypeFromAst(type.bound)}`;
  }
  return type.name || type.text || 'Object';
}

// ---------------------------------------------------------------------------
// Synchronized-block lowering for the owned structurer.
//
// javac compiles `synchronized (E) { body }` as
//     E; dup; astore N; monitorenter
//     body ...  aload N; monitorexit      (before every normal exit)
//     H:  astore M; aload N; monitorexit; aload M; athrow
// with exception rows [body ranges -> H] plus a self-protecting [H -> H].
//
// Recognize each such catch-any handler, replace the monitor plumbing with nops
// on a private copy of the codeItems (the lock store itself stays, so the lock
// variable keeps its name and value), and report {handler_pc -> {lockLocal,
// lockPc}} so the exception structurer emits `synchronized (lock) { ... }` for
// that group instead of a try/catch. Anything that does not match the idiom is
// left untouched: a surviving monitorenter renders as a `// monitorenter`
// comment and the no-fallback gate turns it into a hard panic — a miss is loud,
// never silently-unsynchronized Java.
function lowerSynchronizedRegions(originalItems, exceptionTable) {
  const codeItems = originalItems.slice();
  const syncHandlers = new Map();
  const result = { codeItems, syncHandlers };

  const executablesFrom = (startIndex, count) => {
    const run = [];
    for (let i = startIndex; i >= 0 && i < codeItems.length && run.length < count; i += 1) {
      const instruction = getInstructionFromItem(codeItems[i]);
      if (instruction) run.push({ index: i, op: instruction.op, instruction });
    }
    return run;
  };
  const executablesBefore = (endIndex, count) => {
    const run = []; // nearest-first
    for (let i = endIndex - 1; i >= 0 && run.length < count; i -= 1) {
      const instruction = getInstructionFromItem(codeItems[i]);
      if (instruction) run.push({ index: i, op: instruction.op, instruction });
    }
    return run;
  };
  const indexOfPc = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && getInstructionFromItem(item) && Number.isFinite(Number(item.pc))) {
      indexOfPc.set(Number(item.pc), i);
    }
  }

  const rowsByHandler = new Map();
  for (const row of exceptionTable || []) {
    const catchType = row.catch_type ?? row.catchType;
    if (!(catchType == null || catchType === 0 || catchType === 'any')) continue;
    if (!Number.isFinite(Number(row.handler_pc))) continue;
    const handlerPc = Number(row.handler_pc);
    if (!rowsByHandler.has(handlerPc)) rowsByHandler.set(handlerPc, []);
    rowsByHandler.get(handlerPc).push(row);
  }

  for (const [handlerPc, rows] of rowsByHandler) {
    const handlerIndex = indexOfPc.get(handlerPc);
    if (handlerIndex == null) continue;
    // Handler idiom: astore M; aload N; monitorexit; aload M; athrow.
    const h = executablesFrom(handlerIndex, 5);
    if (h.length < 5) continue;
    const storeM = parseStoreIndex(h[0].op, h[0].instruction.arg);
    const loadN = parseLoadIndex(h[1].op, h[1].instruction.arg);
    const loadM = parseLoadIndex(h[3].op, h[3].instruction.arg);
    if (!storeM || storeM.type !== 'Object' || !loadN || loadN.type !== 'Object') continue;
    if (h[2].op !== 'monitorexit' || !loadM || loadM.index !== storeM.index || h[4].op !== 'athrow') continue;
    const lockLocal = loadN.index;

    // Entry idiom immediately before the earliest protected pc:
    //   dup; astore N; monitorenter        (javac)
    //   astore N; aload N; monitorenter    (alternate compiler form)
    const bodyRows = rows.filter((row) => Number(row.start_pc) !== handlerPc);
    if (!bodyRows.length) continue;
    const startPc = Math.min(...bodyRows.map((row) => Number(row.start_pc)));
    const entryIndex = indexOfPc.get(startPc);
    if (entryIndex == null) continue;
    const pre = executablesBefore(entryIndex, 3); // [monitorenter, astore|aload, dup|astore]
    if (pre.length < 3 || pre[0].op !== 'monitorenter') continue;
    const enterPc = Number(codeItems[pre[0].index].pc);
    const preStore = parseStoreIndex(pre[1].op, pre[1].instruction.arg);
    const preLoad = parseLoadIndex(pre[1].op, pre[1].instruction.arg);
    let entryNops = null;
    if (preStore && preStore.type === 'Object' && preStore.index === lockLocal && pre[2].op === 'dup') {
      entryNops = [pre[0].index, pre[2].index]; // monitorenter + dup
    } else if (preLoad && preLoad.type === 'Object' && preLoad.index === lockLocal) {
      const outerStore = parseStoreIndex(pre[2].op, pre[2].instruction.arg);
      if (outerStore && outerStore.type === 'Object' && outerStore.index === lockLocal) {
        entryNops = [pre[0].index, pre[1].index]; // monitorenter + aload N
      }
    }
    if (!entryNops) continue;

    // Release idiom: every `aload N; monitorexit` pair inside the protected
    // ranges belongs to this group (a pair on another local belongs to a nested
    // group and is left for its own match). Collect all rewrites before
    // committing: a monitorexit in range that is not part of a recognizable pair
    // aborts the whole group, leaving the method to panic loudly.
    //
    // The `monitorexit` becomes a `pop` (not a nop) and its `aload N` is kept.
    // An obfuscator can branch *directly* into a shared `monitorexit`, reusing a
    // lock reference already left on the operand stack instead of re-loading it
    // with `aload N`; the monitorexit pops that leftover. Nop-ing the monitorexit
    // would strip that pop and leave the stack one deep on the jump edge but empty
    // on the fall-through edge — an inconsistent-height join the shape analysis
    // rejects. A `pop` consumes exactly one reference on every incoming edge
    // (the re-loaded `aload N` on the fall-through, the leftover lock on the jump)
    // so all edges stay balanced; `aload N; pop` renders as nothing either way.
    const inBodyRange = (pc) =>
      bodyRows.some((row) => pc >= Number(row.start_pc) && pc < Number(row.end_pc));
    const exitPops = [];
    let matched = true;
    for (let i = 0; i < codeItems.length; i += 1) {
      const instruction = getInstructionFromItem(codeItems[i]);
      if (!instruction || instruction.op !== 'monitorexit') continue;
      const pc = Number(codeItems[i].pc);
      if (!Number.isFinite(pc) || !inBodyRange(pc)) continue;
      const prev = executablesBefore(i, 1)[0];
      const prevLoad = prev && parseLoadIndex(prev.op, prev.instruction.arg);
      if (!prevLoad || prevLoad.type !== 'Object') { matched = false; break; }
      if (prevLoad.index !== lockLocal) continue; // nested group's release
      exitPops.push(i);
    }
    if (!matched) continue;

    const toNop = (index) => {
      codeItems[index] = { ...codeItems[index], instruction: 'nop' };
    };
    const toPop = (index) => {
      codeItems[index] = { ...codeItems[index], instruction: 'pop' };
    };
    for (const index of entryNops) toNop(index);
    for (const index of exitPops) toPop(index);
    toNop(h[1].index); // handler's aload N
    toNop(h[2].index); // handler's monitorexit
    syncHandlers.set(handlerPc, { lockLocal, lockPc: enterPc });
  }

  return result;
}

// A handler that immediately rethrows the caught exception unchanged — bare
// `athrow` (the exception is on the stack at handler entry) or `astore M;
// aload M; athrow` — makes every row targeting it a semantic no-op: catching
// and rethrowing the same throwable changes nothing, not even the stack trace.
// Obfuscators wrap code in exactly such rows, and the wrappers often overlap
// real protected regions without nesting, which defeats structuring. Return
// the table minus those rows (the handler code itself stays; if normal flow
// reaches it, it renders as a plain throw).
//
// "Semantic no-op" only holds while the rethrown exception lands where it
// would have landed anyway. A rethrow row also *shields*: rows are searched in
// table order, so a rethrow row R makes every later row overlapping R's range
// unreachable for the exceptions R catches. The shield is invisible exactly
// when R's handler pc sits inside that later row's own protected range -- then
// the athrow re-dispatches into the very handler that would have caught the
// exception without R. When it does not (e.g. the ThreadDeath-rethrow-before-
// catch-Throwable idiom, where `catch (ThreadDeath t) { throw t; }` exists
// solely to keep ThreadDeath out of the broad Throwable handler), dropping R
// silently reroutes the exception into that broader handler. Keep those rows.
function dropRethrowHandlerRows(codeItems, exceptionTable) {
  const indexOfPc = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && getInstructionFromItem(item) && Number.isFinite(Number(item.pc))) {
      indexOfPc.set(Number(item.pc), i);
    }
  }
  const isRethrowHandler = (handlerPc) => {
    const handlerIndex = indexOfPc.get(Number(handlerPc));
    if (handlerIndex == null) return false;
    const run = [];
    for (let i = handlerIndex; i < codeItems.length && run.length < 3; i += 1) {
      const instruction = getInstructionFromItem(codeItems[i]);
      if (instruction) run.push(instruction);
    }
    if (!run.length) return false;
    if (run[0].op === 'athrow') return true;
    if (run.length < 3) return false;
    const store = parseStoreIndex(run[0].op, run[0].arg);
    const load = parseLoadIndex(run[1].op, run[1].arg);
    return Boolean(store && store.type === 'Object' && load && load.index === store.index
      && run[2].op === 'athrow');
  };
  const rows = exceptionTable || [];
  const typeOf = (row) => {
    const value = row.catch_type ?? row.catchType;
    return value == null || value === 0 || value === 'any' ? null : String(value);
  };
  // Is `ancestor` a proper superclass of `descendant`? `null` means the
  // catch-all `any`, which is a proper widening of every named type. Obfuscated
  // (non-JRE) types resolve to no metadata, so they answer false and keep the
  // pre-existing drop behaviour.
  const isProperSupertype = (ancestor, descendant) => {
    if (!descendant) return false;
    if (!ancestor) return true;
    if (ancestor === descendant) return false;
    // Throwable roots the whole catchable hierarchy, so it widens every other
    // named type. Stating it outright also covers types the JRE metadata index
    // does not carry (java/lang/ThreadDeath among them).
    if (ancestor === 'java/lang/Throwable') return true;
    let current = descendant;
    for (let guard = 0; guard < 64 && current; guard += 1) {
      const info = jreClassInfo(current);
      if (!info || !info.superName) return false;
      current = info.superName;
      if (current === ancestor) return true;
    }
    return false;
  };
  // A rethrow row R shields every later overlapping row from the exceptions R
  // catches. The shield is invisible when R's handler pc sits inside that later
  // row's range (the athrow re-dispatches straight into it), and it is
  // immaterial when the later row catches the same type or narrower -- that is
  // the obfuscator wrapper this function exists to strip. It matters only when
  // the later row is a strictly broader catch that would swallow what R
  // deliberately lets escape, e.g. `catch (ThreadDeath t) { throw t; }` guarding
  // a following `catch (Throwable)`.
  const shieldsABroaderLaterRow = (index) => {
    const row = rows[index];
    const start = Number(row.start_pc);
    const end = Number(row.end_pc);
    const handlerPc = Number(row.handler_pc);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const rowType = typeOf(row);
    if (!rowType) return false; // an `any` rethrow shields nothing broader
    for (let j = index + 1; j < rows.length; j += 1) {
      const later = rows[j];
      const laterStart = Number(later.start_pc);
      const laterEnd = Number(later.end_pc);
      if (!Number.isFinite(laterStart) || !Number.isFinite(laterEnd)) continue;
      if (laterStart >= end || start >= laterEnd) continue; // no overlap
      if (handlerPc >= laterStart && handlerPc < laterEnd) continue; // re-dispatches there anyway
      if (isProperSupertype(typeOf(later), rowType)) return true;
    }
    return false;
  };
  return rows.filter((row, index) => !isRethrowHandler(row.handler_pc)
    || shieldsABroaderLaterRow(index));
}

// Dead-code sweeps replace unreachable instructions with nop but keep the
// exception table intact (nopping preserves every pc/label). A row whose
// protected range now holds only nops can never throw, yet it still seeds a
// phantom handler edge that defeats both the structurer ("try entry is
// outside its own range") and the state-machine stack analysis (the handler's
// exception slot joins a live path with a different stack height). Drop it.
function dropUnthrowableProtectedRows(codeItems, exceptionTable) {
  const rows = exceptionTable || [];
  if (!rows.length) return rows;
  return rows.filter((row) => {
    const start = Number(row.start_pc);
    const end = Number(row.end_pc);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
    for (const item of codeItems) {
      const pc = Number(item && item.pc);
      if (!Number.isFinite(pc) || pc < start || pc >= end) continue;
      const instruction = getInstructionFromItem(item);
      if (instruction && instruction.op !== 'nop') return true;
    }
    return false;
  });
}

function decompileOwnedStructuredControlFlow(code, method, cls, localState, options = {}) {
  const originalItems = code.codeItems || [];
  if (!(code.exceptionTable || []).length && !originalItems.some((item) => {
    const instruction = getInstructionFromItem(item);
    return instruction && (isConditionalBranch(instruction.op) || instruction.op === 'goto' ||
      instruction.op === 'goto_w' || instruction.op === 'tableswitch' || instruction.op === 'lookupswitch');
  })) return null;
  // Region splitting is exclusively an input normalization for our total
  // structurer. CFR/Vineflower-style recognizers see the original bytecode.
  makeNormalControlFlowReducible({
    classes: [{
      className: cls.className,
      items: [{
        type: 'method',
        method: { ...method, attributes: [{ type: 'code', code }] },
      }],
    }],
  });
  let codeItems = code.codeItems || [];
  if (!codeItems.length) return [];
  normalizeLargeIntegerDispatchers(codeItems);

  let exceptionTable = code.exceptionTable || [];
  // Lower javac synchronized regions on a private copy of the codeItems and
  // strip obfuscator catch-and-rethrow wrapper rows. The original codeItems are
  // untouched, so when structuring fails and a later strategy runs, it still
  // sees the monitorenter and panics loudly instead of emitting
  // silently-unsynchronized Java.
  const loweredSync = lowerSynchronizedRegions(codeItems, exceptionTable);
  codeItems = loweredSync.codeItems;
  const syncHandlers = loweredSync.syncHandlers;
  exceptionTable = dropRethrowHandlerRows(codeItems, exceptionTable);
  exceptionTable = dropUnthrowableProtectedRows(codeItems, exceptionTable);
  let structured = structureMethod(codeItems, exceptionTable, { syncHandlers });
  if ((!structured || !structured.ok) && codeItems.length > 1000 && !syncHandlers.size) {
    const normalOnly = structureMethod(codeItems, []);
    if (normalOnly && normalOnly.ok) structured = normalOnly;
  }
  if ((!structured || !structured.ok) && process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
    console.error(`${cls.className}.${method.name}${method.descriptor}: ${structured && structured.reason ? structured.reason : 'structurer returned no result'}`);
  }
  const exceptionBoundaryLabels = [];
  for (const entry of exceptionTable) {
    exceptionBoundaryLabels.push(entry.startLbl, entry.endLbl, entry.handlerLbl);
  }
  const cfg = buildCfgFromCode(codeItems, exceptionBoundaryLabels.filter(Boolean));
  if (!cfg) return [];
  let stateMachineReason = process.env.CFR_JS_FORCE_STATE_MACHINE === '1'
    ? 'forced by CFR_JS_FORCE_STATE_MACHINE'
    : ((!structured || !structured.ok)
      ? (structured && structured.reason ? structured.reason : 'structurer returned no result')
      : null);
  let useStateMachine = stateMachineReason !== null;
  if (useStateMachine && syncHandlers.size) {
    // The state machine would render the lowered (nop'd) monitor plumbing as
    // plain unsynchronized code. Bail out of this strategy instead: the
    // fallbacks see the original monitorenter and panic loudly.
    if (process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
      console.error(`${cls.className}.${method.name}${method.descriptor}: synchronized method failed to structure`);
    }
    return null;
  }
  if (useStateMachine && process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
    console.error(`${cls.className}.${method.name}${method.descriptor}: using CFG state-machine fallback`);
  }

  const handlerEntries = new Map();
  const handlerTypesByPc = new Map();
  for (const entry of exceptionTable) {
    const catchType = entry.catch_type || entry.catchType;
    const sourceType = catchType == null || catchType === 0 || catchType === 'any'
      ? 'Throwable'
      : javaTypeFromInternalName(catchType);
    const handlerKey = Number.isFinite(Number(entry.handler_pc))
      ? `pc:${Number(entry.handler_pc)}`
      : `label:${String(entry.handlerLbl || entry.handlerLabel || '').replace(/:$/, '')}`;
    const previousType = handlerTypesByPc.get(handlerKey);
    handlerTypesByPc.set(handlerKey, previousType
      ? commonExceptionHandlerStackType(previousType, sourceType)
      : sourceType);
  }
  for (const entry of exceptionTable) {
    const label = String(entry.handlerLbl || entry.handlerLabel || '').replace(/:$/, '');
    if (!label) continue;
    const catchType = entry.catch_type || entry.catchType;
    const sourceType = catchType == null || catchType === 0 || catchType === 'any'
      ? 'Throwable'
      : javaTypeFromInternalName(catchType);
    handlerEntries.set(label, commonExceptionSourceType(
      [handlerEntries.get(label), sourceType], options.exceptionModel));
  }
  // Vineflower's ExprProcessor propagates a copied PrimitiveExprsList through
  // every regular CFG edge and seeds catch blocks with one exception value.
  // Do the equivalent shape analysis first, before source rendering mutates the
  // real local-variable state. At joins, stack positions become phi-like
  // synthetic variables instead of borrowing an expression from one predecessor.
  const analysisLocals = localState;
  const entryStacks = new Map([[cfg.entry, []]]);
  const queue = [cfg.entry];
  for (const block of cfg.blocks) {
    if (!handlerEntries.has(block.headLabel)) continue;
    entryStacks.set(block.id, [expr('e', handlerEntries.get(block.headLabel))]);
    if (!queue.includes(block.id)) queue.push(block.id);
  }
  let analysisFailed = false;
  let analysisFailureReason = '';
  for (let steps = 0; queue.length && steps < cfg.blocks.length * 8; steps += 1) {
    const blockId = queue.shift();
    const block = cfg.blocks[blockId];
    const stack = (entryStacks.get(blockId) || []).map((value) => ({ ...value }));
    decompileLinearCodeItems(block.insns.map((index) => codeItems[index]), method, cls, analysisLocals, {
      initialStack: stack,
      mutateStack: true,
      keepTrailingReturn: true,
    });
    if (stack.some((value) => value.code.includes('stack-underflow'))) {
      analysisFailed = true;
      analysisFailureReason = `block ${blockId} produced stack underflow`;
      break;
    }
    for (const successor of cfg.succ[blockId] || []) {
      if (successor == null || handlerEntries.has(cfg.blocks[successor].headLabel)) continue;
      const prior = entryStacks.get(successor);
      if (!prior) {
        entryStacks.set(successor, stack.map((value) => ({ ...value })));
        queue.push(successor);
      } else if (prior.length !== stack.length) {
        analysisFailed = true;
        analysisFailureReason = `edge ${blockId}->${successor} has stack height ${stack.length}, expected ${prior.length}`;
        break;
      } else {
        let changed = false;
        const merged = prior.map((value, index) => {
          const incoming = stack[index];
          const type = mergeStackTypes(value.type, incoming.type);
          if (type !== value.type) changed = true;
          const pendingNew = value.pendingNew && value.pendingNew === incoming.pendingNew
            ? value.pendingNew
            : null;
          if ((value.pendingNew || null) !== pendingNew) changed = true;
          const qualifiedType = value.qualifiedType && value.qualifiedType === incoming.qualifiedType
            ? value.qualifiedType
            : null;
          if ((value.qualifiedType || null) !== qualifiedType) changed = true;
          return expr(value.code, type, value.precedence, {
            ...(pendingNew ? { pendingNew } : {}),
            ...(qualifiedType ? { qualifiedType } : {}),
          });
        });
        if (changed) {
          entryStacks.set(successor, merged);
          queue.push(successor);
        }
      }
    }
    if (analysisFailed) break;
  }
  if (analysisFailed) {
    if (process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
      console.error(`${cls.className}.${method.name}${method.descriptor}: ${analysisFailureReason}`);
    }
    return null;
  }
  localState.resetReferenceFlow();

  const stackInName = (blockId, slot) => `stackIn_${blockId}_${slot}`;
  const stackOutName = (blockId, slot) => `stackOut_${blockId}_${slot}`;
  const structuredCarrierType = [...handlerEntries.values()].every((type) =>
    type === 'RuntimeException' || type === 'java.lang.RuntimeException')
    ? 'RuntimeException' : 'Throwable';
  const declarations = localState.liftAllDeclarations();
  for (const block of cfg.blocks) {
    if (!handlerEntries.has(block.headLabel)) {
      (entryStacks.get(block.id) || []).forEach((value, slot) => {
        requireRenderedTypeImport(options, value.qualifiedType || value.type);
        declarations.push(`${simplifyType(value.type)} ${stackInName(block.id, slot)} = ${defaultValueForType(value.type)};`);
      });
    }
  }

  const cache = new Map();

  const evaluate = (blockId) => {
    if (cache.has(blockId)) return cache.get(blockId);
    const block = cfg.blocks[blockId];
    if (!block) return { lines: [], stack: [], terminator: null };
    const lastIndex = block.insns[block.insns.length - 1];
    const terminator = getInstructionFromItem(codeItems[lastIndex]);
    const op = terminator && terminator.op;
    const consumedByStructurer = op === 'goto' || op === 'goto_w' ||
      op === 'tableswitch' || op === 'lookupswitch' || isConditionalBranch(op);
    const bodyIndexes = consumedByStructurer ? block.insns.slice(0, -1) : block.insns;
    const initialStack = (entryStacks.get(blockId) || []).map((value, slot) => {
      const handlerType = handlerEntries.get(block.headLabel);
      const code = handlerEntries.has(block.headLabel)
        ? (useStateMachine
          ? 'caughtException'
          : (handlerType === structuredCarrierType
            ? 'decompiledCaughtException'
            : `(${simplifyType(handlerType)}) (Object) decompiledCaughtException`))
        : (value.code === 'this' ? 'this' : stackInName(blockId, slot));
      const expressionType = handlerEntries.has(block.headLabel)
        ? (useStateMachine ? 'Throwable' : handlerType)
        : value.type;
      return expr(code, expressionType, 100, {
        ...(value.pendingNew ? { pendingNew: value.pendingNew } : {}),
        ...(value.qualifiedType ? { qualifiedType: value.qualifiedType } : {}),
      });
    });
    const stack = initialStack.slice();
    const lines = decompileLinearCodeItems(bodyIndexes.map((index) => codeItems[index]), method, cls, localState, {
      initialStack: stack,
      mutateStack: true,
      keepTrailingReturn: true,
    });
    const exitStack = stack.slice();
    if (isConditionalBranch(op)) conditionForBranch(terminator, exitStack, false);
    else if (op === 'tableswitch' || op === 'lookupswitch') pop(exitStack);
    if (exitStack.some((value) => value.code.includes('stack-underflow'))) throw new Error('stack dataflow underflow');

    // A terminal block has no outgoing operand stack.  Obfuscated methods can
    // leave dead values beneath a return instruction; materializing those as
    // stack-out assignments would place Java statements after return/throw.
    const hasRegularSuccessor = (cfg.succ[blockId] || []).some((successor) =>
      successor != null && !handlerEntries.has(cfg.blocks[successor].headLabel));
    if (hasRegularSuccessor) exitStack.forEach((value, slot) => {
      requireRenderedTypeImport(options, value.qualifiedType || value.type);
      declarations.push(`${simplifyType(value.type)} ${stackOutName(blockId, slot)} = ${defaultValueForType(value.type)};`);
      const rawStoredValue = renderStoreExpression(value);
      const canonicalSourceType = rawStoredValue && localState.sourceTypeForName(rawStoredValue.code);
      const targetStackType = simplifyType(value.type);
      const primitiveStackTypes = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
      const simpleLocalReference = rawStoredValue
        && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawStoredValue.code)
        && !primitiveStackTypes.has(targetStackType) && targetStackType !== 'Object';
      const typedStoredValue = simpleLocalReference
        ? { ...rawStoredValue, type: 'Object' }
        : (canonicalSourceType ? { ...rawStoredValue, type: canonicalSourceType } : rawStoredValue);
      const rendered = value.pendingNew
        ? expr('null', value.type)
        : coerceExpressionForType(typedStoredValue, value.type);
      lines.push(`${stackOutName(blockId, slot)} = ${rendered.code};`);
    });
    for (const successor of cfg.succ[blockId] || []) {
      if (successor == null || handlerEntries.has(cfg.blocks[successor].headLabel)) continue;
      const target = entryStacks.get(successor) || [];
      target.forEach((value, slot) => {
        const outgoing = expr(stackOutName(blockId, slot), exitStack[slot] ? exitStack[slot].type : 'Object');
        lines.push(`${stackInName(successor, slot)} = ${coerceExpressionForType(outgoing, value.type).code};`);
      });
    }
    const value = { lines, stack, terminator };
    cache.set(blockId, value);
    return value;
  };

  let render = {
    straight(blockId) {
      return evaluate(blockId).lines;
    },
    cond(blockId) {
      const state = evaluate(blockId);
      return conditionForBranch(state.terminator, state.stack.slice(), false).code;
    },
    switchValue(blockId) {
      const state = evaluate(blockId);
      return pop(state.stack.slice()).code;
    },
    syncLock(lockLocal, lockPc) {
      return localState.load(lockLocal, 'Object', lockPc).code;
    },
  };

  // The exception structurer may introduce synthetic blocks (selector sinks and
  // if/else dispatch for multi-exit try/synchronized regions) that carry no
  // bytecode. Their render text comes from `structured.synthetic`; compose it
  // over the expression-reconstruction render so those ids print correctly.
  const syntheticRender = structured && structured.synthetic;
  if (syntheticRender && syntheticRender.size) {
    const base = render;
    render = {
      straight(id) {
        const syn = syntheticRender.get(id);
        return syn && syn.straight ? syn.straight : base.straight(id);
      },
      cond(id) {
        const syn = syntheticRender.get(id);
        return syn && syn.cond ? syn.cond : base.cond(id);
      },
      switchValue: (id) => base.switchValue(id),
      syncLock: (lockLocal, lockPc) => base.syncLock(lockLocal, lockPc),
    };
    for (const name of structured.selectorDecls || []) declarations.push(`int ${name} = 0;`);
  }

  try {
    if (!useStateMachine && structured && structured.tree) {
      normalizeStructuredCatchNodes(structured.tree, cfg, codeItems, options.exceptionModel);
    }
    // Large obfuscated initializers can protect thousands of individual basic
    // blocks with the same wrapper handler. Emitting one Java try/catch per
    // block overflows javac's exception table before it can write the method.
    // Keep the normal CFG state machine, but omit those synthetic wrappers for
    // very large fallbacks. Handler states still need a value for their seeded
    // exception-stack slot even though normal control flow cannot enter them.
    const stateMachineExceptionTable = codeItems.length > 1000
      ? []
      : exceptionTable;
    if (!stateMachineExceptionTable.length && handlerEntries.size) {
      declarations.push('Throwable caughtException = null;');
    }
    if (!useStateMachine && handlerEntries.size) {
      declarations.push(`${structuredCarrierType} decompiledCaughtException = null;`);
    }
    let source = useStateMachine
      ? printCfgStateMachine(cfg, render, evaluate, codeItems, stateMachineExceptionTable, declarations,
        methodReturnType(method))
      : printTree(structured.tree, render);
    const hasInvalidJavaSwitch = (text) => /switch\s*\(\s*null\s*\)/.test(text)
      || /^\s*case\s+(?!-?\d+\s*:|'(?:\\.|[^'])+'\s*:)/m.test(text);
    const hasInvalidJavaFlow = (text) => hasUnreachableStatementAfterTerminal(String(text).split('\n'));
    if (!useStateMachine && (source.includes('unsupported condition') || source.includes('= e;')
      || hasInvalidJavaSwitch(source) || hasInvalidJavaFlow(source))) {
      const normalOnly = codeItems.length > 1000 && !syncHandlers.size ? structureMethod(codeItems, []) : null;
      if (normalOnly && normalOnly.ok) {
        cache.clear();
        source = printTree(normalOnly.tree, render);
      }
      if (source.includes('unsupported condition') || source.includes('= e;')
        || hasInvalidJavaSwitch(source) || hasInvalidJavaFlow(source)) {
        if (syncHandlers.size) {
          // Never route a lowered synchronized method through the state
          // machine — it would emit unsynchronized code. Fall back loudly.
          return null;
        }
        useStateMachine = true;
        stateMachineReason = 'structured output failed Java source-flow validation';
        cache.clear();
        source = printCfgStateMachine(cfg, render, evaluate, codeItems, stateMachineExceptionTable, declarations,
          methodReturnType(method));
      }
    }
    declarations.push(...localState.liftAllDeclarations());
    const lines = source ? source.split('\n') : [];
    if (declarations.length) {
      const uniqueDeclarations = [...new Set(declarations)];
      lines.unshift(...uniqueDeclarations);
    }
    if (lines[lines.length - 1] === 'return;') lines.pop();
    if (useStateMachine && Array.isArray(options.diagnostics)) {
      options.diagnostics.push({
        kind: 'stateMachineFallback',
        className: cls.className,
        methodName: method.name,
        descriptor: method.descriptor,
        reason: stateMachineReason || 'state-machine fallback selected',
      });
    }
    return coalesceDefaultConstructorBody(lines, method);
  } catch (err) {
    // Expression reconstruction can still decline stack-carrying joins. The
    // old recognizers remain a safe fallback while that dataflow grows.
    if (process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
      console.error(`${cls.className}.${method.name}${method.descriptor}: ${err.message}`);
    }
    return null;
  }
}

function commonExceptionHandlerStackType(left, right) {
  if (left === right) return left;
  const internal = (type) => {
    const value = String(type).replace(/\./g, '/');
    return value.includes('/') ? value : `java/lang/${value}`;
  };
  const leftInternal = internal(left);
  const rightInternal = internal(right);
  if (leftInternal === 'java/lang/Throwable' || rightInternal === 'java/lang/Throwable') return 'Throwable';
  const isError = (type) => type === 'java/lang/Error' || /(?:Error)$/.test(type);
  const leftError = isError(leftInternal);
  const rightError = isError(rightInternal);
  if (leftError || rightError) return leftError && rightError ? 'Error' : 'Throwable';
  const leftUnchecked = JDK_UNCHECKED_EXCEPTIONS.has(leftInternal);
  const rightUnchecked = JDK_UNCHECKED_EXCEPTIONS.has(rightInternal);
  return leftUnchecked && rightUnchecked ? 'RuntimeException' : 'Exception';
}

function normalizeStructuredCatchNodes(tree, cfg, codeItems, model) {
  const walk = (node) => {
    if (!node) return;
    if (node.t === 'try') {
      walk(node.body);
      for (const item of node.catches || []) walk(item.body);
      const blocks = new Set();
      collectStructuredBlocks(node.body, blocks);
      const thrownTypes = new Set();
      let hasExplicitThrow = false;
      const allocatedTypes = new Set();
      for (const blockId of blocks) {
        const block = cfg.blocks[blockId];
        if (!block) continue;
        for (const itemIndex of block.insns || []) {
          const instruction = getInstructionFromItem(codeItems[itemIndex]);
          if (!instruction) continue;
          if (instruction.op === 'athrow') hasExplicitThrow = true;
          if (instruction.op === 'new' && typeof instruction.arg === 'string') allocatedTypes.add(instruction.arg);
          if (!INVOKE_OPS.has(instruction.op)) continue;
          let ref;
          try { ref = parseMemberRef(instruction.arg); } catch (_err) { continue; }
          for (const type of resolveMethodThrows(ref.owner, ref.name, ref.descriptor, model) || []) {
            thrownTypes.add(type);
          }
        }
      }
      if (hasExplicitThrow) for (const type of allocatedTypes) thrownTypes.add(type);
      const valid = [];
      const unsupported = [];
      for (const item of node.catches || []) {
        const catchTypes = (item.types || [item.type]).map((type) => type.replace(/\./g, '/'));
        const supported = catchTypes.every((catchType) => {
          const alwaysLegal = catchType === 'java/lang/Throwable' || catchType === 'java/lang/Exception'
            || catchType === 'java/lang/RuntimeException' || catchType === 'java/lang/Error'
            || !isCheckedThrow(catchType, model);
          return alwaysLegal
            || [...thrownTypes].some((type) => isAssignableExceptionType(type, catchType, model));
        });
        (supported ? valid : unsupported).push(item);
      }
      // Catches javac would reject ("exception is never thrown in body of the
      // corresponding try statement") must keep their precise type anyway.
      // Widening them to Exception silently changes behavior — the handler then
      // swallows RuntimeExceptions the original let propagate — and collapsing
      // the group to unsupported[0] discards the remaining handler bodies
      // outright. javac accepts the narrow type because
      // ensureCheckedCatchReachability injects an `if (false) throw (T) null;`
      // reachability anchor into the try body for exactly these types.
      if (!unsupported.length) node.catches = valid;
      return;
    }
    if (node.t === 'seq') for (const child of node.body || []) walk(child);
    else if (node.t === 'block' || node.t === 'loop' || node.t === 'synchronized') walk(node.body);
    else if (node.t === 'if') { walk(node.then); walk(node.els); }
    else if (node.t === 'switch') {
      for (const item of node.cases || []) walk(item.body);
      walk(node.dflt);
    }
  };
  walk(tree);
}

function collectStructuredBlocks(node, blocks) {
  if (!node) return;
  if (node.t === 'straight' || node.t === 'if' || node.t === 'switch') blocks.add(node.block);
  if (node.t === 'seq') for (const child of node.body || []) collectStructuredBlocks(child, blocks);
  else if (node.t === 'block' || node.t === 'loop' || node.t === 'synchronized') collectStructuredBlocks(node.body, blocks);
  else if (node.t === 'if') {
    collectStructuredBlocks(node.then, blocks);
    collectStructuredBlocks(node.els, blocks);
  } else if (node.t === 'switch') {
    for (const item of node.cases || []) collectStructuredBlocks(item.body, blocks);
    collectStructuredBlocks(node.dflt, blocks);
  } else if (node.t === 'try') {
    collectStructuredBlocks(node.body, blocks);
    for (const item of node.catches || []) collectStructuredBlocks(item.body, blocks);
  }
}

function isAssignableExceptionType(thrownType, catchType, model) {
  let current = thrownType;
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (current === catchType) return true;
    seen.add(current);
    current = model && model.superOf ? model.superOf.get(current) : null;
  }
  return false;
}

function printCfgStateMachine(cfg, render, evaluate, codeItems, exceptionTable, declarations, returnType) {
  const blockByPc = new Map();
  for (const block of cfg.blocks) {
    const first = codeItems[block.insns[0]];
    if (first && Number.isFinite(first.pc)) blockByPc.set(first.pc, block.id);
  }

  const handlersForBlock = (block) => {
    const first = codeItems[block.insns[0]];
    const pc = first && first.pc;
    if (!Number.isFinite(pc)) return [];
    const seenTypes = new Set();
    const handlers = [];
    for (const entry of exceptionTable) {
      if (!(pc >= entry.start_pc && pc < entry.end_pc)) continue;
      const target = blockByPc.get(entry.handler_pc);
      if (target == null) continue;
      const catchType = entry.catch_type == null || entry.catch_type === 0 || entry.catch_type === 'any'
        ? 'Throwable'
        : javaTypeFromInternalName(entry.catch_type);
      if (seenTypes.has(catchType)) continue;
      seenTypes.add(catchType);
      handlers.push({ catchType, target });
      if (catchType === 'Throwable') break;
    }
    return handlers;
  };

  // Evaluate every block before declarations are emitted: evaluation discovers
  // stack-out temporaries lazily. Also record each block's handlers and whether
  // its body is empty, so trivial forwarder states can be threaded away.
  const evaluated = new Map();
  for (const block of cfg.blocks) {
    evaluated.set(block.id, { lines: evaluate(block.id).lines, handlers: handlersForBlock(block) });
  }

  // A state that emits no body and just transfers control to a single target is
  // pure dispatch overhead. Thread every reference through it so the switch can
  // drop the state entirely. Skip blocks with handlers: threading past a guarded
  // (even empty) state would change which try/catch a jump lands in.
  const forward = new Map();
  for (const block of cfg.blocks) {
    const info = evaluated.get(block.id);
    const term = cfg.term[block.id];
    if (info.lines.length || info.handlers.length || !term) continue;
    if ((term.kind === 'goto' || term.kind === 'fall') && term.target != null) {
      forward.set(block.id, term.target);
    }
  }
  const resolve = (target) => {
    if (target == null) return target;
    const seen = new Set();
    let current = target;
    while (forward.has(current) && !seen.has(current)) {
      seen.add(current);
      current = forward.get(current);
    }
    return current;
  };

  const dispatch = (blockId) => {
    const term = cfg.term[blockId];
    if (!term || term.kind === 'return') return [];
    if (term.kind === 'goto' || term.kind === 'fall') {
      if (term.target == null) {
        return returnType === 'void'
          ? ['return;']
          : ['throw new IllegalStateException("control fell off non-void method");'];
      }
      return [`statePc = ${resolve(term.target)};`, 'continue stateLoop;'];
    }
    if (term.kind === 'cond') {
      const taken = term.taken == null ? -1 : resolve(term.taken);
      const fall = term.fall == null ? -1 : resolve(term.fall);
      return [
        `if (${render.cond(blockId)}) {`,
        `    statePc = ${taken};`,
        '} else {',
        `    statePc = ${fall};`,
        '}',
        'continue stateLoop;',
      ];
    }
    if (term.kind === 'switch') {
      const lines = [`switch (${render.switchValue(blockId)}) {`];
      for (const item of term.cases) {
        lines.push(`    case ${item.key}: statePc = ${item.target == null ? -1 : resolve(item.target)}; break;`);
      }
      lines.push(`    default: statePc = ${term.default == null ? -1 : resolve(term.default)}; break;`);
      lines.push('}', 'continue stateLoop;');
      return lines;
    }
    return ['throw new IllegalStateException("unsupported CFG terminator");'];
  };

  // Emit only states reachable from the (resolved) entry: threading forwarders
  // away and pruning unreachable states (e.g. dead synthetic rethrow blocks)
  // shrinks the switch enough to keep large methods under javac's 64KB limit.
  const entryState = resolve(cfg.entry);
  const reachable = new Set();
  const worklist = [entryState];
  while (worklist.length) {
    const id = worklist.pop();
    if (id == null || reachable.has(id) || forward.has(id)) continue;
    reachable.add(id);
    const term = cfg.term[id];
    if (!term) continue;
    const targets = [];
    if (term.kind === 'goto' || term.kind === 'fall') targets.push(term.target);
    else if (term.kind === 'cond') targets.push(term.taken, term.fall);
    else if (term.kind === 'switch') { term.cases.forEach((c) => targets.push(c.target)); targets.push(term.default); }
    for (const h of evaluated.get(id).handlers) targets.push(h.target);
    for (const t of targets) worklist.push(resolve(t));
  }

  const renderedBlocks = cfg.blocks
    .filter((block) => reachable.has(block.id))
    .map((block) => {
      const info = evaluated.get(block.id);
      return { block, body: [...info.lines, ...dispatch(block.id)], handlers: info.handlers };
    });
  declarations.push('int statePc = ' + entryState + ';');
  if (renderedBlocks.some((item) => item.handlers.length)) declarations.push('Throwable caughtException = null;');

  const lines = ['stateLoop: while (true) {', '    switch (statePc) {'];
  for (const { block, body, handlers } of renderedBlocks) {
    lines.push(`        case ${block.id}: {`);
    if (handlers.length) lines.push('            try {');
    const bodyIndent = handlers.length ? '                ' : '            ';
    for (const line of body) lines.push(`${bodyIndent}${line}`);
    if (handlers.length) {
      const caught = `stateCaught_${block.id}`;
      lines.push(`            } catch (Throwable ${caught}) {`);
      const dispatchExpression = handlers.slice(0, -1).reduceRight((fallback, handler) =>
        `(${caught} instanceof ${handler.catchType} ? ${resolve(handler.target)} : ${fallback})`,
      String(resolve(handlers[handlers.length - 1].target)));
      lines.push(`                caughtException = ${caught};`);
      lines.push(`                statePc = ${dispatchExpression};`);
      lines.push('                continue stateLoop;');
      lines.push('            }');
    }
    lines.push('        }');
  }
  lines.push('        default: throw new IllegalStateException("invalid CFG state " + statePc);');
  lines.push('    }', '}');
  return lines.join('\n');
}

function mergeStackTypes(left, right) {
  const a = simplifyType(left || 'Object');
  const b = simplifyType(right || 'Object');
  if (a === b) return a;
  if (a === 'Object') return b;
  if (b === 'Object') return a;
  const integral = new Set(['boolean', 'byte', 'char', 'short', 'int']);
  if (integral.has(a) && integral.has(b)) return 'int';
  const numeric = new Set(['byte', 'char', 'short', 'int', 'long', 'float', 'double']);
  if (numeric.has(a) && numeric.has(b)) {
    if (a === 'double' || b === 'double') return 'double';
    if (a === 'float' || b === 'float') return 'float';
    if (a === 'long' || b === 'long') return 'long';
    return 'int';
  }
  return 'Object';
}

function isCategory2(value) {
  return value && (value.type === 'long' || value.type === 'double');
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
      stack.push(expr(INTEGER_CONSTS[op], 'int', 100, { constantValue: Number(INTEGER_CONSTS[op]) }));
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
      stack.push(expr(String(instruction.arg), 'int', 100, { constantValue: Number(instruction.arg) }));
      continue;
    }
    if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') {
      stack.push(constantExpression(instruction.arg, op));
      continue;
    }

    const loadIndex = parseLoadIndex(op, instruction.arg);
    if (loadIndex) {
      stack.push(localState.load(loadIndex.index, loadIndex.type, codeItem.pc));
      continue;
    }

    const storeIndex = parseStoreIndex(op, instruction.arg);
    if (storeIndex) {
      const value = pop(stack);
      // A dup can leave the freshly allocated array live for a field/array
      // store after this local store.  Materialize the shared expression now
      // so every consumer observes the one JVM allocation.
      if (stack.includes(value) && value.newArraySpill && /^new\b/.test(value.code)) {
        materializeNewArraySpill(value, lines, localState);
      }
      const renderedValue = renderStoreExpression(value);
      localState.requireRenderedType(renderedValue.qualifiedType || renderedValue.type);
      lines.push(localState.store(storeIndex.index, storeIndex.type, renderedValue, codeItem.pc));
      continue;
    }

    if (BINARY_OPS.has(op)) {
      let right = pop(stack);
      let left = pop(stack);
      const symbol = BINARY_OPS.get(op);
      if ((op === 'iand' || op === 'ior' || op === 'ixor') && (left.type === 'boolean' || right.type === 'boolean')) {
        left = coerceExpressionForType(left, 'boolean');
        right = coerceExpressionForType(right, 'boolean');
        stack.push(binaryExpr(left, symbol, right, 'boolean'));
        continue;
      }
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
      const variable = localState.load(index, 'int', codeItem.pc).code;
      const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pendingLocal = new RegExp(`(^|[^.$A-Za-z0-9_])${escapedVariable}([^A-Za-z0-9_$]|$)`);
      const snapshots = new Map();
      for (let stackIndex = 0; stackIndex < stack.length; stackIndex += 1) {
        const pending = stack[stackIndex];
        if (!pending || (pending.localIndex !== index && !pendingLocal.test(pending.code))) continue;
        const key = `${pending.type}\0${pending.code}`;
        let snapshot = snapshots.get(key);
        if (!snapshot) {
          const name = localState.nextSyntheticName('incrementValue');
          const rendered = renderStoreExpression(pending);
          lines.push(`${simplifyType(pending.type)} ${name} = ${rendered.code};`);
          snapshot = expr(name, pending.type, 100);
          snapshots.set(key, snapshot);
        }
        stack[stackIndex] = { ...snapshot };
      }
      if (amount === 1) lines.push(`${variable}++;`);
      else if (amount === -1) lines.push(`${variable}--;`);
      else if (amount >= 0) lines.push(`${variable} += ${amount};`);
      else lines.push(`${variable} -= ${Math.abs(amount)};`);
      continue;
    }

    if (op === 'dup') {
      const top = peek(stack);
      // A dynamic-length new-array being filled must be shared (not copied) so
      // that spilling it to a synthetic local at the first aastore propagates
      // to the sibling stores and to the eventual rvalue use.
      if (top.newArraySpill) {
        stack.push(top);
        continue;
      }
      const value = materializeDuplicatedValue(top, lines, localState);
      stack[stack.length - 1] = value;
      stack.push(duplicateStackExpression(value));
      continue;
    }
    if (op === 'dup_x1') {
      const raw1 = pop(stack);
      const value2 = materializeDuplicatedValue(pop(stack), lines, localState);
      const value1 = materializeDuplicatedValue(raw1, lines, localState);
      stack.push(duplicateStackExpression(value1), value2, value1);
      continue;
    }
    if (op === 'dup_x2') {
      const raw1 = pop(stack);
      const raw2 = pop(stack);
      if (isCategory2(raw2)) {
        const value2 = materializeDuplicatedValue(raw2, lines, localState);
        const value1 = materializeDuplicatedValue(raw1, lines, localState);
        stack.push(duplicateStackExpression(value1), value2, value1);
      } else {
        const value3 = materializeDuplicatedValue(pop(stack), lines, localState);
        const value2 = materializeDuplicatedValue(raw2, lines, localState);
        const value1 = materializeDuplicatedValue(raw1, lines, localState);
        stack.push(duplicateStackExpression(value1), value3, value2, value1);
      }
      continue;
    }
    if (op === 'dup2') {
      const raw1 = pop(stack);
      if (isCategory2(raw1)) {
        const value1 = materializeDuplicatedValue(raw1, lines, localState);
        stack.push(value1, duplicateStackExpression(value1));
      } else {
        const value2 = materializeDuplicatedValue(pop(stack), lines, localState);
        const value1 = materializeDuplicatedValue(raw1, lines, localState);
        stack.push(value2, value1, duplicateStackExpression(value2), duplicateStackExpression(value1));
      }
      continue;
    }
    if (op === 'dup2_x1') {
      const raw1 = pop(stack);
      if (isCategory2(raw1)) {
        const value2 = materializeDuplicatedValue(pop(stack), lines, localState);
        const value1 = materializeDuplicatedValue(raw1, lines, localState);
        stack.push(duplicateStackExpression(value1), value2, value1);
      } else {
        const raw2 = pop(stack);
        const value3 = materializeDuplicatedValue(pop(stack), lines, localState);
        const value2 = materializeDuplicatedValue(raw2, lines, localState);
        const value1 = materializeDuplicatedValue(raw1, lines, localState);
        stack.push(duplicateStackExpression(value2), duplicateStackExpression(value1), value3, value2, value1);
      }
      continue;
    }
    if (op === 'dup2_x2') {
      const raw1 = pop(stack);
      if (isCategory2(raw1)) {
        const raw2 = pop(stack);
        if (isCategory2(raw2)) {
          const value2 = materializeDuplicatedValue(raw2, lines, localState);
          const value1 = materializeDuplicatedValue(raw1, lines, localState);
          stack.push(duplicateStackExpression(value1), value2, value1);
        } else {
          const value3 = materializeDuplicatedValue(pop(stack), lines, localState);
          const value2 = materializeDuplicatedValue(raw2, lines, localState);
          const value1 = materializeDuplicatedValue(raw1, lines, localState);
          stack.push(duplicateStackExpression(value1), value3, value2, value1);
        }
      } else {
        const raw2 = pop(stack);
        const raw3 = pop(stack);
        if (isCategory2(raw3)) {
          const value3 = materializeDuplicatedValue(raw3, lines, localState);
          const value2 = materializeDuplicatedValue(raw2, lines, localState);
          const value1 = materializeDuplicatedValue(raw1, lines, localState);
          stack.push(duplicateStackExpression(value2), duplicateStackExpression(value1), value3, value2, value1);
        } else {
          const value4 = materializeDuplicatedValue(pop(stack), lines, localState);
          const value3 = materializeDuplicatedValue(raw3, lines, localState);
          const value2 = materializeDuplicatedValue(raw2, lines, localState);
          const value1 = materializeDuplicatedValue(raw1, lines, localState);
          stack.push(duplicateStackExpression(value2), duplicateStackExpression(value1), value4, value3, value2, value1);
        }
      }
      continue;
    }
    if (op === 'pop') {
      const value = pop(stack);
      const pureReference = value && /^(?:this|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(value.code);
      if (value && value.code && !value.synthetic && !pureReference) {
        const discardedName = localState.nextSyntheticName('discarded');
        lines.push(`${simplifyType(value.type)} ${discardedName} = ${value.code};`);
      }
      continue;
    }
    if (op === 'pop2') {
      const value = pop(stack);
      if (!isCategory2(value)) pop(stack);
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
      const foldable = /^\d+$/.test(length.code);
      stack.push(expr(formatNewArrayExpression(type, length.code), `${type}[]`, 100, {
        arrayLiteral: foldable ? { elementType: type, length: Number(length.code), elements: new Map() } : null,
        // Dynamic-length allocations can't fold into a `T[]{...}` literal, so a
        // dup+aastore fill would render `new T[n][i] = v` (invalid Java). Mark
        // them so the store path can spill the array to a synthetic local.
        newArraySpill: foldable ? undefined : {},
      }));
      continue;
    }
    if (op === 'multianewarray') {
      const multiArray = parseMultiANewArrayInstruction(instruction);
      const dimensions = multiArray.dimensions;
      const args = popArgs(stack, dimensions);
      const arrayType = descriptorToJavaType(multiArray.descriptor);
      const baseType = arrayType.replace(/(?:\[\])+$/g, '');
      const totalDimensions = (arrayType.match(/\[\]/g) || []).length;
      const allocatedSuffix = args.map((arg) => `[${arg.code}]`).join('');
      const unallocatedSuffix = '[]'.repeat(Math.max(0, totalDimensions - dimensions));
      stack.push(expr(`new ${baseType}${allocatedSuffix}${unallocatedSuffix}`, arrayType));
      continue;
    }
    if (op === 'arraylength') {
      const array = pop(stack);
      let rendered = array;
      if (!simplifyType(array.type).endsWith('[]')) {
        if (array.type === 'Object') localState.refineExpressionType(array, 'Object[]');
        // The verifier proves an array here even when a reused source local was
        // inferred as another reference type. Cast through Object when needed.
        const refined = localState.sourceTypeForName(array.code);
        if (!refined || !refined.endsWith('[]')) rendered = coerceExpressionForType(array, 'Object[]');
      }
      stack.push(expr(`${wrap(rendered, 100)}.length`, 'int'));
      continue;
    }

    if (ARRAY_LOAD_TYPES[op]) {
      const index = pop(stack);
      let array = pop(stack);
      const arrayType = op === 'aaload' ? 'Object[]' : `${ARRAY_LOAD_TYPES[op]}[]`;
      const compatibleBooleanArray = op === 'baload' && array.type === 'boolean[]';
      if (array.type === 'Object'
        || (op !== 'aaload' && array.type !== arrayType && !compatibleBooleanArray)) {
        localState.refineExpressionType(array, arrayType);
        const refined = localState.sourceTypeForName(array.code);
        if (refined === arrayType) array = { ...array, type: refined };
        else array = coerceExpressionForType(array, arrayType);
      }
      const elementType = op === 'baload' && array.type === 'boolean[]'
        ? 'boolean'
        : (op === 'aaload' && array.type.endsWith('[]') ? array.type.slice(0, -2) : ARRAY_LOAD_TYPES[op]);
      stack.push(expr(`${renderArrayReceiver(array)}[${index.code}]`, elementType, 100, { arrayElement: true }));
      continue;
    }
    if (ARRAY_STORE_TYPES[op]) {
      let value = pop(stack);
      const index = pop(stack);
      let array = pop(stack);
      const arrayType = op === 'aastore' ? 'Object[]' : `${ARRAY_STORE_TYPES[op]}[]`;
      const compatibleBooleanArray = op === 'bastore' && array.type === 'boolean[]';
      if (array.type === 'Object'
        || (op !== 'aastore' && array.type !== arrayType && !compatibleBooleanArray)) {
        localState.refineExpressionType(array, arrayType);
        const refined = localState.sourceTypeForName(array.code);
        if (refined === arrayType) array = { ...array, type: refined };
        else array = coerceExpressionForType(array, arrayType);
      }
      // A dup_x2 can leave the freshly allocated value below this outer-array
      // store for a following astore.  Materialize it once and mutate the
      // shared expression so both consumers retain JVM reference identity.
      if (stack.includes(value) && value.newArraySpill && /^new\b/.test(value.code)) {
        materializeNewArraySpill(value, lines, localState);
      }
      value = renderStoreExpression(value);
      if (array.arrayLiteral && /^\d+$/.test(index.code)) {
        array.arrayLiteral.elements.set(Number(index.code), value);
      } else {
        if (array.newArraySpill && /^new\b/.test(array.code)) {
          materializeNewArraySpill(array, lines, localState);
        }
        if (value.newArraySpill && /^new\b/.test(value.code)) {
          // A fresh dynamic array may be the value stored into an outer array
          // while a dup_x2-preserved copy remains live for a following astore.
          // Spill the allocation once; shared stack references then retain the
          // required object identity instead of allocating a second array.
          const name = localState.nextSyntheticName();
          lines.push(`${value.type} ${name} = ${value.code};`);
          value.code = name;
          value.newArraySpill = undefined;
        }
        const elementType = op === 'bastore' && array.type === 'boolean[]'
          ? 'boolean'
          : (op === 'aastore' && array.type.endsWith('[]') ? array.type.slice(0, -2) : ARRAY_STORE_TYPES[op]);
        // The stored value may itself be a dup-filled array literal (for
        // example, assigning `new int[]{...}` into an `int[][]` element).
        // Render its recorded stores before consuming it as the outer
        // aastore value; otherwise only `new int[n]` is emitted and every
        // initializer is silently replaced by zero.
        const renderedValue = renderStoreExpression(value);
        lines.push(`${renderArrayReceiver(array)}[${index.code}] = ${coerceExpressionForType(renderedValue, elementType).code};`);
      }
      continue;
    }

    if (op === 'getstatic') {
      const ref = parseMemberRef(instruction.arg);
      stack.push(expr(formatStaticField(ref, localState), descriptorToJavaType(ref.descriptor), 100, {
        qualifiedType: qualifiedReferenceTypeFromDescriptor(ref.descriptor),
      }));
      continue;
    }
    if (op === 'putstatic') {
      const ref = parseMemberRef(instruction.arg);
      const rawValue = pop(stack);
      if (stack.includes(rawValue) && rawValue.newArraySpill && /^new\b/.test(rawValue.code)) {
        materializeNewArraySpill(rawValue, lines, localState);
      }
      const value = coerceExpressionForType(renderStoreExpression(rawValue), descriptorToJavaType(ref.descriptor));
      // A live stack value that reads this same field (e.g. the old value dup_x1'd
      // below the store target in a post-increment `f[x++]=v` idiom) would re-read
      // the *mutated* field after this assignment. Spill such reads to a temp first.
      materializeStackFieldReads(stack, sourceFieldName(ref.owner, ref.name), lines, localState);
      lines.push(`${formatStaticField(ref, localState)} = ${value.code};`);
      continue;
    }
    if (op === 'getfield') {
      const ref = parseMemberRef(instruction.arg);
      const rawOwner = pop(stack);
      const owner = rawOwner.localThis ? rawOwner
        : coerceExpressionForType(rawOwner, javaTypeFromInternalName(ref.owner));
      stack.push(expr(`${wrap(owner, 100)}.${sourceFieldName(ref.owner, ref.name)}`, descriptorToJavaType(ref.descriptor), 100, {
        qualifiedType: qualifiedReferenceTypeFromDescriptor(ref.descriptor),
      }));
      continue;
    }
    if (op === 'putfield') {
      const ref = parseMemberRef(instruction.arg);
      const rawValue = pop(stack);
      if (stack.includes(rawValue) && rawValue.newArraySpill && /^new\b/.test(rawValue.code)) {
        materializeNewArraySpill(rawValue, lines, localState);
      }
      const value = coerceExpressionForType(renderStoreExpression(rawValue), descriptorToJavaType(ref.descriptor));
      const rawOwner = pop(stack);
      const owner = rawOwner.localThis ? rawOwner
        : coerceExpressionForType(rawOwner, javaTypeFromInternalName(ref.owner));
      // Spill any live stack value that reads this field before mutating it, so a
      // post-increment index (`this.r[this.n++] = v`) keeps its pre-increment value.
      materializeStackFieldReads(stack, sourceFieldName(ref.owner, ref.name), lines, localState);
      lines.push(`${wrap(owner, 100)}.${sourceFieldName(ref.owner, ref.name)} = ${value.code};`);
      continue;
    }

    if (op === 'invokevirtual' || op === 'invokeinterface') {
      emitVirtualCall(lines, stack, instruction.arg, localState);
      continue;
    }
    if (op === 'invokestatic') {
      emitStaticCall(lines, stack, instruction.arg, currentInternalClassName, localState);
      continue;
    }
    if (op === 'invokespecial') {
      emitSpecialCall(lines, stack, instruction.arg, method, className, currentInternalClassName, localState);
      continue;
    }
    if (op === 'invokedynamic') {
      emitInvokeDynamic(lines, stack, instruction.arg, cls, localState);
      continue;
    }

    if (op === 'checkcast') {
      const value = pop(stack);
      const foldedSelfCast = value.code === 'this'
        && localState.foldedSelfType
        && instruction.arg === currentInternalClassName;
      const type = javaTypeFromInternalName(foldedSelfCast ? localState.foldedSelfType : instruction.arg);
      // A bare null literal cannot be used as a receiver (`null.m()`), while
      // the bytecode's checkcast supplies exactly the source type needed for
      // overload selection and dereference. Preserve that explicit cast.
      stack.push(foldedSelfCast
        ? expr('this', type, 100)
        : value.code === 'null'
        ? expr(`(${type}) null`, type, 90)
        : coerceExpressionForType(value, type));
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
      const thrown = pop(stack);
      const declaredThrows = methodThrowsTypes(method);
      const broadThrown = ['Object', 'Throwable', 'Exception', 'java.lang.Throwable', 'java.lang.Exception']
        .includes(simplifyType(thrown.type));
      if (broadThrown) {
        options.requiresSneakyThrow = true;
        const owner = simpleClassName(cls.className || 'Class');
        const thrownCode = simplifyType(thrown.type) === 'Object'
          ? `(Throwable) ${wrap(thrown, 90)}`
          : thrown.code;
        lines.push(`throw ${owner}.<RuntimeException>$cfr$sneakyThrow(${thrownCode});`);
        continue;
      }
      const renderedThrown = thrown;
      lines.push(`throw ${renderedThrown.code};`);
      continue;
    }

    if (RETURN_OPS.has(op)) {
      const value = coerceExpressionForType(renderStoreExpression(pop(stack)), methodReturnType(method));
      lines.push(`return ${value.code};`);
      continue;
    }
    if (op === 'return') {
      // Always emit `return;`, even in <init>/<clinit>: a void return inside a
      // loop-exit branch must terminate the method, or the enclosing while(true)
      // spins forever. The redundant trailing return (method fall-off) is
      // stripped by the trailing-return cleanup on each emit path.
      if (methodReturnType(method) === 'void') lines.push('return;');
      else if (method.name !== '<init>' && method.name !== '<clinit>') {
        lines.push('throw new IllegalStateException("void return opcode in non-void method");');
      }
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

function emitVirtualCall(lines, stack, arg, localState) {
  const ref = parseMemberRef(arg);
  const descriptor = parseDescriptor(ref.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const rawReceiver = pop(stack);
  const ownerType = sourceOwnerType(ref.owner, localState);
  const receiver = rawReceiver.code === 'this'
    ? expr('this', ownerType)
    : rawReceiver.code === 'null'
    ? expr(`(${ownerType}) null`, ownerType, 90)
    : /^stackIn_/.test(rawReceiver.code)
    ? expr(`(${ownerType}) (Object) ${rawReceiver.code}`, ownerType, 90)
    : coerceExpressionForType(rawReceiver, ownerType);

  const objectMethods = new Set(['clone', 'equals', 'finalize', 'getClass', 'hashCode', 'notify', 'notifyAll', 'toString', 'wait']);
  if (ref.owner === 'java/lang/Object' && !objectMethods.has(ref.name)) {
    const returnType = simplifyType(descriptor.returnType);
    if (returnType === 'void') lines.push(`/* unresolved invokevirtual Object.${ref.name} */`);
    else stack.push(expr(defaultValueForType(returnType), returnType));
    return;
  }

  if (ref.name === 'getPeer' && descriptor.params.length === 0) {
    stack.push(expr('null', simplifyType(descriptor.returnType)));
    return;
  }

  if (ref.owner === 'java/lang/StringBuilder' && ref.name === 'append' && args.length === 1) {
    stack.push(stringBuilderAppendExpression(receiver, args[0], descriptor.params[0]));
    return;
  }
  if (ref.owner === 'java/lang/StringBuilder' && ref.name === 'toString' && args.length === 0 && receiver.stringBuilderPieces) {
    stack.push(expr(renderStringBuilderConcat(receiver.stringBuilderPieces), 'String', 40));
    return;
  }

  const renderedArgs = formatCallArguments(ref, descriptor, args, localState && localState.exceptionModel);
  const call = `${wrap(receiver, 100)}.${sourceMethodName(ref.name)}(${renderedArgs.join(', ')})`;
  const returnType = simplifyType(descriptor.returnType);
  if (ref.owner === 'java/lang/invoke/MethodHandle'
    && (ref.name === 'invoke' || ref.name === 'invokeExact') && returnType !== 'void') {
    call = `(${returnType}) ${call}`;
  }
  if (returnType === 'void') {
    lines.push(`${call};`);
  } else {
    stack.push(expr(call, returnType));
  }
}

function emitStaticCall(lines, stack, arg, currentInternalClassName, localState) {
  const ref = parseMemberRef(arg);
  const descriptor = parseDescriptor(ref.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const owner = sourceOwnerType(ref.owner, localState);
  const renderedArgs = formatCallArguments(ref, descriptor, args, localState && localState.exceptionModel);
  const call = `${owner}.${sourceMethodName(ref.name)}(${renderedArgs.join(', ')})`;
  const returnType = simplifyType(descriptor.returnType);
  if (returnType === 'void') {
    lines.push(`${call};`);
  } else {
    stack.push(expr(call, returnType));
  }
}

const NUMERIC_PRIMITIVES = new Set(['byte', 'short', 'char', 'int', 'long', 'float', 'double']);

function formatCallArguments(ref, descriptor, args, exceptionModel) {
  const mustPinReferenceOverload = callHasApplicableOverload(ref, descriptor, args, exceptionModel);
  return args.map((arg, index) => {
    if (shouldRenderCharArgument(ref, descriptor, index, arg)) {
      return formatCharLiteral(Number(arg.code));
    }
    const target = (descriptor.params || [])[index];
    const primitiveTargets = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void']);
    if (target && arg.code === 'null' && !primitiveTargets.has(simplifyType(target))) {
      return `(${simplifyType(target)}) null`;
    }
    // A dup-filled array can remain as an arrayLiteral on the operand stack
    // until it is consumed directly by a call. Render that metadata before
    // applying the descriptor-aware coercion.
    const renderedArg = renderStoreExpression(arg);
    const value = coerceExpressionForType(
      renderedArg,
      target || renderedArg.type,
      exceptionModel,
      !mustPinReferenceOverload,
    );
    // Pin the overload: an argument whose rendered type is a *different*
    // numeric primitive than the descriptor's parameter can make javac
    // resolve a more specific overload (e.g. a byte arg to a:(II)I selects
    // an inherited void a(int, byte)). An explicit cast to the descriptor
    // type restores the bytecode's target.
    if (target && NUMERIC_PRIMITIVES.has(target) && NUMERIC_PRIMITIVES.has(value.type) && value.type !== target) {
      return `(${target}) ${wrap(value, 90)}`;
    }
    return value.code;
  });
}

function methodDescriptorsNamed(owner, name, model) {
  const descriptors = [];
  const pending = [owner];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const corpusInfo = model && model.classInfo ? model.classInfo.get(current) : null;
    if (corpusInfo) {
      for (const item of corpusInfo.items || []) {
        const method = item && item.type === 'method' ? item.method : null;
        if (method && method.name === name) descriptors.push(method.descriptor);
      }
      if (corpusInfo.superClassName) pending.push(corpusInfo.superClassName);
      pending.push(...(corpusInfo.interfaces || []));
      continue;
    }

    const jreInfo = jreClassInfo(current);
    if (!jreInfo) continue;
    const candidates = [
      ...(jreInfo.methods.get(name) || []),
      ...(jreInfo.staticMethods.get(name) || []),
    ];
    for (const candidate of candidates) descriptors.push(candidate.descriptor);
    if (jreInfo.superName) pending.push(jreInfo.superName);
    pending.push(...(jreInfo.interfaces || []));
  }
  return descriptors;
}

function isMethodInvocationConvertible(sourceType, targetType, model) {
  const source = simplifyType(sourceType);
  const target = simplifyType(targetType);
  if (source === target) return true;
  const wideningPrimitives = {
    byte: new Set(['short', 'int', 'long', 'float', 'double']),
    short: new Set(['int', 'long', 'float', 'double']),
    char: new Set(['int', 'long', 'float', 'double']),
    int: new Set(['long', 'float', 'double']),
    long: new Set(['float', 'double']),
    float: new Set(['double']),
  };
  if (wideningPrimitives[source]) return wideningPrimitives[source].has(target);
  if (JAVA_PRIMITIVE_TYPES.has(source) || JAVA_PRIMITIVE_TYPES.has(target)) return false;
  return isSourceReferenceTypeAssignable(source, target, model);
}

function callHasApplicableOverload(ref, descriptor, args, model) {
  if (!model || !model.classInfo) return false;
  // Arguments that already need an exact primitive/reference coercion are
  // rendered with the descriptor type.  Only proven widening references are
  // left at their source type and can affect overload selection.
  const renderedTypes = (descriptor.params || []).map((target, index) => {
    const arg = args[index];
    return arg && arg.code !== 'null'
      && isSourceReferenceTypeAssignable(arg.type, target, model)
      ? simplifyType(arg.type)
      : simplifyType(target);
  });
  const descriptors = methodDescriptorsNamed(ref.owner, ref.name, model);
  return descriptors.some((candidateDescriptor) => {
    if (!candidateDescriptor || candidateDescriptor === ref.descriptor) return false;
    const candidate = parseDescriptor(candidateDescriptor);
    if ((candidate.params || []).length !== renderedTypes.length) return false;
    return candidate.params.every((target, index) => {
      const arg = args[index];
      if (arg && arg.code === 'null') return !JAVA_PRIMITIVE_TYPES.has(simplifyType(target));
      return isMethodInvocationConvertible(renderedTypes[index], target, model);
    });
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

function emitSpecialCall(lines, stack, arg, method, currentClassName, currentInternalClassName, localState) {
  const ref = parseMemberRef(arg);
  const descriptor = parseDescriptor(ref.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const renderedArgs = formatCallArguments(ref, descriptor, args, localState && localState.exceptionModel);
  const rawReceiver = pop(stack);
  const ownerTypeForReceiver = javaTypeFromInternalName(ref.owner);
  const receiver = rawReceiver.code === 'this'
    ? rawReceiver
    : (/^stackIn_/.test(rawReceiver.code)
      ? expr(`(${ownerTypeForReceiver}) (Object) ${rawReceiver.code}`, ownerTypeForReceiver, 90)
      : coerceExpressionForType(rawReceiver, ownerTypeForReceiver));

  if (ref.name === '<init>') {
    const ownerType = javaTypeFromInternalName(ref.owner);
    if (method.name === '<init>' && receiver.code === 'this') {
      if (args.length === 0 && ref.owner !== currentInternalClassName) return;
      const target = ref.owner === currentInternalClassName || ownerType === currentClassName ? 'this' : 'super';
      const invocationArgs = renderedArgs.map((rendered, index) => args[index].code.startsWith('stackIn_')
        ? defaultValueForType(simplifyType(descriptor.params[index]))
        : rendered);
      localState.recordConstructorInvocation(target, invocationArgs);
      return;
    }
    if (rawReceiver.pendingNew || receiver.code.startsWith('new ') || /^stackIn_/.test(rawReceiver.code)) {
      const constructed = ref.owner === 'java/lang/StringBuilder'
        ? stringBuilderConstructorExpression(ownerType, args)
        : expr(`new ${ownerType}(${renderedArgs.join(', ')})`, ownerType);
      // Compare via rawReceiver: casts/coercions drop pendingNew metadata, and
      // losing it here silently discards the constructed value (the dup'd twin
      // slot keeps reading its null carrier).
      replacePendingNewOrEmit(lines, stack, rawReceiver, constructed);
      return;
    }
    lines.push(`${wrap(receiver, 100)}.${simpleClassName(ref.owner)}(${renderedArgs.join(', ')});`);
    return;
  }

  const specialReceiver = rawReceiver.code === 'this' && ref.owner !== currentInternalClassName
    ? 'super' : wrap(receiver, 100);
  const call = `${specialReceiver}.${sourceMethodName(ref.name)}(${renderedArgs.join(', ')})`;
  const returnType = simplifyType(descriptor.returnType);
  if (returnType === 'void') lines.push(`${call};`);
  else stack.push(expr(call, returnType));
}

function replacePendingNewOrEmit(lines, stack, receiver, constructed) {
  const last = stack.length ? stack[stack.length - 1] : null;
  if (last && ((last.pendingNew && last.pendingNew === receiver.pendingNew) || last.code === receiver.code)) {
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

function stringBuilderAppendExpression(receiver, value, targetType) {
  // StringBuilder append chains are reconstructed specially so they can later
  // collapse to source-level string concatenation. Do not lose the invoked
  // overload's descriptor while doing so: JVM int-category locals also carry
  // byte/short/char values, but javac selects append(int) unless the emitted
  // expression is narrowed explicitly. That changes visible strings (for
  // example, appending 'L' as the decimal text "76").
  const renderedValue = coerceExpressionForType(value, targetType || value.type);
  const pieces = receiver.stringBuilderPieces ? receiver.stringBuilderPieces.slice() : [];
  pieces.push(renderedValue);
  return expr(`${wrap(receiver, 100)}.append(${renderedValue.code})`, 'StringBuilder', 100, {
    stringBuilderPieces: pieces,
  });
}

function renderStringBuilderConcat(pieces) {
  if (!pieces.length) return '""';
  if (pieces.length === 1) {
    const only = pieces[0];
    return only.type === 'String' ? only.code : `String.valueOf(${only.code})`;
  }
  const isStringPiece = (piece) => piece.type === 'String' || /^"/.test(piece.code);
  // A non-String additive piece must keep its parens: `"x" + a - b` parses as
  // `("x" + a) - b`. String-typed pieces are safe (concat is associative).
  const rendered = pieces.map((piece, index) => wrap(piece, 70, index > 0 && !isStringPiece(piece)));
  // The FIRST binary `+` must be a string concat, or it computes arithmetic /
  // fails to compile (Object + Object): `i + j + "x"` sums i and j.
  if (!isStringPiece(pieces[0]) && !isStringPiece(pieces[1])) rendered.unshift('""');
  return rendered.join(' + ');
}

function emitInvokeDynamic(lines, stack, arg, cls, localState) {
  const descriptor = parseDescriptor(arg.nameAndType.descriptor);
  const args = popArgs(stack, descriptor.params.length);
  const bootstrap = (cls.bootstrapMethods || [])[arg.bootstrap_method_attr_index];
  const bootstrapOwner = bootstrap && bootstrap.method_ref && bootstrap.method_ref.value
    && bootstrap.method_ref.value.reference && bootstrap.method_ref.value.reference.className;
  const recipe = bootstrap && bootstrap.arguments && bootstrap.arguments[0] && bootstrap.arguments[0].value;
  if (typeof recipe === 'string' && recipe.includes('\u0001')) {
    const chunks = recipe.split('\u0001');
    const pieces = [];
    chunks.forEach((chunk, index) => {
      if (chunk) pieces.push(formatStringLiteral(chunk));
      if (index < args.length) pieces.push(wrap(args[index], 70, true));
    });
    stack.push(expr(pieces.length ? pieces.join(' + ') : '""', 'String', 40));
    return;
  }
  const bootstrapHandle = bootstrap && bootstrap.method_ref && bootstrap.method_ref.value;
  const implementation = bootstrap && bootstrap.arguments && bootstrap.arguments[1]
    && bootstrap.arguments[1].type === 'MethodHandle'
    ? bootstrap.arguments[1].value : null;
  if (bootstrapHandle && bootstrapHandle.reference
    && bootstrapHandle.reference.className === 'java/lang/invoke/LambdaMetafactory'
    && implementation && implementation.reference && implementation.reference.nameAndType) {
    const reference = implementation.reference;
    const implementationDescriptor = parseDescriptor(reference.nameAndType.descriptor);
    const samMethodType = bootstrap.arguments[0] && bootstrap.arguments[0].type === 'MethodType'
      ? parseDescriptor(bootstrap.arguments[0].value) : { params: [] };
    const instantiatedMethodType = bootstrap.arguments[2] && bootstrap.arguments[2].type === 'MethodType'
      ? parseDescriptor(bootstrap.arguments[2].value) : samMethodType;
    const lambdaParameterCount = samMethodType.params.length;
    const lambdaParameters = Array.from({ length: lambdaParameterCount }, (_unused, index) => `lambdaParam${index}`);
    const lambdaValues = lambdaParameters.map((name, index) => expr(name,
      simplifyType(samMethodType.params[index] || instantiatedMethodType.params[index] || 'Object')));
    const owner = javaTypeFromInternalName(reference.className);
    const methodName = sourceMethodName(reference.nameAndType.name);
    let invocation;
    if (implementation.kind === 'invokeStatic') {
      const values = [...args, ...lambdaValues];
      const invocationArgs = values.map((value, index) =>
        coerceExpressionForType(value, implementationDescriptor.params[index] || value.type).code);
      invocation = `${owner}.${methodName}(${invocationArgs.join(', ')})`;
    } else if (implementation.kind === 'newInvokeSpecial') {
      const values = [...args, ...lambdaValues];
      const invocationArgs = values.map((value, index) =>
        coerceExpressionForType(value, implementationDescriptor.params[index] || value.type).code);
      invocation = `new ${owner}(${invocationArgs.join(', ')})`;
    } else {
      const hasCapturedReceiver = args.length > 0;
      const receiver = hasCapturedReceiver ? args[0] : lambdaValues.shift();
      const values = [...(hasCapturedReceiver ? args.slice(1) : []), ...lambdaValues];
      const invocationArgs = values.map((value, index) =>
        coerceExpressionForType(value, implementationDescriptor.params[index] || value.type).code);
      const renderedReceiver = coerceExpressionForType(receiver || expr('null', owner), owner);
      invocation = `${wrap(renderedReceiver, 100)}.${methodName}(${invocationArgs.join(', ')})`;
    }
    const parameters = lambdaParameters.length === 1 ? lambdaParameters[0] : `(${lambdaParameters.join(', ')})`;
    const source = `${parameters} -> ${invocation}`;
    const functionalType = simplifyType(descriptor.returnType);
    stack.push(expr(source, functionalType, 20, { lambdaTarget: functionalType }));
    return;
  }
  stack.push(expr(`/* invokedynamic */ ${args.map((a) => a.code).join(', ')}`, simplifyType(descriptor.returnType)));
}

function renderLambdaMetafactoryExpression(bootstrap, capturedArgs, functionalType) {
  const samDescriptorText = bootstrap.arguments && bootstrap.arguments[0]
    && bootstrap.arguments[0].value;
  const implHandle = bootstrap.arguments && bootstrap.arguments[1] && bootstrap.arguments[1].value;
  const instantiatedDescriptor = bootstrap.arguments && bootstrap.arguments[2]
    && bootstrap.arguments[2].value;
  const implRef = implHandle && implHandle.reference;
  if (!implRef || !implRef.nameAndType || typeof samDescriptorText !== 'string'
    || typeof instantiatedDescriptor !== 'string') return null;

  const samDescriptor = parseDescriptor(samDescriptorText);
  const instantiated = parseDescriptor(instantiatedDescriptor);
  const owner = javaTypeFromInternalName(implRef.className);
  const methodName = implRef.nameAndType.name;
  const targetType = simplifyType(functionalType);
  const implDescriptor = parseDescriptor(implRef.nameAndType.descriptor || '()V');
  if (samDescriptor.params.length !== instantiated.params.length) return null;
  const lambdaValues = samDescriptor.params.map((type, index) =>
    expr(`lambdaParam${index}`, simplifyType(type)));
  const lambdaHeader = `(${lambdaValues.map((value) => value.code).join(', ')})`;
  let invocation;

  if (implHandle.kind === 'invokeStatic') {
    const values = [...capturedArgs, ...lambdaValues];
    if (values.length !== implDescriptor.params.length) return null;
    const args = formatCallArguments(implRef, implDescriptor, values, null);
    invocation = `${owner}.${methodName}(${args.join(', ')})`;
  } else if (implHandle.kind === 'invokeVirtual'
    || implHandle.kind === 'invokeInterface'
    || implHandle.kind === 'invokeSpecial') {
    const values = capturedArgs.length
      ? [...capturedArgs]
      : [...lambdaValues];
    const receiverValue = values.shift();
    if (!receiverValue) return null;
    values.push(...(capturedArgs.length ? lambdaValues : []));
    if (values.length !== implDescriptor.params.length) return null;
    const receiver = coerceExpressionForType(receiverValue, owner);
    const args = formatCallArguments(implRef, implDescriptor, values, null);
    invocation = `${wrap(receiver, 100)}.${methodName}(${args.join(', ')})`;
  } else if (implHandle.kind === 'newInvokeSpecial') {
    const values = [...capturedArgs, ...lambdaValues];
    if (values.length !== implDescriptor.params.length) return null;
    const args = formatCallArguments(implRef, implDescriptor, values, null);
    invocation = `new ${owner}(${args.join(', ')})`;
  } else {
    return null;
  }

  return expr(`(${targetType}) (${lambdaHeader} -> ${invocation})`, targetType, 90);
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
  if (lockStack.length !== 1) return null;
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

  const lines = prefixLines.slice();
  lines.push(`synchronized (${lockExpression.code}) {`);
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

function decompileStructuredFinally(code, method, cls, localState) {
  const entries = code.exceptionTable || [];
  if (entries.length !== 1 || entries[0].catch_type !== 'any') return null;
  const entry = entries[0];
  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const startIndex = labelIndex.get(entry.startLbl);
  const endIndex = labelIndex.get(entry.endLbl);
  const handlerIndex = labelIndex.get(entry.handlerLbl);
  if (startIndex === undefined || endIndex === undefined || handlerIndex === undefined) return null;

  const normalFinallyStart = nextNonNopExecutableIndex(codeItems, endIndex);
  if (normalFinallyStart === -1 || normalFinallyStart >= handlerIndex) return null;
  const normalGotoIndex = findNextGoto(codeItems, normalFinallyStart, handlerIndex);
  if (normalGotoIndex === -1) return null;
  const normalGoto = getInstructionAt(codeItems, normalGotoIndex);
  const afterIndex = labelIndex.get(normalGoto.arg);
  if (afterIndex === undefined || afterIndex <= handlerIndex) return null;

  const storeInstruction = getInstructionAt(codeItems, handlerIndex);
  const throwableStore = storeInstruction && parseStoreIndex(storeInstruction.op, storeInstruction.arg);
  if (!throwableStore || throwableStore.type !== 'Object') return null;
  const throwIndex = previousExecutableIndex(codeItems, afterIndex, handlerIndex + 1);
  const throwInstruction = throwIndex === -1 ? null : getInstructionAt(codeItems, throwIndex);
  if (!throwInstruction || throwInstruction.op !== 'athrow') return null;
  const throwLoadIndex = previousExecutableIndex(codeItems, throwIndex, handlerIndex + 1);
  const throwLoad = throwLoadIndex === -1 ? null : getInstructionAt(codeItems, throwLoadIndex);
  const throwableLoad = throwLoad && parseLoadIndex(throwLoad.op, throwLoad.arg);
  if (!throwableLoad || throwableLoad.index !== throwableStore.index) return null;

  const context = { method, cls, localState, labelIndex, exceptionTable: entries };
  const prefix = decompileRange(codeItems, 0, startIndex, context, []);
  const tryBody = decompileRange(codeItems, startIndex, endIndex, context, []);
  const finallyBody = decompileRange(codeItems, normalFinallyStart, normalGotoIndex, context, []);
  const handlerFinallyBody = decompileRange(codeItems, handlerIndex + 1, throwLoadIndex, context, []);
  const afterBody = decompileRange(codeItems, afterIndex, codeItems.length, context, []);
  if (!prefix.ok || !tryBody.ok || !finallyBody.ok || !handlerFinallyBody.ok || !afterBody.ok) return null;
  if (prefix.stack.length || tryBody.stack.length || finallyBody.stack.length || handlerFinallyBody.stack.length || afterBody.stack.length) return null;
  if (!sameArray(finallyBody.lines, handlerFinallyBody.lines)) return null;

  const lines = [...prefix.lines, 'try {'];
  indentLines(tryBody.lines).forEach((line) => lines.push(line));
  lines.push('} finally {');
  indentLines(finallyBody.lines).forEach((line) => lines.push(line));
  lines.push('}');
  afterBody.lines.forEach((line) => lines.push(line));
  if (lines[lines.length - 1] === 'return;') lines.pop();
  return coalesceDefaultConstructorBody(lines, method);
}

function decompileStructuredTryCatchFinally(code, method, cls, localState) {
  const entries = code.exceptionTable || [];
  const typed = entries.filter((entry) => entry.catch_type && entry.catch_type !== 'any');
  if (!typed.length) return null;
  if (!typed.every((entry) => entry.startLbl === typed[0].startLbl && entry.endLbl === typed[0].endLbl)) return null;

  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const startIndex = labelIndex.get(typed[0].startLbl);
  const endIndex = labelIndex.get(typed[0].endLbl);
  if (startIndex === undefined || endIndex === undefined) return null;

  const tryFinallyEntry = entries.find((entry) => entry.catch_type === 'any' && entry.startLbl === typed[0].startLbl && entry.endLbl === typed[0].endLbl);
  if (!tryFinallyEntry) return null;
  const anyHandlerIndex = labelIndex.get(tryFinallyEntry.handlerLbl);
  if (anyHandlerIndex === undefined) return null;

  const normalFinallyStart = nextNonNopExecutableIndex(codeItems, endIndex);
  const firstTypedHandler = Math.min(...typed.map((entry) => labelIndex.get(entry.handlerLbl)).filter((index) => index !== undefined));
  if (normalFinallyStart === -1 || normalFinallyStart >= firstTypedHandler) return null;
  const normalGotoIndex = findNextGoto(codeItems, normalFinallyStart, firstTypedHandler);
  if (normalGotoIndex === -1) return null;
  const normalGoto = getInstructionAt(codeItems, normalGotoIndex);
  const afterIndex = labelIndex.get(normalGoto.arg);
  if (afterIndex === undefined || afterIndex <= anyHandlerIndex) return null;

  const throwableStore = parseStoreIndex(getInstructionAt(codeItems, anyHandlerIndex)?.op, getInstructionAt(codeItems, anyHandlerIndex)?.arg);
  if (!throwableStore || throwableStore.type !== 'Object') return null;
  const throwIndex = previousExecutableIndex(codeItems, afterIndex, anyHandlerIndex + 1);
  const throwInstruction = throwIndex === -1 ? null : getInstructionAt(codeItems, throwIndex);
  if (!throwInstruction || throwInstruction.op !== 'athrow') return null;
  const throwLoadIndex = previousExecutableIndex(codeItems, throwIndex, anyHandlerIndex + 1);
  const throwLoad = throwLoadIndex === -1 ? null : getInstructionAt(codeItems, throwLoadIndex);
  const throwableLoad = throwLoad && parseLoadIndex(throwLoad.op, throwLoad.arg);
  if (!throwableLoad || throwableLoad.index !== throwableStore.index) return null;

  const context = { method, cls, localState, labelIndex, exceptionTable: entries };
  const prefix = decompileRange(codeItems, 0, startIndex, context, []);
  const tryBody = decompileRange(codeItems, startIndex, endIndex, context, []);
  const finallyBody = decompileRange(codeItems, normalFinallyStart, normalGotoIndex, context, []);
  const handlerFinallyBody = decompileRange(codeItems, anyHandlerIndex + 1, throwLoadIndex, context, []);
  if (!prefix.ok || !tryBody.ok || !finallyBody.ok || !handlerFinallyBody.ok) return null;
  if (prefix.stack.length || tryBody.stack.length || finallyBody.stack.length || handlerFinallyBody.stack.length) return null;
  if (!sameArray(finallyBody.lines, handlerFinallyBody.lines)) return null;

  const lines = [...prefix.lines, 'try {'];
  indentLines(tryBody.lines).forEach((line) => lines.push(line));

  for (const entry of typed.sort((a, b) => (labelIndex.get(a.handlerLbl) || 0) - (labelIndex.get(b.handlerLbl) || 0))) {
    const handlerIndex = labelIndex.get(entry.handlerLbl);
    if (handlerIndex === undefined) return null;
    const catchFinallyEntry = entries.find((candidate) => candidate.catch_type === 'any' && candidate.startLbl === entry.handlerLbl);
    const catchEnd = catchFinallyEntry ? labelIndex.get(catchFinallyEntry.endLbl) : nextCatchBoundary(entries, labelIndex, handlerIndex, anyHandlerIndex);
    if (catchEnd === undefined || catchEnd <= handlerIndex) return null;
    const firstHandlerInstruction = getInstructionAt(codeItems, handlerIndex);
    const storeIndex = firstHandlerInstruction && parseStoreIndex(firstHandlerInstruction.op, firstHandlerInstruction.arg);
    if (!storeIndex || storeIndex.type !== 'Object') return null;
    const catchType = javaTypeFromInternalName(entry.catch_type);
    const catchVariable = localCatchName(localState, storeIndex.index, catchType,
      defaultCatchVariableName(entry.catch_type), codeItems[handlerIndex] && codeItems[handlerIndex].pc);
    const catchBody = decompileRange(codeItems, handlerIndex + 1, catchEnd, context, []);
    if (!catchBody.ok || catchBody.stack.length) return null;
    lines.push(`} catch (${catchType} ${catchVariable}) {`);
    indentLines(catchBody.lines).forEach((line) => lines.push(line));
  }

  lines.push('} finally {');
  indentLines(finallyBody.lines).forEach((line) => lines.push(line));
  lines.push('}');

  const afterBody = decompileRange(codeItems, afterIndex, codeItems.length, context, []);
  if (!afterBody.ok || afterBody.stack.length) return null;
  afterBody.lines.forEach((line) => lines.push(line));
  if (lines[lines.length - 1] === 'return;') lines.pop();
  return coalesceDefaultConstructorBody(lines, method);
}

function nextCatchBoundary(entries, labelIndex, handlerIndex, fallbackIndex) {
  return entries
    .map((entry) => labelIndex.get(entry.handlerLbl))
    .filter((index) => index !== undefined && index > handlerIndex)
    .sort((a, b) => a - b)[0] || fallbackIndex;
}

function findNextGoto(codeItems, start, end) {
  for (let i = start; i < end; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (instruction && instruction.op === 'goto') return i;
  }
  return -1;
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
  const frontendCondJumpShape = [
    'iload', 'ifeq', 'iload', 'iload', 'istore', 'iload', 'if_icmpeq',
    'iconst_0', 'goto', 'iconst_1', 'nop', 'goto', 'nop', 'iconst_0',
    'nop', 'ifeq', 'iconst_1', 'goto', 'nop', 'iload', 'ifeq', 'iload',
    'istore', 'iload', 'goto', 'nop', 'iconst_0', 'nop', 'nop', 'ireturn',
  ];
  if (method.descriptor === '(ZZ)Z' && (sameArray(ops, condJumpShape) || sameArray(ops, frontendCondJumpShape))) {
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
    exceptionTable: code.exceptionTable || [],
  };
  const result = decompileRange(codeItems, 0, codeItems.length, context, []);
  if (!result.ok) return null;
  const lines = rewriteEmptyIfElse(rewriteTryWithResources(result.lines));
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

    const synchronizedBlock = tryDecompileSynchronizedAt(codeItems, index, end, context, stack);
    if (synchronizedBlock) {
      lines.push(...synchronizedBlock.lines);
      stack.splice(0, stack.length, ...synchronizedBlock.stack);
      index = synchronizedBlock.next;
      continue;
    }

    const resourceRelease = tryDecompileResourceReleaseAt(codeItems, index, end, context, stack);
    if (resourceRelease) {
      lines.push(...resourceRelease.lines);
      stack.splice(0, stack.length, ...resourceRelease.stack);
      index = resourceRelease.next;
      continue;
    }

    const tryCatch = tryDecompileTryCatchAt(codeItems, index, end, context, stack);
    if (tryCatch) {
      lines.push(...tryCatch.lines);
      stack.splice(0, stack.length, ...tryCatch.stack);
      index = tryCatch.next;
      continue;
    }

    const ifChainSwitch = tryDecompileIfChainSwitchAt(codeItems, index, end, context, stack);
    if (ifChainSwitch) {
      lines.push(...ifChainSwitch.lines);
      stack.splice(0, stack.length, ...ifChainSwitch.stack);
      index = ifChainSwitch.next;
      continue;
    }

    const whileTrue = tryDecompileWhileTrueAt(codeItems, index, end, context, stack);
    if (whileTrue) {
      lines.push(...whileTrue.lines);
      stack.splice(0, stack.length, ...whileTrue.stack);
      index = whileTrue.next;
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

    const guardedLoop = tryDecompileGuardedWhileAt(codeItems, index, end, context, stack);
    if (guardedLoop) {
      lines.push(...guardedLoop.lines);
      stack.splice(0, stack.length, ...guardedLoop.stack);
      index = guardedLoop.next;
      continue;
    }

    const doLoop = tryDecompileDoWhileAt(codeItems, index, end, context, stack);
    if (doLoop) {
      lines.push(...doLoop.lines);
      stack.splice(0, stack.length, ...doLoop.stack);
      index = doLoop.next;
      continue;
    }

    const stackTernary = tryDecompileStackTernaryAt(codeItems, index, end, context, stack);
    if (stackTernary) {
      stack.splice(0, stack.length, ...stackTernary.stack);
      index = stackTernary.next;
      continue;
    }

    const materializedBooleanGuard = tryDecompileMaterializedBooleanGuardAt(codeItems, index, end, context, stack);
    if (materializedBooleanGuard) {
      lines.push(...materializedBooleanGuard.lines);
      stack.splice(0, stack.length, ...materializedBooleanGuard.stack);
      index = materializedBooleanGuard.next;
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
    if (one.some((line) => /^\/\/\s*goto\b/.test(line)) && context.breakTarget !== undefined) {
      const target = instruction.op === 'goto' || instruction.op === 'goto_w' ? context.labelIndex.get(instruction.arg) : undefined;
      if (target === context.breakTarget) {
        lines.push('break;');
        index += 1;
        continue;
      }
    }
    if (one.some((line) => /^\/\/\s*goto\b/.test(line)) && context.continueTarget !== undefined) {
      const target = instruction.op === 'goto' || instruction.op === 'goto_w' ? context.labelIndex.get(instruction.arg) : undefined;
      if (target === context.continueTarget) {
        lines.push('continue;');
        index += 1;
        continue;
      }
    }
    const forwardGoto = trySkipForwardGoto(codeItems, index, end, context);
    if (forwardGoto !== -1) {
      index = forwardGoto;
      continue;
    }
    if (one.some((line) => /^\/\/\s*(if|goto|tableswitch|lookupswitch)\b/.test(line))) {
      if (process.env.CFR_JS_DEBUG_STRUCTURER === '1') {
        console.error(`${context.cls.className}.${context.method.name}${context.method.descriptor}: range structurer stopped at pc ${codeItems[index].pc} (${instruction.op})`);
      }
      return { ok: false, lines };
    }
    lines.push(...one);
    index += 1;
  }
  return { ok: true, lines, stack };
}

// javac.js emits the normal `dup; astore lock; monitorenter ... aload lock;
// monitorexit` shape but, unlike javac, does not add a catch-all release
// handler. Recognize that shape wherever it occurs inside a structured range
// (not only at the method root), so a synchronized block nested in a loop keeps
// both its synchronization semantics and the surrounding control flow.
function tryDecompileSynchronizedAt(codeItems, index, end, context, stack) {
  const monitorIndex = findNextInstruction(codeItems, index, end, 'monitorenter');
  if (monitorIndex === -1) return null;
  const storeIndex = previousExecutableIndex(codeItems, monitorIndex, index);
  const dupIndex = previousExecutableIndex(codeItems, storeIndex, index);
  if (storeIndex === -1 || dupIndex === -1) return null;
  const storeInstruction = getInstructionAt(codeItems, storeIndex);
  const dupInstruction = getInstructionAt(codeItems, dupIndex);
  const lockStore = storeInstruction && parseStoreIndex(storeInstruction.op, storeInstruction.arg);
  if (!lockStore || lockStore.type !== 'Object' || !dupInstruction || dupInstruction.op !== 'dup') return null;

  const lockStack = stack.slice();
  const prefixLines = decompileLinearCodeItems(codeItems.slice(index, dupIndex), context.method, context.cls, context.localState, {
    initialStack: lockStack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  if (prefixLines.length || lockStack.length !== stack.length + 1) return null;
  const lockExpression = lockStack.pop();

  const exit = findMatchingMonitorExit(codeItems, monitorIndex + 1, end, lockStore.index);
  if (!exit) return null;
  const body = decompileRange(codeItems, monitorIndex + 1, exit.loadIndex, context, []);
  if (!body.ok || body.stack.length) return null;

  const lines = [`synchronized (${lockExpression.code}) {`];
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: exit.monitorIndex + 1, stack: lockStack };
}

function trySkipForwardGoto(codeItems, index, end, context) {
  const instruction = getInstructionAt(codeItems, index);
  if (!instruction || (instruction.op !== 'goto' && instruction.op !== 'goto_w')) return -1;
  const target = context.labelIndex.get(instruction.arg);
  if (target === undefined || target <= index || target > end) return -1;
  if (target === index + 1) return target;
  return skippedRangeStartsWithHandler(codeItems, index + 1, target, context) ? target : -1;
}

function skippedRangeStartsWithHandler(codeItems, start, end, context) {
  const first = nextNonNopExecutableIndex(codeItems, start);
  if (first === -1 || first >= end) return true;
  const handlerIndexes = new Set((context.exceptionTable || [])
    .map((entry) => context.labelIndex.get(entry.handlerLbl))
    .filter((handlerIndex) => handlerIndex !== undefined));
  return handlerIndexes.has(first);
}

function tryDecompileResourceReleaseAt(codeItems, index, end, context, stack) {
  if (stack.length) return null;
  const resourceBranchIndex = findNextConditionalBranch(codeItems, index, end);
  if (resourceBranchIndex === -1) return null;
  const resourceBranch = getInstructionAt(codeItems, resourceBranchIndex);
  if (!resourceBranch || resourceBranch.op !== 'if_acmpeq') return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, resourceBranchIndex)) return null;

  const outerExit = context.labelIndex.get(resourceBranch.arg);
  if (outerExit === undefined || outerExit <= resourceBranchIndex || outerExit > end) return null;

  const resourcePrefix = evaluateStackOnlyRange(codeItems, index, resourceBranchIndex, context, []);
  if (!resourcePrefix || resourcePrefix.length !== 2) return null;
  const resource = resourcePrefix[0];
  if (!resource || !resourcePrefix[1] || resourcePrefix[1].code !== 'null') return null;

  const primaryBranchIndex = findNextConditionalBranch(codeItems, resourceBranchIndex + 1, outerExit);
  const primaryBranch = primaryBranchIndex === -1 ? null : getInstructionAt(codeItems, primaryBranchIndex);
  if (!primaryBranch || primaryBranch.op !== 'if_acmpeq') return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, resourceBranchIndex + 1, primaryBranchIndex)) return null;

  const directCloseStart = context.labelIndex.get(primaryBranch.arg);
  if (directCloseStart === undefined || directCloseStart <= primaryBranchIndex || directCloseStart >= outerExit) return null;

  const primaryPrefix = evaluateStackOnlyRange(codeItems, resourceBranchIndex + 1, primaryBranchIndex, context, []);
  if (!primaryPrefix || primaryPrefix.length !== 2 || !primaryPrefix[1] || primaryPrefix[1].code !== 'null') return null;

  const attemptedCloseStart = nextNonNopExecutableIndex(codeItems, primaryBranchIndex + 1);
  if (attemptedCloseStart === -1 || attemptedCloseStart >= directCloseStart) return null;
  const attemptedCloseGoto = findNextGoto(codeItems, attemptedCloseStart, directCloseStart);
  if (attemptedCloseGoto === -1) return null;

  const joinIndex = context.labelIndex.get(getInstructionAt(codeItems, attemptedCloseGoto).arg);
  if (joinIndex === undefined || joinIndex <= attemptedCloseGoto || joinIndex > outerExit) return null;

  const attemptedCloseEnd = previousExecutableIndex(codeItems, attemptedCloseGoto, attemptedCloseStart);
  if (attemptedCloseEnd === -1) return null;
  const handlerEntry = findThrowableHandlerCovering(context.exceptionTable, context.labelIndex, attemptedCloseStart, attemptedCloseEnd);
  if (!handlerEntry) return null;
  const handlerIndex = context.labelIndex.get(handlerEntry.handlerLbl);
  if (handlerIndex === undefined || handlerIndex <= attemptedCloseGoto || handlerIndex >= directCloseStart) return null;
  if (!isSuppressedCloseHandler(codeItems, handlerIndex, directCloseStart, joinIndex, context, primaryPrefix[0].code)) return null;

  const attemptedClose = decompileSideEffectRange(codeItems, attemptedCloseStart, attemptedCloseGoto, context);
  const directClose = decompileSideEffectRange(codeItems, directCloseStart, outerExit, context);
  if (!attemptedClose || !directClose) return null;
  if (!cleanupGraphsEquivalent(attemptedClose, directClose)) return null;

  const closeLines = directClose.lines.length ? directClose.lines : attemptedClose.lines;
  if (!closeLines.length || !closeLines.every((line) => isCloseStatementForResource(line, resource.code))) return null;

  const lines = [`if (${resource.code} != null) {`];
  indentLines(closeLines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: outerExit, stack: [] };
}

function findThrowableHandlerCovering(exceptionTable, labelIndex, startIndex, endIndex) {
  for (const entry of exceptionTable || []) {
    if (entry.catch_type && entry.catch_type !== 'java/lang/Throwable') continue;
    const start = labelIndex.get(entry.startLbl);
    const end = labelIndex.get(entry.endLbl);
    if (start === undefined || end === undefined) continue;
    if (start <= startIndex && end >= endIndex) return entry;
  }
  return null;
}

function isSuppressedCloseHandler(codeItems, handlerIndex, handlerEnd, joinIndex, context, primaryCode) {
  const handlerGoto = findNextGoto(codeItems, handlerIndex, handlerEnd);
  if (handlerGoto === -1) return false;
  const target = context.labelIndex.get(getInstructionAt(codeItems, handlerGoto).arg);
  if (target !== joinIndex) return false;

  const storeIndex = nextNonNopExecutableIndex(codeItems, handlerIndex);
  const store = storeIndex === -1 ? null : getInstructionAt(codeItems, storeIndex);
  const closeFailureStore = store ? parseStoreIndex(store.op, store.arg) : null;
  if (!closeFailureStore || closeFailureStore.type !== 'Object') return false;

  const primaryLoadIndex = nextNonNopExecutableIndex(codeItems, storeIndex + 1);
  const failureLoadIndex = primaryLoadIndex === -1 ? -1 : nextNonNopExecutableIndex(codeItems, primaryLoadIndex + 1);
  const addSuppressedIndex = failureLoadIndex === -1 ? -1 : nextNonNopExecutableIndex(codeItems, failureLoadIndex + 1);
  if (addSuppressedIndex === -1 || addSuppressedIndex >= handlerGoto) return false;
  if (nextNonNopExecutableIndex(codeItems, addSuppressedIndex + 1) !== handlerGoto) return false;

  const stack = [];
  const primaryLines = decompileLinearCodeItems([codeItems[primaryLoadIndex]], context.method, context.cls, context.localState, {
    initialStack: stack,
    mutateStack: true,
    keepTrailingReturn: true,
  });
  if (primaryLines.length || stack.length !== 1 || stack[0].code !== primaryCode) return false;

  const failureLoad = parseLoadIndex(getInstructionAt(codeItems, failureLoadIndex).op, getInstructionAt(codeItems, failureLoadIndex).arg);
  if (!failureLoad || failureLoad.index !== closeFailureStore.index) return false;

  const addSuppressed = getInstructionAt(codeItems, addSuppressedIndex);
  if (!addSuppressed || (addSuppressed.op !== 'invokevirtual' && addSuppressed.op !== 'invokeinterface')) return false;
  const ref = parseMemberRef(addSuppressed.arg);
  return ref.owner === 'java/lang/Throwable'
    && ref.name === 'addSuppressed'
    && ref.descriptor === '(Ljava/lang/Throwable;)V';
}

function decompileSideEffectRange(codeItems, start, end, context) {
  const stack = [];
  const lines = decompileLinearCodeItems(codeItems.slice(start, end), context.method, context.cls, context.localState, {
    initialStack: stack,
    mutateStack: true,
    keepTrailingReturn: true,
  }).filter((line) => !/^\/\/\s*goto\b/.test(line));
  if (stack.length) return null;
  if (lines.some((line) => /^\/\/\s*(if|tableswitch|lookupswitch)\b/.test(line))) return null;
  return { lines };
}

function cleanupGraphsEquivalent(left, right) {
  if (!left || !right || left.lines.length !== right.lines.length) return false;
  for (let i = 0; i < left.lines.length; i += 1) {
    if (canonicalCleanupLine(left.lines[i]) !== canonicalCleanupLine(right.lines[i])) return false;
  }
  return true;
}

function canonicalCleanupLine(line) {
  return String(line).replace(/\bvar\d+\b/g, 'var$');
}

function isCloseStatementForResource(line, resourceCode) {
  const escaped = escapeRegExp(resourceCode);
  return new RegExp(`^${escaped}\\.close\\(\\);$`).test(line);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function rewriteTryWithResources(lines) {
  const out = lines.slice();
  let index = 0;
  while (index < out.length) {
    if (out[index].trim() !== 'try {') {
      index += 1;
      continue;
    }

    const resources = collectPrecedingResourceInitializers(out, index);
    if (!resources.length) {
      index += 1;
      continue;
    }

    const catchIndex = findMatchingCatchLine(out, index);
    if (catchIndex === -1) {
      index += 1;
      continue;
    }

    let rewritten = true;
    for (const resource of resources.slice().reverse()) {
      const removed = removeResourceCloseBlock(out, index, catchIndex, resource.name);
      if (!removed) {
        rewritten = false;
        break;
      }
    }
    if (!rewritten) {
      index += 1;
      continue;
    }

    const declarationStart = resources[0].lineIndex;
    const primaryIndex = declarationStart > 0 && /^Object var\d+ = null;$/.test(out[declarationStart - 1].trim())
      ? declarationStart - 1
      : declarationStart;
    const headerResources = resources.map((resource) => `${resource.type} ${resource.name} = ${resource.initializer}`).join('; ');
    out[index] = `${leadingWhitespace(out[index])}try (${headerResources}) {`;
    out.splice(primaryIndex, index - primaryIndex);
    index = primaryIndex + 1;
  }
  return out;
}

function rewriteEmptyIfElse(lines) {
  const out = lines.slice();
  let changed;
  do {
    changed = false;
    for (let i = 0; i < out.length - 1; i += 1) {
      const ifMatch = /^(\s*)if \((.*)\) \{$/.exec(out[i]);
      if (!ifMatch) continue;
      const elseMatch = new RegExp(`^${escapeRegExp(ifMatch[1])}\\} else \\{$`).exec(out[i + 1]);
      if (!elseMatch) continue;
      const elseEnd = findBlockEndLine(out, i + 1, ifMatch[1]);
      if (elseEnd === -1) continue;
      out[i] = `${ifMatch[1]}if (!(${ifMatch[2]})) {`;
      out.splice(i + 1, 1);
      changed = true;
    }
  } while (changed);
  return out;
}

function findBlockEndLine(lines, start, indent) {
  let depth = 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.endsWith('{')) depth += 1;
    if (trimmed === '}' || trimmed.startsWith('} catch') || trimmed.startsWith('} finally')) depth -= 1;
    if (depth === 0 && lines[i] === `${indent}}`) return i;
  }
  return -1;
}

function collectPrecedingResourceInitializers(lines, tryIndex) {
  const resources = [];
  for (let i = tryIndex - 1; i >= 0; i -= 1) {
    const parsed = parseResourceInitializer(lines[i]);
    if (!parsed) break;
    resources.unshift({ ...parsed, lineIndex: i });
  }
  return resources;
}

function parseResourceInitializer(line) {
  const match = /^\s*(?:(?:Object|[A-Za-z_$][A-Za-z0-9_.$<>\[\]?]*)\s+)?(var\d+)\s*=\s*(new\s+([A-Za-z_$][A-Za-z0-9_.$]*)(?:\([^;]*\)))\s*;\s*$/.exec(line);
  if (!match) return null;
  return {
    name: match[1],
    initializer: match[2],
    type: javaTypeFromInternalName(match[3]),
  };
}

function findMatchingCatchLine(lines, tryIndex) {
  let depth = 0;
  for (let i = tryIndex; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (depth === 1 && (trimmed.startsWith('} catch') || trimmed.startsWith('} finally'))) return i;
    if (trimmed.endsWith('{')) depth += 1;
    if (trimmed === '}' || trimmed.startsWith('} catch') || trimmed.startsWith('} finally')) depth -= 1;
  }
  return -1;
}

function removeResourceCloseBlock(lines, tryIndex, catchIndex, resourceName) {
  for (let i = catchIndex - 3; i > tryIndex; i -= 1) {
    if (lines[i].trim() !== `if (${resourceName} != null) {`) continue;
    if (!lines[i + 1] || lines[i + 1].trim() !== `${resourceName}.close();`) continue;
    if (!lines[i + 2] || lines[i + 2].trim() !== '}') continue;
    lines.splice(i, 3);
    return true;
  }
  return false;
}

function leadingWhitespace(line) {
  const match = /^(\s*)/.exec(line);
  return match ? match[1] : '';
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

function tryDecompileTryCatchAt(codeItems, index, end, context, stack) {
  if (stack.length) return null;
  const startLabel = labelName(codeItems[index]);
  if (!startLabel) return null;

  const entries = (context.exceptionTable || [])
    .filter((entry) => entry.startLbl === startLabel && entry.catch_type && entry.catch_type !== 'any')
    .sort((a, b) => {
      const left = context.labelIndex.get(a.handlerLbl) ?? 0;
      const right = context.labelIndex.get(b.handlerLbl) ?? 0;
      return left - right;
    });
  if (!entries.length) return null;
  if (!entries.every((entry) => entry.endLbl === entries[0].endLbl)) return null;

  const tryEnd = context.labelIndex.get(entries[0].endLbl);
  if (tryEnd === undefined || tryEnd <= index || tryEnd >= end) return null;
  const endGotoIndex = nextNonNopExecutableIndex(codeItems, tryEnd);
  const endInstruction = endGotoIndex === -1 ? null : getInstructionAt(codeItems, endGotoIndex);
  if (!endInstruction || endInstruction.op !== 'goto') return null;
  const afterIndex = context.labelIndex.get(endInstruction.arg);
  if (afterIndex === undefined || afterIndex <= tryEnd || afterIndex > end) return null;

  const handlers = [];
  for (const entry of entries) {
    const handlerIndex = context.labelIndex.get(entry.handlerLbl);
    if (handlerIndex === undefined || handlerIndex <= tryEnd || handlerIndex >= afterIndex) return null;
    handlers.push({ entry, handlerIndex });
  }
  if (handlers[0].handlerIndex <= tryEnd) return null;
  const allHandlerIndexes = (context.exceptionTable || [])
    .map((entry) => context.labelIndex.get(entry.handlerLbl))
    .filter((handlerIndex) => handlerIndex !== undefined && handlerIndex > tryEnd && handlerIndex < afterIndex)
    .sort((a, b) => a - b);

  const tryBody = decompileRange(codeItems, index, tryEnd, context, []);
  if (!tryBody.ok || tryBody.stack.length) return null;

  const lines = ['try {'];
  indentLines(tryBody.lines).forEach((line) => lines.push(line));

  for (let handlerOffset = 0; handlerOffset < handlers.length; handlerOffset += 1) {
    const handler = handlers[handlerOffset];
    const nextHandler = handlers[handlerOffset + 1];
    const nextAnyHandler = allHandlerIndexes.find((handlerIndex) => handlerIndex > handler.handlerIndex);
    const rawHandlerEnd = nextHandler ? nextHandler.handlerIndex : (nextAnyHandler || afterIndex);
    const handlerEnd = stripTrailingGotoTo(codeItems, handler.handlerIndex, rawHandlerEnd, endInstruction.arg);
    if (handlerEnd === -1) return null;

    const catchType = javaTypeFromInternalName(handler.entry.catch_type || 'java/lang/Throwable');
    let catchVariable = defaultCatchVariableName(handler.entry.catch_type);
    let priorCatchBinding = null;
    let bodyStart = handler.handlerIndex;
    const firstHandlerInstruction = getInstructionAt(codeItems, bodyStart);
    const storeIndex = firstHandlerInstruction && parseStoreIndex(firstHandlerInstruction.op, firstHandlerInstruction.arg);
    if (storeIndex && storeIndex.type === 'Object') {
      priorCatchBinding = context.localState.captureBinding(storeIndex.index, catchType);
      catchVariable = localCatchName(context.localState, storeIndex.index, catchType, catchVariable,
        codeItems[bodyStart] && codeItems[bodyStart].pc);
      bodyStart += 1;
    }

    const catchBody = decompileRange(codeItems, bodyStart, handlerEnd, context, []);
    if (priorCatchBinding) context.localState.restoreBinding(priorCatchBinding);
    if (!catchBody.ok || catchBody.stack.length) return null;
    lines.push(`} catch (${catchType} ${catchVariable}) {`);
    indentLines(catchBody.lines).forEach((line) => lines.push(line));
  }

  lines.push('}');
  return { lines, next: afterIndex, stack: [] };
}

function stripTrailingGotoTo(codeItems, start, end, targetLabel) {
  const last = previousExecutableIndex(codeItems, end, start);
  if (last === -1) return end;
  const instruction = getInstructionAt(codeItems, last);
  if (instruction && instruction.op === 'goto' && instruction.arg === targetLabel) return last;
  if (instruction && (instruction.op === 'athrow' || instruction.op === 'return' || RETURN_OPS.has(instruction.op))) return end;
  if (instruction && !isConditionalBranch(instruction.op) && instruction.op !== 'goto_w' && instruction.op !== 'tableswitch' && instruction.op !== 'lookupswitch') return end;
  return -1;
}

function localCatchName(localState, index, catchType, fallbackName, pc = null) {
  const existing = localState.bindCatch(index, catchType, pc, fallbackName);
  return existing;
}

function tryDecompileIfChainSwitchAt(codeItems, index, end, context, stack) {
  if (stack.length) return null;
  const cases = [];
  let selector = null;
  let scan = index;

  while (scan < end) {
    const branchIndex = findNextConditionalBranch(codeItems, scan, end);
    if (branchIndex === -1) return null;
    const branch = getInstructionAt(codeItems, branchIndex);
    if (!branch || branch.op !== 'if_icmpeq') return null;
    if (!conditionPrefixIsExpressionOnly(codeItems, scan, branchIndex)) return null;

    const expressionStack = [];
    const prefixLines = decompileLinearCodeItems(codeItems.slice(scan, branchIndex), context.method, context.cls, context.localState, {
      initialStack: expressionStack,
      mutateStack: true,
      keepTrailingReturn: true,
    });
    if (prefixLines.length || expressionStack.length !== 2) return null;
    const right = expressionStack.pop();
    const left = expressionStack.pop();
    const value = right;
    if (!Number.isInteger(value.constantValue)) return null;
    if (!selector) selector = left;
    if (selector.code !== left.code) return null;
    const targetIndex = context.labelIndex.get(branch.arg);
    if (targetIndex === undefined || targetIndex <= branchIndex || targetIndex > end) return null;
    cases.push({ value, label: branch.arg, start: targetIndex });

    const next = nextNonNopExecutableIndex(codeItems, branchIndex + 1);
    const nextInstruction = next === -1 ? null : getInstructionAt(codeItems, next);
    if (nextInstruction && nextInstruction.op === 'goto') {
      const defaultStart = context.labelIndex.get(nextInstruction.arg);
      if (defaultStart === undefined || defaultStart <= branchIndex || defaultStart > end) return null;
      return buildIfChainSwitch(codeItems, end, context, selector, cases, { label: nextInstruction.arg, start: defaultStart });
    }
    scan = branchIndex + 1;
  }
  return null;
}

function buildIfChainSwitch(codeItems, end, context, selector, cases, defaultCase) {
  if (cases.length < 2) return null;
  const targets = [...cases.map((item) => ({ ...item, isDefault: false })), { ...defaultCase, isDefault: true }]
    .sort((a, b) => a.start - b.start);
  const joinIndex = findCommonCaseJoin(codeItems, targets, end);
  if (joinIndex === -1) return null;

  const bodyByStart = new Map();
  for (let i = 0; i < targets.length; i += 1) {
    const current = targets[i];
    const nextTarget = targets[i + 1];
    const rangeEnd = Math.min(nextTarget ? nextTarget.start : joinIndex, joinIndex);
    const bodyEnd = stripTrailingGotoToIndex(codeItems, current.start, rangeEnd, joinIndex);
    if (bodyEnd === -1) return null;
    const body = decompileRange(codeItems, current.start, bodyEnd, context, []);
    if (!body.ok || body.stack.length) return null;
    bodyByStart.set(current.start, body.lines);
  }

  const lines = [`switch (${selector.code}) {`];
  const emitted = new Set();
  for (const item of cases) {
    lines.push(`    case ${item.value.code}:`);
    if (!emitted.has(item.start)) {
      indentLines(indentLines(bodyByStart.get(item.start) || [])).forEach((line) => lines.push(line));
      lines.push('        break;');
      emitted.add(item.start);
    }
  }
  lines.push('    default:');
  if (!emitted.has(defaultCase.start)) {
    indentLines(indentLines(bodyByStart.get(defaultCase.start) || [])).forEach((line) => lines.push(line));
  }
  lines.push('}');
  return { lines, next: joinIndex, stack: [] };
}

function findCommonCaseJoin(codeItems, targets, end) {
  const joins = new Set();
  for (let i = 0; i < targets.length; i += 1) {
    const current = targets[i];
    const nextTarget = targets[i + 1];
    const searchEnd = nextTarget ? nextTarget.start : end;
    const last = previousExecutableIndex(codeItems, searchEnd, current.start);
    if (last === -1) return -1;
    const instruction = getInstructionAt(codeItems, last);
    if (instruction && instruction.op === 'goto') {
      const joinIndex = contextlessLabelIndex(codeItems, instruction.arg);
      if (joinIndex === -1) return -1;
      joins.add(joinIndex);
    }
  }
  if (joins.size === 1) return Array.from(joins)[0];
  return -1;
}

function contextlessLabelIndex(codeItems, label) {
  const normalized = String(label).replace(/:$/, '');
  for (let i = 0; i < codeItems.length; i += 1) {
    if (labelName(codeItems[i]) === normalized) return i;
  }
  return -1;
}

function stripTrailingGotoToIndex(codeItems, start, end, targetIndex) {
  const last = previousExecutableIndex(codeItems, end, start);
  if (last === -1) return end;
  const instruction = getInstructionAt(codeItems, last);
  if (instruction && instruction.op === 'goto' && contextlessLabelIndex(codeItems, instruction.arg) === targetIndex) return last;
  if (last < targetIndex) return end;
  return -1;
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
  const bodyContext = {
    ...context,
    breakTarget: exitIndex,
    continueTarget: loopContinueTargetIndex(codeItems, branchIndex + 1, backGotoIndex),
  };
  const body = decompileRange(codeItems, branchIndex + 1, backGotoIndex, bodyContext, []);
  if (!body.ok) return null;

  const lines = [`while (${condition.condition.code}) {`];
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: exitIndex, stack: condition.stack };
}

function tryDecompileWhileTrueAt(codeItems, index, end, context, stack) {
  const startLabel = labelName(codeItems[index]);
  if (!startLabel || stack.length) return null;
  const branchIndex = findNextConditionalBranch(codeItems, index, end);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  if (!branch || branch.op !== 'ifeq') return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, branchIndex)) return null;

  const condition = evaluateConditionPrefix(codeItems, index, branchIndex, context, [], false);
  if (!condition || condition.prefixLines.length || condition.condition.code !== '1 == 0') return null;
  const exitIndex = context.labelIndex.get(branch.arg);
  if (exitIndex === undefined || exitIndex <= branchIndex || exitIndex > end) return null;
  const backGotoIndex = previousExecutableIndex(codeItems, exitIndex, branchIndex + 1);
  const backGoto = backGotoIndex === -1 ? null : getInstructionAt(codeItems, backGotoIndex);
  if (!backGoto || backGoto.op !== 'goto' || backGoto.arg !== startLabel) return null;

  const continueTarget = loopContinueTargetIndex(codeItems, branchIndex + 1, backGotoIndex);
  const bodyContext = { ...context, breakTarget: exitIndex, continueTarget };
  const body = decompileRange(codeItems, branchIndex + 1, backGotoIndex, bodyContext, []);
  if (!body.ok || body.stack.length) return null;
  const lines = ['while (true) {'];
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: exitIndex, stack: [] };
}

function loopContinueTargetIndex(codeItems, bodyStart, backGotoIndex) {
  const previous = previousExecutableIndex(codeItems, backGotoIndex, bodyStart);
  if (previous === -1) return backGotoIndex;
  const instruction = getInstructionAt(codeItems, previous);
  if (instruction && instruction.op === 'nop') return previous;

  let updateStart = -1;
  let hasUpdateStore = false;
  for (let i = backGotoIndex - 1; i >= bodyStart; i -= 1) {
    const current = getInstructionAt(codeItems, i);
    if (!current) continue;
    if (parseStoreIndex(current.op, current.arg) || current.op === 'iinc') hasUpdateStore = true;
    if (current.op === 'nop') {
      updateStart = i;
      break;
    }
    if (isConditionalBranch(current.op) || current.op === 'goto' || current.op === 'goto_w' || current.op === 'tableswitch' || current.op === 'lookupswitch' || current.op === 'return' || RETURN_OPS.has(current.op)) {
      break;
    }
  }
  return hasUpdateStore && updateStart !== -1 ? updateStart : backGotoIndex;
}

function tryDecompileGuardedWhileAt(codeItems, index, end, context, stack) {
  const startLabel = labelName(codeItems[index]);
  if (!startLabel || stack.length) return null;
  const branchIndex = findNextConditionalBranch(codeItems, index, end);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  const exitIndex = context.labelIndex.get(branch.arg);
  if (exitIndex === undefined || exitIndex <= branchIndex || exitIndex > end) return null;
  const backGotoIndex = previousExecutableIndex(codeItems, exitIndex, branchIndex + 1);
  const backGoto = backGotoIndex === -1 ? null : getInstructionAt(codeItems, backGotoIndex);
  if (!backGoto || backGoto.op !== 'goto' || backGoto.arg !== startLabel) return null;

  const condition = evaluateConditionPrefix(codeItems, index, branchIndex, context, [], false);
  if (!condition || !condition.prefixLines.length || condition.condition.code.includes('stack-underflow') || condition.stack.length) return null;
  const body = decompileRange(codeItems, branchIndex + 1, backGotoIndex, context, []);
  if (!body.ok || body.stack.length) return null;

  const lines = ['while (true) {'];
  indentLines(condition.prefixLines).forEach((line) => lines.push(line));
  lines.push(`    if (${condition.condition.code}) {`);
  lines.push('        break;');
  lines.push('    }');
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: exitIndex, stack: [] };
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

function tryDecompileStackTernaryAt(codeItems, index, end, context, stack) {
  const branchIndex = findNextConditionalBranch(codeItems, index, end);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  const falseStart = context.labelIndex.get(branch.arg);
  if (falseStart === undefined || falseStart <= branchIndex || falseStart >= end) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, branchIndex)) return null;

  const trueGotoIndex = previousExecutableIndex(codeItems, falseStart, branchIndex + 1);
  const trueGoto = trueGotoIndex === -1 ? null : getInstructionAt(codeItems, trueGotoIndex);
  if (!trueGoto || trueGoto.op !== 'goto') return null;
  const joinIndex = context.labelIndex.get(trueGoto.arg);
  if (joinIndex === undefined || joinIndex <= falseStart) return null;
  let falseEnd = joinIndex;
  let next = joinIndex;
  if (joinIndex > end) {
    // javac flattens nested conditional expressions by sending every inner
    // value arm directly to the enclosing join. During recursive evaluation,
    // the enclosing arm ends on the final goto to that same join, so the join
    // itself is deliberately outside this subrange.
    const boundaryGoto = getInstructionAt(codeItems, end);
    if (!boundaryGoto || boundaryGoto.op !== 'goto' || boundaryGoto.arg !== trueGoto.arg) return null;
    falseEnd = end;
    next = end;
  }

  const condition = evaluateConditionPrefix(codeItems, index, branchIndex, context, stack, true);
  if (!condition || condition.prefixLines.length) return null;

  const trueStack = evaluateStackOnlyRange(codeItems, branchIndex + 1, trueGotoIndex, context, condition.stack);
  if (!trueStack || trueStack.length !== condition.stack.length + 1) return null;

  const falseStack = evaluateStackOnlyRange(codeItems, falseStart, falseEnd, context, condition.stack);
  if (!falseStack || falseStack.length !== condition.stack.length + 1) return null;

  const trueValue = trueStack[trueStack.length - 1];
  const falseValue = falseStack[falseStack.length - 1];
  const nextStack = condition.stack.slice();
  nextStack.push(conditionalExpr(condition.condition, trueValue, falseValue));
  return { next, stack: nextStack };
}

function evaluateStackOnlyRange(codeItems, start, end, context, initialStack) {
  const stack = initialStack.slice();
  let index = start;
  while (index < end) {
    const instruction = getInstructionAt(codeItems, index);
    if (!instruction || instruction.op === 'nop') {
      index += 1;
      continue;
    }

    const stackTernary = tryDecompileStackTernaryAt(codeItems, index, end, context, stack);
    if (stackTernary) {
      stack.splice(0, stack.length, ...stackTernary.stack);
      index = stackTernary.next;
      continue;
    }

    const lines = decompileLinearCodeItems([codeItems[index]], context.method, context.cls, context.localState, {
      initialStack: stack,
      mutateStack: true,
      keepTrailingReturn: true,
    });
    if (lines.length) return null;
    index += 1;
  }
  return stack;
}

function tryDecompileMaterializedBooleanGuardAt(codeItems, index, end, context, stack) {
  const branchIndex = findNextConditionalBranch(codeItems, index, end);
  if (branchIndex === -1) return null;
  const branch = getInstructionAt(codeItems, branchIndex);
  const falseValueIndex = context.labelIndex.get(branch.arg);
  if (falseValueIndex === undefined || falseValueIndex <= branchIndex || falseValueIndex >= end) return null;
  if (!conditionPrefixIsExpressionOnly(codeItems, index, branchIndex)) return null;

  const trueValueIndex = nextExecutableIndex(codeItems, branchIndex + 1);
  if (trueValueIndex === -1 || trueValueIndex >= falseValueIndex) return null;
  const trueValue = booleanConstantValue(getInstructionAt(codeItems, trueValueIndex));
  if (trueValue === null) return null;

  const joinGotoIndex = nextExecutableIndex(codeItems, trueValueIndex + 1);
  const joinGoto = joinGotoIndex === -1 ? null : getInstructionAt(codeItems, joinGotoIndex);
  if (!joinGoto || joinGoto.op !== 'goto') return null;
  const joinIndex = context.labelIndex.get(joinGoto.arg);
  if (joinIndex === undefined || joinIndex <= falseValueIndex || joinIndex >= end) return null;

  const falseValue = booleanConstantValue(getInstructionAt(codeItems, falseValueIndex));
  if (falseValue === null) return null;
  const afterFalseValueIndex = nextExecutableIndex(codeItems, falseValueIndex + 1);
  if (afterFalseValueIndex !== joinIndex) return null;

  const guardIndex = nextNonNopExecutableIndex(codeItems, joinIndex);
  const guard = guardIndex === -1 ? null : getInstructionAt(codeItems, guardIndex);
  if (!guard || (guard.op !== 'ifeq' && guard.op !== 'ifne')) return null;
  const exitIndex = context.labelIndex.get(guard.arg);
  if (exitIndex === undefined || exitIndex <= guardIndex || exitIndex > end) return null;

  const condition = evaluateConditionPrefix(codeItems, index, branchIndex, context, stack, true);
  if (!condition || condition.prefixLines.length) return null;

  const bodyWhenTrueValue = guard.op === 'ifeq' ? trueValue !== false : trueValue === false;
  const bodyWhenFalseValue = guard.op === 'ifeq' ? falseValue !== false : falseValue === false;
  let bodyCondition = null;
  if (bodyWhenTrueValue && !bodyWhenFalseValue) {
    bodyCondition = condition.condition;
  } else if (!bodyWhenTrueValue && bodyWhenFalseValue) {
    bodyCondition = negateBooleanExpression(condition.condition);
  } else {
    return null;
  }

  const body = decompileRange(codeItems, guardIndex + 1, exitIndex, context, []);
  if (!body.ok) return null;

  const lines = [`if (${bodyCondition.code}) {`];
  indentLines(body.lines).forEach((line) => lines.push(line));
  lines.push('}');
  return { lines, next: exitIndex, stack: condition.stack };
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
  if (condition.condition.code === 'true') {
    return { lines: thenBody.lines, next, stack: condition.stack };
  }
  if (condition.condition.code === 'false' && elseStart === -1) {
    return { lines: [], next, stack: condition.stack };
  }
  const lines = [`if (${condition.condition.code}) {`];
  indentLines(thenBody.lines).forEach((line) => lines.push(line));
  if (elseStart !== -1) {
    const elseBody = decompileRange(codeItems, elseStart, elseEnd, context, []);
    if (!elseBody.ok) return null;
    if (condition.condition.code === 'false') {
      return { lines: elseBody.lines, next, stack: condition.stack };
    }
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

const CONDITION_EXPRESSION_OPS = new Set([
  ...Object.keys(INTEGER_CONSTS), ...Object.keys(LONG_CONSTS), ...Object.keys(FLOAT_CONSTS), ...Object.keys(DOUBLE_CONSTS),
  'nop', 'aconst_null', 'bipush', 'sipush', 'ldc', 'ldc_w', 'ldc2_w', 'dup', 'pop', 'pop2', 'swap',
  ...BINARY_OPS.keys(), ...NEGATE_OPS, ...Object.keys(CONVERSION_OPS), ...COMPARE_OPS,
  'getstatic', 'getfield', 'arraylength', 'checkcast', 'instanceof',
  'invokevirtual', 'invokeinterface', 'invokestatic',
  ...Object.keys(ARRAY_LOAD_TYPES),
]);
const conditionExpressionPrefixCache = new WeakMap();

function conditionPrefixIsExpressionOnly(codeItems, start, end) {
  let disallowedPrefix = conditionExpressionPrefixCache.get(codeItems);
  if (!disallowedPrefix) {
    disallowedPrefix = new Uint32Array(codeItems.length + 1);
    for (let i = 0; i < codeItems.length; i += 1) {
      const instruction = getInstructionAt(codeItems, i);
      const allowed = !instruction
        || parseLoadIndex(instruction.op, instruction.arg)
        || CONDITION_EXPRESSION_OPS.has(instruction.op);
      disallowedPrefix[i + 1] = disallowedPrefix[i] + (allowed ? 0 : 1);
    }
    conditionExpressionPrefixCache.set(codeItems, disallowedPrefix);
  }
  return disallowedPrefix[end] === disallowedPrefix[start];
}

function conditionForBranch(branch, stack, invert) {
  const op = branch.op;
  const intCompareOps = {
    if_icmpeq: '==', if_icmpne: '!=', if_icmplt: '<', if_icmpge: '>=', if_icmpgt: '>', if_icmple: '<=',
    if_acmpeq: '==', if_acmpne: '!=',
  };
  if (intCompareOps[op]) {
    let right = pop(stack);
    let left = pop(stack);
    const operator = invert ? invertOperator(intCompareOps[op]) : intCompareOps[op];
    const complementedComparison = simplifyBitwiseComplementComparison(left, operator, right);
    if (complementedComparison) return complementedComparison;
    const literalComparison = evaluateLiteralIntegerComparison(left, operator, right);
    if (literalComparison !== null) return expr(String(literalComparison), 'boolean', 100);
    if ((op === 'if_acmpeq' || op === 'if_acmpne') && left.code !== 'null' && right.code !== 'null'
      && simplifyType(left.type) !== simplifyType(right.type)) {
      left = coerceExpressionForType(left, 'Object');
      right = coerceExpressionForType(right, 'Object');
    }
    // The JVM compares references at runtime, but javac folds identical String
    // constant expressions in source (and can consequently reject following
    // bytecode as unreachable). Preserve runtime comparison semantics in the
    // expression IR by widening one operand before source rendering.
    if ((op === 'if_acmpeq' || op === 'if_acmpne')
      && left.constantKind === 'String' && right.constantKind === 'String'
      && left.code === right.code) {
      left = expr(`(Object) ${wrap(left, 90)}`, 'Object', 90);
    }
    if ((operator === '<' || operator === '<=' || operator === '>' || operator === '>=')
      && (left.type === 'boolean' || right.type === 'boolean')) {
      // JVM verifier int-category values can carry a descriptor-Z value into
      // an integer relational comparison. Java source cannot compare boolean
      // to an int, so materialize the boolean operand as its JVM 0/1 value.
      if (left.type === 'boolean') left = coerceExpressionForType(left, 'int');
      if (right.type === 'boolean') right = coerceExpressionForType(right, 'int');
    }
    if ((operator === '==' || operator === '!=') && (left.type === 'boolean') !== (right.type === 'boolean')) {
      // Mixed boolean/int comparison. Coercing the int side to boolean
      // (`l == (r != 0)`) is unsound when r can be outside {0, 1}; the
      // boolean side is guaranteed 0/1, so coerce THAT side to int instead.
      const bool = left.type === 'boolean' ? left : right;
      const other = left.type === 'boolean' ? right : left;
      if (other.code === '0' || other.code === '1') {
        const truthy = (other.code === '1') === (operator === '==');
        return truthy ? expr(bool.code, 'boolean', bool.precedence) : negateBooleanExpression(bool);
      }
      const intBool = coerceExpressionForType(bool, 'int');
      const newLeft = left.type === 'boolean' ? intBool : left;
      const newRight = left.type === 'boolean' ? right : intBool;
      return expr(`${wrap(newLeft, 60)} ${operator} ${wrap(newRight, 60, true)}`, 'boolean', 60);
    }
    return expr(`${wrap(left, 60)} ${operator} ${wrap(right, 60, true)}`, 'boolean', 60);
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
      const complementedComparison = simplifyBitwiseComplementComparison(
        value.compare.left,
        operator,
        value.compare.right,
      );
      if (complementedComparison) return complementedComparison;
      return expr(`${wrap(value.compare.left, 60)} ${operator} ${wrap(value.compare.right, 60)}`, 'boolean', 60);
    }
    if (isBooleanExpression(value) && (op === 'ifeq' || op === 'ifne')) {
      const isTruthy = operator === '!=';
      return isTruthy ? expr(value.code, 'boolean', value.precedence) : negateBooleanExpression(value);
    }
    const materializedBoolean = simplifyMaterializedBooleanCondition(value, operator);
    if (materializedBoolean) return materializedBoolean;
    const complementedComparison = simplifyBitwiseComplementComparison(
      value,
      operator,
      expr('0', 'int', 100, { constantValue: 0 }),
    );
    if (complementedComparison) return complementedComparison;
    return expr(`${wrap(value, 60)} ${operator} 0`, 'boolean', 60);
  }

  return expr(`/* unsupported condition ${op} */`, 'boolean');
}

function evaluateLiteralIntegerComparison(left, operator, right) {
  const leftValue = integerLiteralValue(left);
  const rightValue = integerLiteralValue(right);
  if (leftValue === null || rightValue === null) return null;
  if (operator === '==') return leftValue === rightValue;
  if (operator === '!=') return leftValue !== rightValue;
  if (operator === '<') return leftValue < rightValue;
  if (operator === '<=') return leftValue <= rightValue;
  if (operator === '>') return leftValue > rightValue;
  if (operator === '>=') return leftValue >= rightValue;
  return null;
}

function integerLiteralValue(value) {
  if (!value || !['byte', 'char', 'short', 'int'].includes(simplifyType(value.type))) return null;
  if (Number.isInteger(value.constantValue)) return value.constantValue | 0;
  const source = String(value.code || '').trim();
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(source)) return null;
  const parsed = Number(source);
  return Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : null;
}

function simplifyMaterializedBooleanCondition(value, operator) {
  if (!value || !value.code || (operator !== '==' && operator !== '!=')) return null;
  const nested = simplifyNestedMaterializedBooleanCondition(value, operator);
  if (nested) return nested;
  const match = /^(?:\(([^?]+)\)|([^?]+)) \? ([01]) : ([01])$/.exec(value.code);
  if (!match) return null;
  const conditionCode = match[1] || match[2];
  const trueValue = match[3] === '1';
  const falseValue = match[4] === '1';
  if (trueValue === falseValue) return null;
  const comparisonTruthy = operator === '!=';
  const conditionMeansTrue = trueValue === comparisonTruthy;
  const condition = expr(conditionCode, 'boolean', 20);
  return conditionMeansTrue ? condition : negateBooleanExpression(condition);
}

function simplifyNestedMaterializedBooleanCondition(value, operator) {
  const match = /^(.+?) \? ([01]) : (.+?) \? ([01]) : ([01])$/.exec(value.code);
  if (!match) return null;
  const firstCondition = expr(match[1], 'boolean', 20);
  const firstValue = materializedIntMeansConditionTrue(match[2], operator);
  const secondCondition = expr(match[3], 'boolean', 20);
  const secondValue = materializedIntMeansConditionTrue(match[4], operator);
  const finalValue = materializedIntMeansConditionTrue(match[5], operator);

  if (firstValue && !secondValue && finalValue) {
    return expr(`${wrap(firstCondition, 30)} || ${negateBooleanExpression(secondCondition).code}`, 'boolean', 30);
  }
  if (!firstValue && secondValue && !finalValue) {
    return expr(`${negateBooleanExpression(firstCondition).code} && ${wrap(secondCondition, 40)}`, 'boolean', 40);
  }
  return null;
}

function materializedIntMeansConditionTrue(value, operator) {
  const truthy = value === '1';
  return operator === '!=' ? truthy : !truthy;
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

function nextNonNopExecutableIndex(codeItems, fromInclusive) {
  for (let i = fromInclusive; i < codeItems.length; i += 1) {
    const instruction = getInstructionAt(codeItems, i);
    if (instruction && instruction.op !== 'nop') return i;
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
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value.code)) return expr(`!${value.code}`, 'boolean', 90);
  const comparison = /^(.+) (==|!=|<|<=|>|>=) (.+)$/.exec(value.code);
  if (comparison) return expr(`${comparison[1]} ${invertOperator(comparison[2])} ${comparison[3]}`, 'boolean', 60);
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

  const endGotoIndex = nextNonNopExecutableIndex(codeItems, endIndex);
  const endInstruction = endGotoIndex === -1 ? null : getInstructionAt(codeItems, endGotoIndex);
  const afterIndex = endInstruction && endInstruction.op === 'goto'
    ? labelIndex.get(endInstruction.arg)
    : endIndex;
  if (afterIndex === undefined || afterIndex < handlerIndex) return null;

  const handlerEnd = endInstruction && endInstruction.op === 'goto'
    ? stripTrailingGotoTo(codeItems, handlerIndex, afterIndex, endInstruction.arg)
    : afterIndex;
  if (handlerEnd === -1) return null;

  let handlerItems = codeItems.slice(handlerIndex, handlerEnd);
  let catchVariable = defaultCatchVariableName(entry.catch_type);
  let priorCatchBinding = null;
  const firstHandlerInstruction = normalizeInstruction(handlerItems[0] && handlerItems[0].instruction);
  const storeIndex = firstHandlerInstruction && parseStoreIndex(firstHandlerInstruction.op, firstHandlerInstruction.arg);
  if (storeIndex && storeIndex.type === 'Object') {
    priorCatchBinding = localState.captureBinding(storeIndex.index, javaTypeFromInternalName(entry.catch_type));
    catchVariable = localState.bindCatch(storeIndex.index, javaTypeFromInternalName(entry.catch_type),
      handlerItems[0] && handlerItems[0].pc, catchVariable);
    handlerItems = handlerItems.slice(1);
  }

  const tryBody = decompileLinearCodeItems(codeItems.slice(startIndex, endIndex), method, cls, localState);
  const catchBody = decompileLinearCodeItems(handlerItems, method, cls, localState);
  if (priorCatchBinding) localState.restoreBinding(priorCatchBinding);
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

function decompileStructuredSequentialTryCatches(code, method, cls, localState) {
  const entries = code.exceptionTable || [];
  if (entries.length < 2 || entries.some((entry) => !entry.catch_type || entry.catch_type === 'any')) return null;
  const codeItems = code.codeItems || [];
  const labelIndex = buildLabelIndex(codeItems);
  const regions = entries.map((entry) => ({
    entry,
    start: labelIndex.get(entry.startLbl),
    end: labelIndex.get(entry.endLbl),
    handler: labelIndex.get(entry.handlerLbl),
  }));
  if (regions.some((region) => region.start === undefined || region.end === undefined || region.handler === undefined)) return null;
  regions.sort((left, right) => left.start - right.start || left.end - right.end);

  for (const region of regions) {
    const gotoIndex = nextNonNopExecutableIndex(codeItems, region.end);
    const gotoInstruction = gotoIndex < 0 ? null : getInstructionAt(codeItems, gotoIndex);
    if (!gotoInstruction || (gotoInstruction.op !== 'goto' && gotoInstruction.op !== 'goto_w')) return null;
    region.after = labelIndex.get(gotoInstruction.arg);
    if (region.after === undefined || region.handler <= gotoIndex || region.handler >= region.after) return null;
  }
  for (let index = 1; index < regions.length; index += 1) {
    if (regions[index].start < regions[index - 1].after) return null;
  }

  const context = { method, cls, localState, labelIndex, exceptionTable: entries };
  const prefix = decompileRange(codeItems, 0, regions[0].start, context, []);
  if (!prefix.ok || prefix.stack.length) return null;
  const lines = prefix.lines.slice();

  for (const region of regions) {
    const tryBody = decompileRange(codeItems, region.start, region.end, context, []);
    if (!tryBody.ok || tryBody.stack.length) return null;
    const firstHandlerInstruction = getInstructionAt(codeItems, region.handler);
    const store = firstHandlerInstruction && parseStoreIndex(firstHandlerInstruction.op, firstHandlerInstruction.arg);
    if (!store || store.type !== 'Object') return null;
    const catchType = javaTypeFromInternalName(region.entry.catch_type);
    const priorBinding = localState.captureBinding(store.index, catchType);
    const catchVariable = localState.bindCatch(store.index, catchType,
      codeItems[region.handler] && codeItems[region.handler].pc,
      defaultCatchVariableName(region.entry.catch_type));
    const catchBody = decompileRange(codeItems, region.handler + 1, region.after, context, []);
    localState.restoreBinding(priorBinding);
    if (!catchBody.ok || catchBody.stack.length) return null;

    lines.push('try {');
    indentLines(tryBody.lines).forEach((line) => lines.push(line));
    lines.push(`} catch (${catchType} ${catchVariable}) {`);
    indentLines(catchBody.lines).forEach((line) => lines.push(line));
    lines.push('}');
  }

  const after = decompileRange(codeItems, regions[regions.length - 1].after, codeItems.length, context, []);
  if (!after.ok || after.stack.length) return null;
  after.lines.forEach((line) => lines.push(line));
  if (lines[lines.length - 1] === 'return;') lines.pop();
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

// Reaching-definitions for object locals over the bytecode CFG: for every
// aload, which astores can supply its value at runtime. Exception edges are
// approximated conservatively (a handler sees the OUT state of every block
// overlapping its protected range). Used to decide whether per-type local
// splitting is sound for a slot.
function computeObjectSlotReachability(code) {
  const codeItems = code && code.codeItems ? code.codeItems : [];
  const cfg = buildCfgFromCode(codeItems, []);
  if (!cfg) return null;
  const labels = buildLabelIndex(codeItems);
  const blockOfItem = new Map();
  cfg.blocks.forEach((block) => block.insns.forEach((itemIndex) => blockOfItem.set(itemIndex, block.id)));

  const accessesByBlock = cfg.blocks.map((block) => {
    const accesses = [];
    for (const itemIndex of block.insns) {
      const item = codeItems[itemIndex];
      const instruction = getInstructionFromItem(item);
      if (!instruction || !Number.isFinite(Number(item.pc))) continue;
      const store = parseStoreIndex(instruction.op, instruction.arg);
      if (store && store.type === 'Object') {
        accesses.push({ kind: 'store', slot: store.index, pc: Number(item.pc) });
        continue;
      }
      const load = parseLoadIndex(instruction.op, instruction.arg);
      if (load && load.type === 'Object') accesses.push({ kind: 'load', slot: load.index, pc: Number(item.pc) });
    }
    return accesses;
  });

  const edges = cfg.blocks.map((block, id) => new Set((cfg.succ[id] || []).filter((s) => s != null)));
  for (const entry of code.exceptionTable || []) {
    const handlerLabel = String(entry.handlerLbl || entry.handlerLabel || '').replace(/:$/, '');
    const handlerIndex = labels.get(handlerLabel);
    const handlerBlock = handlerIndex === undefined ? null : blockOfItem.get(handlerIndex);
    if (handlerBlock == null) continue;
    const startPc = Number(entry.start_pc);
    const endPc = Number(entry.end_pc);
    cfg.blocks.forEach((block, id) => {
      const overlaps = block.insns.some((itemIndex) => {
        const pc = Number(codeItems[itemIndex] && codeItems[itemIndex].pc);
        return Number.isFinite(pc) && pc >= startPc && pc < endPc;
      });
      if (overlaps) edges[id].add(handlerBlock);
    });
  }

  const mergeInto = (target, source) => {
    let changed = false;
    for (const [slot, pcs] of source) {
      if (!target.has(slot)) { target.set(slot, new Set(pcs)); changed = true; continue; }
      const set = target.get(slot);
      for (const pc of pcs) if (!set.has(pc)) { set.add(pc); changed = true; }
    }
    return changed;
  };
  const transfer = (blockId, inState) => {
    const out = new Map();
    for (const [slot, pcs] of inState) out.set(slot, new Set(pcs));
    for (const access of accessesByBlock[blockId]) {
      if (access.kind === 'store') out.set(access.slot, new Set([access.pc]));
    }
    return out;
  };

  const ins = cfg.blocks.map(() => new Map());
  const outs = cfg.blocks.map((block, id) => transfer(id, ins[id]));
  const queue = cfg.blocks.map((block) => block.id);
  for (let steps = 0; queue.length && steps < cfg.blocks.length * 64; steps += 1) {
    const blockId = queue.shift();
    const out = outs[blockId];
    for (const successor of edges[blockId]) {
      if (mergeInto(ins[successor], out)) {
        outs[successor] = transfer(successor, ins[successor]);
        if (!queue.includes(successor)) queue.push(successor);
      }
    }
  }

  const loads = [];
  cfg.blocks.forEach((block, id) => {
    const state = new Map();
    for (const [slot, pcs] of ins[id]) state.set(slot, new Set(pcs));
    for (const access of accessesByBlock[id]) {
      if (access.kind === 'store') state.set(access.slot, new Set([access.pc]));
      else loads.push({ slot: access.slot, pc: access.pc, reaching: [...(state.get(access.slot) || [])] });
    }
  });
  return { loads };
}

function makeLocalState(paramTypes, isStatic, code = null, plainRefSlots = null,
  exceptionModel = null, renderOptions = null) {
  const names = new Map();
  const types = new Map();
  const debugNames = new Map();
  const debugTypes = new Map();
  const declared = new Set();
  const scopedDeclared = new Set();
  const paramNames = [];
  const localTable = collectLocalVariableTable(code);
  const slotKinds = new Map();
  const slotLastKind = new Map();
  const catchStoreTypes = new Map();
  const monitorStorePcs = new Set();
  const castStoreTypes = new Map();
  if (code) {
    const codeItems = code.codeItems || [];
    const labels = buildLabelIndex(codeItems);
    for (const entry of code.exceptionTable || []) {
      const handlerIndex = labels.get(entry.handlerLbl || entry.handlerLabel);
      if (handlerIndex === undefined) continue;
      const storeItemIndex = nextNonNopExecutableIndex(codeItems, handlerIndex);
      if (storeItemIndex < 0) continue;
      const storeItem = codeItems[storeItemIndex];
      const instruction = getInstructionFromItem(storeItem);
      const store = instruction && parseStoreIndex(instruction.op, instruction.arg);
      if (!store || store.type !== 'Object' || !Number.isFinite(Number(storeItem.pc))) continue;
      const rawCatchType = entry.catch_type ?? entry.catchType;
      const catchType = rawCatchType == null || rawCatchType === 0 || rawCatchType === 'any'
        ? 'Throwable' : javaTypeFromInternalName(rawCatchType);
      const storePc = Number(storeItem.pc);
      catchStoreTypes.set(storePc, commonExceptionSourceType(
        [catchStoreTypes.get(storePc), catchType], exceptionModel));
    }
    for (let itemIndex = 0; itemIndex < codeItems.length; itemIndex += 1) {
      const storeItem = codeItems[itemIndex];
      const instruction = getInstructionFromItem(storeItem);
      const store = instruction && parseStoreIndex(instruction.op, instruction.arg);
      if (!store || store.type !== 'Object' || !Number.isFinite(Number(storeItem.pc))) continue;
      const nextIndex = nextNonNopExecutableIndex(codeItems, itemIndex + 1);
      const nextInstruction = nextIndex < 0 ? null : getInstructionFromItem(codeItems[nextIndex]);
      if (nextInstruction && nextInstruction.op === 'monitorenter') monitorStorePcs.add(Number(storeItem.pc));
      let previousIndex = itemIndex - 1;
      let previousInstruction = null;
      while (previousIndex >= 0 && !previousInstruction) {
        previousInstruction = getInstructionFromItem(codeItems[previousIndex]);
        previousIndex -= 1;
      }
      if (previousInstruction && previousInstruction.op === 'checkcast') {
        castStoreTypes.set(Number(storeItem.pc), javaTypeFromInternalName(previousInstruction.arg));
      }
    }
    if (process.env.CFR_JS_DEBUG_LOCALS === '1' && monitorStorePcs.size) {
      console.error('[cfr-monitor-stores]', JSON.stringify([...monitorStorePcs]));
    }
  }
  for (const item of (code && code.codeItems) || []) {
    const instruction = normalizeInstruction(item && item.instruction !== undefined ? item.instruction : item);
    if (!instruction) continue;
    const access = parseLoadIndex(instruction.op, instruction.arg) || parseStoreIndex(instruction.op, instruction.arg);
    if (!access) continue;
    const kind = access.type === 'Object' ? 'ref'
      : (['boolean', 'byte', 'char', 'short', 'int'].includes(access.type) ? 'int' : access.type);
    if (!slotKinds.has(access.index)) slotKinds.set(access.index, new Set());
    slotKinds.get(access.index).add(kind);
    slotLastKind.set(access.index, kind);
  }
  let slot = 0;

  const debugLocalsBySlot = new Map();
  localTable.forEach((local) => {
    if (!debugLocalsBySlot.has(local.index)) debugLocalsBySlot.set(local.index, []);
    debugLocalsBySlot.get(local.index).push(local);
  });
  for (const [index, locals] of debugLocalsBySlot) {
    const signatures = new Set(locals.map((local) => `${local.name}:${local.descriptor}`));
    // A reused JVM slot has distinct source variables with disjoint ranges.
    // Binding the whole method to the first LocalVariableTable row mis-types
    // later stores (e.g. String followed by int[]) and emits invalid Java.
    if (signatures.size !== 1) continue;
    debugNames.set(index, sanitizeJavaIdentifier(locals[0].name, `var${index}`));
    debugTypes.set(index, descriptorToJavaType(locals[0].descriptor));
  }

  if (!isStatic) {
    names.set(0, 'this');
    types.set(0, types.get(0) || 'Object');
    declared.add(0);
    slot = 1;
  }

  paramTypes.forEach((type, index) => {
    const defaultName = index === 0 && isStatic && type === 'String[]' ? 'args' : `param${index}`;
    const name = debugNames.get(slot) || names.get(slot) || defaultName;
    names.set(slot, name);
    types.set(slot, types.get(slot) || type);
    declared.add(slot);
    paramNames.push(name);
    slot += type === 'long' || type === 'double' ? 2 : 1;
  });
  const initiallyDeclared = new Set(declared);
  const liftedDeclared = new Set();
  const currentReferenceKeys = new Map();
  const referenceDefinitions = new Map();
  const objectLoadBindings = new Map();
  let syntheticCounter = 0;
  let constructorInvocation = null;

  function localKey(index, fallbackType = 'Object', forceReferenceVariant = false) {
    if (initiallyDeclared.has(index)) return index;
    const type = simplifyType(fallbackType);
    const intCategory = new Set(['boolean', 'byte', 'char', 'short', 'int']);
    const primitiveKinds = new Set(['long', 'float', 'double']);
    // Slots in plainRefSlots hold references of more than one type on merging
    // control-flow paths; per-type variants would leave some paths writing a
    // variable the join never reads. Collapse every reference access to one
    // Object-typed variable instead.
    const plainForced = plainRefSlots && plainRefSlots.has(index)
      && !intCategory.has(type) && !primitiveKinds.has(type);
    const kind = intCategory.has(type) ? 'int'
      : (primitiveKinds.has(type) ? type
        : (plainForced ? 'ref'
          : ((type.endsWith('[]') || forceReferenceVariant) ? `ref:${type}` : 'ref')));
    return `${index}:${kind}`;
  }
  function isPlainForced(index) {
    return Boolean(plainRefSlots && plainRefSlots.has(index) && !initiallyDeclared.has(index));
  }

  function ensure(index, fallbackType = 'Object', forceReferenceVariant = false) {
    const requestedType = simplifyType(fallbackType);
    const key = requestedType === 'Object' && !forceReferenceVariant && currentReferenceKeys.has(index)
      ? currentReferenceKeys.get(index)
      : localKey(index, fallbackType, forceReferenceVariant);
    if (!names.has(key)) {
      const base = debugNames.get(index) || `var${index}`;
      const hasDebugVariant = typeof key === 'string' && key.endsWith(':ref') && debugTypes.has(index);
      const slotIndex = Number(String(key).split(':')[0]);
      const hasCategoryConflict = (slotKinds.get(slotIndex) || new Set()).size > 1;
      const keyKind = typeof key === 'string' ? key.slice(key.indexOf(':') + 1) : null;
      const coarseKeyKind = keyKind && keyKind.startsWith('ref:') ? 'ref' : keyKind;
      const suffix = typeof key === 'string' && hasCategoryConflict && coarseKeyKind !== slotLastKind.get(slotIndex) && !hasDebugVariant
        ? `_${key.slice(key.indexOf(':') + 1).replace(/[^A-Za-z0-9_$]/g, '_')}`
        : '';
      let candidate = `${base}${suffix}`;
      if ([...names.values()].includes(candidate)) {
        const family = requestedType.endsWith('[]') ? 'array' : 'ref';
        let ordinal = '';
        let next = 2;
        while ([...names.values()].includes(`${base}_${family}${ordinal}`)) {
          ordinal = String(next);
          next += 1;
        }
        candidate = `${base}_${family}${ordinal}`;
      }
      names.set(key, candidate);
    }
    if (!types.has(key)) {
      const type = simplifyType(fallbackType);
      const debugType = debugTypes.get(index);
      const safeReferenceType = debugType && (debugType.endsWith('[]') || debugType === 'String') ? debugType : 'Object';
      types.set(key, type === 'Object' ? safeReferenceType : type);
    }
    if (typeof key === 'string' && key.endsWith(':ref') && isPlainForced(index)) {
      types.set(key, 'Object');
    }
    return key;
  }

  return {
    paramNames,
    recordConstructorInvocation(target, args) {
      if (!constructorInvocation) constructorInvocation = { target, args: args.slice() };
    },
    takeConstructorInvocation() {
      return constructorInvocation;
    },
    nameFor(index, fallbackType = 'Object') {
      const key = ensure(index, fallbackType);
      return names.get(key);
    },
    typeFor(index, fallbackType = 'Object') {
      const key = ensure(index, fallbackType);
      return types.get(key);
    },
    resetReferenceFlow() {
      currentReferenceKeys.clear();
    },
    captureBinding(index, fallbackType = 'Object') {
      const key = localKey(index, fallbackType);
      const existed = names.has(key);
      if (!existed) ensure(index, fallbackType);
      return {
        key,
        existed,
        name: names.get(key),
        type: types.get(key),
        declared: declared.has(key),
        scopedDeclared: scopedDeclared.has(key),
        liftedDeclared: liftedDeclared.has(key),
        currentReferenceKey: currentReferenceKeys.get(index),
        index,
      };
    },
    restoreBinding(binding) {
      if (!binding) return;
      if (binding.currentReferenceKey === undefined) currentReferenceKeys.delete(binding.index);
      else currentReferenceKeys.set(binding.index, binding.currentReferenceKey);
      if (!binding.existed) {
        names.delete(binding.key);
        types.delete(binding.key);
        declared.delete(binding.key);
        scopedDeclared.delete(binding.key);
        liftedDeclared.delete(binding.key);
        return;
      }
      names.set(binding.key, binding.name);
      types.set(binding.key, binding.type);
      if (binding.declared) declared.add(binding.key); else declared.delete(binding.key);
      if (binding.scopedDeclared) scopedDeclared.add(binding.key); else scopedDeclared.delete(binding.key);
      if (binding.liftedDeclared) liftedDeclared.add(binding.key); else liftedDeclared.delete(binding.key);
    },
    // Slots whose reference accesses split into variant variables in a way the
    // bytecode dataflow does not support: some load can observe stores that
    // were emitted into different variants (or a variant other than the one
    // the load bound to). A caller that sees any should re-run emission with
    // these slots collapsed to one Object local (plainRefSlots).
    refConflictSlots() {
      const bySlot = new Map();
      for (const key of names.keys()) {
        const match = String(key).match(/^(\d+):(ref.*)$/);
        if (!match) continue;
        const slotIndex = Number(match[1]);
        if (!bySlot.has(slotIndex)) bySlot.set(slotIndex, new Set());
        bySlot.get(slotIndex).add(match[2]);
      }
      const splitSlots = [...bySlot.entries()]
        .filter(([slotIndex, kinds]) => kinds.size > 1 && !(plainRefSlots && plainRefSlots.has(slotIndex)))
        .map(([slotIndex]) => slotIndex);
      if (!splitSlots.length) return [];
      const reachability = code ? computeObjectSlotReachability(code) : null;
      if (!reachability) return splitSlots;
      const hazards = new Set();
      for (const load of reachability.loads) {
        if (!splitSlots.includes(load.slot) || hazards.has(load.slot)) continue;
        const boundKey = objectLoadBindings.get(load.pc);
        if (boundKey === undefined) continue; // load sits in unemitted (dead) code
        const keyByPc = new Map((referenceDefinitions.get(load.slot) || []).map((item) => [item.pc, item.key]));
        const reachingKeys = new Set();
        for (const storePc of load.reaching) {
          const key = keyByPc.get(storePc);
          if (key !== undefined) reachingKeys.add(key);
        }
        if (reachingKeys.size > 1) hazards.add(load.slot);
        else if (reachingKeys.size === 1 && ![...reachingKeys].includes(boundKey)) hazards.add(load.slot);
      }
      return [...hazards];
    },
    refinedTypeForName(name) {
      const matches = [...names.entries()].filter(([, localName]) => localName === name);
      if (matches.length !== 1) return null;
      const [key] = matches[0];
      const slotIndex = Number(String(key).split(':')[0]);
      if (typeof key === 'string' && key.endsWith(':ref') && isPlainForced(slotIndex)) return null;
      return simplifyType(types.get(matches[0][0]));
    },
    sourceTypeForName(name) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name || ''))) return null;
      const matches = [...names.entries()].filter(([, localName]) => localName === name);
      if (matches.length !== 1) return null;
      return simplifyType(types.get(matches[0][0]));
    },
    hasLocalName(name) {
      return [...names.values()].includes(name);
    },
    refineExpressionType(value, type) {
      if (!value || !value.code) return;
      for (const [key, name] of names) {
        if (name !== value.code) continue;
        // Method headers were rendered before body inference. Keep parameter
        // declarations stable and cast verifier-constrained uses instead.
        if (initiallyDeclared.has(key)) continue;
        // Collapsed (plain-forced) locals must stay Object: their stores were
        // rendered against Object, so re-typing the declaration would break.
        const slotIndex = Number(String(key).split(':')[0]);
        if (typeof key === 'string' && key.endsWith(':ref') && isPlainForced(slotIndex)) continue;
        const currentType = simplifyType(types.get(key));
        const refinedType = simplifyType(type);
        // arraylength establishes only Object[]; a following primitive array
        // opcode carries the concrete verifier type.
        if (currentType === 'Object'
          || (currentType === 'Object[]' && refinedType.endsWith('[]') && refinedType !== 'Object[]')) {
          types.set(key, refinedType);
        }
      }
    },
    setLocal(index, name, type = 'Object', markDeclared = false) {
      const key = ensure(index, type);
      names.set(key, sanitizeJavaIdentifier(name, names.get(key)));
      types.set(key, simplifyType(type));
      if (markDeclared) {
        declared.add(key);
        scopedDeclared.add(key);
      }
    },
    markDeclared(index) {
      declared.add(ensure(index));
    },
    liftAllDeclarations() {
      const lines = [];
      const keys = [...names.keys()].sort((a, b) => Number(String(a).split(':')[0]) - Number(String(b).split(':')[0]));
      for (const key of keys) {
        if (initiallyDeclared.has(key) || scopedDeclared.has(key) || liftedDeclared.has(key)) continue;
        declared.add(key);
        liftedDeclared.add(key);
        const type = simplifyType(types.get(key));
        lines.push(`${type} ${names.get(key)} = ${defaultValueForType(type)};`);
      }
      return lines;
    },
    missingDeclarations(lines) {
      const text = (lines || []).join('\n');
      const missing = [];
      if (process.env.CFR_JS_DEBUG_LOCALS === '1') {
        console.error('[cfr-locals]', JSON.stringify([...names].map(([key, name]) => ({
          key, name, type: types.get(key), declared: declared.has(key), initial: initiallyDeclared.has(key),
        }))));
      }
      for (const [key, name] of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (initiallyDeclared.has(key) || !new RegExp(`\\b${escaped}\\b`).test(text)) continue;
        const hasDeclaration = (lines || []).some((line) =>
          localDeclarationsFromStatement(line).some((item) => item.name === name));
        if (!hasDeclaration) {
          const type = simplifyType(types.get(key));
          missing.push(`${type} ${name} = ${defaultValueForType(type)};`);
        }
      }
      return missing;
    },
    load(index, fallbackType = 'Object', pc = null) {
      let key = null;
      if (fallbackType === 'Object' && Number.isFinite(Number(pc))) {
        const prior = (referenceDefinitions.get(index) || [])
          .filter((item) => item.pc < Number(pc))
          .sort((a, b) => b.pc - a.pc)[0];
        if (prior) key = prior.key;
      }
      if (!key) key = ensure(index, fallbackType);
      if (fallbackType === 'Object' && Number.isFinite(Number(pc))) {
        objectLoadBindings.set(Number(pc), key);
      }
      const name = names.get(key);
      return expr(name, types.get(key), 100, {
        localIndex: index,
        ...(name === 'this' ? { localThis: true } : {}),
      });
    },
    store(index, fallbackType, value, pc = null) {
      const inferred = inferStoreType(fallbackType, value);
      const catchType = Number.isFinite(Number(pc)) ? catchStoreTypes.get(Number(pc)) : null;
      const castType = Number.isFinite(Number(pc)) ? castStoreTypes.get(Number(pc)) : null;
      const monitorStore = (Number.isFinite(Number(pc)) && monitorStorePcs.has(Number(pc)))
        || (value && value.localThis === true);
      if (process.env.CFR_JS_DEBUG_LOCALS === '1' && index === 2) {
        console.error('[cfr-store-slot2]', JSON.stringify({ pc, fallbackType, inferred,
          code: value && value.code, type: value && value.type, localThis: value && value.localThis,
          monitorStore, catchType }));
      }
      let flowInferred = inferred;
      if (flowInferred === 'Object' && value && value.code === 'null') {
        const priorArray = (referenceDefinitions.get(index) || [])
          .filter((definition) => !Number.isFinite(Number(pc)) || definition.pc < Number(pc))
          .sort((left, right) => right.pc - left.pc)
          .map((definition) => simplifyType(types.get(definition.key)))
          .find((type) => type && type.endsWith('[]'));
        if (priorArray) flowInferred = priorArray;
      }
      const effectiveType = monitorStore ? 'Object' : (catchType || castType || flowInferred);
      const typedArrayElement = Boolean(value && value.arrayElement && effectiveType !== 'Object');
      const primitiveTypes = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
      const concreteReference = effectiveType !== 'Object' && !primitiveTypes.has(simplifyType(effectiveType));
      const key = ensure(index, effectiveType,
        Boolean(catchType) || Boolean(castType) || monitorStore || typedArrayElement || concreteReference);
      if (!['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double'].includes(simplifyType(inferred))) {
        currentReferenceKeys.set(index, key);
        if (Number.isFinite(Number(pc))) {
          if (!referenceDefinitions.has(index)) referenceDefinitions.set(index, []);
          const definitions = referenceDefinitions.get(index);
          const existing = definitions.find((item) => item.pc === Number(pc));
          if (existing) existing.key = key;
          else definitions.push({ pc: Number(pc), key });
        }
      }
      const name = names.get(key);
      const upgradeBlocked = typeof key === 'string' && key.endsWith(':ref') && isPlainForced(index);
      if (!upgradeBlocked && (!types.has(key) || (types.get(key) === 'Object' && effectiveType !== 'Object'))) types.set(key, effectiveType);
      const rendered = coerceExpressionForType(renderStoreExpression(value), types.get(key));
      if (!declared.has(key)) {
        declared.add(key);
        return `${simplifyType(types.get(key))} ${name} = ${rendered.code};`;
      }
      return `${name} = ${rendered.code};`;
    },
    bindCatch(index, catchType, pc = null, preferredName = null) {
      // Catch parameters need a typed declaration even when the slot's other
      // reference accesses are collapsed to Object.
      const plainSuspended = plainRefSlots && plainRefSlots.has(index);
      if (plainSuspended) plainRefSlots.delete(index);
      const key = ensure(index, catchType, true);
      if (plainSuspended) plainRefSlots.add(index);
      if (preferredName && ![...names.entries()].some(([otherKey, name]) =>
        otherKey !== key && Number(String(otherKey).split(':')[0]) !== Number(index) && name === preferredName)) {
        names.set(key, sanitizeJavaIdentifier(preferredName, names.get(key)));
      }
      currentReferenceKeys.set(index, key);
      if (Number.isFinite(Number(pc))) {
        if (!referenceDefinitions.has(index)) referenceDefinitions.set(index, []);
        const definitions = referenceDefinitions.get(index);
        const existing = definitions.find((item) => item.pc === Number(pc));
        if (existing) existing.key = key;
        else definitions.push({ pc: Number(pc), key });
      }
      declared.add(key);
      scopedDeclared.add(key);
      return names.get(key);
    },
    nextSyntheticName(prefix = 'array') {
      const name = `${prefix}$${syntheticCounter}`;
      syntheticCounter += 1;
      return name;
    },
    requireRenderedType(type) {
      requireRenderedTypeImport(renderOptions, type);
    },
  };
}

function collectLocalVariableTable(code) {
  const locals = [];
  for (const attr of (code && code.attributes) || []) {
    if (attr.type !== 'localvariabletable') continue;
    for (const variable of attr.vars || []) {
      const index = Number(variable.index);
      if (!Number.isFinite(index)) continue;
      locals.push({
        index,
        name: variable.name,
        descriptor: variable.descriptor,
      });
    }
  }
  return locals;
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
  if (instruction.op === 'wide') return decodeWideInstruction(instruction);
  if (instruction.op) return instruction;
  return null;
}

// A `wide`-prefixed instruction widens the local index (and, for iinc, the
// constant) of a following load/store/iinc/ret to two bytes. The disassembler
// delivers it verbatim as { op: 'wide', arg: 'iinc 3 198' } / 'iload 300'
// (space-joined base mnemonic + operands) so the assembler can round-trip it.
// Decode it into the equivalent base instruction so every consumer — the linear
// emitter and the structurer alike (both read instructions through
// normalizeInstruction) — handles it as an ordinary iinc/iload/istore rather
// than dropping it to a `// wide ...` comment. Unknown targets are left as-is so
// the fallback gate hard-fails instead of silently discarding an opcode.
function decodeWideInstruction(instruction) {
  const parts = String(instruction.arg == null ? '' : instruction.arg).trim().split(/\s+/);
  const baseOp = parts[0];
  if (!baseOp) return instruction;
  if (baseOp === 'iinc') {
    return { op: 'iinc', arg: [Number(parts[1]), Number(parts[2])] };
  }
  if (/^[ilfda](load|store)$/.test(baseOp) || baseOp === 'ret') {
    return { op: baseOp, arg: Number(parts[1]) };
  }
  return instruction;
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

function formatStaticField(ref, localState = null) {
  const fieldName = sourceFieldName(ref.owner, ref.name);
  const currentOwner = localState && localState.currentInternalClassName;
  const classNameCollision = currentOwner && simpleClassName(currentOwner) === fieldName;
  const localCollision = localState && localState.hasLocalName && localState.hasLocalName(fieldName);
  if (ref.owner === currentOwner && !classNameCollision && !localCollision) return fieldName;
  const owner = sourceOwnerType(ref.owner, localState);
  return `${owner}.${fieldName}`;
}

function sourceOwnerType(internalName, localState = null) {
  const aliases = localState && localState.staticOwnerAliases;
  return javaTypeFromInternalName(aliases && aliases.get(internalName) || internalName);
}

function renderArrayReceiver(value) {
  const rendered = wrap(value, 100);
  return /^new\s/.test(rendered) ? `(${rendered})` : rendered;
}

function sourceFieldName(owner, name) {
  if (String(owner || '').includes('/')) return name;
  return `field_${name}`;
}

function sourceMethodName(name) {
  const text = String(name || '');
  return text.startsWith('lambda$') ? `cfr$${text}` : text;
}

function constantExpression(value, op) {
  if (Array.isArray(value) && value[0] === 'Class') {
    return expr(`${javaTypeFromInternalName(value[1])}.class`, 'Class');
  }
  if (value && typeof value === 'object') {
    if (value.type === 'Float') return expr(formatFloat(value.value), 'float');
    if (value.type === 'Double') return expr(formatDouble(value.value), 'double');
    if (value.type === 'Long') return expr(`${String(value.value)}L`, 'long');
    if (value.type === 'Class') return expr(`${javaTypeFromInternalName(value.value)}.class`, 'Class');
    if (value.type === 'String') return expr(formatStringLiteral(value.value), 'String', 100, { constantKind: 'String' });
  }
  if (op === 'ldc2_w' && typeof value === 'string') {
    const numeric = String(unquoteJavaStringLiteral(value));
    if (/^[+-]?\d+$/.test(numeric)) return expr(`${numeric}L`, 'long');
    if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric)) return expr(formatDouble(numeric), 'double');
  }
  if (typeof value === 'string') return expr(formatStringLiteral(unquoteJavaStringLiteral(value)), 'String', 100, { constantKind: 'String' });
  if (typeof value === 'bigint') return expr(`${String(value)}L`, 'long');
  if (typeof value === 'number') return expr(String(value), op === 'ldc2_w' ? 'double' : 'int', 100,
    op === 'ldc2_w' ? {} : { constantValue: value });
  return expr(String(value), 'Object');
}

function binaryExpr(left, symbol, right, type) {
  if (['&', '|', '^'].includes(symbol) && left.type === 'boolean' && right.type === 'boolean') type = 'boolean';
  if (['&', '|', '^'].includes(symbol) && (left.type === 'boolean') !== (right.type === 'boolean')) {
    left = coerceExpressionForType(left, 'int');
    right = coerceExpressionForType(right, 'int');
  }
  const identity = simplifyIntegralIdentityExpression(left, symbol, right, type);
  if (identity) return identity;
  if (experimentalConstantEvaluationEnabled()
    && symbol === '^' && (type === 'int' || type === 'long')) {
    const leftConstant = integralConstantValue(left, type);
    const rightConstant = integralConstantValue(right, type);
    if (leftConstant === minusOneForType(type)) {
      return expr(`~${wrap(right, 90)}`, type, 90, { bitwiseComplement: right });
    }
    if (rightConstant === minusOneForType(type)) {
      return expr(`~${wrap(left, 90)}`, type, 90, { bitwiseComplement: left });
    }
  }
  const precedence = binaryPrecedence(symbol);
  return expr(`${wrap(left, precedence)} ${symbol} ${wrap(right, precedence, true)}`, type, precedence);
}

function simplifyIntegralIdentityExpression(left, symbol, right, type) {
  if (!experimentalConstantEvaluationEnabled() || (type !== 'int' && type !== 'long')) return null;
  const leftConstant = integralConstantValue(left, type);
  const rightConstant = integralConstantValue(right, type);
  const zero = type === 'long' ? 0n : 0;
  const one = type === 'long' ? 1n : 1;
  const minusOne = minusOneForType(type);

  const rightIdentity = (rightConstant === zero && (
    symbol === '+' || symbol === '-' || symbol === '|' || symbol === '^'
      || symbol === '<<' || symbol === '>>' || symbol === '>>>'
  )) || (rightConstant === one && (symbol === '*' || symbol === '/'))
    || (rightConstant === minusOne && symbol === '&');
  if (rightIdentity && simplifyType(left.type) === type) return { ...left, type };

  const leftIdentity = (leftConstant === zero && (
    symbol === '+' || symbol === '|' || symbol === '^'
  )) || (leftConstant === one && symbol === '*')
    || (leftConstant === minusOne && symbol === '&');
  if (leftIdentity && simplifyType(right.type) === type) return { ...right, type };
  return null;
}

function simplifyBitwiseComplementComparison(left, operator, right) {
  if (!experimentalConstantEvaluationEnabled()) return null;
  let value = null;
  let constantExpression = null;
  let normalizedOperator = operator;
  if (left && left.bitwiseComplement) {
    value = left.bitwiseComplement;
    constantExpression = right;
  } else if (right && right.bitwiseComplement) {
    value = right.bitwiseComplement;
    constantExpression = left;
    normalizedOperator = swapComparisonOperator(operator);
  } else {
    return null;
  }

  const type = simplifyType(left && left.bitwiseComplement ? left.type : right.type);
  if (type !== 'int' && type !== 'long') return null;
  const constant = integralConstantValue(constantExpression, type);
  if (constant == null) return null;
  const complementedConstant = complementConstant(constant, type);
  const simplifiedOperator = reverseComparisonOperator(normalizedOperator);
  const renderedConstant = type === 'long'
    ? `${String(complementedConstant)}L`
    : String(complementedConstant);
  return expr(`${wrap(value, 60)} ${simplifiedOperator} ${renderedConstant}`, 'boolean', 60);
}

function experimentalConstantEvaluationEnabled() {
  return process.env.PIPELINE_EXPERIMENTAL_INTERCLASS_DCE === '1';
}

function integralConstantValue(value, type) {
  if (!value || simplifyType(value.type) !== type) return null;
  if (type === 'int') {
    if (Number.isInteger(value.constantValue)) return value.constantValue | 0;
    if (/^-?\d+$/.test(value.code || '')) return Number(value.code) | 0;
    return null;
  }
  if (!/^-?\d+L$/.test(value.code || '')) return null;
  try {
    return BigInt.asIntN(64, BigInt(value.code.slice(0, -1)));
  } catch (error) {
    return null;
  }
}

function minusOneForType(type) {
  return type === 'long' ? -1n : -1;
}

function complementConstant(value, type) {
  return type === 'long' ? BigInt.asIntN(64, ~value) : (~value | 0);
}

function swapComparisonOperator(operator) {
  return ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=' })[operator] || operator;
}

function reverseComparisonOperator(operator) {
  return ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=' })[operator] || operator;
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

function conditionalExpr(condition, trueValue, falseValue, type = null) {
  const resultType = simplifyType(type || mergeStackTypes(trueValue.type, falseValue.type));
  const qualifiedType = trueValue.qualifiedType && trueValue.qualifiedType === falseValue.qualifiedType
    ? trueValue.qualifiedType
    : null;
  return expr(`${wrap(condition, 20)} ? ${trueValue.code} : ${falseValue.code}`, resultType, 20, {
    conditional: { condition, trueValue, falseValue },
    ...(qualifiedType ? { qualifiedType } : {}),
  });
}

function renderStoreExpression(value) {
  if (value && value.compare) {
    const left = wrap(value.compare.left, 60);
    const right = wrap(value.compare.right, 60, true);
    return expr(`(${left} < ${right} ? -1 : (${left} == ${right} ? 0 : 1))`, 'int', 20);
  }
  if (!value || !value.arrayLiteral) return value;
  const literal = value.arrayLiteral;
  if (!literal || !Number.isFinite(literal.length)) return value;
  const elements = [];
  for (let i = 0; i < literal.length; i += 1) {
    const element = literal.elements.get(i);
    if (!element) return value;
    const renderedElement = renderStoreExpression(element);
    elements.push(coerceExpressionForType(renderedElement, literal.elementType).code);
  }
  return expr(`new ${literal.elementType}[]{${elements.join(', ')}}`, `${literal.elementType}[]`);
}

function coerceExpressionForType(value, targetType, exceptionModel = null, allowWideningReference = true) {
  if (!value) return value;
  const type = simplifyType(targetType);
  if (value.lambdaTarget && type !== simplifyType(value.lambdaTarget)) {
    return expr(`(${value.lambdaTarget}) (${value.code})`, value.lambdaTarget, 90);
  }
  if (value.conditional) {
    const { condition, trueValue, falseValue } = value.conditional;
    return conditionalExpr(
      condition,
      coerceExpressionForType(trueValue, type, exceptionModel, allowWideningReference),
      coerceExpressionForType(falseValue, type, exceptionModel, allowWideningReference),
      type,
    );
  }
  if (type === 'boolean') {
    if (value.conditional) {
      const { condition, trueValue, falseValue } = value.conditional;
      return conditionalExpr(
        condition,
        coerceExpressionForType(trueValue, 'boolean', exceptionModel, allowWideningReference),
        coerceExpressionForType(falseValue, 'boolean', exceptionModel, allowWideningReference),
        'boolean',
      );
    }
    if (value.code === '0') return expr('false', 'boolean');
    if (value.code === '1') return expr('true', 'boolean');
    if (value.type !== 'boolean') return expr(`${wrap(value, 60)} != 0`, 'boolean', 60);
  }
  if (type === 'char' && /^\d+$/.test(value.code)) {
    return expr(formatCharLiteral(Number(value.code)), 'char');
  }
  if (type === 'long' && value.type === 'int' && /^-?\d+$/.test(value.code)) {
    return expr(`${value.code}L`, 'long');
  }
  if ((type === 'byte' || type === 'short' || type === 'char') && value.type === 'boolean') {
    return expr(`(${type}) (${wrap(value, 20)} ? 1 : 0)`, type, 90);
  }
  if ((type === 'byte' || type === 'short' || type === 'char') && value.type !== type) {
    return expr(`(${type}) ${wrap(value, 90)}`, type, 90);
  }
  if (type === 'int' && value.type === 'boolean') {
    return expr(`${wrap(value, 20)} ? 1 : 0`, 'int', 20);
  }
  const primitive = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void']);
  if (!primitive.has(type) && value.type !== type && value.code !== 'null') {
    const sourceType = simplifyType(value.type);
    const isAssignable = isSourceReferenceTypeAssignable(sourceType, type, exceptionModel);
    if (allowWideningReference && isAssignable) {
      return { ...value, type };
    }
    const sourceIsKnownReference = !primitive.has(sourceType) && sourceType !== 'Object';
    const sourceNeedsBridge = !isAssignable
      && (sourceIsKnownReference || /^stack(?:In|Out)_/.test(value.code));
    const operand = sourceNeedsBridge ? `(Object) ${wrap(value, 90)}` : wrap(value, 90);
    return expr(`(${type}) (${operand})`, type, 90);
  }
  return value;
}

function expressionHasSideEffects(value) {
  if (!value || !value.code || value.pendingNew) return false;
  return /[A-Za-z0-9_$]\s*\(/.test(value.code) || /\bnew\b/.test(value.code) || /\+\+|--/.test(value.code);
}

// A dup of a side-effecting expression must not render it once per consumer:
// spill it to a synthetic local so the effect happens exactly once. Pending
// new-array fills (dynamic and literal) and StringBuilder concat chains keep
// their shared entries so the dedicated pattern handling still sees them.
function materializeDuplicatedValue(value, lines, localState) {
  if (!expressionHasSideEffects(value) || value.newArraySpill || value.arrayLiteral || value.stringBuilderPieces) return value;
  const rendered = renderStoreExpression(value);
  const name = localState.nextSyntheticName('dupTemp');
  lines.push(`${simplifyType(rendered.type)} ${name} = ${rendered.code};`);
  return expr(name, value.type, 100);
}

// Array construction metadata is intentionally mutable while dup-based fills
// are reconstructed.  Every duplicated stack slot must therefore retain the
// same expression object; a shallow clone shares the element map but not later
// code/spill updates, which can emit a second allocation for one JVM value.
function duplicateStackExpression(value) {
  if (!value || value.newArraySpill || value.arrayLiteral) return value;
  return { ...value };
}

function materializeNewArraySpill(value, lines, localState) {
  const name = localState.nextSyntheticName();
  lines.push(`${value.type} ${name} = ${value.code};`);
  value.code = name;
  value.newArraySpill = undefined;
  value.arrayLiteral = undefined;
  return value;
}

// Before a field write, freeze any live stack expression that reads the same
// field into a temp. Otherwise the operand — captured before the store but
// rendered lazily as a field access — would read the post-store value. The
// field-name check over-approximates (a same-named field on another object is
// spilled too), which is always safe: spilling a pure re-read changes nothing.
function materializeStackFieldReads(stack, fieldName, lines, localState) {
  if (!fieldName) return;
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRead = new RegExp(`(^|[^A-Za-z0-9_$])${escapedFieldName}([^A-Za-z0-9_$]|$)`);
  for (let i = 0; i < stack.length; i += 1) {
    const value = stack[i];
    if (!value || typeof value.code !== 'string') continue;
    if (!fieldRead.test(value.code)) continue;
    if (value.newArraySpill || value.arrayLiteral || value.stringBuilderPieces) continue;
    const rendered = renderStoreExpression(value);
    const name = localState.nextSyntheticName('fieldTemp');
    lines.push(`${simplifyType(rendered.type)} ${name} = ${rendered.code};`);
    stack[i] = expr(name, value.type, 100);
  }
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

function replaceArrayContents(target, values) {
  if (target === values) return target;
  target.length = 0;
  for (const value of values || []) target.push(value);
  return target;
}

function descriptorToJavaType(descriptor) {
  const parsed = parseDescriptor(descriptor);
  if (Array.isArray(parsed)) return simplifyType(parsed[0]);
  return simplifyType(parsed.returnType);
}

function simplifyType(type) {
  if (!type) return 'Object';
  const raw = String(type);
  const nestedJreTypes = {
    'MethodHandles$Lookup': 'java.lang.invoke.MethodHandles.Lookup',
    'MethodHandles.Lookup': 'java.lang.invoke.MethodHandles.Lookup',
    'DataLine$Info': 'javax.sound.sampled.DataLine.Info',
    'DataLine.Info': 'javax.sound.sampled.DataLine.Info',
  };
  if (nestedJreTypes[raw]) return nestedJreTypes[raw];
  const text = /^(?:java|javax)\./.test(raw) ? raw.replace(/\$/g, '.') : raw;
  const arraySuffix = (text.match(/(?:\[\])+$/) || [''])[0];
  const component = arraySuffix ? text.slice(0, -arraySuffix.length) : text;
  if (/^java\.(?:lang|io|util)\.[^.]+$/.test(component)) {
    return component.slice(component.lastIndexOf('.') + 1) + arraySuffix;
  }
  return text;
}

function javaTypeFromInternalName(name) {
  if (String(name || '').startsWith('[')) return descriptorToJavaType(name);
  const internal = String(name || 'Object');
  const sourceName = /^(?:java|javax)\//.test(internal) ? internal.replace(/\$/g, '.') : internal;
  return simplifyType(sourceName.replace(/\//g, '.'));
}

function defaultValueForType(type) {
  const simplified = simplifyType(type);
  if (simplified === 'boolean') return 'false';
  if (simplified === 'long') return '0L';
  if (simplified === 'float') return '0.0f';
  if (simplified === 'double') return '0.0';
  if (['byte', 'char', 'short', 'int'].includes(simplified)) return '0';
  return 'null';
}

function formatNewArrayExpression(elementType, lengthCode) {
  const match = /^(.*?)(\[\])+$/.exec(elementType);
  if (!match) return `new ${elementType}[${lengthCode}]`;
  return `new ${match[1]}[${lengthCode}]${elementType.slice(match[1].length)}`;
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
  DecompilationFallbackError,
  assertNoFallback,
  decompileClassFile,
  decompileClassBytes,
  decompileAstRoot,
  decompileClassAst,
  decompilePath,
  buildExceptionModel,
  _internals: {
    binaryExpr,
    coerceExpressionForType,
    dropUnthrowableProtectedRows,
    isCheckedThrow,
    isSourceReferenceTypeAssignable,
    removeImpossibleCheckedCatchBlocks,
    requireRenderedTypeImport,
    simplifyBitwiseComplementComparison,
  },
};
