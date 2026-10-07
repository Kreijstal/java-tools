'use strict';
// Port of the langtools build tool propertiesparser.PropertiesParser
// (make/langtools/tools/propertiesparser): compiler.properties ->
// CompilerProperties.java factory classes.

const fs = require('fs');
const path = require('path');
const { LNSEP, javaTrim } = require('./util');
const { readUtf8Strict, loadProperties } = require('./props-load');

// String.split(regex) with limit 0: no match -> [s], trailing empties dropped
function javaSplit(s, re) {
  const g = new RegExp(re.source, 'g');
  if (!g.test(s)) return [s];
  const parts = s.split(re);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// Character.toUpperCase(char)
function upperChar(c) {
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
}

// Files.readAllLines: BufferedReader.readLine terminators
function readAllLines(file) {
  const text = readUtf8Strict(file);
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// java.text.MessageFormat.format with plain String/Integer arguments
function messageFormat(pattern, args) {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i++; } else inQuote = !inQuote;
    } else if (c === '{' && !inQuote) {
      const end = pattern.indexOf('}', i);
      if (end < 0) throw new Error('java.lang.IllegalArgumentException: Unmatched braces in the pattern.');
      const spec = pattern.slice(i + 1, end);
      if (!/^\s*\d+\s*$/.test(spec)) throw new Error('unsupported MessageFormat element {' + spec + '}');
      const n = parseInt(spec, 10);
      if (n >= args.length) out += '{' + n + '}';
      else {
        const a = args[n];
        if (a === null || a === undefined) out += 'null';
        else if (typeof a === 'number') out += a.toLocaleString('en-US', { maximumFractionDigits: 3 });
        else out += String(a);
      }
      i = end;
    } else out += c;
  }
  return out;
}

const DOT = '[^\\n\\r\\u0085\\u2028\\u2029]';
const emptyOrCommentPattern = new RegExp(`^( *#${DOT}*)?$`);
const typePattern = "[-\\\\'A-Z\\.a-z ]+( \\([-A-Za-z 0-9]+\\))?";
const infoPattern = new RegExp(`^# ([0-9]+: ${typePattern}, )*[0-9]+: ${typePattern}$`);
const lintPattern = /^# lint: ([a-z-]+)$/;
const diagnosticFlagsPattern = /^# flags: ([a-z-]+(, ([a-z-]+))*)$/;

class MessageLine {
  constructor(text) { this.text = text; this.prev = null; this.next = null; }
  isEmptyOrComment() { return emptyOrCommentPattern.test(this.text); }
  isInfo() { return infoPattern.test(this.text); }
  isLint() { return lintPattern.test(this.text); }
  lintCategory() { const m = lintPattern.exec(this.text); return m ? m[1] : null; }
  isDiagnosticFlags() { return diagnosticFlagsPattern.test(this.text); }
  diagnosticFlags() { const m = diagnosticFlagsPattern.exec(this.text); return m ? m[1].split(', ') : null; }
  hasContinuation() { return this.next !== null && this.text.endsWith('\\'); }
  append(text) {
    const l = new MessageLine(text);
    l.prev = this; l.next = this.next;
    if (this.next) this.next.prev = l;
    this.next = l;
    return l;
  }
}

// message types: {kind:'custom', typeString} | {kind:'simple', st} |
// {kind:'compound', ck, elem} | {kind:'union', uk|null, choices}
const SIMPLE = {};
for (const [name, kindName, clazz, qualifier] of [
  ['ANNOTATION', 'annotation', 'Compound', 'com.sun.tools.javac.code.Attribute'],
  ['BOOLEAN', 'boolean', 'boolean', null],
  ['COLLECTION', 'collection', 'Collection', 'java.util'],
  ['FLAG', 'flag', 'FlagsEnum', 'com.sun.tools.javac.code'],
  ['FRAGMENT', 'fragment', 'Fragment', null],
  ['DIAGNOSTIC', 'diagnostic', 'JCDiagnostic', 'com.sun.tools.javac.util'],
  ['MODIFIER', 'modifier', 'Modifier', 'javax.lang.model.element'],
  ['FILE', 'file', 'File', 'java.io'],
  ['FILE_OBJECT', 'file object', 'JavaFileObject', 'javax.tools'],
  ['PATH', 'path', 'Path', 'java.nio.file'],
  ['NAME', 'name', 'Name', 'com.sun.tools.javac.util'],
  ['LONG', 'long', 'long', null],
  ['NUMBER', 'number', 'int', null],
  ['OPTION_NAME', 'option name', 'Option', 'com.sun.tools.javac.main'],
  ['PROFILE', 'profile', 'Profile', 'com.sun.tools.javac.jvm'],
  ['SOURCE', 'source', 'Source', 'com.sun.tools.javac.code'],
  ['SOURCE_VERSION', 'source version', 'SourceVersion', 'javax.lang.model'],
  ['STRING', 'string', 'String', null],
  ['SYMBOL', 'symbol', 'Symbol', 'com.sun.tools.javac.code'],
  ['SYMBOL_KIND', 'symbol kind', 'Kind', 'com.sun.tools.javac.code.Kinds'],
  ['KIND_NAME', 'kind name', 'KindName', 'com.sun.tools.javac.code.Kinds'],
  ['TARGET', 'target', 'Target', 'com.sun.tools.javac.jvm'],
  ['TOKEN', 'token', 'TokenKind', 'com.sun.tools.javac.parser.Tokens'],
  ['TREE_TAG', 'tree tag', 'Tag', 'com.sun.tools.javac.tree.JCTree'],
  ['TYPE', 'type', 'Type', 'com.sun.tools.javac.code'],
  ['ANNOTATED_TYPE', 'annotated-type', 'AnnotatedType', 'com.sun.tools.javac.util.JCDiagnostic'],
  ['URL', 'url', 'URL', 'java.net'],
  ['SET', 'set', 'Set', 'java.util'],
  ['LIST', 'list', 'List', 'java.util'],
  ['OBJECT', 'object', 'Object', null],
  ['UNUSED', 'unused', 'Void', null],
  ['UNKNOWN', '<unknown>', 'UnknownType', null],
]) SIMPLE[name] = { name, kindName, clazz, qualifier };
const SIMPLE_VALUES = Object.values(SIMPLE);
const COMPOUND_KINDS = [
  { kindName: 'collection of', clazz: SIMPLE.COLLECTION },
  { kindName: 'list of', clazz: SIMPLE.LIST },
  { kindName: 'set of', clazz: SIMPLE.SET },
];
const UNION_KINDS = [
  { kindName: 'message segment', choices: [SIMPLE.DIAGNOSTIC, SIMPLE.FRAGMENT] },
  { kindName: 'file name', choices: [SIMPLE.FILE, SIMPLE.FILE_OBJECT, SIMPLE.PATH] },
];
const simple = (st) => ({ kind: 'simple', st });

function parseAlternative(text) {
  if (text.charAt(0) === "'") {
    const end = text.indexOf("'", 1);
    if (end < 0) throw new Error('java.lang.StringIndexOutOfBoundsException');
    return { kind: 'custom', typeString: text.slice(1, end) };
  }
  for (const st of SIMPLE_VALUES) if (text === st.kindName) return simple(st);
  for (const ck of COMPOUND_KINDS) {
    if (text.startsWith(ck.kindName)) {
      return { kind: 'compound', ck, elem: parseAlternative(javaTrim(text.slice(ck.kindName.length + 1))) };
    }
  }
  for (const uk of UNION_KINDS) {
    if (text.startsWith(uk.kindName)) return { kind: 'union', uk, choices: uk.choices.map(simple) };
  }
  process.stderr.write('WARNING - unrecognized type: ' + text + LNSEP);
  return simple(SIMPLE.UNKNOWN);
}

function parseType(text) {
  const commentStart = text.indexOf('(');
  if (commentStart !== -1) text = text.slice(0, commentStart);
  text = text.slice(text.indexOf(': ') + 2);
  const alts = javaSplit(text, / or /);
  const types = alts.map((a) => parseAlternative(javaTrim(a)));
  return types.length > 1 ? { kind: 'union', uk: null, choices: types } : types[0];
}

function messageInfoTypes(text) {
  if (text === null) return [];
  if (!text.startsWith('# ')) throw new Error('java.lang.IllegalArgumentException');
  return javaSplit(text.slice(2), /, /).map(parseType);
}

class Message {
  constructor(firstLine) { this.firstLine = firstLine; this.info = undefined; }
  getTypes() {
    if (this.info === undefined) {
      let l = this.firstLine.prev;
      while (l !== null && (l.isLint() || l.isDiagnosticFlags())) l = l.prev;
      this.info = messageInfoTypes(l !== null && l.isInfo() ? l.text : null);
    }
    return this.info;
  }
  getLines() {
    const lines = [];
    let l = this.firstLine;
    while (l.prev !== null && (l.prev.isInfo() || l.prev.isLint() || l.prev.isDiagnosticFlags())) l = l.prev;
    for (; l !== this.firstLine; l = l.next) lines.push(l);
    for (l = this.firstLine; l !== null && l.hasContinuation(); l = l.next) lines.push(l);
    lines.push(l);
    l = l.next;
    if (l !== null && l.text === '') lines.push(l);
    return lines;
  }
}

function readMessageFile(file, keyPrefix) {
  const messages = new Map();
  let curr = null;
  for (const line of readAllLines(file)) {
    curr = curr === null ? new MessageLine(line) : curr.append(line);
    if (line.startsWith(keyPrefix + '.')) {
      const eq = line.indexOf('=');
      if (eq > 0) messages.set(javaTrim(line.slice(0, eq)), new Message(curr));
    }
  }
  return messages;
}

let stubs = null;
function stub(key, ...args) {
  if (stubs === null) {
    stubs = loadProperties(require('./propertiesparser-templates'));
  }
  return messageFormat(stubs.get(key), args);
}

const INDENT_STRING = ' '.repeat(67);
function indent(s, level) {
  return javaSplit(s, /\n/).map((sub) => INDENT_STRING.slice(0, level * 4) + sub).join('\n');
}

const FACTORY_KINDS = [
  { name: 'ERR', prefix: 'err', keyClazz: 'Error', factoryClazz: 'Errors' },
  { name: 'WARN', prefix: 'warn', keyClazz: 'Warning', factoryClazz: 'Warnings' },
  { name: 'LINT_WARN', prefix: 'warn', keyClazz: 'LintWarning', factoryClazz: 'LintWarnings' },
  { name: 'NOTE', prefix: 'note', keyClazz: 'Note', factoryClazz: 'Notes' },
  { name: 'MISC', prefix: 'misc', keyClazz: 'Fragment', factoryClazz: 'Fragments' },
  { name: 'OTHER', prefix: null, keyClazz: null, factoryClazz: null },
];

function factoryKindOf(key, msg) {
  const prefix = javaSplit(key, /\./)[1];
  if (prefix === undefined) throw new Error('java.lang.ArrayIndexOutOfBoundsException: Index 1 out of bounds for length 1');
  let selected = FACTORY_KINDS.find((k) => k.prefix === null || k.prefix === prefix);
  if (selected.name === 'WARN' && msg.getLines().some((l) => l.isLint())) selected = FACTORY_KINDS[2];
  return selected;
}

// MessageType visitors
function typeString(t) {
  switch (t.kind) {
    case 'custom': return t.typeString.slice(t.typeString.lastIndexOf('.') + 1);
    case 'simple': return t.st.clazz;
    case 'compound': return stub('wildcards.extends', t.ck.clazz.clazz, typeString(t.elem));
    default: throw new Error('Union types should have been denormalized!');
  }
}
function needsSuppress(t) {
  switch (t.kind) {
    case 'custom': return true;
    case 'simple': return t.st === SIMPLE.LIST || t.st === SIMPLE.SET;
    case 'compound': return needsSuppress(t.elem);
    default: return t.choices.some(needsSuppress);
  }
}
function addImports(t, imports) {
  switch (t.kind) {
    case 'custom': imports.add(t.typeString); break;
    case 'simple': if (t.st.qualifier !== null) imports.add(t.st.qualifier + '.' + t.st.clazz); break;
    case 'compound': addImports(simple(t.ck.clazz), imports); addImports(t.elem, imports); break;
    default: for (const c of t.choices) addImports(c, imports);
  }
}
function normalize(t) {
  switch (t.kind) {
    case 'custom': case 'simple': return [t];
    case 'compound': return normalize(t.elem).map((nt) => ({ kind: 'compound', ck: t.ck, elem: nt }));
    default: return t.choices.flatMap(normalize);
  }
}
function normalizeTypes(idx, types) {
  if (types.length === idx) return [[]];
  const buf = [];
  for (const alt of normalize(types[idx])) {
    for (const rest of normalizeTypes(idx + 1, types)) buf.push([alt, ...rest]);
  }
  return buf;
}

function factoryName(key) {
  return javaSplit(key, /[.-]/).slice(2).map((s) => {
    if (s === '') throw new Error('java.lang.StringIndexOutOfBoundsException: index 0, length 0');
    return upperChar(s[0]) + s.slice(1);
  }).join('');
}

function generateFactoryMethodsAndFields(k, key, msg) {
  const types = msg.getTypes();
  const lines = msg.getLines();
  const javadoc = lines.filter((ml) => !ml.isInfo() && !ml.isEmptyOrComment()).map((ml) => ml.text).join('\n *');
  const keyParts = javaSplit(key, /\./);
  const lintLine = lines.find((l) => l.isLint());
  const lintCategory = lintLine ? lintLine.lintCategory() : null;
  const diagnosticFlags = lines.filter((l) => l.isDiagnosticFlags())
    .flatMap((l) => l.diagnosticFlags())
    .map((s) => s.replace(/-/g, '_').toUpperCase())
    .join(', ');
  const flags = diagnosticFlags === '' ? stub('diagnostic.flags.empty') : stub('diagnostic.flags.non-empty', diagnosticFlags);
  const prefixArg = '"' + keyParts[0] + '"';
  const keyArg = '"' + keyParts.slice(2).join('.') + '"';
  const lintArg = lintCategory === null ? null : stub('lint.category', lintCategory.toUpperCase().replace(/-/g, '_'));
  const fname = factoryName(key);
  if (types.length === 0) {
    return [lintArg === null
      ? stub('factory.decl.field', k.keyClazz, fname, flags, prefixArg, keyArg, javadoc)
      : stub('factory.decl.field.lint', k.keyClazz, fname, flags, lintArg, prefixArg, keyArg, javadoc)];
  }
  const methods = [];
  for (const msgTypes of normalizeTypes(0, types)) {
    const tnames = msgTypes.map(typeString);
    const argNames = tnames.map((_, i) => stub('factory.decl.method.arg', i));
    const suppression = msgTypes.some(needsSuppress) ? stub('suppress.warnings') : '';
    const body = lintArg === null
      ? stub('factory.decl.method.body', k.keyClazz, flags, prefixArg, keyArg, argNames.join(', '))
      : stub('factory.decl.method.body.lint', k.keyClazz, flags, lintArg, prefixArg, keyArg, argNames.join(', '));
    methods.push(stub('factory.decl.method', suppression, k.keyClazz, fname,
      tnames.map((t, i) => t + ' ' + argNames[i]).join(', '), indent(body, 1), javadoc));
  }
  return methods;
}

const WIN = process.platform === 'win32';
const SEP = WIN ? '\\' : '/';

function packageName(file) {
  const p = path.resolve(file);
  const begin = p.lastIndexOf(SEP + 'com' + SEP);
  return p.slice(begin + 1, p.lastIndexOf(SEP)).split(SEP).join('.');
}

function toplevelName(file) {
  return javaSplit(path.basename(file), /\./).map((s) => upperChar(s[0]) + s.slice(1)).join('');
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function generateFactory(file, messages, outDir) {
  const grouped = new Map(FACTORY_KINDS.map((k) => [k, []]));
  for (const key of [...messages.keys()].sort(cmpStr)) {
    const msg = messages.get(key);
    grouped.get(factoryKindOf(key, msg)).push([key, msg]);
  }
  const nestedDecls = [];
  const imported = new Set();
  for (const [k, entries] of grouped) {
    if (entries.length === 0 || k.name === 'OTHER') continue;
    const members = entries.flatMap(([key, msg]) => generateFactoryMethodsAndFields(k, key, msg)).join('\n\n');
    nestedDecls.push(indent(stub('nested.decl', k.factoryClazz, indent(members, 1)), 1));
    for (const [, msg] of entries) for (const t of msg.getTypes()) addImports(t, imported);
  }
  const imports = [...imported].sort(cmpStr).map((it) => stub('import.decl', it));
  const clazz = stub('toplevel.decl', packageName(file), imports.join('\n'), toplevelName(file), nestedDecls.join('\n'));
  // FileWriter: default charset (UTF-8)
  fs.writeFileSync(path.join(outDir, toplevelName(file) + '.java'), clazz, 'utf8');
}

function main(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-compile' && i + 2 < args.length) options.set(args[++i], args[++i]);
    else { options.clear(); break; }
  }
  if (options.size === 0) {
    for (const l of ['usage:', '    java PropertiesParser {-compile path_to_properties_file path_to_java_output_dir}',
      '', 'Example:', '    java PropertiesParser -compile resources/test.properties resources']) process.stdout.write(l + LNSEP);
    return 1;
  }
  try {
    for (const propertyPath of [...options.keys()].sort(cmpStr)) {
      const prefix = javaSplit(path.basename(propertyPath), /\./)[0];
      generateFactory(propertyPath, readMessageFile(propertyPath, prefix), options.get(propertyPath));
    }
    return 0;
  } catch (e) {
    process.stderr.write('java.lang.RuntimeException: ' + (e.stack || e) + LNSEP);
    return 1;
  }
}

module.exports = { main, messageFormat, javaSplit };
