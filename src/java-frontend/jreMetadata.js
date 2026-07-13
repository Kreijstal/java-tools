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

function jreMethodCandidates(internalName, methodName, isStatic) {
  const classInfo = jreClassInfo(internalName);
  if (!classInfo) return [];
  const table = isStatic ? classInfo.staticMethods : classInfo.methods;
  return table.get(methodName) || [];
}

module.exports = {
  jreClassExists,
  jreClassInfo,
  jreInternalNameForSimpleName,
  jreMethodCandidates,
};
