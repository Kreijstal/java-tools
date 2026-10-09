'use strict';
const {JavaParser} = require('../java-frontend/parser');

const reverse = {'<': '>', '<=': '>=', '>': '<', '>=': '<='};
const peel = node => {while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node;};
const complemented = node => {const n = peel(node); return n?.kind === 'UnaryExpression' && n.prefix === true && n.operator === '~' ? n : null;};

// In every legal Java relational comparison, ~ produces a signed int/long.
// Sign extension commutes with complement, and complement reverses that order.
// Retain all original operands, casts and parentheses; equality is excluded
// because removing ~ there could change boxed reference identity semantics.
function simplifyComplementedRelations(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, comparisonsSimplified: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, closes, children} = proof;let count = 0, refused = false;
  function inspect(node, depth = 0) {
    if (depth > 128) {refused = true; return;}
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'BinaryExpression' && reverse[node.operator] && complemented(node.left) && complemented(node.right)) count++;
    children(node, child => inspect(child, depth + 1));
  }
  inspect(parsed);if (refused || !count || count > 512) return unchanged();
  const opens = new Map([...closes].map(([a,b]) => [b,a]));
  const boundaries = new Set(['(', '[', '{', ')', ']', '}', ',', ';', ':', '?', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&', '||', '&', '|', '^', '==', '!=', '<', '<=', '>', '>=', 'instanceof', 'return', 'throw', 'assert', 'case']);
  const selections = [], edits = [], parser = new JavaParser();
  const range = i => ({start: tokens[i].range.startOffset - 2, end: tokens[i].range.endOffset - 2});
  for (let i = 0; i < tokens.length; i++) {
    if (!reverse[tokens[i].text]) continue;
    let first = i - 1, end = i + 1;
    for (; first >= 0 && i - first <= 256; first--) {
      if (opens.has(first)) {first = opens.get(first); continue;}
      if (boundaries.has(tokens[first].text)) break;
    }
    first++;
    for (; end < tokens.length && end - i <= 256; end++) {
      if (closes.has(end)) {end = closes.get(end); continue;}
      if (boundaries.has(tokens[end].text)) break;
    }
    if (first >= i || end <= i + 1 || i - first > 256 || end - i > 256) continue;
    const startOffset = tokens[first].range.startOffset - 2, endOffset = tokens[end - 1].range.endOffset - 2;
    if (endOffset - startOffset > 8192) continue;
    let expression;
    try {expression = parser.parseExpression(source.slice(startOffset,endOffset), {requireComplete: true});} catch (_) {continue;}
    const e = peel(expression);
    if (e?.kind !== 'BinaryExpression' || e.operator !== tokens[i].text || !complemented(e.left) || !complemented(e.right)) continue;
    function tilde(a,b) {while (tokens[a]?.text === '(' && closes.get(a) === b - 1) {a++;b--;}return tokens[a]?.text === '~' ? a : null;}
    const left = tilde(first,i), right = tilde(i+1,end);if (left === null || right === null) continue;
    const selection = {operatorRange: range(i), operator: tokens[i].text, replacement: reverse[tokens[i].text], leftComplementRange: range(left), rightComplementRange: range(right)};
    selections.push(selection);edits.push({...range(i),text:selection.replacement},{...range(left),text:''},{...range(right),text:''});
  }
  if (selections.length !== count) return unchanged();
  edits.sort((a,b)=>a.start-b.start);
  if (edits.some((e,i)=>i&&edits[i-1].end>e.start)) return unchanged();
  let output = source;for (const edit of edits.slice().reverse()) output = output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  // Lexical discovery never establishes operand boundaries by itself. Compare
  // complete independently parsed trees against the exact intended AST change.
  function normalize(node, transform, depth = 0) {
    if (depth > 256) throw new RangeError('complemented relation AST depth');
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(n=>normalize(n,transform,depth+1));
    if (node.kind === 'ParenthesizedExpression') return normalize(node.expression,transform,depth+1);
    let value = node;
    if (transform && node.kind === 'BinaryExpression' && reverse[node.operator] && complemented(node.left) && complemented(node.right)) value = {...node,operator:reverse[node.operator],left:complemented(node.left).operand,right:complemented(node.right).operand};
    return Object.fromEntries(Object.entries(value).filter(([key])=>!['range','meta','tokens'].includes(key)).map(([key,child])=>[key,normalize(child,transform,depth+1)]));
  }
  let after;
  try {after=parser.parseStatement('{\n'+output+'\n}',{requireComplete:true});} catch (_) {return unchanged();}
  if (JSON.stringify(normalize(parsed,true)) !== JSON.stringify(normalize(after,false))) return unchanged();
  return {source:output,comparisonsSimplified:count,complementsRemoved:count*2,...(retainDiagnostics?{diagnostics:{selections,edits}}:{})};
}
module.exports={simplifyComplementedRelations};
