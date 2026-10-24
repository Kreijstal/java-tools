'use strict';

// Debug disassembler for the instruction subset the closed backend emits.
// Works on resolved function-body bytes (no validation), so it can show the
// instructions around a CompileError offset that external tools refuse to
// parse. Usage: node src/jit/closed/disassemble.js module.wasm [functionName]

const { OP, GC, SAT } = require('./wasmBuilder');

const NAMES = new Map(Object.entries(OP).map(([k, v]) => [v, k]));
const GC_NAMES = new Map(Object.entries(GC).map(([k, v]) => [v[1], k]));
const SAT_NAMES = new Map(Object.entries(SAT).map(([k, v]) => [v[1], k]));

function reader(bytes, at) {
  const r = { at };
  r.u8 = () => bytes[r.at++];
  r.uleb = () => { let n = 0, shift = 0, b; do { b = bytes[r.at++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return n; };
  r.sleb = () => {
    let n = 0n, shift = 0n, b;
    do { b = bytes[r.at++]; n |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80);
    if (b & 0x40) n -= 1n << shift;
    return n;
  };
  return r;
}

function blockType(r) {
  const b = r.u8();
  if (b === 0x40) return 'void';
  if (b === 0x63 || b === 0x64) return `ref${b === 0x63 ? ' null' : ''} ${r.sleb()}`;
  return `0x${b.toString(16)}`;
}

function disassembleBody(bytes, start, end, base = 0) {
  const r = reader(bytes, start);
  const lines = [];
  let depth = 0;
  // locals
  const groups = r.uleb();
  for (let i = 0; i < groups; i++) {
    const count = r.uleb();
    const t = r.u8();
    if (t === 0x63 || t === 0x64) r.sleb();
    lines.push(`  (local x${count} 0x${t.toString(16)})`);
  }
  while (r.at < end) {
    const offset = r.at - base;
    const op = r.u8();
    let text = NAMES.get(op) || `op_0x${op.toString(16)}`;
    switch (op) {
      case OP.block: case OP.loop: case OP.if: text += ` ${blockType(r)}`; break;
      case OP.br: case OP.br_if: case OP.call: case OP.local_get: case OP.local_set: case OP.local_tee:
      case OP.global_get: case OP.global_set: text += ` ${r.uleb()}`; break;
      case OP.br_table: { const n = r.uleb(); const t = []; for (let i = 0; i <= n; i++) t.push(r.uleb()); text += ` [${t.join(',')}]`; break; }
      case OP.i32_const: case OP.i64_const: text += ` ${r.sleb()}`; break;
      case OP.f32_const: r.at += 4; break;
      case OP.f64_const: r.at += 8; break;
      case OP.ref_null: { const t = r.u8(); text += ` 0x${t.toString(16)}`; break; }
      case 0xfb: {
        const sub = r.uleb();
        text = GC_NAMES.get(sub) || `gc_0x${sub.toString(16)}`;
        if ([0x02, 0x05].includes(sub)) text += ` ${r.uleb()} ${r.uleb()}`;
        else if ([0x00, 0x06, 0x07, 0x0b, 0x0e].includes(sub)) text += ` ${r.uleb()}`;
        else if ([0x14, 0x15, 0x16, 0x17].includes(sub)) text += ` ${r.sleb()}`;
        break;
      }
      case 0xfc: { const sub = r.uleb(); text = SAT_NAMES.get(sub) || `sat_${sub}`; break; }
      default:
        if (op >= 0x28 && op <= 0x3e) text += ` align=${r.uleb()} offset=${r.uleb()}`;
    }
    if (op === OP.end || op === OP.else) depth = Math.max(0, depth - 1);
    lines.push(`${String(offset).padStart(6)}: ${'  '.repeat(depth)}${text}`);
    if (op === OP.block || op === OP.loop || op === OP.if || op === OP.else) depth += 1;
  }
  return lines;
}

// Locate function bodies in a module's code section.
function functionBodies(bytes) {
  const r = reader(bytes, 8);
  let imports = 0;
  const bodies = [];
  const names = new Map();
  while (r.at < bytes.length) {
    const id = r.u8(), size = r.uleb(), end = r.at + size;
    if (id === 2) {
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        { const a = r.uleb(); r.at += a; } { const b = r.uleb(); r.at += b; }
        const kind = r.u8();
        if (kind === 0) { imports++; r.uleb(); } else if (kind === 3) { const t = r.u8(); if (t === 0x63 || t === 0x64) r.sleb(); r.u8(); }
        else if (kind === 2) { const flags = r.u8(); r.uleb(); if (flags & 1) r.uleb(); } else if (kind === 4) { r.u8(); r.uleb(); }
      }
    } else if (id === 10) {
      const count = r.uleb();
      for (let i = 0; i < count; i++) { const len = r.uleb(); bodies.push({ index: imports + i, start: r.at, end: r.at + len }); r.at += len; }
    } else if (id === 0) {
      const nameLength = r.uleb();
      const sectionName = Buffer.from(bytes.subarray(r.at, r.at + nameLength)).toString();
      r.at += nameLength;
      if (sectionName === 'name') {
        while (r.at < end) {
          const sub = r.u8(), subSize = r.uleb(), subEnd = r.at + subSize;
          if (sub === 1) {
            const n = r.uleb();
            for (let i = 0; i < n; i++) { const index = r.uleb(); const l = r.uleb(); names.set(index, Buffer.from(bytes.subarray(r.at, r.at + l)).toString()); r.at += l; }
          }
          r.at = subEnd;
        }
      }
    }
    r.at = end;
  }
  for (const body of bodies) body.name = names.get(body.index);
  return bodies;
}

module.exports = { disassembleBody, functionBodies };

if (require.main === module) {
  const bytes = require('node:fs').readFileSync(process.argv[2]);
  const want = process.argv[3];
  for (const body of functionBodies(bytes)) {
    if (want && body.name !== want && String(body.index) !== want) continue;
    console.log(`(func #${body.index} ${body.name || ''}  body@${body.start}`);
    for (const line of disassembleBody(bytes, body.start, body.end, 0)) console.log(line);
  }
}
