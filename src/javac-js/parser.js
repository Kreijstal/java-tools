'use strict';

// Recursive descent parser for Java (through the Java 25 language level as
// used by OpenJDK sources). Produces a javac-shaped tree of plain objects:
// every node has `tag` and `pos` (source offset). Ambiguous constructs are
// resolved by speculative parsing with mark/reset.

const { lex } = require('./lexer');
const { F, MODIFIER_KEYWORDS } = require('./flags');

class ParseError extends Error {
  constructor(message, file, line, col) {
    super(`${file || '<input>'}:${line}:${col}: ${message}`);
    this.file = file;
    this.line = line;
    this.col = col;
  }
}

const PRIMITIVES = new Set(['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']);

// Binary operator precedence (higher binds tighter).
const BINARY_PREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, instanceof: 7,
  '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

function node(tag, pos, props) {
  const n = { tag, pos };
  if (props) Object.assign(n, props);
  return n;
}

class Parser {
  constructor(source, file) {
    this.file = file;
    const res = lex(source, file);
    this.toks = res.tokens;
    this.lineCol = res.lineCol;
    this.i = 0;
    // pending '>' pieces when splitting '>>' / '>>>' / '>=' etc. in type args
    this.split = null;
  }

  // ---- token helpers -------------------------------------------------
  get tok() {
    if (this.split) return this.split;
    return this.toks[this.i];
  }

  peekTok(n) {
    // n-th token after current (ignores split state; only used where no split is pending)
    return this.toks[Math.min(this.i + n, this.toks.length - 1)];
  }

  next() {
    if (this.split) {
      const t = this.split;
      const rest = t.rest;
      if (rest) {
        this.split = { kind: 'op', text: rest[0], pos: t.pos + 1, end: t.end, rest: rest.length > 1 ? rest.slice(1) : null, synthetic: true };
        if (rest.length === 1) {
          // the last piece; we will consume the underlying token when it is taken
        }
      } else {
        this.split = null;
        this.i++;
      }
      return t;
    }
    const t = this.toks[this.i];
    if (t.kind !== 'eof') this.i++;
    return t;
  }

  is(text) {
    const t = this.tok;
    return (t.kind === 'op' || t.kind === 'keyword') && t.text === text;
  }

  isIdent(text) {
    const t = this.tok;
    return t.kind === 'ident' && (text === undefined || t.text === text);
  }

  accept(text) {
    if (this.is(text)) { this.next(); return true; }
    return false;
  }

  expect(text) {
    if (!this.is(text)) this.fail(`'${text}' expected, found '${this.tok.text}'`);
    return this.next();
  }

  // consume a single '>' possibly splitting '>>', '>>>', '>=', '>>=', '>>>='
  expectGT() {
    const t = this.tok;
    if (t.kind === 'op' && t.text === '>') { this.next(); return; }
    if (t.kind === 'op' && t.text[0] === '>' && t.text.length > 1) {
      // replace current token by its remainder
      if (this.split) {
        const rest = t.text.slice(1);
        this.split = { kind: 'op', text: rest, pos: t.pos + 1, end: t.end, rest: null, synthetic: true };
      } else {
        this.split = { kind: 'op', text: t.text.slice(1), pos: t.pos + 1, end: t.end, rest: null, synthetic: true };
      }
      return;
    }
    this.fail(`'>' expected, found '${t.text}'`);
  }

  ident() {
    const t = this.tok;
    if (t.kind !== 'ident') this.fail(`<identifier> expected, found '${t.text}'`);
    this.next();
    return t.text;
  }

  mark() {
    return { i: this.i, split: this.split };
  }

  reset(m) {
    this.i = m.i;
    this.split = m.split;
  }

  pos() {
    return this.tok.pos;
  }

  fail(msg, pos) {
    const p = pos === undefined ? this.tok.pos : pos;
    const { line, col } = this.lineCol(p);
    throw new ParseError(msg, this.file, line, col);
  }

  speculate(fn) {
    const m = this.mark();
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.reset(m);
      return undefined;
    }
  }

  // ---- compilation unit ----------------------------------------------
  parseCompilationUnit() {
    const pos = this.pos();
    let pkg = null;
    let pkgAnnotations = [];
    const imports = [];
    const types = [];
    let module = null;

    // package annotations / modifiers before package or module
    const m0 = this.mark();
    const firstMods = this.modifiersOpt();
    if (this.is('package')) {
      pkgAnnotations = firstMods.annotations;
      this.next();
      pkg = this.qualident();
      this.expect(';');
    } else {
      this.reset(m0);
    }
    while (true) {
      if (this.is('import')) {
        const ipos = this.pos();
        this.next();
        let isStatic = false;
        let isModule = false;
        if (this.is('static')) { this.next(); isStatic = true; }
        else if (this.isIdent('module') && this.peekTok(1).kind === 'ident') { this.next(); isModule = true; }
        let name = node('Ident', this.pos(), { name: this.ident() });
        let wildcard = false;
        while (this.accept('.')) {
          if (this.accept('*')) { wildcard = true; break; }
          name = node('Select', name.pos, { selected: name, name: this.ident() });
        }
        this.expect(';');
        imports.push(node('Import', ipos, { isStatic, isModule, qualid: name, wildcard }));
      } else if (this.is(';')) {
        this.next();
      } else {
        break;
      }
    }
    while (this.tok.kind !== 'eof') {
      if (this.accept(';')) continue;
      const mods = this.modifiersOpt();
      if ((this.isIdent('module') || this.isIdent('open')) && this.looksLikeModuleDecl()) {
        module = this.moduleDecl(mods);
        continue;
      }
      types.push(this.classOrInterfaceDecl(mods));
    }
    return node('CompilationUnit', pos, { file: this.file, pkg, pkgAnnotations, imports, types, module });
  }

  looksLikeModuleDecl() {
    let k = 0;
    if (this.tok.text === 'open') k = 1;
    const t = this.peekTok(k);
    const n = this.peekTok(k + 1);
    return t.kind === 'ident' && t.text === 'module' && n.kind === 'ident';
  }

  moduleDecl(mods) {
    const pos = this.pos();
    let open = false;
    if (this.isIdent('open')) { this.next(); open = true; }
    this.next(); // module
    const name = this.qualident();
    this.expect('{');
    const directives = [];
    while (!this.accept('}')) {
      const dpos = this.pos();
      const kw = this.ident();
      if (kw === 'requires') {
        let isTransitive = false, isStatic = false;
        while (true) {
          if (this.isIdent('transitive') && !(this.peekTok(1).kind === 'op' && (this.peekTok(1).text === ';' || this.peekTok(1).text === '.'))) { this.next(); isTransitive = true; continue; }
          if (this.is('static')) { this.next(); isStatic = true; continue; }
          break;
        }
        const mod = this.qualident();
        this.expect(';');
        directives.push(node('Requires', dpos, { isTransitive, isStatic, moduleName: mod }));
      } else if (kw === 'exports' || kw === 'opens') {
        const pkg = this.qualident();
        const to = [];
        if (this.isIdent('to')) {
          this.next();
          do { to.push(this.qualident()); } while (this.accept(','));
        }
        this.expect(';');
        directives.push(node(kw === 'exports' ? 'Exports' : 'Opens', dpos, { pkg, to }));
      } else if (kw === 'uses') {
        const service = this.qualident();
        this.expect(';');
        directives.push(node('Uses', dpos, { service }));
      } else if (kw === 'provides') {
        const service = this.qualident();
        if (!this.isIdent('with')) this.fail("'with' expected");
        this.next();
        const impls = [];
        do { impls.push(this.qualident()); } while (this.accept(','));
        this.expect(';');
        directives.push(node('Provides', dpos, { service, impls }));
      } else {
        this.fail(`unexpected module directive '${kw}'`, dpos);
      }
    }
    return node('ModuleDecl', pos, { mods, open, name, directives });
  }

  qualident() {
    let t = node('Ident', this.pos(), { name: this.ident() });
    while (this.is('.') && this.peekTok(1).kind === 'ident') {
      this.next();
      t = node('Select', t.pos, { selected: t, name: this.ident() });
    }
    return t;
  }

  // ---- modifiers and annotations -------------------------------------
  modifiersOpt(initial) {
    const pos = this.pos();
    let flags = initial ? initial.flags : 0;
    const annotations = initial ? initial.annotations.slice() : [];
    let docComment = null;
    while (true) {
      const t = this.tok;
      if (t.docComment && docComment === null) docComment = t.docComment;
      if (t.kind === 'keyword' && MODIFIER_KEYWORDS[t.text] !== undefined) {
        // 'default' as a modifier only in interface method context; a 'default:'
        // label never reaches here because statements do not call modifiersOpt for it.
        if (t.text === 'default' && this.peekTok(1).kind === 'op' && (this.peekTok(1).text === ':' || this.peekTok(1).text === '->')) break;
        flags |= MODIFIER_KEYWORDS[t.text];
        this.next();
        continue;
      }
      if (t.kind === 'ident' && t.text === 'sealed' && this.isModifierContextual(1)) {
        flags |= F.SEALED; this.next(); continue;
      }
      if (t.kind === 'ident' && t.text === 'non' && this.peekTok(1).text === '-' && this.peekTok(2).text === 'sealed') {
        flags |= F.NON_SEALED; this.next(); this.next(); this.next(); continue;
      }
      if (t.kind === 'op' && t.text === '@' && !(this.peekTok(1).kind === 'keyword' && this.peekTok(1).text === 'interface')) {
        annotations.push(this.annotation());
        continue;
      }
      break;
    }
    const mods = { tag: 'Modifiers', pos, flags, annotations };
    if (docComment && /@deprecated/.test(docComment)) mods.flags |= F.DEPRECATED;
    if (docComment) mods.docComment = docComment;
    return mods;
  }

  isModifierContextual(k) {
    const n = this.peekTok(k);
    if (n.kind === 'keyword') return ['class', 'interface', 'abstract', 'public', 'private', 'protected', 'static', 'final', 'strictfp'].includes(n.text) || n.text === '@';
    if (n.kind === 'ident') return ['record', 'sealed', 'non'].includes(n.text) || (n.text !== 'permits');
    if (n.kind === 'op') return n.text === '@';
    return false;
  }

  annotation() {
    const pos = this.pos();
    this.expect('@');
    const annotationType = this.qualident();
    const args = [];
    if (this.accept('(')) {
      if (!this.is(')')) {
        // either single element value or name=value pairs
        if (this.tok.kind === 'ident' && this.peekTok(1).kind === 'op' && this.peekTok(1).text === '=') {
          do {
            const npos = this.pos();
            const name = this.ident();
            this.expect('=');
            const value = this.elementValue();
            args.push(node('Assign', npos, { lhs: node('Ident', npos, { name }), rhs: value }));
          } while (this.accept(','));
        } else {
          const value = this.elementValue();
          args.push(node('Assign', value.pos, { lhs: node('Ident', value.pos, { name: 'value' }), rhs: value }));
        }
      }
      this.expect(')');
    }
    return node('Annotation', pos, { annotationType, args });
  }

  elementValue() {
    if (this.is('@')) return this.annotation();
    if (this.is('{')) {
      const pos = this.pos();
      this.next();
      const elems = [];
      while (!this.is('}')) {
        elems.push(this.elementValue());
        if (!this.accept(',')) break;
      }
      this.expect('}');
      return node('NewArray', pos, { elemtype: null, dims: [], elems });
    }
    return this.expression();
  }

  typeAnnotationsOpt() {
    const anns = [];
    while (this.is('@') && !(this.peekTok(1).kind === 'keyword' && this.peekTok(1).text === 'interface')) anns.push(this.annotation());
    return anns;
  }

  // ---- declarations ---------------------------------------------------
  classOrInterfaceDecl(mods) {
    if (this.is('class')) return this.classDecl(mods);
    if (this.is('interface')) return this.interfaceDecl(mods);
    if (this.is('enum')) return this.enumDecl(mods);
    if (this.is('@')) {
      // @interface
      this.next();
      return this.interfaceDecl(mods, true);
    }
    if (this.isIdent('record') && this.peekTok(1).kind === 'ident') return this.recordDecl(mods);
    this.fail(`class, interface, enum, or record expected, found '${this.tok.text}'`);
  }

  typeParametersOpt() {
    if (!this.is('<')) return [];
    this.next();
    const params = [];
    do {
      const pos = this.pos();
      const annotations = this.typeAnnotationsOpt();
      const name = this.ident();
      const bounds = [];
      if (this.accept('extends')) {
        do { bounds.push(this.parseType()); } while (this.accept('&'));
      }
      params.push(node('TypeParameter', pos, { name, bounds, annotations }));
    } while (this.accept(','));
    this.expectGT();
    return params;
  }

  classDecl(mods) {
    const pos = this.pos();
    this.expect('class');
    const name = this.ident();
    const typarams = this.typeParametersOpt();
    let ext = null;
    const impl = [];
    const permits = [];
    if (this.accept('extends')) ext = this.parseType();
    if (this.accept('implements')) { do { impl.push(this.parseType()); } while (this.accept(',')); }
    if (this.isIdent('permits')) { this.next(); do { permits.push(this.parseType()); } while (this.accept(',')); }
    const defs = this.classBody(name, 'class');
    return node('ClassDecl', pos, { kind: 'class', mods, name, typarams, extending: ext, implementing: impl, permitting: permits, defs });
  }

  recordDecl(mods) {
    const pos = this.pos();
    this.next(); // record
    const name = this.ident();
    const typarams = this.typeParametersOpt();
    this.expect('(');
    const components = [];
    if (!this.is(')')) {
      do {
        const cmods = this.modifiersOpt();
        const cpos = this.pos();
        let type = this.parseType();
        let varargs = false;
        if (this.accept('...')) { varargs = true; type = node('ArrayType', type.pos, { elemtype: type }); }
        const cname = this.ident();
        components.push(node('VarDecl', cpos, { mods: cmods, name: cname, vartype: type, init: null, varargs }));
      } while (this.accept(','));
    }
    this.expect(')');
    const impl = [];
    if (this.accept('implements')) { do { impl.push(this.parseType()); } while (this.accept(',')); }
    const defs = this.classBody(name, 'record');
    return node('ClassDecl', pos, { kind: 'record', mods, name, typarams, extending: null, implementing: impl, permitting: [], defs, components });
  }

  interfaceDecl(mods, isAnnotation) {
    const pos = this.pos();
    this.expect('interface');
    const name = this.ident();
    const typarams = this.typeParametersOpt();
    const ext = [];
    const permits = [];
    if (this.accept('extends')) { do { ext.push(this.parseType()); } while (this.accept(',')); }
    if (this.isIdent('permits')) { this.next(); do { permits.push(this.parseType()); } while (this.accept(',')); }
    const defs = this.classBody(name, isAnnotation ? 'annotation' : 'interface');
    return node('ClassDecl', pos, { kind: isAnnotation ? 'annotation' : 'interface', mods, name, typarams, extending: null, implementing: ext, permitting: permits, defs });
  }

  enumDecl(mods) {
    const pos = this.pos();
    this.expect('enum');
    const name = this.ident();
    const impl = [];
    if (this.accept('implements')) { do { impl.push(this.parseType()); } while (this.accept(',')); }
    this.expect('{');
    const defs = [];
    // enum constants
    while (!this.is(';') && !this.is('}')) {
      const cmods = this.modifiersOpt();
      const cpos = this.pos();
      const cname = this.ident();
      let args = null;
      if (this.is('(')) args = this.arguments();
      let body = null;
      if (this.is('{')) {
        const bpos = this.pos();
        const bdefs = this.classBody(null, 'class');
        body = node('ClassDecl', bpos, { kind: 'class', mods: { tag: 'Modifiers', pos: bpos, flags: 0, annotations: [] }, name: '', typarams: [], extending: null, implementing: [], permitting: [], defs: bdefs, isEnumConstantBody: true });
      }
      defs.push(node('VarDecl', cpos, { mods: { ...cmods, flags: cmods.flags | F.PUBLIC | F.STATIC | F.FINAL | F.ENUM }, name: cname, vartype: null, init: null, enumConstant: { args: args || [], body } }));
      if (!this.accept(',')) break;
    }
    if (this.accept(';')) {
      while (!this.is('}')) {
        const member = this.classBodyDeclaration(name, 'enum');
        if (member) defs.push(...member);
      }
    }
    this.expect('}');
    return node('ClassDecl', pos, { kind: 'enum', mods, name, typarams: [], extending: null, implementing: impl, permitting: [], defs });
  }

  classBody(className, kind) {
    this.expect('{');
    const defs = [];
    while (!this.accept('}')) {
      if (this.tok.kind === 'eof') this.fail("reached end of file while parsing");
      const member = this.classBodyDeclaration(className, kind);
      if (member) defs.push(...member);
    }
    return defs;
  }

  classBodyDeclaration(className, kind) {
    if (this.accept(';')) return null;
    const pos = this.pos();
    // initializer blocks
    if (this.is('{')) return [node('Block', pos, { stats: this.block().stats, isStatic: false, isInitializer: true })];
    if (this.is('static') && this.peekTok(1).kind === 'op' && this.peekTok(1).text === '{') {
      this.next();
      return [node('Block', pos, { stats: this.block().stats, isStatic: true, isInitializer: true })];
    }
    const mods = this.modifiersOpt();
    if (this.is('class') || this.is('interface') || this.is('enum') || (this.is('@') && this.peekTok(1).text === 'interface') ||
      (this.isIdent('record') && this.peekTok(1).kind === 'ident' && this.peekTok(2).kind === 'op' && (this.peekTok(2).text === '(' || this.peekTok(2).text === '<'))) {
      return [this.classOrInterfaceDecl(mods)];
    }
    const typarams = this.typeParametersOpt();
    const tpos = this.pos();
    // constructor: Name '('
    if (this.tok.kind === 'ident' && this.tok.text === className && this.peekTok(1).kind === 'op' && this.peekTok(1).text === '(') {
      this.next();
      return [this.methodRest(mods, typarams, null, '<init>', tpos, kind)];
    }
    // compact record constructor: Name '{'
    if (kind === 'record' && this.tok.kind === 'ident' && this.tok.text === className && this.peekTok(1).kind === 'op' && this.peekTok(1).text === '{') {
      this.next();
      const body = this.block();
      return [node('MethodDecl', tpos, { mods: { ...mods, flags: mods.flags | F.COMPACT_RECORD_CONSTRUCTOR }, name: '<init>', typarams, restype: null, params: [], recvParam: null, thrown: [], body, defaultValue: null, compact: true })];
    }
    let type;
    if (this.is('void')) {
      this.next();
      type = node('PrimitiveType', tpos, { typetag: 'void' });
    } else {
      type = this.parseType();
    }
    const npos = this.pos();
    const name = this.ident();
    if (this.is('(')) {
      return [this.methodRest(mods, typarams, type, name, npos, kind)];
    }
    // fields
    const vars = [];
    let vname = name;
    let vpos = npos;
    while (true) {
      let vtype = type;
      let dims = 0;
      while (this.is('[') || this.is('@')) {
        const anns = this.typeAnnotationsOpt();
        this.expect('[');
        this.expect(']');
        vtype = node('ArrayType', vtype.pos, { elemtype: vtype, annotations: anns });
        dims++;
      }
      let init = null;
      if (this.accept('=')) init = this.variableInitializer();
      vars.push(node('VarDecl', vpos, { mods, name: vname, vartype: vtype, init }));
      if (!this.accept(',')) break;
      vpos = this.pos();
      vname = this.ident();
    }
    this.expect(';');
    return vars;
  }

  methodRest(mods, typarams, restype, name, pos, kind) {
    const { params, recvParam } = this.formalParameters();
    if (restype) {
      // old-style array dims after parameter list
      while (this.is('[') || this.is('@')) {
        const anns = this.typeAnnotationsOpt();
        this.expect('[');
        this.expect(']');
        restype = node('ArrayType', restype.pos, { elemtype: restype, annotations: anns });
      }
    }
    const thrown = [];
    if (this.accept('throws')) { do { thrown.push(this.parseType()); } while (this.accept(',')); }
    let body = null;
    let defaultValue = null;
    if (this.accept('default')) defaultValue = this.elementValue();
    if (this.is('{')) body = this.block();
    else this.expect(';');
    return node('MethodDecl', pos, { mods, name, typarams, restype, params, recvParam, thrown, body, defaultValue });
  }

  formalParameters() {
    this.expect('(');
    const params = [];
    let recvParam = null;
    if (!this.is(')')) {
      do {
        const mods = this.modifiersOpt();
        const ppos = this.pos();
        let type = this.parseType();
        let varargs = false;
        if (this.is('@') || this.is('...')) {
          const anns = this.typeAnnotationsOpt();
          this.expect('...');
          varargs = true;
          type = node('ArrayType', type.pos, { elemtype: type, annotations: anns });
        }
        // receiver parameter: Type this  |  Type Outer.this
        if (this.is('this')) {
          this.next();
          recvParam = node('VarDecl', ppos, { mods, name: 'this', vartype: type, init: null });
          continue;
        }
        if (this.tok.kind === 'ident' && this.peekTok(1).text === '.' && this.peekTok(2).text === 'this') {
          this.next(); this.next(); this.next();
          recvParam = node('VarDecl', ppos, { mods, name: 'this', vartype: type, init: null });
          continue;
        }
        const name = this.ident();
        while (this.is('[')) {
          this.next();
          this.expect(']');
          type = node('ArrayType', type.pos, { elemtype: type });
        }
        params.push(node('VarDecl', ppos, { mods: { ...mods, flags: mods.flags | (varargs ? F.VARARGS : 0) }, name, vartype: type, init: null, varargs }));
      } while (this.accept(','));
    }
    this.expect(')');
    return { params, recvParam };
  }

  variableInitializer() {
    if (this.is('{')) return this.arrayInitializer(null);
    return this.expression();
  }

  arrayInitializer(elemtype) {
    const pos = this.pos();
    this.expect('{');
    const elems = [];
    while (!this.is('}')) {
      elems.push(this.variableInitializer());
      if (!this.accept(',')) break;
    }
    this.expect('}');
    return node('NewArray', pos, { elemtype, dims: [], elems });
  }

  // ---- types ------------------------------------------------------------
  // Parse a type (no void). Handles annotations, generics, arrays.
  parseType(allowVar) {
    const annotations = this.typeAnnotationsOpt();
    const pos = this.pos();
    let t;
    if (this.tok.kind === 'keyword' && PRIMITIVES.has(this.tok.text)) {
      t = node('PrimitiveType', pos, { typetag: this.next().text });
    } else if (this.is('?')) {
      this.fail('wildcard not allowed here');
    } else {
      t = this.classType();
    }
    if (annotations.length) t = node('AnnotatedType', pos, { annotations, underlying: t });
    return this.bracketsOpt(t);
  }

  bracketsOpt(t) {
    while (true) {
      if (this.is('[') && this.peekTok(1).kind === 'op' && this.peekTok(1).text === ']' && !this.split) {
        this.next();
        this.next();
        t = node('ArrayType', t.pos, { elemtype: t });
        continue;
      }
      if (this.is('@')) {
        const m = this.mark();
        const anns = this.typeAnnotationsOpt();
        if (this.is('[') && this.peekTok(1).text === ']') {
          this.next(); this.next();
          t = node('ArrayType', t.pos, { elemtype: t, annotations: anns });
          continue;
        }
        this.reset(m);
      }
      break;
    }
    return t;
  }

  classType() {
    let t = node('Ident', this.pos(), { name: this.ident() });
    if (this.is('<')) t = this.typeArgumentsApply(t);
    while (this.is('.') && (this.peekTok(1).kind === 'ident' || (this.peekTok(1).kind === 'op' && this.peekTok(1).text === '@'))) {
      this.next();
      const anns = this.typeAnnotationsOpt();
      const spos = this.pos();
      t = node('Select', spos, { selected: t, name: this.ident() });
      if (anns.length) t = node('AnnotatedType', spos, { annotations: anns, underlying: t });
      if (this.is('<')) t = this.typeArgumentsApply(t);
    }
    return t;
  }

  typeArgumentsApply(clazz) {
    const pos = this.pos();
    const args = this.typeArguments(true);
    return node('TypeApply', pos, { clazz, args });
  }

  // allowDiamond: '<>' yields empty list
  typeArguments(allowDiamond) {
    this.expect('<');
    const args = [];
    if (this.is('>') && allowDiamond) {
      this.next();
      return args;
    }
    do {
      args.push(this.typeArgument());
    } while (this.accept(','));
    this.expectGT();
    return args;
  }

  typeArgument() {
    const annotations = this.typeAnnotationsOpt();
    const pos = this.pos();
    let t;
    if (this.accept('?')) {
      let kind = 'unbound';
      let bound = null;
      if (this.accept('extends')) { kind = 'extends'; bound = this.parseType(); }
      else if (this.accept('super')) { kind = 'super'; bound = this.parseType(); }
      t = node('Wildcard', pos, { kind, bound });
    } else {
      t = this.parseType();
    }
    if (annotations.length) t = node('AnnotatedType', pos, { annotations, underlying: t });
    return t;
  }

  // ---- statements -------------------------------------------------------
  block() {
    const pos = this.pos();
    this.expect('{');
    const stats = [];
    while (!this.is('}')) {
      if (this.tok.kind === 'eof') this.fail('reached end of file while parsing');
      stats.push(...this.blockStatement());
    }
    this.expect('}');
    return node('Block', pos, { stats, endPos: this.toks[this.i - 1].pos });
  }

  // returns an array of statements (local var decls with several declarators split)
  blockStatement() {
    const t = this.tok;
    const pos = t.pos;
    // local class / record / interface / enum
    if (t.kind === 'keyword' && (t.text === 'class' || t.text === 'interface' || t.text === 'enum' || t.text === 'abstract' || t.text === 'final' || t.text === 'static' || t.text === 'strictfp')) {
      if (t.text === 'final' || t.text === 'abstract' || t.text === 'static' || t.text === 'strictfp') {
        const m = this.mark();
        const mods = this.modifiersOpt();
        if (this.is('class') || this.is('interface') || this.is('enum') || (this.isIdent('record') && this.peekTok(1).kind === 'ident')) {
          return [node('ClassDef', pos, { decl: this.classOrInterfaceDecl(mods) })];
        }
        this.reset(m);
        return this.localVariableDeclarationStatement();
      }
      return [node('ClassDef', pos, { decl: this.classOrInterfaceDecl({ tag: 'Modifiers', pos, flags: 0, annotations: [] }) })];
    }
    if (t.kind === 'ident' && t.text === 'record' && this.peekTok(1).kind === 'ident' && this.peekTok(2).kind === 'op' && (this.peekTok(2).text === '(' || this.peekTok(2).text === '<')) {
      return [node('ClassDef', pos, { decl: this.recordDecl({ tag: 'Modifiers', pos, flags: 0, annotations: [] }) })];
    }
    if (t.kind === 'op' && t.text === '@') {
      const m = this.mark();
      const mods = this.modifiersOpt();
      if (this.is('class') || this.is('interface') || this.is('enum') || (this.isIdent('record') && this.peekTok(1).kind === 'ident')) {
        return [node('ClassDef', pos, { decl: this.classOrInterfaceDecl(mods) })];
      }
      this.reset(m);
      return this.localVariableDeclarationStatement();
    }
    if (t.kind === 'ident' && (t.text === 'sealed' || t.text === 'non') ) {
      const m = this.mark();
      const r = this.speculate(() => {
        const mods = this.modifiersOpt();
        if (this.is('class') || this.is('interface')) return [node('ClassDef', pos, { decl: this.classOrInterfaceDecl(mods) })];
        throw new ParseError('x', '', 0, 0);
      });
      if (r) return r;
      this.reset(m);
    }
    // local variable declaration?
    if (this.looksLikeLocalVarDecl()) {
      return this.localVariableDeclarationStatement();
    }
    return [this.statement()];
  }

  // Decide whether a block statement starts with a local variable declaration.
  looksLikeLocalVarDecl() {
    const t = this.tok;
    if (t.kind === 'keyword' && PRIMITIVES.has(t.text)) {
      // int.class is an expression
      const n = this.peekTok(1);
      if (n.kind === 'op' && n.text === '.') return false;
      if (n.kind === 'op' && n.text === '[') {
        // int[].class
        let k = 1;
        while (this.peekTok(k).text === '[' && this.peekTok(k + 1).text === ']') k += 2;
        if (this.peekTok(k).text === '.') return false;
      }
      return true;
    }
    if (t.kind === 'keyword' && t.text === 'final') return true;
    if (t.kind !== 'ident') return false;
    // `yield` is a restricted identifier and never names a type
    if (t.text === 'yield' && this.isYieldStatement()) return false;
    // 'var x' / 'var _'
    if (t.text === 'var' && this.peekTok(1).kind === 'ident') return true;
    // Speculatively parse a type followed by an identifier
    const m = this.mark();
    try {
      this.parseType();
      const ok = this.tok.kind === 'ident' && this.peekAfterNameIsDeclarator();
      return ok;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return false;
    } finally {
      this.reset(m);
    }
  }

  peekAfterNameIsDeclarator() {
    const n = this.peekTok(1);
    if (n.kind !== 'op') return n.kind === 'eof';
    return n.text === '=' || n.text === ';' || n.text === ',' || n.text === '[' || n.text === ':' || n.text === ')';
  }

  localVariableDeclarationStatement() {
    const decls = this.localVariableDeclarations();
    this.expect(';');
    return decls;
  }

  localVariableDeclarations(noInit) {
    const mods = this.modifiersOpt();
    const pos = this.pos();
    let type;
    if (this.isIdent('var') && this.peekTok(1).kind === 'ident') {
      this.next();
      type = null; // inferred
    } else {
      type = this.parseType();
    }
    const decls = [];
    do {
      const vpos = this.pos();
      const name = this.ident();
      let vtype = type;
      while (this.is('[')) {
        this.next();
        this.expect(']');
        vtype = node('ArrayType', vtype ? vtype.pos : vpos, { elemtype: vtype });
      }
      let init = null;
      if (!noInit && this.accept('=')) init = this.variableInitializer();
      decls.push(node('VarDecl', vpos, { mods, name, vartype: vtype, init, isLocal: true, declaredVar: type === null }));
    } while (!noInit && this.accept(','));
    return decls;
  }

  statement() {
    const t = this.tok;
    const pos = t.pos;
    if (t.kind === 'op') {
      if (t.text === '{') return this.block();
      if (t.text === ';') { this.next(); return node('Skip', pos); }
    }
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'if': {
          this.next();
          const cond = this.parExpression();
          const thenp = this.statement();
          const elsep = this.accept('else') ? this.statement() : null;
          return node('If', pos, { cond, thenp, elsep });
        }
        case 'while': {
          this.next();
          const cond = this.parExpression();
          return node('WhileLoop', pos, { cond, body: this.statement() });
        }
        case 'do': {
          this.next();
          const body = this.statement();
          this.expect('while');
          const cond = this.parExpression();
          this.expect(';');
          return node('DoLoop', pos, { body, cond });
        }
        case 'for': return this.forStatement();
        case 'try': return this.tryStatement();
        case 'switch': {
          const sw = this.switchConstruct(false);
          return sw;
        }
        case 'synchronized': {
          this.next();
          const lock = this.parExpression();
          return node('Synchronized', pos, { lock, body: this.block() });
        }
        case 'return': {
          this.next();
          const expr = this.is(';') ? null : this.expression();
          this.expect(';');
          return node('Return', pos, { expr });
        }
        case 'throw': {
          this.next();
          const expr = this.expression();
          this.expect(';');
          return node('Throw', pos, { expr });
        }
        case 'break': {
          this.next();
          const label = this.tok.kind === 'ident' ? this.ident() : null;
          this.expect(';');
          return node('Break', pos, { label });
        }
        case 'continue': {
          this.next();
          const label = this.tok.kind === 'ident' ? this.ident() : null;
          this.expect(';');
          return node('Continue', pos, { label });
        }
        case 'assert': {
          this.next();
          const cond = this.expression();
          const detail = this.accept(':') ? this.expression() : null;
          this.expect(';');
          return node('Assert', pos, { cond, detail });
        }
        default: break;
      }
    }
    if (t.kind === 'ident') {
      // labeled statement
      const n = this.peekTok(1);
      if (n.kind === 'op' && n.text === ':' ) {
        const label = this.ident();
        this.next();
        return node('Labelled', pos, { label, body: this.statement() });
      }
      // yield statement (contextual)
      if (t.text === 'yield' && this.isYieldStatement()) {
        this.next();
        const value = this.expression();
        this.expect(';');
        return node('Yield', pos, { value });
      }
    }
    const expr = this.expression();
    this.expect(';');
    return node('Exec', pos, { expr });
  }

  isYieldStatement() {
    const n = this.peekTok(1);
    if (n.kind === 'op') {
      // yield = x; yield += ... ; yield.foo() ; yield[0] are expressions
      if (['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '.', '[', ';', '->', '::', '++', '--'].includes(n.text)) {
        if (n.text === '++' || n.text === '--') return false;
        return false;
      }
      if (n.text === '(') {
        // yield (x) could be a method call named yield, which is illegal unqualified in modern Java;
        // treat as yield statement.
        return true;
      }
      return true;
    }
    return true;
  }

  parExpression() {
    this.expect('(');
    const e = this.expression();
    this.expect(')');
    return e;
  }

  forStatement() {
    const pos = this.pos();
    this.expect('for');
    this.expect('(');
    // enhanced for?
    const m = this.mark();
    if (!this.is(';')) {
      const isDecl = this.looksLikeLocalVarDeclForHeader();
      if (isDecl) {
        const decls = this.localVariableDeclarationsForHeader();
        if (decls.enhanced) {
          const expr = this.expression();
          this.expect(')');
          const body = this.statement();
          return node('ForeachLoop', pos, { var: decls.var, expr, body });
        }
        this.expect(';');
        const cond = this.is(';') ? null : this.expression();
        this.expect(';');
        const step = this.is(')') ? [] : this.expressionList();
        this.expect(')');
        return node('ForLoop', pos, { init: decls.list, cond, step: step.map((e) => node('Exec', e.pos, { expr: e })), body: this.statement() });
      }
      this.reset(m);
      const init = this.expressionList().map((e) => node('Exec', e.pos, { expr: e }));
      this.expect(';');
      const cond = this.is(';') ? null : this.expression();
      this.expect(';');
      const step = this.is(')') ? [] : this.expressionList();
      this.expect(')');
      return node('ForLoop', pos, { init, cond, step: step.map((e) => node('Exec', e.pos, { expr: e })), body: this.statement() });
    }
    this.expect(';');
    const cond = this.is(';') ? null : this.expression();
    this.expect(';');
    const step = this.is(')') ? [] : this.expressionList();
    this.expect(')');
    return node('ForLoop', pos, { init: [], cond, step: step.map((e) => node('Exec', e.pos, { expr: e })), body: this.statement() });
  }

  looksLikeLocalVarDeclForHeader() {
    const t = this.tok;
    if (t.kind === 'keyword' && (t.text === 'final' || PRIMITIVES.has(t.text))) return true;
    if (t.kind === 'op' && t.text === '@') return true;
    if (t.kind !== 'ident') return false;
    if (t.text === 'var' && this.peekTok(1).kind === 'ident') return true;
    const m = this.mark();
    try {
      this.parseType();
      return this.tok.kind === 'ident';
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return false;
    } finally {
      this.reset(m);
    }
  }

  localVariableDeclarationsForHeader() {
    const mods = this.modifiersOpt();
    const pos = this.pos();
    let type;
    if (this.isIdent('var') && this.peekTok(1).kind === 'ident') { this.next(); type = null; }
    else type = this.parseType();
    const list = [];
    do {
      const vpos = this.pos();
      const name = this.ident();
      let vtype = type;
      while (this.is('[')) { this.next(); this.expect(']'); vtype = node('ArrayType', vpos, { elemtype: vtype }); }
      if (list.length === 0 && this.is(':')) {
        this.next();
        return { enhanced: true, var: node('VarDecl', vpos, { mods, name, vartype: vtype, init: null, isLocal: true, declaredVar: type === null }) };
      }
      let init = null;
      if (this.accept('=')) init = this.variableInitializer();
      list.push(node('VarDecl', vpos, { mods, name, vartype: vtype, init, isLocal: true, declaredVar: type === null }));
    } while (this.accept(','));
    return { enhanced: false, list };
  }

  expressionList() {
    const list = [this.expression()];
    while (this.accept(',')) list.push(this.expression());
    return list;
  }

  tryStatement() {
    const pos = this.pos();
    this.expect('try');
    const resources = [];
    if (this.accept('(')) {
      while (!this.is(')')) {
        const rpos = this.pos();
        // resource: declaration or a variable access expression
        if (this.looksLikeLocalVarDeclForHeader() && !this.looksLikeResourceExpr()) {
          const mods = this.modifiersOpt();
          let type;
          if (this.isIdent('var') && this.peekTok(1).kind === 'ident') { this.next(); type = null; }
          else type = this.parseType();
          const name = this.ident();
          this.expect('=');
          const init = this.expression();
          resources.push(node('VarDecl', rpos, { mods, name, vartype: type, init, isLocal: true, declaredVar: type === null, isResource: true }));
        } else {
          resources.push(this.expression());
        }
        if (!this.accept(';')) break;
      }
      this.expect(')');
    }
    const body = this.block();
    const catchers = [];
    while (this.is('catch')) {
      const cpos = this.pos();
      this.next();
      this.expect('(');
      const mods = this.modifiersOpt();
      const types = [this.parseType()];
      while (this.accept('|')) types.push(this.parseType());
      const vpos = this.pos();
      const name = this.ident();
      this.expect(')');
      const vartype = types.length > 1 ? node('TypeUnion', types[0].pos, { alternatives: types }) : types[0];
      const param = node('VarDecl', vpos, { mods, name, vartype, init: null, isLocal: true });
      catchers.push(node('Catch', cpos, { param, body: this.block() }));
    }
    const finalizer = this.accept('finally') ? this.block() : null;
    if (!catchers.length && !finalizer && !resources.length) this.fail("'catch' or 'finally' expected");
    return node('Try', pos, { resources, body, catchers, finalizer });
  }

  looksLikeResourceExpr() {
    // `this.x`, `x`, `a.b.c` followed by ';' or ')'
    const m = this.mark();
    try {
      if (this.is('this')) this.next(); else this.ident();
      while (this.accept('.')) this.ident();
      return this.is(';') || this.is(')');
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return false;
    } finally {
      this.reset(m);
    }
  }

  // switch statement or expression
  switchConstruct(isExpression) {
    const pos = this.pos();
    this.expect('switch');
    const selector = this.parExpression();
    this.expect('{');
    const cases = [];
    while (!this.is('}')) {
      const cpos = this.pos();
      const labels = [];
      let guard = null;
      if (this.accept('default')) {
        labels.push(node('DefaultCaseLabel', cpos));
      } else {
        this.expect('case');
        do {
          labels.push(this.caseLabel());
        } while (this.accept(','));
        if (this.isIdent('when')) {
          this.next();
          // A guard cannot be a lambda, and `when (a || b) -> ...` must not be
          // read as one, so parse it below the lambda/assignment level.
          guard = this.ternary();
        }
      }
      let arrow = false;
      let stats = [];
      let body = null;
      if (this.accept('->')) {
        arrow = true;
        if (this.is('{')) {
          body = this.block();
          stats = [body];
        } else if (this.is('throw')) {
          body = this.statement();
          stats = [body];
        } else {
          const e = this.expression();
          this.expect(';');
          body = node('Exec', e.pos, { expr: e, isCaseExpression: true });
          stats = [body];
        }
      } else {
        this.expect(':');
        while (!this.is('case') && !this.is('default') && !this.is('}')) {
          stats.push(...this.blockStatement());
        }
        // `default:` might also appear as label after statements; loop handles it
      }
      cases.push(node('Case', cpos, { labels, guard, stats, body, arrow }));
    }
    this.expect('}');
    return node(isExpression ? 'SwitchExpression' : 'Switch', pos, { selector, cases });
  }

  caseLabel() {
    const pos = this.pos();
    if (this.is('null')) {
      // 'null' or 'null, default'
      this.next();
      if (this.is(',') && this.peekTok(1).text === 'default') {
        this.next();
        this.next();
        return node('NullDefaultCaseLabel', pos);
      }
      return node('ConstantCaseLabel', pos, { expr: node('Literal', pos, { typetag: 'null', value: null }) });
    }
    if (this.is('default')) {
      this.next();
      return node('DefaultCaseLabel', pos);
    }
    // pattern or constant expression?
    const pat = this.speculate(() => {
      const p = this.pattern();
      if (!(this.is('->') || this.is(':') || this.is(',') || this.isIdent('when'))) throw new ParseError('not a pattern', '', 0, 0);
      return p;
    });
    if (pat) return node('PatternCaseLabel', pos, { pat });
    // constant expression; ':' terminates (no conditional at top level in a case label without parens)
    const expr = this.ternary();
    return node('ConstantCaseLabel', pos, { expr });
  }

  // type pattern, record pattern, or '_'
  pattern() {
    const pos = this.pos();
    const mods = this.modifiersOpt();
    if (this.isIdent('_') && !(mods.flags || mods.annotations.length)) {
      // unnamed pattern only valid nested; keep it
      this.next();
      return node('AnyPattern', pos);
    }
    let type = null;
    if (this.isIdent('var') && this.peekTok(1).kind === 'ident') {
      this.next();
    } else {
      type = this.parseType();
    }
    if (this.is('(') && type) {
      // record pattern
      this.next();
      const nested = [];
      if (!this.is(')')) {
        do { nested.push(this.pattern()); } while (this.accept(','));
      }
      this.expect(')');
      return node('RecordPattern', pos, { deconstructor: type, nested });
    }
    const vpos = this.pos();
    const name = this.ident();
    return node('BindingPattern', pos, { var: node('VarDecl', vpos, { mods, name, vartype: type, init: null, isLocal: true, declaredVar: type === null }) });
  }

  // ---- expressions --------------------------------------------------------
  expression() {
    // lambda check at expression start
    const lam = this.tryLambda();
    if (lam) return lam;
    const pos = this.pos();
    const lhs = this.ternary();
    const t = this.tok;
    if (t.kind === 'op' && ASSIGN_OPS.has(t.text)) {
      this.next();
      const rhs = this.expression();
      if (t.text === '=') return node('Assign', pos, { lhs, rhs });
      return node('AssignOp', pos, { op: t.text.slice(0, -1), lhs, rhs });
    }
    return lhs;
  }

  tryLambda() {
    const t = this.tok;
    // x -> ...
    if (t.kind === 'ident' && this.peekTok(1).kind === 'op' && this.peekTok(1).text === '->' && !this.split) {
      const pos = t.pos;
      const name = this.ident();
      this.next(); // ->
      return this.lambdaBody(pos, [node('VarDecl', pos, { mods: { tag: 'Modifiers', pos, flags: F.LAMBDA_PARAM, annotations: [] }, name, vartype: null, init: null, isLocal: true, implicitLambdaParam: true })], 'implicit');
    }
    if (t.kind === 'op' && t.text === '(' && !this.split) {
      // find matching paren and check for '->'
      let depth = 0;
      let k = 0;
      while (true) {
        const tk = this.peekTok(k);
        if (tk.kind === 'eof') return null;
        if (tk.kind === 'op') {
          if (tk.text === '(') depth++;
          else if (tk.text === ')') { depth--; if (depth === 0) break; }
        }
        k++;
      }
      const after = this.peekTok(k + 1);
      if (!(after.kind === 'op' && after.text === '->')) return null;
      const pos = t.pos;
      this.next();
      const params = [];
      let kind = 'explicit';
      if (!this.is(')')) {
        // implicit: identifiers only
        const implicit = this.speculate(() => {
          const names = [];
          do {
            const ppos = this.pos();
            names.push(node('VarDecl', ppos, { mods: { tag: 'Modifiers', pos: ppos, flags: F.LAMBDA_PARAM, annotations: [] }, name: this.ident(), vartype: null, init: null, isLocal: true, implicitLambdaParam: true }));
          } while (this.accept(','));
          if (!this.is(')')) throw new ParseError('x', '', 0, 0);
          return names;
        });
        if (implicit) {
          kind = 'implicit';
          params.push(...implicit);
        } else {
          do {
            const mods = this.modifiersOpt();
            const ppos = this.pos();
            let type;
            let declaredVar = false;
            if (this.isIdent('var') && this.peekTok(1).kind === 'ident') { this.next(); type = null; declaredVar = true; }
            else type = this.parseType();
            let varargs = false;
            if (this.accept('...')) { varargs = true; type = node('ArrayType', type.pos, { elemtype: type }); }
            const name = this.ident();
            while (this.is('[')) { this.next(); this.expect(']'); type = node('ArrayType', type.pos, { elemtype: type }); }
            params.push(node('VarDecl', ppos, { mods: { ...mods, flags: mods.flags | F.LAMBDA_PARAM }, name, vartype: type, init: null, isLocal: true, varargs, declaredVar, implicitLambdaParam: declaredVar }));
          } while (this.accept(','));
          if (params.every((p) => p.declaredVar)) kind = 'implicit';
        }
      }
      this.expect(')');
      this.expect('->');
      return this.lambdaBody(pos, params, kind);
    }
    return null;
  }

  lambdaBody(pos, params, paramKind) {
    let body;
    if (this.is('{')) body = this.block();
    else body = this.expression();
    return node('Lambda', pos, { params, body, paramKind });
  }

  ternary() {
    const pos = this.pos();
    const cond = this.binary(1);
    if (this.is('?')) {
      this.next();
      const truepart = this.is('(') || this.tok.kind === 'ident' ? (this.tryLambda() || this.ternaryOrAssignInCond()) : this.ternaryOrAssignInCond();
      this.expect(':');
      const falsepart = this.tryLambda() || this.ternary();
      return node('Conditional', pos, { cond, truepart, falsepart });
    }
    return cond;
  }

  ternaryOrAssignInCond() {
    // JLS: true part is an Expression
    return this.expression();
  }

  binary(minPrec) {
    const pos = this.pos();
    let left = this.unary();
    while (true) {
      const t = this.tok;
      let op = null;
      if (t.kind === 'op' && BINARY_PREC[t.text] !== undefined) op = t.text;
      else if (t.kind === 'keyword' && t.text === 'instanceof') op = 'instanceof';
      if (!op) break;
      const prec = BINARY_PREC[op];
      if (prec < minPrec) break;
      this.next();
      if (op === 'instanceof') {
        const ipos = this.pos();
        // pattern or type
        const m = this.mark();
        const isFinal = this.is('final') || this.is('@');
        let pattern = null;
        let type = null;
        if (isFinal) {
          pattern = this.pattern();
        } else {
          type = this.parseType();
          if (this.is('(')) {
            this.reset(m);
            pattern = this.pattern();
            type = null;
          } else if (this.tok.kind === 'ident' && !(this.tok.text === 'when' && false)) {
            // binding pattern
            const vpos = this.pos();
            const name = this.ident();
            pattern = node('BindingPattern', ipos, { var: node('VarDecl', vpos, { mods: { tag: 'Modifiers', pos: vpos, flags: 0, annotations: [] }, name, vartype: type, init: null, isLocal: true }) });
            type = null;
          }
        }
        left = node('InstanceOf', pos, { expr: left, clazz: type, pattern });
        continue;
      }
      const right = this.binary(prec + 1);
      left = node('Binary', pos, { op, lhs: left, rhs: right });
    }
    return left;
  }

  unary() {
    const t = this.tok;
    const pos = t.pos;
    if (t.kind === 'op') {
      switch (t.text) {
        case '++': case '--': {
          this.next();
          return node('Unary', pos, { op: t.text === '++' ? 'preinc' : 'predec', arg: this.unary() });
        }
        case '+': case '-': {
          this.next();
          // fold negative literals at parse time so that -2147483648 is legal
          const nt = this.tok;
          if (t.text === '-' && (nt.kind === 'int' || nt.kind === 'long') && !this.split) {
            const after = this.peekTok(1);
            const postfixy = after.kind === 'op' && (after.text === '.' || after.text === '[' || after.text === '++' || after.text === '--');
            if (!postfixy) {
              this.next();
              return node('Literal', pos, { typetag: nt.kind, value: this.normalizeInt(nt.value, nt.kind, pos, true, nt.text), text: '-' + nt.text });
            }
          }
          return node('Unary', pos, { op: t.text === '+' ? 'pos' : 'neg', arg: this.unary() });
        }
        case '!': this.next(); return node('Unary', pos, { op: 'not', arg: this.unary() });
        case '~': this.next(); return node('Unary', pos, { op: 'compl', arg: this.unary() });
        case '(': {
          const cast = this.tryCast();
          if (cast) return cast;
          break;
        }
        default: break;
      }
    }
    return this.postfix(this.primary());
  }

  // Literal magnitudes come from the lexer as BigInt. Only decimal literals
  // are range checked here (2^31 and 2^63 are legal only after unary minus);
  // hex, octal and binary literals denote two's complement bit patterns.
  normalizeInt(big, kind, pos, negated, text) {
    const decimal = !/^0[0-9xXbB_]/.test(text || '');
    if (kind === 'int') {
      if (decimal && !negated && big === 2147483648n) this.fail('integer number too large', pos);
      return Number(BigInt.asIntN(32, negated ? -big : big));
    }
    if (decimal && !negated && big === 9223372036854775808n) this.fail('long number too large', pos);
    return BigInt.asIntN(64, negated ? -big : big);
  }

  // '(' Type ')' UnaryNotPlusMinus  |  '(' PrimitiveType ')' Unary  |  intersection casts
  tryCast() {
    const m = this.mark();
    const pos = this.pos();
    this.next(); // (
    try {
      const t = this.tok;
      if (t.kind === 'keyword' && PRIMITIVES.has(t.text)) {
        const type = this.parseType();
        if (!this.is(')')) { this.reset(m); return null; }
        this.next();
        if (type.tag === 'PrimitiveType') {
          return node('TypeCast', pos, { clazz: type, expr: this.unary() });
        }
        // primitive array cast: (int[]) x
        if (!this.castFollows()) { this.reset(m); return null; }
        return node('TypeCast', pos, { clazz: type, expr: this.unary() });
      }
      if (t.kind !== 'ident' && !(t.kind === 'op' && t.text === '@')) { this.reset(m); return null; }
      let type = this.parseType();
      if (this.is('&')) {
        const bounds = [type];
        while (this.accept('&')) bounds.push(this.parseType());
        type = node('TypeIntersection', type.pos, { bounds });
      }
      if (!this.is(')')) { this.reset(m); return null; }
      this.next();
      if (!this.castFollows()) { this.reset(m); return null; }
      // a cast to a reference type may be followed by a lambda
      const lam = this.tryLambda();
      if (lam) return node('TypeCast', pos, { clazz: type, expr: lam });
      return node('TypeCast', pos, { clazz: type, expr: this.unary() });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.reset(m);
      return null;
    }
  }

  // After '(' Type ')' — does what follows start a UnaryNotPlusMinus?
  castFollows() {
    const t = this.tok;
    if (t.kind === 'ident' || t.kind === 'int' || t.kind === 'long' || t.kind === 'float' || t.kind === 'double' || t.kind === 'char' || t.kind === 'string') return true;
    if (t.kind === 'keyword') {
      return ['this', 'super', 'new', 'true', 'false', 'null', 'switch'].includes(t.text) || PRIMITIVES.has(t.text) || t.text === 'void';
    }
    if (t.kind === 'op') return t.text === '(' || t.text === '!' || t.text === '~' || t.text === '@';
    return false;
  }

  arguments() {
    this.expect('(');
    const args = [];
    if (!this.is(')')) {
      do { args.push(this.expression()); } while (this.accept(','));
    }
    this.expect(')');
    return args;
  }

  literal() {
    const t = this.next();
    const pos = t.pos;
    switch (t.kind) {
      case 'int': return node('Literal', pos, { typetag: 'int', value: this.normalizeInt(t.value, 'int', pos, false, t.text), text: t.text });
      case 'long': return node('Literal', pos, { typetag: 'long', value: this.normalizeInt(t.value, 'long', pos, false, t.text), text: t.text });
      case 'float': return node('Literal', pos, { typetag: 'float', value: t.value, text: t.text });
      case 'double': return node('Literal', pos, { typetag: 'double', value: t.value, text: t.text });
      case 'char': return node('Literal', pos, { typetag: 'char', value: t.value, text: t.text });
      case 'string': return node('Literal', pos, { typetag: 'String', value: t.value, text: t.text });
      default: break;
    }
    if (t.text === 'true' || t.text === 'false') return node('Literal', pos, { typetag: 'boolean', value: t.text === 'true' });
    if (t.text === 'null') return node('Literal', pos, { typetag: 'null', value: null });
    this.fail('literal expected', pos);
  }

  primary() {
    const t = this.tok;
    const pos = t.pos;
    switch (t.kind) {
      case 'int': case 'long': case 'float': case 'double': case 'char': case 'string':
        return this.literal();
      case 'keyword':
        switch (t.text) {
          case 'true': case 'false': case 'null': return this.literal();
          case 'this': {
            this.next();
            const id = node('Ident', pos, { name: 'this' });
            if (this.is('(')) return node('Apply', pos, { meth: id, typeargs: [], args: this.arguments() });
            return id;
          }
          case 'super': {
            this.next();
            const id = node('Ident', pos, { name: 'super' });
            if (this.is('(')) return node('Apply', pos, { meth: id, typeargs: [], args: this.arguments() });
            if (this.is('::')) return this.memberReferenceSuffix(id);
            this.expect('.');
            const typeargs = this.is('<') ? this.typeArguments(false) : [];
            const spos = this.pos();
            const name = this.ident();
            const sel = node('Select', spos, { selected: id, name });
            if (this.is('(')) return node('Apply', pos, { meth: sel, typeargs, args: this.arguments() });
            return sel;
          }
          case 'new': return this.creator(null);
          case 'switch': return this.switchConstruct(true);
          case 'void': {
            this.next();
            this.expect('.');
            this.expect('class');
            return node('Select', pos, { selected: node('PrimitiveType', pos, { typetag: 'void' }), name: 'class' });
          }
          default:
            if (PRIMITIVES.has(t.text)) {
              // int.class, int[].class, int[]::new
              let type = node('PrimitiveType', pos, { typetag: this.next().text });
              type = this.bracketsOpt(type);
              if (this.is('::')) return this.memberReferenceSuffix(type);
              this.expect('.');
              this.expect('class');
              return node('Select', pos, { selected: type, name: 'class' });
            }
        }
        break;
      case 'op':
        if (t.text === '(') {
          this.next();
          const e = this.expression();
          this.expect(')');
          return node('Parens', pos, { expr: e });
        }
        if (t.text === '<') {
          // generic method call on implicit this: <T>foo()  (rare; only with explicit receiver in practice)
          const typeargs = this.typeArguments(false);
          if (this.is('this')) { this.next(); return node('Apply', pos, { meth: node('Ident', pos, { name: 'this' }), typeargs, args: this.arguments() }); }
          if (this.is('super')) { this.next(); return node('Apply', pos, { meth: node('Ident', pos, { name: 'super' }), typeargs, args: this.arguments() }); }
          const name = this.ident();
          return node('Apply', pos, { meth: node('Ident', pos, { name }), typeargs, args: this.arguments() });
        }
        if (t.text === '@') {
          // annotated type in expression context, e.g. method reference on an annotated type
          const type = this.parseType();
          if (this.is('::')) return this.memberReferenceSuffix(type);
          this.fail('illegal start of expression');
        }
        break;
      case 'ident': {
        // generic type in expression context before '::', e.g. List<String>::size
        // or Map.Entry<K, V>::getKey
        if (this.qualifiedNameThenLT()) {
          const ref = this.speculate(() => {
            const type = this.parseType();
            if (!this.is('::')) throw new ParseError('x', '', 0, 0);
            return this.memberReferenceSuffix(type);
          });
          if (ref) return ref;
          // Generic type followed by `.Inner::new` etc are handled in speculation above when
          // parseType covers the whole qualified name.
        }
        this.next();
        let e = node('Ident', pos, { name: t.text });
        if (this.is('(')) return node('Apply', pos, { meth: e, typeargs: [], args: this.arguments() });
        return e;
      }
      default: break;
    }
    this.fail(`illegal start of expression: '${t.text}'`);
  }

  // ident ( '.' ident )* '<'
  qualifiedNameThenLT() {
    let k = 1;
    while (this.peekTok(k).kind === 'op' && this.peekTok(k).text === '.' && this.peekTok(k + 1).kind === 'ident') k += 2;
    const t = this.peekTok(k);
    return t.kind === 'op' && t.text === '<';
  }

  // postfix: selectors, array access, calls, ++/--, method refs
  postfix(e) {
    while (true) {
      const t = this.tok;
      if (t.kind !== 'op') break;
      if (t.text === '.') {
        this.next();
        const pos = this.pos();
        if (this.is('new')) {
          e = this.creator(e);
          continue;
        }
        if (this.is('this')) {
          this.next();
          e = node('Select', pos, { selected: e, name: 'this' });
          continue;
        }
        if (this.is('super')) {
          this.next();
          const sup = node('Select', pos, { selected: e, name: 'super' });
          if (this.is('::')) { e = this.memberReferenceSuffix(sup); continue; }
          if (this.is('(')) { e = node('Apply', pos, { meth: sup, typeargs: [], args: this.arguments() }); continue; }
          e = sup;
          continue;
        }
        if (this.is('class')) {
          this.next();
          e = node('Select', pos, { selected: e, name: 'class' });
          continue;
        }
        let typeargs = [];
        if (this.is('<')) typeargs = this.typeArguments(false);
        const npos = this.pos();
        const name = this.ident();
        const sel = node('Select', npos, { selected: e, name });
        if (this.is('(')) {
          e = node('Apply', npos, { meth: sel, typeargs, args: this.arguments() });
        } else {
          e = sel;
        }
        continue;
      }
      if (t.text === '[') {
        // array type for class literal / method ref: Foo[].class, Foo[]::new
        if (this.peekTok(1).kind === 'op' && this.peekTok(1).text === ']' && !this.split) {
          let type = e;
          while (this.is('[') && this.peekTok(1).text === ']') {
            this.next(); this.next();
            type = node('ArrayType', type.pos, { elemtype: type });
          }
          if (this.is('::')) return this.memberReferenceSuffix(type);
          this.expect('.');
          const cpos = this.pos();
          this.expect('class');
          e = node('Select', cpos, { selected: type, name: 'class' });
          continue;
        }
        this.next();
        const index = this.expression();
        this.expect(']');
        e = node('Indexed', e.pos, { indexed: e, index });
        continue;
      }
      if (t.text === '++' || t.text === '--') {
        this.next();
        e = node('Unary', e.pos, { op: t.text === '++' ? 'postinc' : 'postdec', arg: e });
        continue;
      }
      if (t.text === '::') {
        e = this.memberReferenceSuffix(e);
        continue;
      }
      break;
    }
    return e;
  }

  memberReferenceSuffix(expr) {
    const pos = this.pos();
    this.expect('::');
    let typeargs = [];
    if (this.is('<')) typeargs = this.typeArguments(false);
    if (this.accept('new')) {
      return node('Reference', pos, { expr, mode: 'new', name: '<init>', typeargs });
    }
    const name = this.ident();
    return node('Reference', pos, { expr, mode: 'invoke', name, typeargs });
  }

  // new ...   (outer is the enclosing instance expression for qualified creation)
  creator(outer) {
    const pos = this.pos();
    this.expect('new');
    let typeargs = [];
    if (this.is('<')) typeargs = this.typeArguments(false);
    const annotations = this.typeAnnotationsOpt();
    const t = this.tok;
    if (t.kind === 'keyword' && PRIMITIVES.has(t.text)) {
      const elem = node('PrimitiveType', t.pos, { typetag: this.next().text });
      return this.arrayCreatorRest(pos, annotations.length ? node('AnnotatedType', t.pos, { annotations, underlying: elem }) : elem);
    }
    // class type, possibly with diamond
    let clazz = node('Ident', this.pos(), { name: this.ident() });
    if (this.is('<')) {
      const apos = this.pos();
      clazz = node('TypeApply', apos, { clazz, args: this.typeArguments(true) });
    }
    while (this.is('.')) {
      this.next();
      const anns = this.typeAnnotationsOpt();
      const spos = this.pos();
      clazz = node('Select', spos, { selected: clazz, name: this.ident() });
      if (anns.length) clazz = node('AnnotatedType', spos, { annotations: anns, underlying: clazz });
      if (this.is('<')) {
        const apos = this.pos();
        clazz = node('TypeApply', apos, { clazz, args: this.typeArguments(true) });
      }
    }
    if (annotations.length) clazz = node('AnnotatedType', pos, { annotations, underlying: clazz });
    if (this.is('[') || this.is('@')) return this.arrayCreatorRest(pos, clazz);
    const args = this.arguments();
    let body = null;
    if (this.is('{')) {
      const bpos = this.pos();
      const defs = this.classBody(null, 'class');
      body = node('ClassDecl', bpos, { kind: 'class', mods: { tag: 'Modifiers', pos: bpos, flags: 0, annotations: [] }, name: '', typarams: [], extending: null, implementing: [], permitting: [], defs, anonymous: true });
    }
    return node('NewClass', pos, { encl: outer, typeargs, clazz, args, body });
  }

  arrayCreatorRest(pos, elemtype) {
    // new T[]{...} or new T[e][e][]...
    const dims = [];
    const anns0 = this.typeAnnotationsOpt();
    this.expect('[');
    if (this.is(']')) {
      this.next();
      let type = elemtype;
      let extra = 1;
      while (this.is('[') || this.is('@')) {
        this.typeAnnotationsOpt();
        this.expect('[');
        this.expect(']');
        extra++;
      }
      for (let k = 1; k < extra; k++) type = node('ArrayType', type.pos, { elemtype: type });
      const init = this.arrayInitializer(type);
      return node('NewArray', pos, { elemtype: type, dims: [], elems: init.elems });
    }
    dims.push(this.expression());
    this.expect(']');
    let extraDims = 0;
    while (true) {
      const m = this.mark();
      this.typeAnnotationsOpt();
      if (!this.is('[')) { this.reset(m); break; }
      this.next();
      if (this.is(']')) {
        this.next();
        extraDims++;
        continue;
      }
      if (extraDims > 0) this.fail("']' expected");
      dims.push(this.expression());
      this.expect(']');
    }
    let type = elemtype;
    for (let k = 0; k < extraDims; k++) type = node('ArrayType', type.pos, { elemtype: type });
    return node('NewArray', pos, { elemtype: type, dims, elems: null });
  }
}

function parse(source, file) {
  const p = new Parser(source, file);
  const cu = p.parseCompilationUnit();
  cu.lineCol = p.lineCol;
  return cu;
}

module.exports = { parse, Parser, ParseError };
