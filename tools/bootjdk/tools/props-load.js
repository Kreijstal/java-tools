'use strict';
// java.util.Properties.load(Reader) and the decoders the build tools put in
// front of it.

const fs = require('fs');

// Files.newBufferedReader(path): strict UTF-8, BOM kept, malformed -> IOException
function readUtf8Strict(file) {
  const buf = fs.readFileSync(file);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch (e) {
    const err = new Error('Input length = 1');
    err.javaClass = 'java.nio.charset.MalformedInputException';
    throw err;
  }
}

// Properties.load(InputStream) decodes ISO-8859-1
function readLatin1(file) {
  return fs.readFileSync(file).toString('latin1');
}

// LineReader.readLine over the whole text; yields logical lines
function* logicalLines(text) {
  const limit = text.length;
  let off = 0;
  for (;;) {
    let line = [];
    let skipWhiteSpace = true, appendedLineBegin = false, precedingBackslash = false;
    let done = false;
    for (;;) {
      if (off >= limit) {
        if (line.length === 0) return;
        if (precedingBackslash) line.pop();
        done = true;
        break;
      }
      const c = text[off++];
      if (skipWhiteSpace) {
        if (c === ' ' || c === '\t' || c === '\f') continue;
        if (!appendedLineBegin && (c === '\r' || c === '\n')) continue;
        skipWhiteSpace = false;
        appendedLineBegin = false;
      }
      if (line.length === 0 && (c === '#' || c === '!')) {
        for (;;) {
          if (off >= limit) return;
          const d = text[off++];
          if (d === '\r' || d === '\n') break;
        }
        skipWhiteSpace = true;
        continue;
      }
      if (c !== '\n' && c !== '\r') {
        line.push(c);
        precedingBackslash = c === '\\' ? !precedingBackslash : false;
      } else {
        if (line.length === 0) { skipWhiteSpace = true; continue; }
        if (off >= limit) {
          if (precedingBackslash) line.pop();
          done = true;
          break;
        }
        if (precedingBackslash) {
          line.pop();
          skipWhiteSpace = true;
          appendedLineBegin = true;
          precedingBackslash = false;
          if (c === '\r' && text[off] === '\n') off++;
        } else break;
      }
    }
    yield line;
    if (done) return;
  }
}

function loadConvert(buf, off, len) {
  const end = off + len;
  let out = '';
  while (off < end) {
    let c = buf[off++];
    if (c === '\\') {
      c = buf[off++];
      if (c === 'u') {
        if (off > end - 4) throw new Error('java.lang.IllegalArgumentException: Malformed \\uxxxx encoding.');
        let v = 0;
        for (let i = 0; i < 4; i++) {
          const h = buf[off++];
          const d = /^[0-9a-fA-F]$/.test(h || '') ? parseInt(h, 16) : -1;
          if (d < 0) throw new Error('java.lang.IllegalArgumentException: Malformed \\uxxxx encoding.');
          v = (v << 4) + d;
        }
        out += String.fromCharCode(v);
      } else {
        if (c === 't') c = '\t';
        else if (c === 'r') c = '\r';
        else if (c === 'n') c = '\n';
        else if (c === 'f') c = '\f';
        out += c === undefined ? '\0' : c;
      }
    } else out += c;
  }
  return out;
}

// Properties.load0: returns a Map in file order, later duplicates replace
// earlier values (insertion position of the first occurrence kept)
function loadProperties(text, map = new Map()) {
  for (const buf of logicalLines(text)) {
    const limit = buf.length;
    let keyLen = 0, valueStart = limit, hasSep = false, precedingBackslash = false;
    while (keyLen < limit) {
      const c = buf[keyLen];
      if ((c === '=' || c === ':') && !precedingBackslash) {
        valueStart = keyLen + 1; hasSep = true; break;
      } else if ((c === ' ' || c === '\t' || c === '\f') && !precedingBackslash) {
        valueStart = keyLen + 1; break;
      }
      precedingBackslash = c === '\\' ? !precedingBackslash : false;
      keyLen++;
    }
    while (valueStart < limit) {
      const c = buf[valueStart];
      if (c !== ' ' && c !== '\t' && c !== '\f') {
        if (!hasSep && (c === '=' || c === ':')) hasSep = true;
        else break;
      }
      valueStart++;
    }
    map.set(loadConvert(buf, 0, keyLen), loadConvert(buf, valueStart, limit - valueStart));
  }
  return map;
}

module.exports = { readUtf8Strict, readLatin1, loadProperties, logicalLines };
