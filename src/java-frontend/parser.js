'use strict';

const ast = require('./ast');
const { tokenizeJava, translateUnicodeEscapes } = require('./lexer');
const { NotImplementedJavaFrontendError } = require('./errors');

const MODIFIERS = new Set([
  'public', 'protected', 'private', 'abstract', 'static', 'final', 'strictfp',
  'native', 'synchronized', 'transient', 'volatile', 'default', 'sealed',
  'non-sealed',
]);

const PRIMITIVE_TYPES = new Set([
  'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
]);

const CONTEXTUAL_NAME_KEYWORDS = new Set([
  'module', 'open', 'opens', 'exports', 'requires', 'transitive', 'to', 'uses',
  'provides', 'with', 'var', 'yield', 'record', 'sealed', 'permits', 'non-sealed',
]);

function sourceLevelFromOptions(options) {
  return Object.prototype.hasOwnProperty.call(options, 'sourceLevel')
    ? options.sourceLevel
    : 8;
}

function compactToken(token) {
  return {
    kind: token.kind,
    text: token.text,
    value: token.value,
    range: token.range,
  };
}

function tokenText(tokens, source = null) {
  if (!tokens || tokens.length === 0) {
    return '';
  }
  if (source !== null) {
    const start = tokens[0].range.startOffset;
    const end = tokens[tokens.length - 1].range.endOffset;
    return source.slice(start, end).trim();
  }
  return tokens.map((token) => token.text).join(' ').trim();
}

function tokenRange(tokens) {
  if (!tokens || tokens.length === 0) {
    return null;
  }
  const first = tokens[0].range;
  const last = tokens[tokens.length - 1].range;
  return ast.range(first.startOffset, last.endOffset, first.start, last.end);
}

function isNameToken(token) {
  return Boolean(token)
    && (
      token.kind === 'identifier'
      || (token.kind === 'keyword' && CONTEXTUAL_NAME_KEYWORDS.has(token.text))
    );
}

function isIdentifierOrKeyword(token, text) {
  return Boolean(token) && token.text === text;
}

function angleCloseCount(text) {
  if (text === '>') return 1;
  if (text === '>>') return 2;
  if (text === '>>>') return 3;
  return 0;
}

function adjustAngleDepth(depth, token) {
  if (!token) return depth;
  if (token.text === '<') return depth + 1;
  const closeCount = angleCloseCount(token.text);
  return closeCount ? Math.max(0, depth - closeCount) : depth;
}

function isTypeDeclarationStart(token, nextToken) {
  if (!token) {
    return false;
  }
  if (token.text === '@' && nextToken && nextToken.text === 'interface') {
    return true;
  }
  return token.text === 'class'
    || token.text === 'interface'
    || token.text === 'enum'
    || token.text === 'record';
}

function splitTopLevel(tokens, separatorText) {
  const parts = [];
  let current = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;

  for (const token of tokens) {
    if (token.text === '(') parenDepth += 1;
    else if (token.text === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (token.text === '[') bracketDepth += 1;
    else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (token.text === '{') braceDepth += 1;
    else if (token.text === '}') braceDepth = Math.max(0, braceDepth - 1);
    else angleDepth = adjustAngleDepth(angleDepth, token);

    if (token.text === separatorText && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      parts.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  parts.push(current);
  return parts;
}

function findTopLevelToken(tokens, text) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.text === text && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return i;
    }
    if (token.text === '(') parenDepth += 1;
    else if (token.text === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (token.text === '[') bracketDepth += 1;
    else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (token.text === '{') braceDepth += 1;
    else if (token.text === '}') braceDepth = Math.max(0, braceDepth - 1);
    else angleDepth = adjustAngleDepth(angleDepth, token);
  }
  return -1;
}

function findMatchingInTokens(tokens, openIndex, openText = '(', closeText = ')') {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    if (tokens[i].text === openText) {
      depth += 1;
    } else if (tokens[i].text === closeText || (closeText === '>' && angleCloseCount(tokens[i].text) > 0)) {
      depth -= closeText === '>' ? angleCloseCount(tokens[i].text) : 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function stripArraySuffix(tokens) {
  const out = tokens.slice();
  let dimensions = 0;
  while (out.length >= 2 && out[out.length - 2].text === '[' && out[out.length - 1].text === ']') {
    out.pop();
    out.pop();
    dimensions += 1;
  }
  return { tokens: out, dimensions };
}

function trimTokens(tokens) {
  return tokens.filter(Boolean);
}

const NON_TYPE_OPERATOR_TOKENS = new Set([
  '+', '-', '*', '/', '%', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<=', '>>=', '>>>=', '++', '--', '!', '~', '&&', '||', '==', '!=', '<=',
  '>=', '->', '::', ':',
]);

function tokensCouldBeType(tokens) {
  const normalized = trimTokens(tokens || []);
  if (normalized.length === 0) {
    return false;
  }
  let angleDepth = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const token = normalized[i];
    const text = token.text;
    if (NON_TYPE_OPERATOR_TOKENS.has(text)) {
      return false;
    }
    if (text === '<') {
      angleDepth += 1;
      continue;
    }
    const closeCount = angleCloseCount(text);
    if (closeCount) {
      angleDepth = Math.max(0, angleDepth - closeCount);
      continue;
    }
    if (text === '[') {
      if (!normalized[i + 1] || normalized[i + 1].text !== ']') {
        return false;
      }
      i += 1;
      continue;
    }
    if (text === ']') {
      return false;
    }
    if (text === '.') {
      if (!normalized[i - 1] || !normalized[i + 1]
          || !isNameToken(normalized[i - 1]) || !isNameToken(normalized[i + 1])) {
        return false;
      }
      continue;
    }
    if (text === ',' || text === '?' || text === '&' || text === 'extends' || text === 'super') {
      continue;
    }
    if (isNameToken(token) || PRIMITIVE_TYPES.has(text)) {
      continue;
    }
    return false;
  }
  return angleDepth === 0;
}

class ParserImpl {
  constructor(source, options = {}) {
    this.source = translateUnicodeEscapes(source);
    this.options = options;
    const lexed = tokenizeJava(this.source, options);
    this.tokens = lexed.tokens;
    this.diagnostics = lexed.diagnostics.slice();
    this.index = 0;
  }

  parseDocument() {
    const sourceLevel = sourceLevelFromOptions(this.options);
    const root = this.parseCompilationUnit();
    return ast.createAstDocument(root, {
      sourceLevel,
      diagnostics: this.diagnostics,
      meta: {
        parser: 'java-frontend',
      },
    });
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset] || null;
  }

  consume() {
    const token = this.peek();
    if (token) {
      this.index += 1;
    }
    return token;
  }

  match(text) {
    if (this.peek() && this.peek().text === text) {
      return this.consume();
    }
    return null;
  }

  expect(text) {
    const token = this.match(text);
    if (!token) {
      this.error(`Expected ${text}`, this.peek());
    }
    return token;
  }

  error(message, token = this.peek()) {
    const suffix = token ? ` at ${token.range.start.line}:${token.range.start.column}` : ' at end of input';
    throw new SyntaxError(`${message}${suffix}`);
  }

  mark() {
    return this.index;
  }

  reset(mark) {
    this.index = mark;
  }

  get eof() {
    return this.index >= this.tokens.length;
  }

  currentRangeFrom(startIndex) {
    return tokenRange(this.tokens.slice(startIndex, this.index));
  }

  textOf(tokens) {
    return tokenText(tokens, this.source);
  }

  parseCompilationUnit() {
    if (this.tokens.length === 0) {
      return ast.compilationUnit();
    }

    let packageDeclaration = null;
    const imports = [];
    const typeDeclarations = [];

    const packageAnnotations = [];
    while (this.peek() && this.peek().text === '@' && !(this.peek(1) && this.peek(1).text === 'interface')) {
      packageAnnotations.push(this.parseAnnotation());
    }

    if (this.peek() && this.peek().text === 'package') {
      packageDeclaration = this.parsePackageDeclaration(packageAnnotations);
    } else if (packageAnnotations.length > 0) {
      typeDeclarations.push(ast.createNode('UnsupportedDeclaration', {
        reason: 'dangling-package-annotations',
        annotations: packageAnnotations,
      }));
    }

    while (this.peek() && this.peek().text === 'import') {
      imports.push(this.parseImportDeclaration());
    }

    while (!this.eof) {
      if (this.match(';')) {
        continue;
      }
      const start = this.index;
      const prefix = this.parseModifiersAndAnnotations();
      if (this.eof) {
        if (prefix.modifiers.length || prefix.annotations.length) {
          typeDeclarations.push(ast.createNode('UnsupportedDeclaration', {
            reason: 'trailing-declaration-prefix',
            modifiers: prefix.modifiers,
            annotations: prefix.annotations,
          }));
        }
        break;
      }
      if (isTypeDeclarationStart(this.peek(), this.peek(1))) {
        typeDeclarations.push(this.parseTypeDeclaration(prefix));
      } else {
        this.reset(start);
        typeDeclarations.push(this.parseUnsupportedDeclaration('top-level-declaration'));
      }
      if (this.index === start) {
        this.consume();
      }
    }

    return ast.compilationUnit({ packageDeclaration, imports, typeDeclarations });
  }

  parsePackageDeclaration(annotations = []) {
    this.expect('package');
    const nameTokens = [];
    while (!this.eof && this.peek().text !== ';') {
      nameTokens.push(this.consume());
    }
    this.match(';');
    return ast.packageDeclaration(this.qualifiedNameFromTokens(nameTokens), annotations);
  }

  parseImportDeclaration() {
    this.expect('import');
    const isStatic = Boolean(this.match('static'));
    const nameTokens = [];
    while (!this.eof && this.peek().text !== ';') {
      nameTokens.push(this.consume());
    }
    this.match(';');
    const isWildcard = nameTokens.length >= 2
      && nameTokens[nameTokens.length - 2].text === '.'
      && nameTokens[nameTokens.length - 1].text === '*';
    const effectiveNameTokens = isWildcard ? nameTokens.slice(0, -2) : nameTokens;
    return ast.importDeclaration(this.qualifiedNameFromTokens(effectiveNameTokens), { isStatic, isWildcard });
  }

  parseModifiersAndAnnotations() {
    const modifiers = [];
    const annotations = [];
    while (!this.eof) {
      if (this.peek().text === '@' && !(this.peek(1) && this.peek(1).text === 'interface')) {
        annotations.push(this.parseAnnotation());
        continue;
      }
      if (MODIFIERS.has(this.peek().text)) {
        modifiers.push(ast.modifier(this.consume().text));
        continue;
      }
      break;
    }
    return { modifiers, annotations };
  }

  parseAnnotation() {
    const start = this.index;
    this.expect('@');
    const nameTokens = [];
    while (!this.eof) {
      const token = this.peek();
      if (isNameToken(token)) {
        nameTokens.push(this.consume());
        if (this.peek() && this.peek().text === '.') {
          nameTokens.push(this.consume());
          continue;
        }
      }
      break;
    }
    let values = null;
    let kind = 'MarkerAnnotation';
    if (this.peek() && this.peek().text === '(') {
      const tokens = this.consumeBalancedEnclosed('(', ')');
      values = ast.createNode('UnsupportedExpression', {
        text: this.textOf(tokens),
        tokens: tokens.map(compactToken),
        range: tokenRange(tokens),
      });
      kind = 'NormalAnnotation';
    }
    return ast.createNode(kind, {
      name: this.qualifiedNameFromTokens(nameTokens),
      values,
      range: this.currentRangeFrom(start),
    });
  }

  parseTypeDeclaration(prefix = { modifiers: [], annotations: [] }) {
    if (this.peek() && this.peek().text === '@' && this.peek(1) && this.peek(1).text === 'interface') {
      return this.parseAnnotationTypeDeclaration(prefix);
    }
    const token = this.peek();
    if (!token) {
      this.error('Expected type declaration');
    }
    if (token.text === 'class') return this.parseClassDeclaration(prefix);
    if (token.text === 'interface') return this.parseInterfaceDeclaration(prefix);
    if (token.text === 'enum') return this.parseEnumDeclaration(prefix);
    if (token.text === 'record') return this.parseRecordDeclaration(prefix);
    return this.parseUnsupportedDeclaration('type-declaration');
  }

  parseClassDeclaration(prefix) {
    this.expect('class');
    const name = this.consumeName('class name');
    const typeParameters = this.parseOptionalTypeParameters();
    const header = this.collectUntilTopLevel(new Set(['{', ';']));
    const headerInfo = this.parseClassLikeHeader(header);
    const body = this.peek() && this.peek().text === '{'
      ? this.parseTypeBody(name, 'class')
      : [];
    this.match(';');
    return ast.classDeclaration(name, {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      typeParameters,
      extendsType: headerInfo.extendsTypes[0] || null,
      implementsTypes: headerInfo.implementsTypes,
      permitsTypes: headerInfo.permitsTypes,
      body,
    });
  }

  parseInterfaceDeclaration(prefix) {
    this.expect('interface');
    const name = this.consumeName('interface name');
    const typeParameters = this.parseOptionalTypeParameters();
    const header = this.collectUntilTopLevel(new Set(['{', ';']));
    const headerInfo = this.parseClassLikeHeader(header);
    const body = this.peek() && this.peek().text === '{'
      ? this.parseTypeBody(name, 'interface')
      : [];
    this.match(';');
    return ast.interfaceDeclaration(name, {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      typeParameters,
      extendsTypes: headerInfo.extendsTypes,
      permitsTypes: headerInfo.permitsTypes,
      body,
    });
  }

  parseAnnotationTypeDeclaration(prefix) {
    this.expect('@');
    this.expect('interface');
    const name = this.consumeName('annotation type name');
    const body = this.peek() && this.peek().text === '{'
      ? this.parseTypeBody(name, 'annotation')
      : [];
    return ast.createNode('AnnotationTypeDeclaration', {
      name,
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      body,
    });
  }

  parseRecordDeclaration(prefix) {
    this.expect('record');
    const name = this.consumeName('record name');
    const typeParameters = this.parseOptionalTypeParameters();
    const components = this.peek() && this.peek().text === '('
      ? this.parseFormalParametersAsRecordComponents()
      : [];
    const header = this.collectUntilTopLevel(new Set(['{', ';']));
    const headerInfo = this.parseClassLikeHeader(header);
    const body = this.peek() && this.peek().text === '{'
      ? this.parseTypeBody(name, 'record')
      : [];
    this.match(';');
    return ast.recordDeclaration(name, {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      typeParameters,
      components,
      implementsTypes: headerInfo.implementsTypes,
      body,
    });
  }

  parseEnumDeclaration(prefix) {
    this.expect('enum');
    const name = this.consumeName('enum name');
    const header = this.collectUntilTopLevel(new Set(['{', ';']));
    const headerInfo = this.parseClassLikeHeader(header);
    const constants = [];
    const body = [];
    if (this.match('{')) {
      constants.push(...this.parseEnumConstants());
      while (!this.eof && !(this.peek() && this.peek().text === '}')) {
        if (this.match(';')) {
          continue;
        }
        const start = this.index;
        const memberPrefix = this.parseModifiersAndAnnotations();
        if (isTypeDeclarationStart(this.peek(), this.peek(1))) {
          body.push(this.parseTypeDeclaration(memberPrefix));
        } else {
          body.push(this.parseMember(name, memberPrefix));
        }
        if (this.index === start) {
          this.consume();
        }
      }
      this.match('}');
    }
    this.match(';');
    return ast.enumDeclaration(name, {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      implementsTypes: headerInfo.implementsTypes,
      constants,
      body,
    });
  }

  parseEnumConstants() {
    const constants = [];
    while (!this.eof && !(this.peek() && (this.peek().text === '}' || this.peek().text === ';'))) {
      const prefix = this.parseModifiersAndAnnotations();
      if (!isNameToken(this.peek())) {
        break;
      }
      const start = this.index;
      const name = this.consume().text;
      let argumentTokens = [];
      let body = [];
      if (this.peek() && this.peek().text === '(') {
        argumentTokens = this.consumeBalancedEnclosed('(', ')');
      }
      if (this.peek() && this.peek().text === '{') {
        body = this.parseTypeBody(name, 'enumConstant');
      }
      constants.push(ast.createNode('EnumConstantDeclaration', {
        name,
        annotations: prefix.annotations,
        arguments: argumentTokens.length ? this.unsupportedExpression(argumentTokens) : null,
        body,
        range: this.currentRangeFrom(start),
      }));
      if (this.match(',')) {
        if (this.peek() && (this.peek().text === '}' || this.peek().text === ';')) {
          break;
        }
        continue;
      }
      break;
    }
    this.match(';');
    return constants;
  }

  parseTypeBody(ownerName, bodyKind) {
    this.expect('{');
    const members = [];
    while (!this.eof && !(this.peek() && this.peek().text === '}')) {
      if (this.match(';')) {
        continue;
      }
      const start = this.index;
      const prefix = this.parseModifiersAndAnnotations();
      if (this.peek() && this.peek().text === '{') {
        members.push(ast.createNode('InitializerBlock', {
          modifiers: prefix.modifiers,
          annotations: prefix.annotations,
          isStatic: prefix.modifiers.some((modifier) => modifier.name === 'static'),
          body: this.parseBlock(),
        }));
      } else if (isTypeDeclarationStart(this.peek(), this.peek(1))) {
        members.push(this.parseTypeDeclaration(prefix));
      } else {
        members.push(this.parseMember(ownerName, prefix, bodyKind));
      }
      if (this.index === start) {
        members.push(this.parseUnsupportedDeclaration('member-no-progress'));
      }
    }
    this.match('}');
    return members;
  }

  parseMember(ownerName, prefix) {
    if (!this.peek()) {
      return ast.createNode('UnsupportedDeclaration', { reason: 'end-of-input-member' });
    }

    const declarationStart = this.index;
    const scan = this.collectMemberHeaderAndBody();
    if (scan.headerTokens.length === 0 && !scan.body) {
      return ast.createNode('UnsupportedDeclaration', {
        reason: 'empty-member',
        modifiers: prefix.modifiers,
        annotations: prefix.annotations,
      });
    }

    const methodInfo = this.tryParseMethodHeader(scan.headerTokens, ownerName);
    if (methodInfo) {
      const fields = {
        modifiers: prefix.modifiers,
        annotations: prefix.annotations,
        typeParameters: methodInfo.typeParameters,
        parameters: methodInfo.parameters,
        receiverParameter: methodInfo.receiverParameter,
        throwsTypes: methodInfo.throwsTypes,
        body: scan.body || null,
        defaultValue: methodInfo.defaultValue,
        range: this.currentRangeFrom(declarationStart),
      };
      if (methodInfo.isConstructor) {
        return ast.constructorDeclaration(methodInfo.name, fields);
      }
      return ast.methodDeclaration(methodInfo.name, methodInfo.returnType, fields);
    }

    const field = this.tryParseFieldDeclaration(scan.headerTokens, prefix, declarationStart);
    if (field) {
      return field;
    }

    return ast.createNode('UnsupportedDeclaration', {
      reason: 'unrecognized-member',
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      text: this.textOf(scan.headerTokens),
      tokens: scan.headerTokens.map(compactToken),
      body: scan.body,
      range: this.currentRangeFrom(declarationStart),
    });
  }

  collectMemberHeaderAndBody() {
    const headerTokens = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let seenEquals = false;

    while (!this.eof) {
      const token = this.peek();
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (token.text === ';') {
          this.consume();
          return { headerTokens, body: null, hasSemicolon: true };
        }
        if (token.text === '{' && !seenEquals) {
          return { headerTokens, body: this.parseBlock(), hasSemicolon: false };
        }
        if (token.text === '}') {
          return { headerTokens, body: null, hasSemicolon: false };
        }
      }

      if (token.text === '=') {
        seenEquals = true;
      }
      if (token.text === '(') parenDepth += 1;
      else if (token.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (token.text === '[') bracketDepth += 1;
      else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (token.text === '{') braceDepth += 1;
      else if (token.text === '}') braceDepth = Math.max(0, braceDepth - 1);
      headerTokens.push(this.consume());
    }
    return { headerTokens, body: null, hasSemicolon: false };
  }

  tryParseMethodHeader(headerTokens, ownerName) {
    const equalsIndex = findTopLevelToken(headerTokens, '=');
    const candidateTokens = equalsIndex === -1 ? headerTokens : headerTokens.slice(0, equalsIndex);
    const parenIndex = this.findMethodParameterOpen(candidateTokens);
    if (parenIndex === -1) {
      return null;
    }
    const closeIndex = findMatchingInTokens(candidateTokens, parenIndex, '(', ')');
    if (closeIndex === -1) {
      return null;
    }
    const nameToken = candidateTokens[parenIndex - 1];
    if (!isNameToken(nameToken) && nameToken.text !== 'this') {
      return null;
    }

    let beforeName = candidateTokens.slice(0, parenIndex - 1);
    const typeParameters = [];
    if (beforeName.length && beforeName[0].text === '<') {
      const typeParamClose = findMatchingInTokens(beforeName, 0, '<', '>');
      if (typeParamClose !== -1) {
        const rawTypeParams = beforeName.slice(1, typeParamClose);
        for (const part of splitTopLevel(rawTypeParams, ',')) {
          const text = this.textOf(part);
          if (text) {
            const name = part.find(isNameToken);
            typeParameters.push(ast.createNode('TypeParameter', {
              name: name ? name.text : text,
              bounds: this.parseBoundsFromTypeParameterTokens(part),
              text,
            }));
          }
        }
        beforeName = beforeName.slice(typeParamClose + 1);
      }
    }

    const afterParen = candidateTokens.slice(closeIndex + 1);
    const parameters = this.parseFormalParametersFromTokens(candidateTokens.slice(parenIndex + 1, closeIndex));
    const throwsTypes = this.parseThrowsTypes(afterParen);
    const defaultValue = this.parseDefaultValue(afterParen);
    const isConstructor = nameToken.text === ownerName && beforeName.length === 0;
    const receiverParameter = parameters.find((param) => param.kind === 'ReceiverParameter') || null;
    const regularParameters = parameters.filter((param) => param.kind !== 'ReceiverParameter');

    return {
      name: nameToken.text,
      isConstructor,
      typeParameters,
      returnType: isConstructor ? null : this.typeFromTokens(beforeName),
      parameters: regularParameters,
      receiverParameter,
      throwsTypes,
      defaultValue,
    };
  }

  findMethodParameterOpen(tokens) {
    let angleDepth = 0;
    let bracketDepth = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.text === '[') bracketDepth += 1;
      else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (token.text === '(' && angleDepth === 0 && bracketDepth === 0 && i > 0 && (isNameToken(tokens[i - 1]) || tokens[i - 1].text === 'this')) {
        return i;
      }
      angleDepth = adjustAngleDepth(angleDepth, token);
    }
    return -1;
  }

  parseBoundsFromTypeParameterTokens(tokens) {
    const extendsIndex = tokens.findIndex((token) => token.text === 'extends');
    if (extendsIndex === -1) {
      return [];
    }
    return splitTopLevel(tokens.slice(extendsIndex + 1), '&')
      .filter((part) => part.length > 0)
      .map((part) => this.typeFromTokens(part));
  }

  parseThrowsTypes(tokens) {
    const throwsIndex = tokens.findIndex((token) => token.text === 'throws');
    if (throwsIndex === -1) {
      return [];
    }
    const untilDefault = tokens.findIndex((token, index) => index > throwsIndex && token.text === 'default');
    const throwTokens = untilDefault === -1 ? tokens.slice(throwsIndex + 1) : tokens.slice(throwsIndex + 1, untilDefault);
    return splitTopLevel(throwTokens, ',')
      .filter((part) => part.length > 0)
      .map((part) => this.typeFromTokens(part));
  }

  parseDefaultValue(tokens) {
    const defaultIndex = tokens.findIndex((token) => token.text === 'default');
    if (defaultIndex === -1) {
      return null;
    }
    const valueTokens = tokens.slice(defaultIndex + 1);
    return valueTokens.length ? this.unsupportedExpression(valueTokens) : null;
  }

  tryParseFieldDeclaration(headerTokens, prefix, declarationStart) {
    const declaratorParts = splitTopLevel(headerTokens, ',').filter((part) => part.length > 0);
    if (declaratorParts.length === 0) {
      return null;
    }
    const firstInfo = this.parseVariableDeclaratorPart(declaratorParts[0], null);
    if (!firstInfo || firstInfo.typeTokens.length === 0) {
      return null;
    }
    const fieldType = this.typeFromTokens(firstInfo.typeTokens);
    const declarators = [firstInfo.declarator];
    for (let i = 1; i < declaratorParts.length; i += 1) {
      const info = this.parseVariableDeclaratorPart(declaratorParts[i], firstInfo.typeTokens);
      if (info) {
        declarators.push(info.declarator);
      }
    }
    return ast.fieldDeclaration(fieldType, declarators, {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      range: this.currentRangeFrom(declarationStart),
    });
  }

  parseVariableDeclaratorPart(tokens, inheritedTypeTokens = null) {
    const equalsIndex = findTopLevelToken(tokens, '=');
    const beforeEquals = equalsIndex === -1 ? tokens : tokens.slice(0, equalsIndex);
    const initializerTokens = equalsIndex === -1 ? [] : tokens.slice(equalsIndex + 1);
    let nameIndex = -1;
    for (let i = beforeEquals.length - 1; i >= 0; i -= 1) {
      if (isNameToken(beforeEquals[i])) {
        nameIndex = i;
        break;
      }
    }
    if (nameIndex === -1) {
      return null;
    }
    const name = beforeEquals[nameIndex].text;
    const afterName = beforeEquals.slice(nameIndex + 1);
    let dimensions = 0;
    for (let i = 0; i < afterName.length - 1; i += 2) {
      if (afterName[i].text === '[' && afterName[i + 1].text === ']') {
        dimensions += 1;
      }
    }
    const typeTokens = inheritedTypeTokens || beforeEquals.slice(0, nameIndex);
    const initializer = initializerTokens.length ? this.unsupportedExpression(initializerTokens) : null;
    return {
      typeTokens,
      declarator: ast.variableDeclarator(name, { dimensions, initializer }),
    };
  }

  parseBlock() {
    this.expect('{');
    const statements = [];
    while (!this.eof && !(this.peek() && this.peek().text === '}')) {
      const start = this.index;
      statements.push(this.parseStatement());
      if (this.index === start) {
        statements.push(ast.createNode('UnsupportedStatement', {
          reason: 'statement-no-progress',
          token: this.peek() ? compactToken(this.peek()) : null,
        }));
        this.consume();
      }
    }
    this.match('}');
    return ast.blockStatement(statements);
  }

  parseStatement() {
    const token = this.peek();
    if (!token) {
      return ast.createNode('UnsupportedStatement', { reason: 'end-of-input-statement' });
    }

    if (token.text === '{') return this.parseBlock();
    if (this.match(';')) return ast.createNode('EmptyStatement', {});
    if (token.text === 'if') return this.parseIfStatement();
    if (token.text === 'while') return this.parseWhileStatement();
    if (token.text === 'do') return this.parseDoWhileStatement();
    if (token.text === 'for') return this.parseForStatement();
    if (token.text === 'switch') return this.parseSwitchStatement();
    if (token.text === 'try') return this.parseTryStatement();
    if (token.text === 'synchronized') return this.parseSynchronizedStatement();
    if (token.text === 'return') return this.parseReturnStatement();
    if (token.text === 'throw') return this.parseThrowStatement();
    if (token.text === 'break' || token.text === 'continue') return this.parseBranchStatement(token.text);
    if (token.text === 'assert') return this.parseAssertStatement();

    if (isNameToken(token) && this.peek(1) && this.peek(1).text === ':') {
      const label = this.consume().text;
      this.expect(':');
      return ast.createNode('LabeledStatement', {
        label,
        statement: this.parseStatement(),
      });
    }

    const prefixMark = this.mark();
    const prefix = this.parseModifiersAndAnnotations();
    if (isTypeDeclarationStart(this.peek(), this.peek(1))) {
      const declaration = this.parseTypeDeclaration(prefix);
      return ast.createNode('UnsupportedStatement', {
        reason: 'local-type-declaration',
        declaration,
      });
    }
    this.reset(prefixMark);

    const statementTokens = this.collectStatementTokensToSemicolon();
    const localVariable = this.tryParseLocalVariableStatement(statementTokens);
    if (localVariable) {
      return localVariable;
    }
    return ast.expressionStatement(this.unsupportedExpression(statementTokens));
  }

  parseIfStatement() {
    this.expect('if');
    const condition = this.parseParenthesizedExpression();
    const consequent = this.parseStatement();
    const alternate = this.match('else') ? this.parseStatement() : null;
    return ast.createNode('IfStatement', { condition, consequent, alternate });
  }

  parseWhileStatement() {
    this.expect('while');
    const condition = this.parseParenthesizedExpression();
    const body = this.parseStatement();
    return ast.createNode('WhileStatement', { condition, body });
  }

  parseDoWhileStatement() {
    this.expect('do');
    const body = this.parseStatement();
    this.expect('while');
    const condition = this.parseParenthesizedExpression();
    this.match(';');
    return ast.createNode('DoWhileStatement', { body, condition });
  }

  parseForStatement() {
    this.expect('for');
    const headerTokens = this.consumeBalancedEnclosed('(', ')');
    const colonIndex = findTopLevelToken(headerTokens, ':');
    const semicolonIndex = findTopLevelToken(headerTokens, ';');
    const body = this.parseStatement();
    if (colonIndex !== -1 && semicolonIndex === -1) {
      const parameterTokens = headerTokens.slice(0, colonIndex);
      const iterableTokens = headerTokens.slice(colonIndex + 1);
      return ast.createNode('EnhancedForStatement', {
        parameter: this.parseFormalParameterFromTokens(parameterTokens, 0),
        iterable: this.unsupportedExpression(iterableTokens),
        body,
      });
    }
    const parts = splitTopLevel(headerTokens, ';');
    const initializer = parts[0] && parts[0].length
      ? this.tryParseLocalVariableStatement(parts[0]) || this.unsupportedExpression(parts[0])
      : null;
    return ast.createNode('ForStatement', {
      initializer,
      condition: parts[1] && parts[1].length ? this.unsupportedExpression(parts[1]) : null,
      update: parts[2] && parts[2].length ? this.unsupportedExpression(parts[2]) : null,
      body,
    });
  }

  parseSwitchStatement() {
    this.expect('switch');
    const expression = this.parseParenthesizedExpression();
    this.expect('{');
    const groups = [];
    while (!this.eof && !(this.peek() && this.peek().text === '}')) {
      const labels = [];
      while (this.peek() && (this.peek().text === 'case' || this.peek().text === 'default')) {
        labels.push(this.parseSwitchLabel());
      }
      const statements = [];
      while (!this.eof && this.peek() && this.peek().text !== '}' && this.peek().text !== 'case' && this.peek().text !== 'default') {
        statements.push(this.parseStatement());
      }
      if (labels.length || statements.length) {
        groups.push(ast.createNode('SwitchBlockStatementGroup', { labels, statements }));
      }
    }
    this.match('}');
    return ast.createNode('SwitchStatement', { expression, groups });
  }

  parseSwitchLabel() {
    if (this.match('default')) {
      let separator = ':';
      if (this.match('->')) separator = '->';
      else this.match(':');
      return ast.createNode('SwitchLabel', { labelKind: 'default', expression: null, separator });
    }
    this.expect('case');
    const exprTokens = this.collectUntilTopLevel(new Set([':', '->']));
    let separator = ':';
    if (this.match('->')) separator = '->';
    else this.match(':');
    return ast.createNode('SwitchLabel', {
      labelKind: 'case',
      expression: this.unsupportedExpression(exprTokens),
      separator,
    });
  }

  parseTryStatement() {
    this.expect('try');
    const resources = this.peek() && this.peek().text === '('
      ? splitTopLevel(this.consumeBalancedEnclosed('(', ')'), ';')
        .filter((part) => part.length > 0)
        .map((part) => ast.createNode('UnsupportedExpression', {
          text: this.textOf(part),
          tokens: part.map(compactToken),
          range: tokenRange(part),
        }))
      : null;
    const block = this.parseBlock();
    const catches = [];
    while (this.peek() && this.peek().text === 'catch') {
      catches.push(this.parseCatchClause());
    }
    const finallyBlock = this.match('finally') ? this.parseBlock() : null;
    return ast.createNode('TryStatement', { resources, block, catches, finallyBlock });
  }

  parseCatchClause() {
    this.expect('catch');
    const parameterTokens = this.consumeBalancedEnclosed('(', ')');
    const parameter = this.parseFormalParameterFromTokens(parameterTokens, 0);
    const body = this.parseBlock();
    return ast.createNode('CatchClause', { parameter, body });
  }

  parseSynchronizedStatement() {
    this.expect('synchronized');
    const expression = this.parseParenthesizedExpression();
    const body = this.parseBlock();
    return ast.createNode('SynchronizedStatement', { expression, body });
  }

  parseReturnStatement() {
    this.expect('return');
    const exprTokens = this.collectStatementTokensToSemicolon();
    return ast.returnStatement(exprTokens.length ? this.unsupportedExpression(exprTokens) : null);
  }

  parseThrowStatement() {
    this.expect('throw');
    const exprTokens = this.collectStatementTokensToSemicolon();
    return ast.createNode('ThrowStatement', {
      expression: exprTokens.length ? this.unsupportedExpression(exprTokens) : null,
    });
  }

  parseBranchStatement(kind) {
    this.expect(kind);
    const labelTokens = this.collectStatementTokensToSemicolon();
    return ast.createNode(kind === 'break' ? 'BreakStatement' : 'ContinueStatement', {
      label: labelTokens.length ? this.textOf(labelTokens) : null,
    });
  }

  parseAssertStatement() {
    this.expect('assert');
    const exprTokens = this.collectStatementTokensToSemicolon();
    const parts = splitTopLevel(exprTokens, ':');
    return ast.createNode('AssertStatement', {
      condition: parts[0] && parts[0].length ? this.unsupportedExpression(parts[0]) : null,
      detail: parts[1] && parts[1].length ? this.unsupportedExpression(parts[1]) : null,
    });
  }

  collectStatementTokensToSemicolon() {
    const tokens = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    while (!this.eof) {
      const token = this.peek();
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && token.text === ';') {
        this.consume();
        break;
      }
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && token.text === '}') {
        break;
      }
      if (token.text === '(') parenDepth += 1;
      else if (token.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (token.text === '[') bracketDepth += 1;
      else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (token.text === '{') braceDepth += 1;
      else if (token.text === '}') braceDepth = Math.max(0, braceDepth - 1);
      tokens.push(this.consume());
    }
    return tokens;
  }

  tryParseLocalVariableStatement(statementTokens) {
    if (!statementTokens || statementTokens.length === 0) {
      return null;
    }
    const firstText = statementTokens[0].text;
    if (['this', 'super', 'new'].includes(firstText)) {
      return null;
    }
    const equalsIndex = findTopLevelToken(statementTokens, '=');
    const commaIndex = findTopLevelToken(statementTokens, ',');
    const boundary = equalsIndex !== -1 ? equalsIndex : (commaIndex !== -1 ? commaIndex : statementTokens.length);
    const declaratorPrefix = statementTokens.slice(0, boundary);
    if (declaratorPrefix.some((token) => token.text === '(' || token.text === ')' || token.text === '::' || token.text === '->')) {
      return null;
    }
    const parts = splitTopLevel(statementTokens, ',').filter((part) => part.length > 0);
    if (parts.length === 0) {
      return null;
    }
    const prefix = this.extractInlineModifiersAndAnnotations(parts[0]);
    const firstInfo = this.parseVariableDeclaratorPart(prefix.remaining, null);
    if (!firstInfo || firstInfo.typeTokens.length === 0 || !tokensCouldBeType(firstInfo.typeTokens)) {
      return null;
    }
    const variableType = this.typeFromTokens(firstInfo.typeTokens);
    const declarators = [firstInfo.declarator];
    for (let i = 1; i < parts.length; i += 1) {
      const info = this.parseVariableDeclaratorPart(parts[i], firstInfo.typeTokens);
      if (info) {
        declarators.push(info.declarator);
      }
    }
    return ast.createNode('LocalVariableDeclarationStatement', {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      variableType,
      declarators,
    });
  }

  extractInlineModifiersAndAnnotations(tokens) {
    const modifiers = [];
    const annotations = [];
    let index = 0;
    while (index < tokens.length) {
      if (MODIFIERS.has(tokens[index].text)) {
        modifiers.push(ast.modifier(tokens[index].text));
        index += 1;
        continue;
      }
      if (tokens[index].text === '@') {
        const start = index;
        index += 1;
        while (index < tokens.length && (isNameToken(tokens[index]) || tokens[index].text === '.')) {
          index += 1;
        }
        if (tokens[index] && tokens[index].text === '(') {
          const close = findMatchingInTokens(tokens, index, '(', ')');
          index = close === -1 ? tokens.length : close + 1;
        }
        annotations.push(ast.createNode('MarkerAnnotation', {
          name: this.qualifiedNameFromTokens(tokens.slice(start + 1, index)),
          text: this.textOf(tokens.slice(start, index)),
        }));
        continue;
      }
      break;
    }
    return { modifiers, annotations, remaining: tokens.slice(index) };
  }

  parseParenthesizedExpression() {
    const tokens = this.consumeBalancedEnclosed('(', ')');
    return this.unsupportedExpression(tokens);
  }

  consumeBalancedEnclosed(openText, closeText) {
    this.expect(openText);
    const tokens = [];
    let depth = 1;
    while (!this.eof && depth > 0) {
      const token = this.consume();
      if (token.text === openText) {
        depth += 1;
        tokens.push(token);
      } else if (token.text === closeText || (closeText === '>' && angleCloseCount(token.text) > 0)) {
        const closeCount = closeText === '>' ? angleCloseCount(token.text) : 1;
        if (closeText === '>' && closeCount > 1) {
          for (let i = 1; i < Math.min(closeCount, depth); i += 1) {
            tokens.push({ ...token, text: '>' });
          }
        }
        depth -= closeCount;
        if (depth > 0) {
          tokens.push(token);
        }
      } else {
        tokens.push(token);
      }
    }
    return tokens;
  }

  collectUntilTopLevel(stopTexts) {
    const tokens = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let angleDepth = 0;
    while (!this.eof) {
      const token = this.peek();
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0 && stopTexts.has(token.text)) {
        break;
      }
      if (token.text === '(') parenDepth += 1;
      else if (token.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (token.text === '[') bracketDepth += 1;
      else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (token.text === '{') braceDepth += 1;
      else if (token.text === '}') braceDepth = Math.max(0, braceDepth - 1);
      else angleDepth = adjustAngleDepth(angleDepth, token);
      tokens.push(this.consume());
    }
    return tokens;
  }

  parseOptionalTypeParameters() {
    if (!this.peek() || this.peek().text !== '<') {
      return [];
    }
    const tokens = this.consumeBalancedEnclosed('<', '>');
    return splitTopLevel(tokens, ',')
      .filter((part) => part.length > 0)
      .map((part) => {
        const name = part.find(isNameToken);
        return ast.createNode('TypeParameter', {
          name: name ? name.text : this.textOf(part),
          bounds: this.parseBoundsFromTypeParameterTokens(part),
          text: this.textOf(part),
        });
      });
  }

  parseClassLikeHeader(headerTokens) {
    const sections = {
      extendsTypes: [],
      implementsTypes: [],
      permitsTypes: [],
    };
    let i = 0;
    while (i < headerTokens.length) {
      const keyword = headerTokens[i].text;
      if (keyword !== 'extends' && keyword !== 'implements' && keyword !== 'permits') {
        i += 1;
        continue;
      }
      const start = i + 1;
      i = start;
      let parenDepth = 0;
      let bracketDepth = 0;
      let angleDepth = 0;
      while (i < headerTokens.length) {
        const token = headerTokens[i];
        if (parenDepth === 0 && bracketDepth === 0 && angleDepth === 0
          && (token.text === 'extends' || token.text === 'implements' || token.text === 'permits')) {
          break;
        }
        if (token.text === '(') parenDepth += 1;
        else if (token.text === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (token.text === '[') bracketDepth += 1;
        else if (token.text === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        else angleDepth = adjustAngleDepth(angleDepth, token);
        i += 1;
      }
      const types = splitTopLevel(headerTokens.slice(start, i), ',')
        .filter((part) => part.length > 0)
        .map((part) => this.typeFromTokens(part));
      if (keyword === 'extends') sections.extendsTypes.push(...types);
      else if (keyword === 'implements') sections.implementsTypes.push(...types);
      else if (keyword === 'permits') sections.permitsTypes.push(...types);
    }
    return sections;
  }

  parseFormalParametersAsRecordComponents() {
    const parameters = this.parseFormalParametersFromTokens(this.consumeBalancedEnclosed('(', ')'));
    return parameters.map((parameter) => ast.createNode('RecordComponent', {
      name: parameter.name,
      componentType: parameter.parameterType,
      annotations: parameter.annotations || [],
    }));
  }

  parseFormalParametersFromTokens(tokens) {
    return splitTopLevel(tokens, ',')
      .filter((part) => part.length > 0)
      .map((part, index) => this.parseFormalParameterFromTokens(part, index));
  }

  parseFormalParameterFromTokens(tokens, index = 0) {
    const prefix = this.extractInlineModifiersAndAnnotations(tokens);
    let remaining = prefix.remaining.slice();
    let isVarargs = false;
    const ellipsisIndex = remaining.findIndex((token) => token.text === '...');
    if (ellipsisIndex !== -1) {
      isVarargs = true;
      remaining = remaining.slice(0, ellipsisIndex).concat(remaining.slice(ellipsisIndex + 1));
    }
    let nameIndex = -1;
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (isNameToken(remaining[i]) || remaining[i].text === 'this') {
        nameIndex = i;
        break;
      }
    }
    if (nameIndex === -1) {
      return ast.formalParameter(`param${index}`, this.typeFromTokens(remaining), {
        modifiers: prefix.modifiers,
        annotations: prefix.annotations,
        isVarargs,
      });
    }
    const name = remaining[nameIndex].text;
    const typeTokens = remaining.slice(0, nameIndex);
    const afterName = remaining.slice(nameIndex + 1);
    let parameterType = this.typeFromTokens(typeTokens);
    const suffix = stripArraySuffix(afterName);
    if (suffix.dimensions > 0) {
      parameterType = ast.arrayType(parameterType, suffix.dimensions);
    }
    if (name === 'this') {
      return ast.createNode('ReceiverParameter', {
        parameterType,
        annotations: prefix.annotations,
      });
    }
    return ast.formalParameter(name, parameterType, {
      modifiers: prefix.modifiers,
      annotations: prefix.annotations,
      isVarargs,
    });
  }

  typeFromTokens(inputTokens) {
    const tokens = trimTokens(inputTokens || []);
    if (tokens.length === 0) {
      return ast.createNode('UnsupportedType', { text: '' });
    }

    const suffix = stripArraySuffix(tokens);
    if (suffix.dimensions > 0) {
      return ast.arrayType(this.typeFromTokens(suffix.tokens), suffix.dimensions);
    }

    const unionParts = splitTopLevel(tokens, '|').filter((part) => part.length > 0);
    if (unionParts.length > 1) {
      return ast.createNode('UnionType', { alternatives: unionParts.map((part) => this.typeFromTokens(part)) });
    }

    const intersectionParts = splitTopLevel(tokens, '&').filter((part) => part.length > 0);
    if (intersectionParts.length > 1) {
      return ast.createNode('IntersectionType', { types: intersectionParts.map((part) => this.typeFromTokens(part)) });
    }

    const text = this.textOf(tokens);
    if (text === 'void') {
      return ast.voidType();
    }
    if (PRIMITIVE_TYPES.has(text)) {
      return ast.primitiveType(text);
    }
    if (text === '?') {
      return ast.wildcardType();
    }
    if (tokens[0].text === '?') {
      const boundKind = tokens[1] && (tokens[1].text === 'extends' || tokens[1].text === 'super') ? tokens[1].text : null;
      return ast.wildcardType({
        boundKind,
        boundType: boundKind ? this.typeFromTokens(tokens.slice(2)) : null,
      });
    }

    const genericIndex = findTopLevelToken(tokens, '<');
    if (genericIndex !== -1) {
      let closeIndex = findMatchingInTokens(tokens, genericIndex, '<', '>');
      if (closeIndex === -1) closeIndex = tokens.length;
      if (closeIndex > genericIndex) {
        const baseType = this.typeFromTokens(tokens.slice(0, genericIndex));
        const typeArguments = splitTopLevel(tokens.slice(genericIndex + 1, closeIndex), ',')
          .filter((part) => part.length > 0)
          .map((part) => this.typeFromTokens(part));
        return ast.createNode('ParameterizedType', { baseType, typeArguments, text });
      }
    }

    if (tokens.every((token) => isNameToken(token) || token.text === '.')) {
      const parts = tokens.filter((token) => token.text !== '.').map((token) => token.text);
      if (parts.length === 1) {
        return ast.classType(parts[0]);
      }
      if (parts.length > 1) {
        return ast.classType(parts[parts.length - 1], { packageName: parts.slice(0, -1).join('.') });
      }
    }

    return ast.createNode('UnsupportedType', {
      text,
      tokens: tokens.map(compactToken),
      range: tokenRange(tokens),
    });
  }

  expressionFromTokens(tokens) {
    const safeTokens = tokens || [];
    if (safeTokens.length === 0) {
      return null;
    }

    if (safeTokens.length >= 2 && safeTokens[0].text === '(') {
      const closeIndex = findMatchingInTokens(safeTokens, 0, '(', ')');
      if (closeIndex === safeTokens.length - 1) {
        return ast.createNode('ParenthesizedExpression', {
          expression: this.expressionFromTokens(safeTokens.slice(1, -1)) || this.unsupportedExpression(safeTokens.slice(1, -1)),
        });
      }
    }

    if (safeTokens.length === 1) {
      const token = safeTokens[0];
      if (token.kind === 'string') return ast.literalExpression(token.value, 'string', token.text);
      if (token.kind === 'char') return ast.literalExpression(token.value, 'char', token.text);
      if (token.kind === 'number') return ast.literalExpression(token.value, 'number', token.text);
      if (token.text === 'true' || token.text === 'false') return ast.literalExpression(token.text === 'true', 'boolean', token.text);
      if (token.text === 'null') return ast.literalExpression(null, 'null', token.text);
      if (isNameToken(token)) return ast.identifier(token.text);
      return null;
    }

    const last = safeTokens[safeTokens.length - 1];
    if (last && last.text === ')') {
      let openIndex = -1;
      for (let i = safeTokens.length - 2; i >= 0; i -= 1) {
        if (safeTokens[i].text === '(') {
          const closeIndex = findMatchingInTokens(safeTokens, i, '(', ')');
          if (closeIndex === safeTokens.length - 1) {
            openIndex = i;
            break;
          }
        }
      }
      if (openIndex > 0 && isNameToken(safeTokens[openIndex - 1])) {
        const name = safeTokens[openIndex - 1].text;
        let targetTokens = safeTokens.slice(0, openIndex - 1);
        if (targetTokens.length && targetTokens[targetTokens.length - 1].text === '.') {
          targetTokens = targetTokens.slice(0, -1);
        }
        const argumentTokens = safeTokens.slice(openIndex + 1, -1);
        const argumentParts = splitTopLevel(argumentTokens, ',').filter((part) => part.length > 0);
        const args = argumentParts.map((part) => this.expressionFromTokens(part) || this.unsupportedExpression(part));
        const target = targetTokens.length ? this.expressionFromTokens(targetTokens) || this.unsupportedExpression(targetTokens) : null;
        return ast.methodInvocationExpression({
          target,
          name,
          arguments: args,
          meta: { recoveredBy: 'java-frontend.expressionFromTokens' },
        });
      }
    }

    if (safeTokens.every((token, index) => {
      if (index % 2 === 0) return isNameToken(token);
      return token.text === '.';
    })) {
      let expr = ast.identifier(safeTokens[0].text);
      for (let i = 2; i < safeTokens.length; i += 2) {
        expr = ast.createNode('FieldAccessExpression', {
          target: expr,
          name: safeTokens[i].text,
        });
      }
      return expr;
    }

    return null;
  }

  unsupportedExpression(tokens) {
    const safeTokens = tokens || [];
    const text = this.textOf(safeTokens);
    const expression = this.expressionFromTokens(safeTokens);
    if (expression) {
      return expression;
    }
    return ast.createNode('UnsupportedExpression', {
      text,
      tokens: safeTokens.map(compactToken),
      range: tokenRange(safeTokens),
    });
  }

  qualifiedNameFromTokens(tokens) {
    const parts = tokens.filter((token) => isNameToken(token)).map((token) => token.text);
    return ast.qualifiedName(parts);
  }

  consumeName(description) {
    const token = this.peek();
    if (!isNameToken(token)) {
      this.error(`Expected ${description}`);
    }
    return this.consume().text;
  }

  parseUnsupportedDeclaration(reason) {
    const start = this.index;
    const tokens = [];
    let body = null;
    while (!this.eof) {
      const token = this.peek();
      if (token.text === ';') {
        this.consume();
        break;
      }
      if (token.text === '{') {
        body = this.parseBlock();
        break;
      }
      if (token.text === '}') {
        break;
      }
      tokens.push(this.consume());
    }
    return ast.createNode('UnsupportedDeclaration', {
      reason,
      text: this.textOf(tokens),
      tokens: tokens.map(compactToken),
      body,
      range: this.currentRangeFrom(start),
    });
  }
}

function parseCompilationUnit(source, options = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('Java source must be a string');
  }
  const parser = new ParserImpl(source, options);
  return parser.parseDocument();
}

function parseJava(source, options = {}) {
  return parseCompilationUnit(source, options);
}

class JavaParser {
  constructor(options = {}) {
    this.options = options;
  }

  parseCompilationUnit(source, options = {}) {
    return parseCompilationUnit(source, { ...this.options, ...options });
  }

  parsePackageDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    return parser.parsePackageDeclaration();
  }

  parseImportDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    return parser.parseImportDeclaration();
  }

  parseTypeDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    const prefix = parser.parseModifiersAndAnnotations();
    return parser.parseTypeDeclaration(prefix);
  }

  parseClassDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    const prefix = parser.parseModifiersAndAnnotations();
    return parser.parseClassDeclaration(prefix);
  }

  parseInterfaceDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    const prefix = parser.parseModifiersAndAnnotations();
    return parser.parseInterfaceDeclaration(prefix);
  }

  parseEnumDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    const prefix = parser.parseModifiersAndAnnotations();
    return parser.parseEnumDeclaration(prefix);
  }

  parseRecordDeclaration(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    const prefix = parser.parseModifiersAndAnnotations();
    return parser.parseRecordDeclaration(prefix);
  }

  parseMethodDeclaration() {
    throw new NotImplementedJavaFrontendError('parse', 'standalone method declarations');
  }

  parseFieldDeclaration() {
    throw new NotImplementedJavaFrontendError('parse', 'standalone field declarations');
  }

  parseStatement(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    return parser.parseStatement();
  }

  parseExpression(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    return parser.unsupportedExpression(parser.tokens);
  }

  parseType(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    return parser.typeFromTokens(parser.tokens);
  }

  parseAnnotation(source, options = {}) {
    const parser = new ParserImpl(source, { ...this.options, ...options });
    return parser.parseAnnotation();
  }

  parseModuleDeclaration() {
    throw new NotImplementedJavaFrontendError('parse', 'module declarations');
  }
}

module.exports = {
  JavaParser,
  parseJava,
  parseCompilationUnit,
};
