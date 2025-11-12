'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKrak2Assembly } = require('./parse_krak2');
const { convertKrak2AstToClassAst } = require('./convert_krak2_ast');
const { writeClassAstToClassFile } = require('./classAstToClassFile');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('./convert_tree');

function normalizeNewlines(str) {
  return str.replace(/\r\n/g, '\n');
}

function findCommentStart(line) {
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inDouble && ch === ';') {
      return i;
    }
  }
  return -1;
}

function captureCommentMetadata(sourceText) {
  const normalized = normalizeNewlines(sourceText);
  const lines = normalized.split('\n');
  const inlineComments = new Map();
  const standaloneComments = [];
  let codeLineIndex = 0;

  for (const line of lines) {
    const commentIdx = findCommentStart(line);
    const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : null;
    const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    if (codePart.trim().length === 0) {
      if (commentPart) {
        standaloneComments.push({
          position: codeLineIndex,
          text: line.replace(/\s+$/, ''),
        });
      }
      continue;
    }
    if (commentPart) {
      inlineComments.set(codeLineIndex, commentPart.trimEnd());
    }
    codeLineIndex += 1;
  }

  return {
    inlineComments,
    standaloneComments,
    totalCodeLines: codeLineIndex,
    hasTrailingNewline: normalized.endsWith('\n'),
  };
}

function mergeFormattedTextWithComments(formattedText, metadata) {
  const normalized = normalizeNewlines(formattedText);
  const lines = normalized.split('\n');
  const result = [];
  let codeLineIndex = 0;

  const standaloneMap = new Map();
  metadata.standaloneComments.forEach((entry) => {
    const arr = standaloneMap.get(entry.position) || [];
    arr.push(entry.text);
    standaloneMap.set(entry.position, arr);
  });
  const inlineMap = new Map(metadata.inlineComments);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      result.push(line);
      continue;
    }
    const pendingStandalone = standaloneMap.get(codeLineIndex);
    if (pendingStandalone) {
      result.push(...pendingStandalone);
      standaloneMap.delete(codeLineIndex);
    }
    let finalLine = line;
    const inline = inlineMap.get(codeLineIndex);
    if (inline) {
      const base = line.replace(/[ \t]+$/, '');
      const spacer = base.length ? '  ' : '';
      finalLine = `${base}${spacer}${inline}`;
      inlineMap.delete(codeLineIndex);
    }
    result.push(finalLine);
    codeLineIndex += 1;
  }

  const remainingPositions = [...standaloneMap.keys()].sort((a, b) => a - b);
  remainingPositions.forEach((position) => {
    if (position >= codeLineIndex) {
      result.push(...standaloneMap.get(position));
    }
  });

  inlineMap.forEach((inline) => {
    result.push(inline);
  });

  let output = result.join('\n');
  if (metadata.hasTrailingNewline && !output.endsWith('\n')) {
    output += '\n';
  }
  return output;
}

function canonicalizeJasmin(text) {
  const ast = convertKrak2AstToClassAst(parseKrak2Assembly(text), { sourceText: text });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jasmin-format-'));
  try {
    const tempClass = path.join(tempDir, 'temp.class');
    writeClassAstToClassFile(ast, tempClass);
    const classBytes = fs.readFileSync(tempClass);
    const parsed = getAST(new Uint8Array(classBytes));
    const classAst = convertJson(parsed.ast, parsed.constantPool);
    return classAst.classes.map((cls) => unparseDataStructures(cls, parsed.constantPool)).join('\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function formatJasminSource(sourceText) {
  const metadata = captureCommentMetadata(sourceText);
  const canonical = canonicalizeJasmin(sourceText);
  return mergeFormattedTextWithComments(canonical, metadata);
}

module.exports = {
  formatJasminSource,
  normalizeNewlines,
};
