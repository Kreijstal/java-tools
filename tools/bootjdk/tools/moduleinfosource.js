'use strict';
// Port of make/jdk/src/classes/build/tools/module/GenModuleInfoSource.java:
// merges module-info.java.extra files into a module's module-info.java.
//
// usage: GenModuleInfoSource [-d] [-v] -o <output file> --source-file <module-info.java>
//            --modules <module-name>[,<module-name>...] <module-info.java.extra> ...
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { LNSEP, javaTrim } = require('./util');
const { compareStrings } = require('./misc-java');

const USAGE = 'Usage: GenModuleInfoSource \n'
  + ' [-d]\n'
  + ' -o <output file>\n'
  + '  --source-file <module-info-java>\n'
  + '  --modules <module-name>[,<module-name>...]\n'
  + '  <module-info.java.extra> ...\n';

// Files.readAllLines
function readLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

class Statement {
  constructor(directive, qualifier, name, ordered = false) {
    this.directive = directive;
    this.qualifier = qualifier;
    this.name = name;
    this.targets = new Set();
    this.ordered = ordered;
  }
  addTarget(mn) {
    if (mn === '') throw new Error('empty module name');
    this.targets.add(mn);
    return this;
  }
  isQualified() { return this.targets.size > 0; }
  isUnqualified() { return this.targets.size === 0; }
  // unqualified, or at least one target in names
  filter(names) {
    return this.isUnqualified() || [...this.targets].some(mn => names.has(mn));
  }
  orderedTargets() {
    return this.ordered ? [...this.targets] : [...this.targets].sort(compareStrings);
  }
  toString() {
    let sb = '    ' + this.directive + ' ' + this.name;
    if (this.targets.size === 0) sb += ';';
    else if (this.targets.size === 1) sb += ' ' + this.qualifier + ' ' + this.orderedTargets().join(',') + ';';
    else sb += ' ' + this.qualifier + '\n' + this.orderedTargets().map(t => '        ' + t).join(',\n') + ';';
    return sb;
  }
}

class Parser {
  constructor(file) {
    this.sourceFile = file;
    this.inCommentBlock = false;
    this.tokens = [];
    this.lineNumber = 1;
    this.index = 0;
  }
  run() {
    for (const l of readLines(this.sourceFile)) this.tokenize(javaTrim(l));
  }
  // tokenize one line, skipping comments
  tokenize(l) {
    while (l !== '') {
      if (this.inCommentBlock) {
        const comment = l.indexOf('*/');
        if (comment === -1) return this.emptyTokens();
        this.inCommentBlock = false;
        if (comment + 2 >= l.length) return this.emptyTokens();
        l = javaTrim(l.substring(comment + 2));
      }
      const comment = l.indexOf('//');
      if (comment >= 0) {
        l = javaTrim(l.substring(0, comment));
        if (l === '') return this.emptyTokens();
      }
      if (l === '') return this.emptyTokens();
      const beginComment = l.indexOf('/*');
      const endComment = l.indexOf('*/');
      if (beginComment === -1) return this.lineTokens(l);
      const s1 = javaTrim(l.substring(0, beginComment));
      if (endComment > 0) {
        const s2 = javaTrim(l.substring(endComment + 2));
        l = s1 === '' ? s2 : s2 === '' ? s1 : s1 + ' ' + s2;
      } else {
        this.inCommentBlock = true;
        return this.lineTokens(s1);
      }
    }
    return this.lineTokens(l);
  }
  emptyTokens() { this.tokens.push([]); return []; }
  lineTokens(l) {
    const tokens = [];
    for (let s of l.split(/[ \t\n\x0B\f\r]+/)) {
      let pos = 0;
      s = javaTrim(s);
      if (s === '') continue;
      let i = s.indexOf(',', pos);
      let j = s.indexOf(';', pos);
      while (i >= 0 || j >= 0) {
        if (j === -1 || (i >= 0 && i < j)) {
          const n = javaTrim(s.substring(pos, i));
          if (n !== '') tokens.push(n);
          tokens.push(',');
          pos = i + 1;
          i = s.indexOf(',', pos);
        } else {
          const n = javaTrim(s.substring(pos, j));
          if (n !== '') tokens.push(n);
          tokens.push(';');
          pos = j + 1;
          j = s.indexOf(';', pos);
        }
      }
      const n = javaTrim(s.substring(pos));
      if (n !== '') tokens.push(n);
    }
    this.tokens.push(tokens);
    return tokens;
  }
  nextToken() {
    while (this.lineNumber <= this.tokens.length) {
      const l = this.tokens[this.lineNumber - 1];
      if (this.index < l.length) return l[this.index++];
      this.lineNumber++;
      this.index = 0;
    }
    return null;
  }
  peekToken() {
    let ln = this.lineNumber, i = this.index;
    while (ln <= this.tokens.length) {
      const l = this.tokens[ln - 1];
      if (i < l.length) return l[i];
      ln++;
      i = 0;
    }
    return null;
  }
  newError(msg) {
    if (this.lineNumber <= this.tokens.length) {
      return new Error(this.sourceFile + ', line ' + this.lineNumber + ', ' + msg
        + ' "' + this.tokens[this.lineNumber - 1].join(' ') + '"');
    }
    return new Error(this.sourceFile + ', line ' + this.lineNumber + ', ' + msg);
  }
}

const NOT_IDENTIFIER = new Set(['module', 'requires', 'exports', 'opens', 'provides', 'uses',
  'to', 'with', ',', ';', '{', '}']);

function nextIdentifier(parser) {
  const lookAhead = parser.peekToken();
  if (lookAhead === null || NOT_IDENTIFIER.has(lookAhead)) throw parser.newError('<identifier> missing');
  return parser.nextToken();
}
function lookAheadOrThrow(parser) {
  const t = parser.peekToken();
  if (t === null) throw parser.newError('reach end of file');
  return t;
}
function skipTokenOrThrow(parser, token, msg) {
  if (parser.peekToken() !== token) throw parser.newError(msg);
  return parser.nextToken();
}

class ModuleInfo {
  constructor(gen) {
    this.gen = gen;
    this.exports = new Map();
    this.opens = new Map();
    this.uses = new Map();
    this.provides = new Map();
  }
  getStatement(directive, name) {
    const main = this.gen.moduleInfo;
    const already = () => new Error(this.gen.sourceFile + ' already has ' + directive + ' ' + name);
    const computeIfAbsent = (m, mk) => {
      if (!m.has(name)) m.set(name, mk());
      return m.get(name);
    };
    switch (directive) {
      case 'exports':
        if (main.exports.has(name) && main.exports.get(name).isUnqualified()) throw already();
        return computeIfAbsent(this.exports, () => new Statement('exports', 'to', name));
      case 'opens':
        if (main.opens.has(name)) throw already();
        return computeIfAbsent(this.opens, () => new Statement('opens', 'to', name));
      case 'uses':
        return computeIfAbsent(this.uses, () => new Statement('uses', '', name));
      case 'provides':
        return computeIfAbsent(this.provides, () => new Statement('provides', 'with', name, true));
      default:
        throw new Error(directive);
    }
  }
  augmentModuleInfo(extra, modules) {
    for (const [k, v] of extra.exports) {
      if (this.exports.has(k) && v.filter(modules)) this.mergeExportsOrOpens(this.exports.get(k), v, modules);
    }
    for (const [k, v] of extra.exports) {
      if (!this.exports.has(k) && v.filter(modules)) this.addTargets(this.getStatement('exports', k), v, modules);
    }
    for (const [k, v] of extra.opens) {
      if (this.opens.has(k) && v.filter(modules)) this.mergeExportsOrOpens(this.opens.get(k), v, modules);
    }
    for (const [k, v] of extra.opens) {
      if (!this.opens.has(k) && v.filter(modules)) this.addTargets(this.getStatement('opens', k), v, modules);
    }
    for (const [service, v] of extra.provides) {
      if (this.provides.has(service)) this.mergeProvides(service, v);
    }
    for (const [service, v] of extra.provides) {
      if (!this.provides.has(service)) this.provides.set(service, v);
    }
    for (const [service, v] of extra.uses) {
      if (!this.uses.has(service)) this.uses.set(service, v);
    }
  }
  addTargets(statement, extra, modules) {
    for (const mn of extra.targets) if (modules.has(mn)) statement.addTarget(mn);
  }
  mergeExportsOrOpens(statement, extra, modules) {
    const pn = statement.name;
    if (statement.isUnqualified() && extra.isQualified()) {
      throw new Error("can't add qualified exports to unqualified exports " + pn);
    }
    const mods = [...extra.targets].filter(mn => statement.targets.has(mn));
    if (mods.length > 0) {
      throw new Error('qualified exports ' + pn + ' to [' + mods.join(', ') + '] already declared in '
        + this.gen.sourceFile);
    }
    this.addTargets(statement, extra, modules);
  }
  mergeProvides(service, extra) {
    const statement = this.provides.get(service);
    const mods = [...extra.targets].filter(mn => statement.targets.has(mn));
    if (mods.length > 0) {
      throw new Error('qualified exports ' + service + ' to [' + mods.join(', ') + '] already declared in '
        + this.gen.sourceFile);
    }
    for (const mn of extra.targets) statement.addTarget(mn);
  }
  print(println) {
    const sorted = m => [...m.entries()].sort((a, b) => compareStrings(a[0], b[0])).map(e => e[1]);
    for (const m of [this.exports, this.opens]) {
      for (const s of sorted(m)) if (s.isUnqualified()) println(s.toString());
      for (const s of sorted(m)) if (s.isQualified()) println(s.toString());
    }
    println('');
    for (const s of sorted(this.uses)) println(s.toString());
    for (const s of sorted(this.provides)) println(s.toString());
  }
  parse(file, extraFile) {
    const parser = new Parser(file);
    parser.run();
    if (this.gen.verbose) {
      parser.tokens.forEach((t, i) => process.stdout.write((i + 1) + ': ' + t.join(' ') + LNSEP));
    }
    this.process(parser, extraFile);
  }
  process(parser, extraFile) {
    // no duplicate statement local in each file
    const local = { exports: new Set(), opens: new Set(), uses: new Set(), provides: new Set() };
    let token;
    let hasCurlyBracket = false;
    while ((token = parser.nextToken()) !== null) {
      if (token === 'module') {
        nextIdentifier(parser);
        if (extraFile) throw parser.newError('cannot declare module in ' + parser.sourceFile);
        skipTokenOrThrow(parser, '{', 'missing {');
        hasCurlyBracket = true;
      } else if (token === 'requires') {
        token = nextIdentifier(parser);
        if (token === 'transitive') token = nextIdentifier(parser);
        if (extraFile) throw parser.newError('cannot declare requires in ' + parser.sourceFile);
        skipTokenOrThrow(parser, ';', 'missing semicolon');
      } else if (token in local) {
        const keyword = token;
        let name = nextIdentifier(parser);
        const statement = this.getStatement(keyword, name);
        if (local[keyword].has(name)) throw parser.newError('multiple ' + keyword + ' ' + name);
        local[keyword].add(name);
        let lookAhead = lookAheadOrThrow(parser);
        if (lookAhead === statement.qualifier) {
          parser.nextToken(); // skip qualifier
          while ((lookAhead = parser.peekToken()) !== null) {
            name = nextIdentifier(parser);
            statement.addTarget(name);
            lookAhead = lookAheadOrThrow(parser);
            if (lookAhead === ',' || lookAhead === ';') parser.nextToken();
            else throw parser.newError('missing semicolon');
            if (lookAhead === ';') break;
          }
        } else {
          skipTokenOrThrow(parser, ';', 'missing semicolon');
        }
      } else if (token === ';') {
        continue;
      } else if (hasCurlyBracket && token === '}') {
        hasCurlyBracket = false;
        if (parser.peekToken() !== null) throw parser.newError('is malformed');
      } else if (token === 'import') {
        nextIdentifier(parser);
        skipTokenOrThrow(parser, ';', 'missing semicolon');
      } else if (token.startsWith('@')) {
        continue;
      } else {
        throw parser.newError('missing keyword');
      }
    }
  }
}

function main(args) {
  let outfile = null, moduleInfoJava = null;
  let modules = new Set();
  const extras = [];
  const gen = { debug: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const arg = i + 1 < args.length ? args[i + 1] : null;
    switch (option) {
      case '-d': gen.debug = true; break;
      case '-o': outfile = arg; i++; break;
      case '--source-file':
        moduleInfoJava = arg;
        if (!fs.existsSync(arg)) throw new Error(arg + ' not exist');
        i++;
        break;
      case '--modules': {
        const parts = arg.split(',');
        while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
        modules = new Set(parts);
        i++;
        break;
      }
      case '-v': gen.verbose = true; break;
      default:
        if (!fs.existsSync(option)) throw new Error(option + ' not exist');
        extras.push(option);
    }
  }
  if (moduleInfoJava === null || outfile === null || modules.size === 0 || extras.length === 0) {
    process.stderr.write(USAGE + LNSEP);
    return 255;
  }

  gen.sourceFile = moduleInfoJava;
  gen.moduleInfo = new ModuleInfo(gen);
  gen.moduleInfo.parse(moduleInfoJava, false);
  const extra = new ModuleInfo(gen);
  for (const f of extras) extra.parse(f, true);
  gen.moduleInfo.augmentModuleInfo(extra, modules);

  const lines = readLines(moduleInfoJava);
  let out = '';
  const println = s => { out += s + LNSEP; };
  for (const l of lines) {
    println(l);
    if (javaTrim(l).startsWith('module ')) {
      if (gen.debug) {
        println('    // source file: ' + pathToFileURL(path.resolve(moduleInfoJava)).href);
        for (const f of extras) println('    //              ' + pathToFileURL(path.resolve(f)).href);
      }
      break;
    }
  }
  for (const l of lines) if (javaTrim(l).startsWith('requires')) println(l);
  gen.moduleInfo.print(println);
  println('}');
  fs.writeFileSync(outfile, out);
  return 0;
}

module.exports = { main };
