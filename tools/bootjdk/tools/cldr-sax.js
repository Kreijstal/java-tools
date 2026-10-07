'use strict';
// A SAX-style XML parser with the DTD support the CLDR converter depends on
// when run through the JDK's validating SAX parser: the external DTD named by
// the DOCTYPE is read for attribute defaults, attribute-value normalization of
// non-CDATA attributes, and element-only content models (whitespace there is
// ignorable and never reaches characters()). Handler methods:
// startElement(qName, attrs) with attrs.getValue(name), endElement(qName),
// characters(text), endDocument().

const fs = require('fs');
const path = require('path');

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const dtdCache = new Map();

function parseDtd(file) {
  if (dtdCache.has(file)) return dtdCache.get(file);
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const elements = new Map(); // name -> 'children' | 'mixed' | 'empty' | 'any'
  const attlists = new Map(); // name -> Map(attr -> {type, def})
  for (const m of text.matchAll(/<!ELEMENT\s+(\S+)\s+([\s\S]*?)>/g)) {
    const model = m[2].trim();
    elements.set(m[1], model === 'EMPTY' ? 'empty' : model === 'ANY' ? 'any'
      : model.includes('#PCDATA') ? 'mixed' : 'children');
  }
  for (const m of text.matchAll(/<!ATTLIST\s+(\S+)\s+((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    let defs = attlists.get(m[1]);
    if (!defs) attlists.set(m[1], defs = new Map());
    const re = /\s*(\S+)\s+(\([^)]*\)|NOTATION\s*\([^)]*\)|\S+)\s+(#REQUIRED|#IMPLIED|(?:#FIXED\s+)?(?:"[^"]*"|'[^']*'))/gy;
    let a;
    const body = m[2];
    while ((a = re.exec(body)) !== null) {
      if (defs.has(a[1])) continue; // first declaration wins
      let def = null;
      const d = a[3];
      if (d !== '#REQUIRED' && d !== '#IMPLIED') {
        const q = d.replace(/^#FIXED\s+/, '');
        def = decode(q.slice(1, -1));
      }
      defs.set(a[1], { type: a[2].startsWith('(') ? 'ENUM' : a[2], def });
    }
  }
  const dtd = { elements, attlists };
  dtdCache.set(file, dtd);
  return dtd;
}

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new Error(`undefined entity &${e};`);
    return ENTITIES[e];
  });
}

class Attributes {
  constructor(map) { this.map = map; }
  getValue(name) { return this.map.has(name) ? this.map.get(name) : null; }
}

function parseFile(file, handler) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  let dtd = { elements: new Map(), attlists: new Map() };
  let i = 0;
  const fail = (msg) => {
    throw new Error(`${file}:${text.slice(0, i).split('\n').length}: ${msg}`);
  };
  const skipTo = (s) => {
    const e = text.indexOf(s, i);
    if (e < 0) fail(`expected ${s}`);
    i = e + s.length;
  };
  const stack = [];
  const flushText = (s) => {
    if (!stack.length) return;
    const top = stack[stack.length - 1];
    const kind = dtd.elements.get(top);
    // split the way the JDK's Xerces reports text: around references, and
    // after each supplementary character (the scanner stops at a surrogate
    // pair, appends it and ends the characters() event there)
    for (const m of s.matchAll(/&[^;]*;|[^&\ud800-\udbff]*[\ud800-\udbff][\udc00-\udfff]|[^&\ud800-\udbff]+/g)) {
      const chunk = m[0][0] === '&' ? decode(m[0]) : m[0];
      if ((kind === 'children' || kind === 'empty') && /^[ \t\n]*$/.test(chunk)) continue;
      handler.characters(chunk);
    }
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) flushText(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) { skipTo('-->'); continue; }
    if (text.startsWith('<?', i)) { skipTo('?>'); continue; }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i);
      if (stack.length) handler.characters(text.slice(i + 9, e));
      i = e + 3;
      continue;
    }
    if (text.startsWith('<!DOCTYPE', i)) {
      const m = /^<!DOCTYPE\s+(\S+)\s+SYSTEM\s+("([^"]*)"|'([^']*)')\s*>/.exec(text.slice(i, i + 1024));
      if (!m) fail('unsupported DOCTYPE');
      const sysId = m[3] !== undefined ? m[3] : m[4];
      let dtdFile = null;
      if (handler.resolveEntity) dtdFile = handler.resolveEntity(null, sysId);
      dtd = parseDtd(dtdFile || path.resolve(path.dirname(file), sysId));
      i += m[0].length;
      continue;
    }
    if (text[i + 1] === '/') {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i, i + 256));
      if (!m) fail('malformed end tag');
      if (stack.pop() !== m[1]) fail(`mismatched </${m[1]}>`);
      handler.endElement(m[1]);
      i += m[0].length;
      continue;
    }
    const nm = /^<([^\s/>]+)/.exec(text.slice(i, i + 256));
    if (!nm) fail('malformed start tag');
    const name = nm[1];
    i += nm[0].length;
    const attrs = new Map();
    let empty = false;
    for (;;) {
      while (/[ \t\n]/.test(text[i])) i++;
      if (text.startsWith('/>', i)) { i += 2; empty = true; break; }
      if (text[i] === '>') { i++; break; }
      const am = /^([^\s=]+)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(text.slice(i, i + 65536));
      if (!am) fail(`malformed attribute in <${name}>`);
      const raw = am[3] !== undefined ? am[3] : am[4];
      attrs.set(am[1], decode(raw.replace(/[\t\n]/g, ' ')));
      i += am[0].length;
    }
    const decl = dtd.attlists.get(name);
    if (decl) {
      for (const [a, d] of decl) {
        if (attrs.has(a)) {
          if (d.type !== 'CDATA') attrs.set(a, attrs.get(a).replace(/ +/g, ' ').replace(/^ | $/g, ''));
        } else if (d.def !== null) {
          attrs.set(a, d.def);
        }
      }
    }
    stack.push(name);
    handler.startElement(name, new Attributes(attrs));
    if (empty) {
      stack.pop();
      handler.endElement(name);
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1]}>`);
  if (handler.endDocument) handler.endDocument();
}

module.exports = { parseFile };
