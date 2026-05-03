'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function runJavap(classpath, className, javap = 'javap') {
  return execFileSync(javap, ['-classpath', classpath, '-c', '-p', '-v', className], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function parseJavap(text) {
  const lines = text.split(/\r?\n/);
  const methods = [];
  let pendingHeader = null;
  let current = null;
  let inCode = false;
  let inExceptionTable = false;

  function finish() {
    if (current) {
      methods.push(current);
    }
    current = null;
    inCode = false;
    inExceptionTable = false;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!current && line.endsWith(';') && line.includes('(') && !line.startsWith('descriptor:')) {
      pendingHeader = line;
      continue;
    }

    if (!current && pendingHeader && line.startsWith('descriptor: ')) {
      const descriptor = line.slice('descriptor: '.length);
      const beforeParen = pendingHeader.slice(0, pendingHeader.indexOf('(')).trim();
      const name = pendingHeader === 'static {};' ? '<clinit>' : beforeParen.split(/\s+/).pop();
      current = {
        name,
        descriptor,
        header: pendingHeader,
        instructions: [],
        exceptionTable: [],
      };
      pendingHeader = null;
      continue;
    }

    if (current && line === 'Code:') {
      inCode = true;
      inExceptionTable = false;
      continue;
    }

    if (current && line.startsWith('Exception table:')) {
      inCode = false;
      inExceptionTable = true;
      continue;
    }

    if (current && !inCode && line.endsWith(';') && line.includes('(')
        && !line.startsWith('descriptor:')) {
      finish();
      pendingHeader = line;
      continue;
    }

    if (current && (line.startsWith('LineNumberTable:') || line.startsWith('LocalVariableTable:')
        || line.startsWith('StackMapTable:') || line.startsWith('RuntimeVisible'))) {
      inExceptionTable = false;
      continue;
    }

    if (current && inCode) {
      const match = line.match(/^(\d+):\s+([a-z][a-z0-9_]*)(?:\s+(-?\d+))?/);
      if (match) {
        current.instructions.push({
          pc: Number(match[1]),
          opcode: match[2],
          operand: match[3] == null ? null : Number(match[3]),
          text: line,
        });
      }
      continue;
    }

    if (current && inExceptionTable) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (match) {
        current.exceptionTable.push({
          startPc: Number(match[1]),
          endPc: Number(match[2]),
          handlerPc: Number(match[3]),
          type: match[4].trim(),
        });
      }
    }
  }

  finish();
  return methods;
}

function isBranch(opcode) {
  return opcode === 'goto' || opcode === 'goto_w' || opcode.startsWith('if')
    || opcode === 'jsr' || opcode === 'jsr_w';
}

function isUnconditionalBranch(opcode) {
  return opcode === 'goto' || opcode === 'goto_w' || opcode === 'jsr' || opcode === 'jsr_w';
}

function analyzeMethods(methods) {
  const findings = [];
  for (const method of methods) {
    const byPc = new Map(method.instructions.map((insn, index) => [insn.pc, { insn, index }]));
    const normalPredecessors = new Map();

    for (let i = 0; i < method.instructions.length; i += 1) {
      const insn = method.instructions[i];
      if (isBranch(insn.opcode) && insn.operand != null) {
        if (!normalPredecessors.has(insn.operand)) normalPredecessors.set(insn.operand, []);
        normalPredecessors.get(insn.operand).push({ pc: insn.pc, opcode: insn.opcode, kind: 'branch' });
      }
      if (!isUnconditionalBranch(insn.opcode) && insn.opcode !== 'return' && insn.opcode !== 'ireturn'
          && insn.opcode !== 'lreturn' && insn.opcode !== 'freturn' && insn.opcode !== 'dreturn'
          && insn.opcode !== 'areturn' && insn.opcode !== 'athrow') {
        const next = method.instructions[i + 1];
        if (next) {
          if (!normalPredecessors.has(next.pc)) normalPredecessors.set(next.pc, []);
          normalPredecessors.get(next.pc).push({ pc: insn.pc, opcode: insn.opcode, kind: 'fallthrough' });
        }
      }
    }

    for (const entry of method.exceptionTable) {
      const target = byPc.get(entry.handlerPc);
      if (!target || target.insn.opcode !== 'athrow') {
        continue;
      }

      const prev = method.instructions[target.index - 1] || null;
      const normalPreds = normalPredecessors.get(entry.handlerPc) || [];
      const skippedByBranch = prev && isUnconditionalBranch(prev.opcode) && prev.operand !== entry.handlerPc;
      const noNormalPreds = normalPreds.length === 0;
      const rangeEndsAtHandler = entry.endPc === entry.handlerPc;

      findings.push({
        method: `${method.name}${method.descriptor}`,
        handlerPc: entry.handlerPc,
        startPc: entry.startPc,
        endPc: entry.endPc,
        type: entry.type,
        previousInstruction: prev ? prev.text : null,
        normalPredecessors: normalPreds,
        skippedByBranch,
        rangeEndsAtHandler,
        trapLike: noNormalPreds && skippedByBranch && rangeEndsAtHandler,
      });
    }
  }
  return findings;
}

function analyzeJavap(text) {
  return analyzeMethods(parseJavap(text));
}

function analyzeClass(classpath, className, options = {}) {
  const javap = options.javap || process.env.JAVAP || 'javap';
  return analyzeJavap(runJavap(classpath, className, javap));
}

module.exports = {
  analyzeClass,
  analyzeJavap,
  analyzeMethods,
  parseJavap,
};
