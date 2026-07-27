'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { KrakatauWorkspace } = require('./KrakatauWorkspace');
const { renameClasses } = require('./renameClass');
const { renameFields } = require('./renameField');
const { renameMethods } = require('./renameMethod');
const { writeClassAstToClassFile } = require('../parsing/classAstToClassFile');

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}

function assertJavaIdentifier(name, label) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || JAVA_KEYWORDS.has(name)) {
    throw new Error(`${label} is not a valid Java identifier: ${name}`);
  }
}

function assertInternalClassName(name, label) {
  const parts = String(name).split('/');
  if (parts.length === 0 || parts.some((part) => {
    try {
      assertJavaIdentifier(part, label);
      return false;
    } catch (_error) {
      return true;
    }
  })) {
    throw new Error(`${label} is not a valid JVM/Java class name: ${name}`);
  }
}

function parseFieldKey(key) {
  const dot = key.lastIndexOf('.');
  const colon = key.indexOf(':', dot + 1);
  if (dot <= 0 || colon <= dot + 1 || colon === key.length - 1) {
    throw new Error(`invalid field mapping key ${key}; expected owner.name:descriptor`);
  }
  return {
    key,
    owner: key.slice(0, dot),
    name: key.slice(dot + 1, colon),
    descriptor: key.slice(colon + 1),
  };
}

function parseMethodKey(key) {
  const descriptorAt = key.indexOf('(');
  const dot = key.lastIndexOf('.', descriptorAt);
  if (dot <= 0 || descriptorAt <= dot + 1 || !key.includes(')', descriptorAt)) {
    throw new Error(`invalid method mapping key ${key}; expected owner.name(descriptor)return`);
  }
  return {
    key,
    owner: key.slice(0, dot),
    name: key.slice(dot + 1, descriptorAt),
    descriptor: key.slice(descriptorAt),
  };
}

function normalizeRenameMap(raw) {
  assertPlainObject(raw, 'rename map');
  if (raw.formatVersion !== 1) {
    throw new Error(`unsupported rename map formatVersion: ${raw.formatVersion}`);
  }
  const sections = {};
  for (const section of ['classes', 'fields', 'methods']) {
    const value = raw[section] || {};
    assertPlainObject(value, section);
    sections[section] = value;
  }

  const classes = Object.entries(sections.classes)
    .map(([oldName, newName]) => {
      assertInternalClassName(oldName, 'class mapping source');
      assertInternalClassName(newName, 'class mapping target');
      return { oldName, newName };
    })
    .sort((left, right) => left.oldName.localeCompare(right.oldName));
  const fields = Object.entries(sections.fields)
    .map(([key, newName]) => {
      const parsed = parseFieldKey(key);
      assertJavaIdentifier(newName, `field mapping target for ${key}`);
      return { ...parsed, newName };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const methods = Object.entries(sections.methods)
    .map(([key, newName]) => {
      const parsed = parseMethodKey(key);
      if (parsed.name === '<init>' || parsed.name === '<clinit>') {
        throw new Error(`constructors cannot be renamed independently: ${key}`);
      }
      assertJavaIdentifier(newName, `method mapping target for ${key}`);
      return { ...parsed, newName };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  return { formatVersion: 1, classes, fields, methods };
}

function classNode(workspace, owner) {
  const entry = workspace.workspaceASTs[owner];
  return entry && entry.ast && entry.ast.classes && entry.ast.classes[0];
}

function fieldItems(cls) {
  return (cls.items || []).filter((item) => item && item.type === 'field' && item.field)
    .map((item) => item.field);
}

function methodItems(cls) {
  return (cls.items || []).filter((item) => item && item.type === 'method' && item.method)
    .map((item) => item.method);
}

function javaParameterDescriptor(descriptor) {
  const end = descriptor.indexOf(')');
  return end < 0 ? descriptor : descriptor.slice(0, end + 1);
}

function validateRenamePlan(workspace, plan) {
  const errors = [];
  const existingClasses = new Set(Object.keys(workspace.workspaceASTs));
  const classTargets = new Map();

  for (const item of plan.classes) {
    if (!existingClasses.has(item.oldName)) {
      errors.push(`class mapping source does not exist: ${item.oldName}`);
    }
    const prior = classTargets.get(item.newName);
    if (prior && prior !== item.oldName) {
      errors.push(`class mappings ${prior} and ${item.oldName} both target ${item.newName}`);
    }
    classTargets.set(item.newName, item.oldName);
    if (existingClasses.has(item.newName)
        && !plan.classes.some((candidate) => candidate.oldName === item.newName)) {
      errors.push(`class mapping target already exists: ${item.newName}`);
    }
  }

  const fieldTargets = new Map();
  for (const item of plan.fields) {
    const cls = classNode(workspace, item.owner);
    if (!cls) {
      errors.push(`field mapping owner does not exist: ${item.owner}`);
      continue;
    }
    const fields = fieldItems(cls);
    if (!fields.some((field) => field.name === item.name && field.descriptor === item.descriptor)) {
      errors.push(`field mapping source does not exist: ${item.key}`);
      continue;
    }
    const targetKey = `${item.owner}.${item.newName}`;
    const prior = fieldTargets.get(targetKey);
    if (prior && prior !== item.key) {
      errors.push(`field mappings ${prior} and ${item.key} both target ${targetKey}`);
    }
    fieldTargets.set(targetKey, item.key);
    if (fields.some((field) => field.name === item.newName && field.name !== item.name)) {
      errors.push(`field mapping target already exists: ${targetKey}`);
    }
  }

  const methodTargets = new Map();
  for (const item of plan.methods) {
    const cls = classNode(workspace, item.owner);
    if (!cls) {
      errors.push(`method mapping owner does not exist: ${item.owner}`);
      continue;
    }
    const methods = methodItems(cls);
    if (!methods.some((method) => method.name === item.name
        && method.descriptor === item.descriptor)) {
      errors.push(`method mapping source does not exist: ${item.key}`);
      continue;
    }
    const targetKey = `${item.owner}.${item.newName}${javaParameterDescriptor(item.descriptor)}`;
    const prior = methodTargets.get(targetKey);
    if (prior && prior !== item.key) {
      errors.push(`method mappings ${prior} and ${item.key} both target ${targetKey}`);
    }
    methodTargets.set(targetKey, item.key);
    if (methods.some((method) => method.name === item.newName
        && method.name !== item.name
        && javaParameterDescriptor(method.descriptor)
          === javaParameterDescriptor(item.descriptor))) {
      errors.push(`method mapping target already exists: ${targetKey}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`rename map validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
}

function writeWorkspace(workspace, inputDir, outputDir) {
  for (const [originalName, entry] of Object.entries(workspace.workspaceASTs)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const cls = entry.ast.classes[0];
    const originalPath = workspace.classFilePaths[originalName];
    if (originalPath) {
      const copiedOriginal = path.join(outputDir, path.relative(inputDir, originalPath));
      const desired = path.join(outputDir, `${cls.className}.class`);
      if (path.resolve(copiedOriginal) !== path.resolve(desired)) {
        fs.rmSync(copiedOriginal, { force: true });
      }
    }
    const outputFile = path.join(outputDir, `${cls.className}.class`);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    writeClassAstToClassFile(entry.ast, outputFile, entry.constantPool);
  }
}

async function applyRenameMap(inputDir, outputDir, rawMap, options = {}) {
  const startedAt = performance.now();
  const timingsMs = {};
  const measure = (name, phaseStartedAt) => {
    timingsMs[name] = Number((performance.now() - phaseStartedAt).toFixed(3));
  };
  const resolvedInput = path.resolve(inputDir);
  const resolvedOutput = path.resolve(outputDir);
  if (resolvedInput === resolvedOutput) {
    throw new Error('input and output directories must be different');
  }
  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`input directory does not exist: ${resolvedInput}`);
  }
  if (fs.existsSync(resolvedOutput)) {
    if (!options.force) {
      throw new Error(`output directory already exists: ${resolvedOutput}`);
    }
    fs.rmSync(resolvedOutput, { recursive: true, force: true });
  }

  let phaseStartedAt = performance.now();
  const plan = normalizeRenameMap(rawMap);
  measure('normalizeMap', phaseStartedAt);

  phaseStartedAt = performance.now();
  const workspace = await KrakatauWorkspace.create(resolvedInput);
  measure('loadWorkspace', phaseStartedAt);

  phaseStartedAt = performance.now();
  validateRenamePlan(workspace, plan);
  measure('validatePlan', phaseStartedAt);

  phaseStartedAt = performance.now();
  renameFields(workspace, plan.fields);
  measure('renameFields', phaseStartedAt);

  phaseStartedAt = performance.now();
  renameMethods(workspace, plan.methods);
  measure('renameMethods', phaseStartedAt);

  phaseStartedAt = performance.now();
  renameClasses(workspace, plan.classes);
  measure('renameClasses', phaseStartedAt);

  phaseStartedAt = performance.now();
  fs.cpSync(resolvedInput, resolvedOutput, { recursive: true, force: true });
  measure('copyInputTree', phaseStartedAt);

  phaseStartedAt = performance.now();
  writeWorkspace(workspace, resolvedInput, resolvedOutput);
  measure('writeWorkspace', phaseStartedAt);
  timingsMs.total = Number((performance.now() - startedAt).toFixed(3));

  const result = {
    formatVersion: 1,
    input: resolvedInput,
    output: resolvedOutput,
    renamed: {
      classes: plan.classes.length,
      fields: plan.fields.length,
      methods: plan.methods.length,
    },
  };
  if (options.profile) result.timingsMs = timingsMs;
  return result;
}

async function applyRenameMapFile(inputDir, mapFile, outputDir, options = {}) {
  const rawMap = JSON.parse(fs.readFileSync(path.resolve(mapFile), 'utf8'));
  return applyRenameMap(inputDir, outputDir, rawMap, options);
}

module.exports = {
  normalizeRenameMap,
  validateRenamePlan,
  applyRenameMap,
  applyRenameMapFile,
};
