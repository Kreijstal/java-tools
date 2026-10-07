'use strict';
// A small non-validating XML parser, enough for the build's metadata files:
// elements, attributes, comments, processing instructions, CDATA and the
// predefined and numeric entities. Calls handler.startElement(name, attrs)
// and handler.endElement(name), where attrs is a Map.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s, where) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in ENTITIES)) throw new Error(`${where}: undefined entity &${e};`);
    return ENTITIES[e];
  });
}

function parseXml(text, handler, file) {
  // end-of-line handling (XML 1.0 section 2.11)
  text = text.replace(/\r\n?/g, '\n');
  let i = 0;
  const stack = [];
  const lineAt = (p) => text.slice(0, p).split('\n').length;
  const fail = (msg) => { throw new Error(`${file || 'xml'}:${lineAt(i)}: ${msg}`); };
  const skipTo = (s) => {
    const e = text.indexOf(s, i);
    if (e < 0) fail(`unterminated construct, expected ${s}`);
    i = e + s.length;
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { if (text.slice(i).trim()) fail('text after root element'); break; }
    i = lt;
    if (text.startsWith('<!--', i)) { skipTo('-->'); continue; }
    if (text.startsWith('<?', i)) { skipTo('?>'); continue; }
    if (text.startsWith('<![CDATA[', i)) { skipTo(']]>'); continue; }
    if (text.startsWith('<!', i)) fail('DTDs are not supported');
    if (text[i + 1] === '/') {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i, i + 256));
      if (!m) fail('malformed end tag');
      const open = stack.pop();
      if (open !== m[1]) fail(`end tag </${m[1]}> does not match <${open}>`);
      handler.endElement(m[1]);
      i += m[0].length;
      continue;
    }
    const nm = /^<([A-Za-z_:][\w.:-]*)/.exec(text.slice(i, i + 256));
    if (!nm) fail('malformed start tag');
    const name = nm[1];
    i += nm[0].length;
    const attrs = new Map();
    for (;;) {
      const ws = /^\s*/.exec(text.slice(i, i + 4096));
      i += ws[0].length;
      if (text.startsWith('/>', i)) {
        i += 2;
        handler.startElement(name, attrs);
        handler.endElement(name);
        break;
      }
      if (text[i] === '>') {
        i++;
        stack.push(name);
        handler.startElement(name, attrs);
        break;
      }
      const am = /^([A-Za-z_:][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(text.slice(i, i + 65536));
      if (!am) fail(`malformed attribute in <${name}>`);
      if (attrs.has(am[1])) fail(`duplicate attribute ${am[1]}`);
      const raw = am[3] !== undefined ? am[3] : am[4];
      // attribute value normalization: literal whitespace becomes a space
      attrs.set(am[1], decode(raw.replace(/[\t\n]/g, ' '), file));
      i += am[0].length;
    }
  }
  if (stack.length) fail(`unclosed element <${stack[stack.length - 1]}>`);
}

module.exports = { parseXml };
