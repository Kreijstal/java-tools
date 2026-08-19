'use strict';

const fs = require('fs');
const path = require('path');

const JRE_ROOT = path.resolve(__dirname, '..', 'jre');
const indexedJreClasses = typeof fs.existsSync === 'function'
  ? null
  : require('../jre');

let cache = null;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function internalNameFromFile(file) {
  const relative = path.relative(JRE_ROOT, file).replace(/\\/g, '/');
  return relative.replace(/\.js$/, '');
}

function methodNameFromKey(key) {
  const index = String(key).indexOf('(');
  return index >= 0 ? String(key).slice(0, index) : String(key);
}

function descriptorFromKey(key) {
  const index = String(key).indexOf('(');
  return index >= 0 ? String(key).slice(index) : null;
}

function returnDescriptor(descriptor) {
  if (typeof descriptor !== 'string') return null;
  const index = descriptor.indexOf(')');
  return index >= 0 ? descriptor.slice(index + 1) : null;
}

function fieldMetadataFromKey(key, isStatic) {
  const separator = String(key).indexOf(':');
  if (separator <= 0) return null;
  return {
    name: String(key).slice(0, separator),
    descriptor: String(key).slice(separator + 1),
    isStatic,
  };
}

function declaredThrowsForImplementation(implementation) {
  if (Array.isArray(implementation.__declaredThrows)) {
    return implementation.__declaredThrows.slice();
  }
  return Array.isArray(implementation.__throws) ? implementation.__throws.slice() : [];
}

function loadClass(file) {
  try {
    return require(file);
  } catch (_) {
    return {};
  }
}

function buildMetadata() {
  const classes = new Map();
  const simpleNames = new Map();
  const definitions = indexedJreClasses
    ? Object.entries(indexedJreClasses)
    : walk(JRE_ROOT).map((file) => [internalNameFromFile(file), loadClass(file)]);
  for (const [internalName, classDef] of definitions) {
    if (internalName === 'helpers' || internalName.endsWith('/index') || internalName === 'index') continue;
    const methods = new Map();
    const staticMethods = new Map();
    const fields = new Map();
    const staticFields = new Map();
    for (const key of Object.keys(classDef.fields || {})) {
      const field = fieldMetadataFromKey(key, false);
      if (field) fields.set(field.name, field);
    }
    for (const key of Object.keys(classDef.staticFields || {})) {
      const field = fieldMetadataFromKey(key, true);
      if (field) staticFields.set(field.name, field);
    }
    for (const [key, implementation] of Object.entries(classDef.methods || {})) {
      const descriptor = descriptorFromKey(key);
      if (!descriptor) continue;
      const name = methodNameFromKey(key);
      if (!methods.has(name)) methods.set(name, []);
      methods.get(name).push({
        name, descriptor, returnDescriptor: returnDescriptor(descriptor), isStatic: false,
        throwsTypes: declaredThrowsForImplementation(implementation),
      });
    }
    for (const [key, implementation] of Object.entries(classDef.staticMethods || {})) {
      const descriptor = descriptorFromKey(key);
      if (!descriptor) continue;
      const name = methodNameFromKey(key);
      if (!staticMethods.has(name)) staticMethods.set(name, []);
      staticMethods.get(name).push({
        name, descriptor, returnDescriptor: returnDescriptor(descriptor), isStatic: true,
        throwsTypes: declaredThrowsForImplementation(implementation),
      });
    }
    classes.set(internalName, {
      internalName,
      simpleName: internalName.split('/').pop(),
      isInterface: Boolean(classDef.isInterface),
      superName: classDef.super || null,
      interfaces: classDef.interfaces || [],
      methods,
      staticMethods,
      fields,
      staticFields,
    });
    const simpleName = internalName.split('/').pop();
    if (!simpleNames.has(simpleName)) simpleNames.set(simpleName, []);
    simpleNames.get(simpleName).push(internalName);
  }
  return { classes, simpleNames };
}

function metadata() {
  if (!cache) cache = buildMetadata();
  return cache;
}

function jreClassExists(internalName) {
  return metadata().classes.has(internalName);
}

// java.lang is implicitly imported into every compilation unit, so any simple
// name in it has to resolve without a stub backing it. Deriving this from the
// jvm.js stub tree instead left holes - ThreadDeath had no stub, so it was
// emitted as the unqualified class `ThreadDeath` and failed to load. This is
// the full set of public top-level java.lang classes.
const JAVA_LANG_TYPES = new Set([
  'AbstractMethodError', 'Appendable', 'ArithmeticException', 'ArrayIndexOutOfBoundsException',
  'ArrayStoreException', 'AssertionError', 'AutoCloseable', 'Boolean', 'BootstrapMethodError',
  'Byte', 'CharSequence', 'Character', 'Class', 'ClassCastException', 'ClassCircularityError',
  'ClassFormatError', 'ClassLoader', 'ClassNotFoundException', 'ClassValue',
  'CloneNotSupportedException', 'Cloneable', 'Comparable', 'Deprecated', 'Double', 'Enum',
  'EnumConstantNotPresentException', 'Error', 'Exception', 'ExceptionInInitializerError',
  'Float', 'FunctionalInterface', 'IllegalAccessError', 'IllegalAccessException',
  'IllegalArgumentException', 'IllegalCallerException', 'IllegalMonitorStateException',
  'IllegalStateException', 'IllegalThreadStateException', 'IncompatibleClassChangeError',
  'IndexOutOfBoundsException', 'InheritableThreadLocal', 'InstantiationError',
  'InstantiationException', 'Integer', 'InternalError', 'InterruptedException', 'Iterable',
  'LayerInstantiationException', 'LinkageError', 'Long', 'Math', 'Module', 'ModuleLayer',
  'NegativeArraySizeException', 'NoClassDefFoundError', 'NoSuchFieldError',
  'NoSuchFieldException', 'NoSuchMethodError', 'NoSuchMethodException', 'NullPointerException',
  'Number', 'NumberFormatException', 'Object', 'OutOfMemoryError', 'Override', 'Package',
  'Process', 'ProcessBuilder', 'ProcessHandle', 'Readable', 'ReflectiveOperationException',
  'Runnable', 'Runtime', 'RuntimeException', 'RuntimePermission', 'SafeVarargs',
  'SecurityException', 'SecurityManager', 'Short', 'StackOverflowError', 'StackTraceElement',
  'StackWalker', 'StrictMath', 'String', 'StringBuffer', 'StringBuilder',
  'StringIndexOutOfBoundsException', 'SuppressWarnings', 'System', 'Thread', 'ThreadDeath',
  'ThreadGroup', 'ThreadLocal', 'Throwable', 'TypeNotPresentException', 'UnknownError',
  'UnsatisfiedLinkError', 'UnsupportedClassVersionError', 'UnsupportedOperationException',
  'VerifyError', 'VirtualMachineError', 'Void',
]);

// Whether the model says anything about this class's own signatures. Some
// entries are placeholders - `java/awt/image/ImageObserver` declares no methods
// at all - so "the model does not have this method" only means the method is
// absent when the class carries a method table to be absent from.
function jreClassDeclaresMethods(internalName) {
  const classInfo = jreClassInfo(internalName);
  if (!classInfo) return false;
  return classInfo.methods.size > 0 || classInfo.staticMethods.size > 0;
}

function jreInternalNameForSimpleName(name) {
  const matches = metadata().simpleNames.get(name);
  return matches && matches.length === 1 ? matches[0] : null;
}

function jreClassInfo(internalName) {
  return metadata().classes.get(internalName) || null;
}

function jreCanonicalInternalName(internalName) {
  if (metadata().classes.has(internalName)) return internalName;
  let candidate = String(internalName || '');
  for (let slash = candidate.lastIndexOf('/'); slash >= 0; slash = candidate.lastIndexOf('/')) {
    candidate = `${candidate.slice(0, slash)}$${candidate.slice(slash + 1)}`;
    if (metadata().classes.has(candidate)) return candidate;
  }
  return null;
}

function jreMethodCandidates(internalName, methodName, isStatic) {
  const candidates = [];
  const visited = new Set();
  const pending = [internalName];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const classInfo = jreClassInfo(current);
    if (!classInfo) continue;
    const table = isStatic ? classInfo.staticMethods : classInfo.methods;
    candidates.push(...(table.get(methodName) || []));
    if (classInfo.superName) pending.push(classInfo.superName);
    pending.push(...(classInfo.interfaces || []));
  }
  return candidates;
}

function jreFieldInfo(internalName, fieldName) {
  const visited = new Set();
  const pending = [internalName];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const classInfo = jreClassInfo(current);
    if (!classInfo) continue;
    const field = classInfo.fields.get(fieldName) || classInfo.staticFields.get(fieldName);
    if (field) return { ...field, owner: current };
    if (classInfo.superName) pending.push(classInfo.superName);
    pending.push(...(classInfo.interfaces || []));
  }
  return null;
}

module.exports = {
  jreClassExists,
  jreClassDeclaresMethods,
  jreCanonicalInternalName,
  jreClassInfo,
  jreFieldInfo,
  jreInternalNameForSimpleName,
  JAVA_LANG_TYPES,
  jreMethodCandidates,
};
