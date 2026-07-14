'use strict';

const fs = require('fs');
const path = require('path');

const JRE_ROOT = path.resolve(__dirname, '..', 'jre');

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
  for (const file of walk(JRE_ROOT)) {
    const internalName = internalNameFromFile(file);
    if (internalName === 'helpers' || internalName.endsWith('/index') || internalName === 'index') continue;
    const classDef = loadClass(file);
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
        throwsTypes: Array.isArray(implementation.__throws) ? implementation.__throws.slice() : [],
      });
    }
    for (const [key, implementation] of Object.entries(classDef.staticMethods || {})) {
      const descriptor = descriptorFromKey(key);
      if (!descriptor) continue;
      const name = methodNameFromKey(key);
      if (!staticMethods.has(name)) staticMethods.set(name, []);
      staticMethods.get(name).push({
        name, descriptor, returnDescriptor: returnDescriptor(descriptor), isStatic: true,
        throwsTypes: Array.isArray(implementation.__throws) ? implementation.__throws.slice() : [],
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
  jreCanonicalInternalName,
  jreClassInfo,
  jreFieldInfo,
  jreInternalNameForSimpleName,
  jreMethodCandidates,
};
