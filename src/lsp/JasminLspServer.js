'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { formatJasminSource, normalizeNewlines } = require('../jasminFormatter');
const { OPCODE_NAMES } = require('./opcodeList');
const { KrakatauWorkspace } = require('../KrakatauWorkspace');

const LABEL_CHAR_REGEX = /[A-Za-z0-9_.$]/;
const METHOD_SIGNATURE_REGEX =
  /([0-9A-Za-z_/$]+)\.([0-9A-Za-z_$<>$]+)(\((?:\[*(?:[BCDFIJSZ]|L[0-9A-Za-z_/$]+;))*\)(?:\[*(?:[BCDFIJSZV]|L[0-9A-Za-z_/$]+;)))/g;

function isLabelChar(ch) {
  if (!ch) return false;
  return LABEL_CHAR_REGEX.test(ch);
}

function parseMethodDeclaration(line) {
  const declMatch = line.match(/^\s*\.method\b(.*)$/);
  if (!declMatch) {
    return null;
  }
  const rest = declMatch[1].trim();
  if (!rest) {
    return null;
  }
  const colonIndex = rest.indexOf(':');
  if (colonIndex !== -1) {
    const before = rest.slice(0, colonIndex).trim();
    const after = rest.slice(colonIndex + 1).trim();
    const descriptor = after.split(/\s+/)[0];
    const name = before.split(/\s+/).pop();
    if (name && descriptor) {
      return { name, descriptor };
    }
    return null;
  }
  const parenIndex = rest.indexOf('(');
  if (parenIndex !== -1) {
    const name = rest.slice(0, parenIndex).trim().split(/\s+/).pop();
    const descriptor = rest.slice(parenIndex).trim().split(/\s+/)[0];
    if (name && descriptor) {
      return { name, descriptor };
    }
  }
  return null;
}

function parseClassDirective(line) {
  const declMatch = line.match(/^\s*\.class\b(.*)$/);
  if (!declMatch) {
    return null;
  }
  let rest = declMatch[1];
  const commentIndex = rest.indexOf(';');
  if (commentIndex !== -1) {
    rest = rest.slice(0, commentIndex);
  }
  rest = rest.trim();
  if (!rest) {
    return null;
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return null;
  }
  return tokens[tokens.length - 1];
}

function parseFieldDeclaration(line) {
  const declMatch = line.match(/^\s*\.field\b(.*)$/);
  if (!declMatch) {
    return null;
  }
  let rest = declMatch[1];
  const commentIndex = rest.indexOf(';');
  if (commentIndex !== -1) {
    rest = rest.slice(0, commentIndex);
  }
  rest = rest.trim();
  if (!rest) {
    return null;
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }
  const descriptor = tokens[tokens.length - 1];
  const name = tokens[tokens.length - 2];
  if (!name || !descriptor) {
    return null;
  }
  return { name, descriptor };
}

class JasminLspServer {
  constructor(connection) {
    this.connection = connection;
    this.documents = new Map();
    this.symbolIndex = new Map();
    this.shutdownRequested = false;
    this.rootPath = null;
    this.classpathEntries = [];
    this.workspaceMethodsByClass = new Map();
    this.workspaceFieldsByClass = new Map();
    this.workspaceConstants = [];
    this.workspaceLoadPromise = null;
  }

  async initialize(params = {}) {
    if (params.rootUri) {
      try {
        this.rootPath = fileURLToPath(params.rootUri);
      } catch (_err) {
        this.rootPath = null;
      }
    }
    this.classpathEntries = this._normalizeClasspath(
      params?.initializationOptions?.classpath,
    );
    if (this.classpathEntries.length > 0) {
      this.workspaceLoadPromise = this._loadWorkspaceSymbols(this.classpathEntries);
    }
    return {
      capabilities: {
        textDocumentSync: 1,
        documentFormattingProvider: true,
        definitionProvider: true,
        completionProvider: {
          triggerCharacters: [' ', '\t', ':'],
        },
      },
    };
  }

  async shutdown() {
    this.documents.clear();
    this.symbolIndex.clear();
    this.shutdownRequested = true;
    return null;
  }

  handleNotification(method, params) {
    switch (method) {
      case 'textDocument/didOpen': {
        const uri = params?.textDocument?.uri;
        if (!uri) break;
        const text = params.textDocument.text || '';
        this.documents.set(uri, text);
        this._updateSymbolIndex(uri, text);
        break;
      }
      case 'textDocument/didChange': {
        const uri = params?.textDocument?.uri;
        if (!uri) break;
        const change = params.contentChanges?.[0];
        const text = typeof change?.text === 'string' ? change.text : '';
        this.documents.set(uri, text);
        this._updateSymbolIndex(uri, text);
        break;
      }
      case 'textDocument/didClose':
        if (params?.textDocument?.uri) {
          this.documents.delete(params.textDocument.uri);
          this.symbolIndex.delete(params.textDocument.uri);
        }
        break;
      case 'exit':
        process.exit(this.shutdownRequested ? 0 : 1);
        break;
      default:
        break;
    }
  }

  async handleRequest(method, params) {
    if (method === 'shutdown') {
      return this.shutdown();
    }
    if (method === 'textDocument/formatting') {
      return this.handleFormatting(params);
    }
    if (method === 'textDocument/definition') {
      return this.handleDefinition(params);
    }
    if (method === 'textDocument/completion') {
      return this.handleCompletion(params);
    }
    throw new Error(`Unsupported request: ${method}`);
  }

  handleFormatting(params) {
    if (!params?.textDocument?.uri) {
      throw new Error('textDocument.uri is required');
    }
    const uri = params.textDocument.uri;
    const currentText = this._getDocumentText(uri);
    if (typeof currentText !== 'string') {
      throw new Error(`Document not open or unreadable: ${uri}`);
    }
    const formatted = formatJasminSource(currentText);
    if (normalizeNewlines(formatted) === normalizeNewlines(currentText)) {
      return [];
    }
    const lineCount = normalizeNewlines(currentText).split('\n').length;
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lineCount, character: 0 },
        },
        newText: formatted,
      },
    ];
  }

  handleDefinition(params) {
    const uri = params?.textDocument?.uri;
    const position = params?.position;
    if (!uri || !position) {
      throw new Error('textDocument/definition requires textDocument and position');
    }
    const text = this._getDocumentText(uri);
    if (typeof text !== 'string') {
      throw new Error(`Document not open or unreadable: ${uri}`);
    }
    const lines = normalizeNewlines(text).split('\n');
    const lineText = lines[position.line] || '';
    const docInfo = this.symbolIndex.get(uri);
    const enclosingMethod = this._findEnclosingMethod(docInfo, position.line);
    const reference = this._extractReference(lineText, position.character, enclosingMethod);
    if (!reference) {
      return null;
    }

    if (reference.type === 'label') {
      if (!enclosingMethod) return null;
      const labelInfo = enclosingMethod.labels.get(reference.name);
      if (!labelInfo) return null;
      return [
        {
          uri,
          range: labelInfo.range,
        },
      ];
    }

    if (reference.type === 'method') {
      const matches = this._findMethodDefinitions(
        reference.className,
        reference.methodName,
        reference.descriptor,
        uri,
      );
      if (matches.length) {
        return matches;
      }
    }

    if (reference.type === 'class') {
      const classLocation = this._findClassDefinition(reference.className, uri);
      if (classLocation) {
        return [classLocation];
      }
    }

    return null;
  }

  async handleCompletion(params) {
    const uri = params?.textDocument?.uri;
    const position = params?.position;
    if (!uri || !position) {
      throw new Error('textDocument/completion requires textDocument and position');
    }
    const text = this._getDocumentText(uri);
    if (typeof text !== 'string') {
      return [];
    }
    const lines = normalizeNewlines(text).split('\n');
    const lineText = lines[position.line] || '';
    const beforeCursor = lineText.slice(0, position.character);
    const commentIndex = beforeCursor.indexOf(';');
    const inComment = commentIndex !== -1;

    const methodItems = await this._buildMethodCompletions(
      uri,
      lineText,
      position,
      beforeCursor,
    );
    const fieldItems = await this._buildFieldCompletions(
      uri,
      lineText,
      position,
      beforeCursor,
    );
    if ((methodItems && methodItems.length) || (fieldItems && fieldItems.length)) {
      return [...(methodItems || []), ...(fieldItems || [])];
    }
    if (!inComment) {
      const constantItems = this._buildConstantCompletions(position, beforeCursor);
      if (constantItems?.length) {
        return constantItems;
      }
      const opcodeItems = this._buildOpcodeCompletions(lineText, position, beforeCursor);
      if (opcodeItems?.length) {
        return opcodeItems;
      }
    }
    return [];
  }

  _getDocumentText(uri) {
    if (this.documents.has(uri)) {
      return this.documents.get(uri);
    }
    if (uri.startsWith('file://')) {
      try {
        return fs.readFileSync(fileURLToPath(uri), 'utf8');
      } catch (_err) {
        return null;
      }
    }
    return null;
  }

  _updateSymbolIndex(uri, text) {
    if (typeof text !== 'string') {
      this.symbolIndex.delete(uri);
      return;
    }
    const info = {
      className: null,
      methods: new Map(),
      methodList: [],
      fields: new Map(),
      fieldList: [],
    };
    const lines = normalizeNewlines(text).split('\n');
    let currentMethod = null;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber];
      const className = parseClassDirective(line);
      if (className) {
        info.className = className;
      }
      const methodDecl = parseMethodDeclaration(line);
      if (methodDecl) {
        const { name, descriptor } = methodDecl;
        const key = `${name}${descriptor}`;
        const nameIndex = line.indexOf(name);
        const entry = {
          name,
          descriptor,
          key,
          uri,
          range: {
            start: { line: lineNumber, character: Math.max(0, nameIndex) },
            end: { line: lineNumber, character: Math.max(0, nameIndex) + name.length },
          },
          bodyRange: { startLine: lineNumber, endLine: lineNumber },
          labels: new Map(),
        };
        info.methods.set(key, entry);
        info.methodList.push(entry);
        currentMethod = entry;
        continue;
      }
      const fieldDecl = parseFieldDeclaration(line);
      if (fieldDecl && info.className) {
        const key = `${fieldDecl.name}${fieldDecl.descriptor}`;
        const nameIndex = line.indexOf(fieldDecl.name);
        const entry = {
          name: fieldDecl.name,
          descriptor: fieldDecl.descriptor,
          key,
          uri,
          range: {
            start: { line: lineNumber, character: Math.max(0, nameIndex) },
            end: { line: lineNumber, character: Math.max(0, nameIndex) + fieldDecl.name.length },
          },
        };
        info.fields.set(key, entry);
        info.fieldList.push(entry);
      }
      if (/^\s*\.end\s+method\b/.test(line)) {
        if (currentMethod) {
          currentMethod.bodyRange.endLine = lineNumber;
        }
        currentMethod = null;
        continue;
      }
      if (currentMethod) {
        currentMethod.bodyRange.endLine = lineNumber;
        const labelMatch = line.match(/^\s*([A-Za-z0-9_.$]+):/);
        if (labelMatch) {
          const label = labelMatch[1];
          const charIndex = line.indexOf(label);
          currentMethod.labels.set(label, {
            range: {
              start: { line: lineNumber, character: Math.max(0, charIndex) },
              end: { line: lineNumber, character: Math.max(0, charIndex) + label.length },
            },
          });
        }
      }
    }
    this.symbolIndex.set(uri, info);
  }

  _extractReference(line, character, methodEntry) {
    const methodRegex =
      /(invoke(?:virtual|special|static|interface)\s+(?:Interface)?Method\s+([^\s]+)\s+([^\s]+)\s+([^\s]+))(?:\s+\d+)?/g;
    let match;
    while ((match = methodRegex.exec(line))) {
      const className = match[2];
      const methodName = match[3];
      const descriptor = match[4];
      const classStart = line.indexOf(className, match.index);
      const classEnd = classStart + className.length;
      const methodStart = line.indexOf(methodName, classEnd);
      const methodEnd = methodStart + methodName.length;
      if (character >= methodStart && character <= methodEnd) {
        return { type: 'method', className, methodName, descriptor };
      }
    }
    const signatureRegex = new RegExp(METHOD_SIGNATURE_REGEX.source, 'g');
    while ((match = signatureRegex.exec(line))) {
      const className = match[1];
      const methodName = match[2];
      const descriptor = match[3];
      const start = match.index;
      const end = start + match[0].length;
      if (character >= start && character <= end) {
        return { type: 'method', className, methodName, descriptor };
      }
    }
    if (methodEntry) {
      for (const label of methodEntry.labels.keys()) {
        let searchIndex = -1;
        while ((searchIndex = line.indexOf(label, searchIndex + 1)) !== -1) {
          const start = searchIndex;
          const end = start + label.length;
          const beforeChar = line[start - 1];
          const afterChar = line[end];
          if (afterChar === ':') {
            continue;
          }
          if (isLabelChar(beforeChar) || isLabelChar(afterChar)) {
            continue;
          }
          if (character >= start && character <= end) {
            return { type: 'label', name: label };
          }
        }
      }
    }
    const className = parseClassDirective(line);
    if (className) {
      const start = line.lastIndexOf(className);
      if (start !== -1) {
        const end = start + className.length;
        if (character >= start && character <= end) {
          return { type: 'class', className };
        }
      }
    }
    return null;
  }

  _findEnclosingMethod(docInfo, lineNumber) {
    if (!docInfo) return null;
    return docInfo.methodList.find(
      (method) =>
        lineNumber >= method.bodyRange.startLine && lineNumber <= method.bodyRange.endLine,
    );
  }

  _findMethodDefinitions(className, methodName, descriptor, currentUri) {
    const key = `${methodName}${descriptor}`;
    const results = [];
    for (const [uri, info] of this.symbolIndex.entries()) {
      if (info.className === className) {
        const methodEntry = info.methods.get(key);
        if (methodEntry) {
          results.push({ uri, range: methodEntry.range });
        }
      }
    }
    if (results.length) {
      return results;
    }
    const resolvedUri = this._resolveClassUri(className, currentUri);
    if (resolvedUri && !this.symbolIndex.has(resolvedUri)) {
      const text = this._getDocumentText(resolvedUri);
      if (typeof text === 'string') {
        this.documents.set(resolvedUri, text);
        this._updateSymbolIndex(resolvedUri, text);
        return this._findMethodDefinitions(className, methodName, descriptor, currentUri);
      }
    }
    return results;
  }

  _findClassDefinition(className, currentUri) {
    for (const [uri, info] of this.symbolIndex.entries()) {
      if (info.className === className) {
        const line = this._findClassLine(uri, className);
        if (line != null) {
          return {
            uri,
            range: {
              start: { line, character: 0 },
              end: { line, character: className.length },
            },
          };
        }
      }
    }
    const targetUri = this._resolveClassUri(className, currentUri);
    if (targetUri && !this.symbolIndex.has(targetUri)) {
      const text = this._getDocumentText(targetUri);
      if (typeof text === 'string') {
        this.documents.set(targetUri, text);
        this._updateSymbolIndex(targetUri, text);
        return this._findClassDefinition(className, currentUri);
      }
    }
    return null;
  }

  _findClassLine(uri, className) {
    const text = this._getDocumentText(uri);
    if (typeof text !== 'string') return null;
    const lines = normalizeNewlines(text).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('.class') && lines[i].includes(className)) {
        return i;
      }
    }
    return null;
  }

  _buildOpcodeCompletions(lineText, position, beforeCursor) {
    const tokenMatch = beforeCursor.match(/([A-Za-z][A-Za-z0-9_.$]*)$/);
    let partial = '';
    let tokenStart = position.character;
    if (tokenMatch) {
      partial = tokenMatch[1];
      tokenStart = position.character - partial.length;
      const prevChar = lineText[tokenStart - 1];
      if (prevChar && !/\s|:/.test(prevChar)) {
        return null;
      }
    } else if (beforeCursor.trim().length !== 0 && !beforeCursor.trim().endsWith(':')) {
      return null;
    }
    const lowerPartial = partial.toLowerCase();
    const matches = OPCODE_NAMES.filter((name) => name.startsWith(lowerPartial)).slice(0, 50);
    if (!matches.length) {
      return null;
    }
    return matches.map((name) => ({
      label: name,
      kind: 14,
      detail: 'Jasmin opcode',
      sortText: `0_${name}`,
      textEdit: {
        range: {
          start: { line: position.line, character: tokenStart },
          end: { line: position.line, character: position.character },
        },
        newText: name,
      },
    }));
  }

  _buildConstantCompletions(position, beforeCursor) {
    const trimmed = beforeCursor.replace(/[ \t\r]+$/, '');
    const constMatch = trimmed.match(/ldc(?:2_w|_w)?\s+"([^"]*)$/);
    if (!constMatch) {
      return null;
    }
    const partial = constMatch[1] || '';
    const quoteIndex = beforeCursor.lastIndexOf('"');
    if (quoteIndex === -1) {
      return null;
    }
    const tokenStart = quoteIndex + 1;
    const candidates = this._collectConstantCandidates();
    if (!candidates.length) {
      return null;
    }
    const lowerPartial = partial.toLowerCase();
    const filtered = candidates
      .filter((value) => value.toLowerCase().startsWith(lowerPartial))
      .slice(0, 50);
    if (!filtered.length) {
      return null;
    }
    return filtered.map((value) => ({
      label: value,
      kind: 15,
      detail: 'workspace constant',
      sortText: `3_${value}`,
      textEdit: {
        range: {
          start: { line: position.line, character: tokenStart },
          end: { line: position.line, character: position.character },
        },
        newText: value,
      },
    }));
  }

  async _buildMethodCompletions(uri, lineText, position, beforeCursor) {
    const context = this._detectMethodContext(beforeCursor);
    if (!context) {
      return null;
    }
    const { className, partial, tokenStart } = context;
    const methods = await this._collectMethodsForClass(className, uri);
    if (!methods.length) {
      return null;
    }
    const lowerPartial = partial.toLowerCase();
    const filtered = methods
      .filter((method) => method.methodName.toLowerCase().startsWith(lowerPartial))
      .slice(0, 50);
    if (!filtered.length) {
      return null;
    }
    return filtered.map((method) => ({
      label: method.methodName,
      kind: 2,
      detail: `${className}.${method.methodName}${method.descriptor}`,
      sortText: `1_${method.methodName}`,
      textEdit: {
        range: {
          start: { line: position.line, character: tokenStart },
          end: { line: position.line, character: position.character },
        },
        newText: method.methodName,
      },
    }));
  }

  _detectMethodContext(beforeCursor) {
    const dotMatch = beforeCursor.match(/([A-Za-z0-9_/$]+)\.([A-Za-z0-9_<$]*)$/);
    if (dotMatch) {
      const className = dotMatch[1];
      const partial = dotMatch[2] || '';
      const tokenStart = beforeCursor.length - partial.length;
      return { className, partial, tokenStart };
    }
    const invokeMatch = beforeCursor.match(
      /(?:invoke(?:virtual|special|static|interface))\s+(?:Interface)?Method\s+([^\s]+)\s+([^\s]*)$/,
    );
    if (invokeMatch) {
      const className = invokeMatch[1];
      const partial = invokeMatch[2] || '';
      const tokenStart = beforeCursor.length - partial.length;
      return { className, partial, tokenStart };
    }
    return null;
  }

  async _buildFieldCompletions(uri, lineText, position, beforeCursor) {
    const context = this._detectFieldContext(beforeCursor);
    if (!context) {
      return null;
    }
    const { className, partial, tokenStart } = context;
    const fields = await this._collectFieldsForClass(className, uri);
    if (!fields.length) {
      return null;
    }
    const lowerPartial = partial.toLowerCase();
    const filtered = fields
      .filter((field) => field.fieldName.toLowerCase().startsWith(lowerPartial))
      .slice(0, 50);
    if (!filtered.length) {
      return null;
    }
    return filtered.map((field) => ({
      label: field.fieldName,
      kind: 5,
      detail: `${className}.${field.fieldName}${field.descriptor}`,
      sortText: `2_${field.fieldName}`,
      textEdit: {
        range: {
          start: { line: position.line, character: tokenStart },
          end: { line: position.line, character: position.character },
        },
        newText: field.fieldName,
      },
    }));
  }

  _detectFieldContext(beforeCursor) {
    const fieldInstrMatch = beforeCursor.match(
      /(?:getstatic|putstatic|getfield|putfield)\s+Field\s+([^\s]+)\s+([^\s]*)$/,
    );
    if (fieldInstrMatch) {
      const className = fieldInstrMatch[1];
      const partial = fieldInstrMatch[2] || '';
      const tokenStart = beforeCursor.length - partial.length;
      return { className, partial, tokenStart };
    }
    const dotMatch = beforeCursor.match(/([A-Za-z0-9_/$]+)\.([A-Za-z0-9_<$]*)$/);
    if (dotMatch) {
      const className = dotMatch[1];
      const partial = dotMatch[2] || '';
      const tokenStart = beforeCursor.length - partial.length;
      return { className, partial, tokenStart };
    }
    return null;
  }

  async _collectMethodsForClass(className, currentUri) {
    const entries = new Map();
    for (const info of this.symbolIndex.values()) {
      if (info.className === className) {
        info.methodList.forEach((method) => {
          entries.set(`${method.name}${method.descriptor}`, {
            methodName: method.name,
            descriptor: method.descriptor,
          });
        });
      }
    }
    if (this.workspaceLoadPromise) {
      await this.workspaceLoadPromise;
    }
    const workspaceEntries = this.workspaceMethodsByClass.get(className);
    if (Array.isArray(workspaceEntries)) {
      workspaceEntries.forEach((method) => {
        entries.set(`${method.methodName}${method.descriptor}`, method);
      });
    }
    if (entries.size === 0 && currentUri) {
      const resolvedUri = this._resolveClassUri(className, currentUri);
      if (resolvedUri && !this.symbolIndex.has(resolvedUri)) {
        const text = this._getDocumentText(resolvedUri);
        if (typeof text === 'string') {
          this.documents.set(resolvedUri, text);
          this._updateSymbolIndex(resolvedUri, text);
          return this._collectMethodsForClass(className, currentUri);
        }
      }
    }
    return Array.from(entries.values());
  }

  _collectConstantCandidates() {
    const set = new Set(this.workspaceConstants || []);
    for (const text of this.documents.values()) {
      if (typeof text !== 'string') continue;
      const normalized = normalizeNewlines(text);
      const regex = /ldc(?:2_w|_w)?\s+"([^"\r\n]+)"/g;
      let match;
      while ((match = regex.exec(normalized))) {
        set.add(match[1]);
      }
    }
    return Array.from(set);
  }

  async _collectFieldsForClass(className, currentUri) {
    const entries = new Map();
    for (const info of this.symbolIndex.values()) {
      if (info.className === className) {
        info.fieldList.forEach((field) => {
          entries.set(`${field.name}${field.descriptor}`, {
            fieldName: field.name,
            descriptor: field.descriptor,
          });
        });
      }
    }
    if (this.workspaceLoadPromise) {
      await this.workspaceLoadPromise;
    }
    const workspaceEntries = this.workspaceFieldsByClass.get(className);
    if (Array.isArray(workspaceEntries)) {
      workspaceEntries.forEach((field) => {
        entries.set(`${field.fieldName}${field.descriptor}`, field);
      });
    }
    if (entries.size === 0 && currentUri) {
      const resolvedUri = this._resolveClassUri(className, currentUri);
      if (resolvedUri && !this.symbolIndex.has(resolvedUri)) {
        const text = this._getDocumentText(resolvedUri);
        if (typeof text === 'string') {
          this.documents.set(resolvedUri, text);
          this._updateSymbolIndex(resolvedUri, text);
          return this._collectFieldsForClass(className, currentUri);
        }
      }
    }
    return Array.from(entries.values());
  }

  _normalizeClasspath(input) {
    if (!input) {
      return [];
    }
    if (Array.isArray(input)) {
      return input.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
    }
    if (typeof input === 'string') {
      return input
        .split(path.delimiter)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    }
    return [];
  }

  async _loadWorkspaceSymbols(classpaths) {
    try {
      const workspace = await KrakatauWorkspace.create(classpaths);
      const methodMap = new Map();
      const fieldMap = new Map();
      Object.entries(workspace.workspaceASTs || {}).forEach(([className, entry]) => {
        const cls = entry?.ast?.classes?.[0];
        if (!cls || !Array.isArray(cls.items)) {
          return;
        }
        const methods = [];
        const fields = [];
        cls.items.forEach((item) => {
          if (!item) {
            return;
          }
          if (item.type === 'method' && item.method) {
            methods.push({
              methodName: item.method.name,
              descriptor: item.method.descriptor,
            });
          } else if (item.type === 'field' && item.field) {
            fields.push({
              fieldName: item.field.name,
              descriptor: item.field.descriptor,
            });
          }
        });
        if (methods.length) {
          methodMap.set(className, methods);
        }
        if (fields.length) {
          fieldMap.set(className, fields);
        }
      });
      this.workspaceMethodsByClass = methodMap;
      this.workspaceFieldsByClass = fieldMap;
      try {
        this.workspaceConstants = workspace.listUtf8Strings() || [];
      } catch (_err) {
        this.workspaceConstants = [];
      }
    } catch (err) {
      console.warn(`Failed to load workspace for LSP completions: ${err.message}`);
      this.workspaceMethodsByClass = new Map();
      this.workspaceFieldsByClass = new Map();
      this.workspaceConstants = [];
    }
  }

  _resolveClassUri(className, currentUri) {
    const candidateNames = [
      `${className}.j`,
      `${className.replace(/\./g, '/')}.j`,
      `${className.replace(/\//g, path.sep)}.j`,
    ];
    const roots = [];
    if (this.rootPath) {
      roots.push(this.rootPath);
    }
    if (currentUri && currentUri.startsWith('file://')) {
      try {
        roots.push(path.dirname(fileURLToPath(currentUri)));
      } catch (_err) {
        // ignore
      }
    }
    for (const root of roots) {
      for (const candidate of candidateNames) {
        const fullPath = path.join(root, candidate);
        if (fs.existsSync(fullPath)) {
          return pathToFileURL(fullPath).href;
        }
      }
    }
    return null;
  }
}

module.exports = { JasminLspServer };
