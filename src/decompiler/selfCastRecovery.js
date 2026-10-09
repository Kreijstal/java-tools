'use strict';

function sourceType(node) {
  if (node?.kind !== 'ClassType' || node.enclosingType || node.typeArguments?.length || node.annotations?.length) return null;
  return [node.packageName, node.name].filter(Boolean).join('.');
}
function ownThis(node, owner) {
  for (let depth = 0; depth < 128; depth++) {
    if (node?.kind === 'ThisExpression') return true;
    if (node?.kind === 'ParenthesizedExpression') node = node.expression;
    else if (node?.kind === 'CastExpression' && sourceType(node.castType) === owner) node = node.expression;
    else return false;
  }
  return false;
}
// This context comes from the erased source class header, never a guessed type
// of an ordinary receiver. Different self casts can select different overloads.
function simplifySelfCasts(source, proof, {selfType, retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, castsRemoved: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000
      || !selfType || typeof selfType.sourceName !== 'string' || !Array.isArray(selfType.typeParameters)
      || selfType.typeParameters.length || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(selfType.sourceName)) return unchanged();
  const owner = selfType.sourceName, {parsed, tokens, closes, children} = proof;
  let invalid = false, astCasts = 0;
  function walk(node, depth = 0) {
    if (depth > 128) {invalid = true; return;}
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) invalid = true;
    if (node.kind === 'CastExpression' && sourceType(node.castType) === owner && ownThis(node.expression, owner)) astCasts++;
    children(node, child => walk(child, depth + 1));
  }
  walk(parsed);
  if (invalid || !astCasts || astCasts > 1024) return unchanged();
  const opens = new Map([...closes].map(([open, close]) => [close, open])), selections = [];
  const ownerTokens = owner.split('.').flatMap((part, index) => index ? ['.', part] : [part]);
  const ownPrefix = close => {const open = opens.get(close); return open !== undefined && tokens[close]?.text === ')' && close - open === ownerTokens.length + 1 && ownerTokens.every((text, offset) => tokens[open + 1 + offset].text === text);};
  const argumentPrefix = (token, index) => token && (token.text === ')' && ownPrefix(index) ? false : token.kind === 'identifier' || ['this', 'super', 'if', 'while', 'for', 'switch', 'catch', 'synchronized', 'assert', '>', ']', ')'].includes(token.text));
  let castCount = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== 'this') continue;
    let first = index, last = index + 1;
    const castRanges = [], typeRanges = [];
    for (;;) {
      if (tokens[first - 1]?.text === '(' && closes.get(first - 1) === last && !argumentPrefix(tokens[first - 2], first - 2)) {
        first--; last++; continue;
      }
      const open = opens.get(first - 1);
      if (open === undefined || tokens[first - 1]?.text !== ')' || first - open !== ownerTokens.length + 2
          || ownerTokens.some((text, offset) => tokens[open + 1 + offset].text !== text)) break;
      castRanges.push({start: tokens[open].range.startOffset - 2, end: tokens[first - 1].range.endOffset - 2});
      typeRanges.push({start: tokens[open + 1].range.startOffset - 2, end: tokens[first - 2].range.endOffset - 2});
      first = open;
    }
    if (!castRanges.length) continue;
    const start = tokens[first].range.startOffset - 2, end = tokens[last - 1].range.endOffset - 2;
    const word = character => character && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(character);
    const text = (word(source[start - 1]) ? ' ' : '') + 'this' + (word(source[end]) ? ' ' : '');
    selections.push({range: {start, end}, thisRange: {start: tokens[index].range.startOffset - 2, end: tokens[index].range.endOffset - 2}, castRanges, typeRanges, text});
    castCount += castRanges.length;
  }
  if (castCount !== astCasts || !selections.length || selections.some((item, index) => index && selections[index - 1].range.end > item.range.start)) return unchanged();
  let output = source;
  for (const item of selections.slice().reverse()) output = output.slice(0, item.range.start) + item.text + output.slice(item.range.end);
  return {source: output, castsRemoved: castCount, expressionsSimplified: selections.length,
    ...(retainDiagnostics ? {diagnostics: {selections}} : {})};
}

function normalizedSelfCastAst(proof, owner) {
  function normalize(node, depth = 0) {
    if (depth > 256) throw new RangeError('self cast AST depth');
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(child => normalize(child, depth + 1));
    if (node.kind === 'ParenthesizedExpression'
        || node.kind === 'CastExpression' && sourceType(node.castType) === owner && ownThis(node.expression, owner)) return normalize(node.expression, depth + 1);
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['range', 'meta', 'tokens'].includes(key)).map(([key, value]) => [key, normalize(value, depth + 1)]));
  }
  return JSON.stringify(normalize(proof.parsed));
}
module.exports = {simplifySelfCasts, normalizedSelfCastAst};
