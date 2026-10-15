'use strict';

// Recover an empty-stack loop entry from a duplicated local producer:
//   P: load slot; goto J; H: load slot; J: consume value; ... goto H
// becomes P: nop; goto H. The load is nonthrowing and no work separates the
// two evaluations on P's path. Other paths, instruction PCs, labels, exception
// boundaries and metadata stay intact. Fields/constants/calls are not locals.
// Index all incoming edges first: an entry into P's goto must reject the
// rewrite, since that path already carries its value on the operand stack.
function recoverPreloadedLoopEntries(code, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({entriesRecovered: 0});
  if (!Array.isArray(code?.codeItems) || typeof retainDiagnostics !== 'boolean') return unchanged();
  const items = code.codeItems, real = [], instructions = [], labels = new Map(), at = [], pcs = new Map();
  let pending = [], invalid = false;
  const trim = value => typeof value === 'string' ? value.replace(/:$/, '') : null;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    const label = trim(item.labelDef || item.lineLabel);
    if (label) pending.push(label);
    if (item.instruction == null) continue;
    const instruction = typeof item.instruction === 'string' ? {op: item.instruction} : item.instruction;
    if (!instruction || typeof instruction.op !== 'string' || /^(?:jsr|jsr_w|ret|wide)$/.test(instruction.op)) return unchanged();
    for (const name of pending) {
      if (labels.has(name)) invalid = true;
      labels.set(name, real.length);
    }
    at.push(pending); pending = [];
    if (item.pc != null) pcs.set(Number(item.pc), real.length);
    real.push(index); instructions.push(instruction);
  }
  for (const name of pending) {
    if (labels.has(name)) invalid = true;
    labels.set(name, real.length);
  }
  if (invalid || !real.length) return unchanged();
  const incoming = Array.from({length: real.length}, () => []), boundaries = new Set();
  function destination(value) {
    return typeof value === 'number' ? pcs.get(value) : labels.get(trim(value));
  }
  for (const entry of code.exceptionTable || []) {
    let handlerFound = false;
    for (const key of ['startLbl', 'startLabel', 'start', 'start_pc', 'endLbl', 'endLabel', 'end', 'end_pc',
      'handlerLbl', 'handlerLabel', 'handler', 'handler_pc', 'usingLbl']) {
      if (entry[key] == null) continue;
      const target = destination(entry[key]);
      if (target !== undefined) boundaries.add(target);
      if (/handler|using/.test(key) && target !== undefined) handlerFound = true;
    }
    if (!handlerFound) return unchanged();
  }
  const conditional = /^(?:if(?:eq|ne|lt|le|gt|ge|null|nonnull)|if_(?:icmp(?:eq|ne|lt|le|gt|ge)|acmp(?:eq|ne)))$/;
  for (let from = 0; from < instructions.length; from++) {
    const instruction = instructions[from], op = instruction.op;
    let targets = [];
    if (op === 'goto' || op === 'goto_w' || conditional.test(op)) targets = [instruction.arg];
    else if (op === 'tableswitch') {
      if (!Array.isArray(instruction.labels) || instruction.defaultLbl == null) return unchanged();
      targets = [...instruction.labels, instruction.defaultLbl];
    } else if (op === 'lookupswitch') {
      const arg = instruction.arg;
      if (!Array.isArray(arg?.pairs) || arg.defaultLabel == null || arg.pairs.some(p => !Array.isArray(p) || p.length !== 2)) return unchanged();
      targets = [...arg.pairs.map(p => p[1]), arg.defaultLabel];
    } else if (op.startsWith('if')) return unchanged();
    for (const value of new Set(targets)) {
      const to = destination(value);
      if (to === undefined || to >= real.length) return unchanged();
      incoming[to].push({from, op});
    }
  }
  function local(instruction) {
    const match = /^([ailfd])load(?:_([0-3]))?$/.exec(instruction?.op);
    if (!match) return null;
    const slot = match[2] ?? instruction.arg;
    if (!/^(?:0|[1-9]\d*)$/.test(String(slot)) || Number(slot) > 65535) return null;
    return match[1] + ':' + Number(slot);
  }
  const edits = [], touched = new Set();
  for (let join = 1; join < real.length; join++) {
    const header = join - 1, key = local(instructions[header]);
    if (!key || !incoming[join].length || boundaries.has(header) || boundaries.has(join)
        || !incoming[header].some(edge => edge.from >= join) || touched.has(header) || touched.has(join)) continue;
    const sites = [];
    for (const edge of incoming[join]) {
      const load = edge.from - 1;
      if (!['goto', 'goto_w'].includes(edge.op) || load < 0 || local(instructions[load]) !== key
          || incoming[edge.from].length || boundaries.has(edge.from)
          || touched.has(load) || touched.has(edge.from)) {sites.length = 0; break;}
      sites.push({load, jump: edge.from});
    }
    if (!sites.length || sites.some(site => site.load === header || site.jump === join)) continue;
    const label = at[header][0];
    if (!label) continue;
    edits.push({header: real[header], join: real[join], label,
      sites: sites.map(site => ({load: real[site.load], jump: real[site.jump]}))});
    touched.add(header); touched.add(join);
    for (const site of sites) {touched.add(site.load); touched.add(site.jump);}
  }
  for (const edit of edits) for (const site of edit.sites) {
    items[site.load] = {...items[site.load], instruction: 'nop'};
    items[site.jump] = {...items[site.jump], instruction: {...items[site.jump].instruction, arg: edit.label}};
  }
  return {entriesRecovered: edits.reduce((n, edit) => n + edit.sites.length, 0),
    ...(retainDiagnostics ? {diagnostics: {edits, instructionsIndexed: real.length,
      edgesIndexed: incoming.reduce((n, edges) => n + edges.length, 0)}} : {})};
}

module.exports = {recoverPreloadedLoopEntries};
