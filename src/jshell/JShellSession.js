'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../core/jvm');
const { compileJavaSource, parseJava } = require('../java-frontend');

const MEMBER_KINDS = new Map([
  ['FieldDeclaration', 'variable'],
  ['MethodDeclaration', 'method'],
  ['ClassDeclaration', 'type'],
  ['InterfaceDeclaration', 'type'],
  ['EnumDeclaration', 'type'],
  ['AnnotationTypeDeclaration', 'type'],
  ['RecordDeclaration', 'type'],
]);

function normalizeClasspath(classpath) {
  if (!classpath) return [];
  if (Array.isArray(classpath)) return classpath.filter(Boolean).map(String);
  return String(classpath).split(path.delimiter).filter(Boolean);
}

function memberName(member) {
  if (!member) return null;
  if (typeof member.name === 'string') return member.name;
  if (Array.isArray(member.declarators) && member.declarators.length === 1) {
    return member.declarators[0].name || null;
  }
  return null;
}

function supportedType(type) {
  return Boolean(type) && type.kind !== 'UnsupportedType';
}

function validMember(member, source) {
  if (member.kind === 'FieldDeclaration') {
    if (!supportedType(member.fieldType) || !Array.isArray(member.declarators) ||
        member.declarators.length === 0) {
      return false;
    }
    return member.declarators.every((declarator) => {
      if (!declarator.name) return false;
      const escapedName = declarator.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\s+${escapedName}(?:\\s|=|,|;|\\[)`).test(source);
    });
  }
  if (member.kind === 'MethodDeclaration') {
    return supportedType(member.returnType) &&
      (member.parameters || []).every((parameter) => supportedType(parameter.parameterType)) &&
      Boolean(member.body);
  }
  return MEMBER_KINDS.has(member.kind);
}

function classifyMember(source, imports) {
  const importText = imports.length ? `${imports.join('\n')}\n` : '';
  try {
    const document = parseJava(`${importText}class JShellMemberProbe {\n${source}\n}`);
    const declaration = document.root.typeDeclarations[0];
    if (!declaration || !Array.isArray(declaration.body) || declaration.body.length !== 1) {
      return null;
    }
    const member = declaration.body[0];
    const kind = MEMBER_KINDS.get(member.kind);
    return kind && validMember(member, source)
      ? { kind, name: memberName(member) }
      : null;
  } catch (_) {
    return null;
  }
}

function ensurePublicStatic(source) {
  const match = /^(\s*)((?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|transient|volatile)\s+)*)([\s\S]*)$/.exec(source);
  const indent = match[1];
  const modifiers = match[2].trim().split(/\s+/).filter(Boolean);
  const remainder = match[3];
  const retained = modifiers.filter((modifier) =>
    modifier !== 'public' && modifier !== 'protected' &&
    modifier !== 'private' && modifier !== 'static');
  const prefix = ['public', 'static', ...retained].join(' ');
  return `${indent}${prefix} ${remainder}`;
}

function ensureStatementTerminator(source) {
  const trimmed = source.trim();
  if (!trimmed || /[;}]\s*$/.test(trimmed)) return source;
  return `${source};`;
}

function candidateKinds(source, imports) {
  let memberSource = source;
  let member = classifyMember(memberSource, imports);
  if (member && member.kind === 'variable' && !/;\s*$/.test(memberSource.trim())) {
    memberSource = `${memberSource};`;
  }
  if (!member && !/;\s*$/.test(source.trim())) {
    memberSource = `${source};`;
    member = classifyMember(memberSource, imports);
  }
  if (member) return [{ ...member, body: ensurePublicStatic(memberSource) }];
  if (/;\s*$/.test(source.trim()) || /^[{}]/.test(source.trim())) {
    return [{ kind: 'statement', body: source }];
  }
  return [
    { kind: 'expression', body: source },
    { kind: 'statement', body: ensureStatementTerminator(source) },
  ];
}

function sourceForCandidate(className, previousClass, imports, candidate) {
  const importText = imports.length ? `${imports.join('\n')}\n\n` : '';
  const extendsText = previousClass ? ` extends ${previousClass}` : '';
  let members;
  if (candidate.kind === 'variable' ||
      candidate.kind === 'method' ||
      candidate.kind === 'type') {
    members = `  ${candidate.body.trim()}\n\n` +
      '  public static void main(String[] args) {\n' +
      '  }\n';
  } else if (candidate.kind === 'expression') {
    members = '  public static void main(String[] args) {\n' +
      `    System.out.println(${candidate.body.trim()});\n` +
      '  }\n';
  } else {
    const statement = candidate.body.trim().split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    members = '  public static void main(String[] args) {\n' +
      `${statement}\n` +
      '  }\n';
  }
  return `${importText}public class ${className}${extendsText} {\n${members}}\n`;
}

function removeGeneratedClasses(directory, className) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (name === `${className}.class` ||
        (name.startsWith(`${className}$`) && name.endsWith('.class'))) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }
}

function formatGuestError(error) {
  if (!error) return 'Unknown error';
  const type = error.type || error.name;
  let message = error.message;
  if (message && typeof message === 'object' &&
      Object.prototype.hasOwnProperty.call(message, 'value')) {
    message = message.value;
  }
  if (type) return message ? `${type}: ${String(message)}` : String(type);
  return error.stack || String(error);
}

class JShellSession {
  constructor(options = {}) {
    this.options = { ...options };
    this.keepWorkspace = Boolean(options.keepWorkspace);
    this.externalClasspath = normalizeClasspath(options.classpath);
    this._ownsWorkspace = !options.workspace;
    this.workspace = options.workspace
      ? path.resolve(options.workspace)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'java-tools-jshell-'));
    this.sourceDir = path.join(this.workspace, 'src');
    this.outputDir = path.join(this.workspace, 'classes');
    fs.mkdirSync(this.sourceDir, { recursive: true });
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.imports = [];
    this.snippets = [];
    this.previousClass = null;
    this.nextId = 1;
    this.jvm = this._createJvm();
  }

  _createJvm() {
    return new JVM({
      classpath: [this.outputDir, ...this.externalClasspath],
      verbose: Boolean(this.options.verbose),
      jit: this.options.jit === false ? { enabled: false } : this.options.jit,
    });
  }

  async evaluate(rawSource) {
    const source = String(rawSource || '').trim();
    if (!source) return { status: 'empty', kind: 'empty' };

    if (/^import\s+(?:static\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$*][\w$*]*)*\s*;?$/.test(source)) {
      const normalizedImport = /;\s*$/.test(source) ? source : `${source};`;
      if (!this.imports.includes(normalizedImport)) this.imports.push(normalizedImport);
      const result = {
        status: 'accepted',
        kind: 'import',
        source: normalizedImport,
        name: normalizedImport.replace(/^import\s+/, '').replace(/;$/, ''),
      };
      this.snippets.push(result);
      return result;
    }

    const id = this.nextId++;
    const className = `JShellSnippet${id}`;
    const sourcePath = path.join(this.sourceDir, `${className}.java`);
    const failures = [];
    let compiled = null;
    let candidate = null;
    let generatedSource = null;

    for (const nextCandidate of candidateKinds(source, this.imports)) {
      const nextSource = sourceForCandidate(
        className,
        this.previousClass,
        this.imports,
        nextCandidate,
      );
      fs.writeFileSync(sourcePath, nextSource);
      removeGeneratedClasses(this.outputDir, className);
      try {
        compiled = compileJavaSource(nextSource, {
          sourcePath,
          sourceFileName: `${className}.java`,
          sourceRoot: this.sourceDir,
          outputDir: this.outputDir,
          sourceLevel: this.options.sourceLevel || 8,
          cacheSourceMetadata: false,
        });
        candidate = nextCandidate;
        generatedSource = nextSource;
        break;
      } catch (error) {
        failures.push(error);
      }
    }

    if (!compiled) {
      fs.rmSync(sourcePath, { force: true });
      removeGeneratedClasses(this.outputDir, className);
      const error = failures[failures.length - 1] || new Error('Unable to compile snippet');
      error.jshellAttempts = failures;
      throw error;
    }

    try {
      await this.jvm.run(className);
    } catch (error) {
      fs.rmSync(sourcePath, { force: true });
      removeGeneratedClasses(this.outputDir, className);
      throw error;
    }

    const result = {
      status: 'accepted',
      kind: candidate.kind,
      name: candidate.name || null,
      source,
      className,
      generatedSource,
      written: compiled.written.map((entry) => entry.outputPath),
    };
    this.previousClass = className;
    this.snippets.push(result);
    return result;
  }

  list(kind = null) {
    return this.snippets.filter((snippet) => !kind || snippet.kind === kind);
  }

  async reset() {
    if (this._ownsWorkspace && fs.existsSync(this.workspace)) {
      fs.rmSync(this.workspace, { recursive: true, force: true });
      this.workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'java-tools-jshell-'));
      this.sourceDir = path.join(this.workspace, 'src');
      this.outputDir = path.join(this.workspace, 'classes');
    } else {
      fs.rmSync(this.sourceDir, { recursive: true, force: true });
      fs.rmSync(this.outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.sourceDir, { recursive: true });
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.imports = [];
    this.snippets = [];
    this.previousClass = null;
    this.nextId = 1;
    this.jvm = this._createJvm();
  }

  close() {
    if (this._ownsWorkspace && !this.keepWorkspace && fs.existsSync(this.workspace)) {
      fs.rmSync(this.workspace, { recursive: true, force: true });
    }
  }
}

module.exports = {
  JShellSession,
  candidateKinds,
  classifyMember,
  formatGuestError,
  sourceForCandidate,
};
