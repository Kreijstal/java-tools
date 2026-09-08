'use strict';
const {parseDescriptor} = require('../parsing/typeParser');

// Explicit pre-main compiler experiment, not a production admission policy.
// It replaces one compiler-delimited call assignment, retaining the original
// caller catch/completion protocol and the child's own guards and polls.
function prepare(jit, spec) {
  if (jit.mainStarted || jit.jvm.guestStarted) throw Error('single-site inline requires pre-main preparation');
  if (jit.hotCallGraphRegions?.enabled || jit.caughtRuntimeCalls || jit.rawRestoringCalls)
    throw Error('single-site inline requires canonical restoring call ABI');
  const resolve = ([owner, name, descriptor]) => {
    const method = jit.jvm.findMethod(jit.jvm.classes[owner], name, descriptor);
    if (!method) throw Error('missing experiment method ' + owner + '.' + name);
    return method;
  };
  const caller = resolve(spec.caller), callee = resolve(spec.callee);
  if (caller === callee) throw Error('recursive expansion refused');
  const parent = jit.codegenCache.get(caller), originalChild = jit.codegenCache.get(callee);
  const variant = 'jvmRestoringDirectPositionalSource';
  const bodyKey = 'jvmRestoringDirectPositionalBody';
  if (!parent?.[bodyKey] || !originalChild?.[bodyKey]) throw Error('missing prepared restoring body');
  const sites = parent.jvmStructuredRegionCallSites.filter(s =>
    s.op === 'invokestatic' && s.exactTarget && s.resolvedMethod === callee && !s.directBoundary);
  const site = sites[spec.siteOrdinal || 0];
  if (!site?.regionLowering?.fastCall) throw Error('no exact static call with restoring protocol');
  let child = originalChild;
  if (spec.simplify === true || !child.jvmRestoringDirectPositionalInsertion) {
    // Isolate array-view/range-check simplification to the inserted body.
    // Never publish this alternative as the canonical callee for other sites.
    const old = jit.structuredSsa.normalPathArrayOptionality;
    try {
      jit.structuredSsa.normalPathArrayOptionality = spec.simplify === true;
      child = jit.structuredSsa.compile(callee);
    } finally { jit.structuredSsa.normalPathArrayOptionality = old; }
  }
  const insertion = child?.jvmRestoringDirectPositionalInsertion;
  if (!insertion || child[bodyKey].jvmHoistedSource) throw Error('callee has no self-contained insertion');
  const lower = site.regionLowering, source = parent[variant];
  const open = '/*' + site.regionMarkers.start + '*/';
  const close = '/*' + site.regionMarkers.end + '*/';
  const start = source.indexOf(open), end = source.indexOf(close, start);
  if (start < 0 || end < 0 || source.indexOf(open, start + 1) >= 0)
    throw Error('call site is absent or duplicated');
  const region = source.slice(start, end);
  const rawStart = region.indexOf(lower.rawCallPrefix);
  const rawEnd = region.indexOf(lower.rawCallSuffix, rawStart);
  if (rawStart < 0 || rawEnd < 0) throw Error('call operand tokens absent');
  const tokens = lower.operandTokens, starts = [];
  let scan = rawStart + lower.rawCallPrefix.length;
  for (const token of tokens) {
    const at = region.indexOf(token, scan);
    if (at < 0 || at >= rawEnd) throw Error('invalid operand token');
    scan = at + token.length; starts.push(scan);
  }
  const args = starts.map((at, i) => region.slice(at,
    (i + 1 < starts.length ? starts[i + 1] - tokens[i + 1].length : rawEnd) - 2));
  const assignmentStart = region.lastIndexOf('try { ' + lower.resultName + ' = ', rawStart);
  const catchStart = region.indexOf('} catch (' + lower.fastCall.caught + ') {', rawEnd);
  if (assignmentStart < 0 || catchStart < 0) throw Error('canonical call assignment absent');
  const originalAssignment = region.slice(assignmentStart + 'try { '.length, catchStart);
  const invoke = site.identifiers.invoke;
  if (!invoke) throw Error('missing bound invoker');
  const namespace = 'singleSite' + site.pc + '_';
  const childSource = 'const plan = ' + namespace + 'plan;\n' + insertion.source;
  const expanded = insertion.assemble({source: childSource, argumentValues: args,
    resultName: lower.resultName, exitLabel: namespace + 'exit', namespace,
    declareResult: false, entryGuardValue: 'true'});
  if (!expanded) throw Error('insertion assembly refused');
  // The simplified body's entry view can refuse a null argument before the
  // original body would. Keep nulls on the original call path so exception
  // restoration remains at exactly the original caller invoke PC.
  const nullGuards = spec.simplify ? parseDescriptor(callee.descriptor).params
    .flatMap((type,i)=>type.endsWith('[]') ? ['(' + args[i] + ') != null'] : []) : [];
  const replacement = 'try {\nif (' + invoke + '.jvmInlineRestoringBody && ' +
    invoke + '.jvmInlineRestoringBody === helpers.singleSiteInlineTargetBody' +
    nullGuards.map(g=>' && '+g).join('') + ') {\nconst ' + namespace + 'plan = ' +
    invoke + '.jvmInlineRestoringPlan;\n' +
    (spec.countEntries ? 'helpers.singleSiteInlineEntries = (helpers.singleSiteInlineEntries || 0) + 1;\n' : '') +
    expanded + '\n} else {\n' + originalAssignment + '\n}\n';
  const newSource = source.slice(0, start + assignmentStart) + replacement +
    source.slice(start + catchStart);
  const parentSpec = jit.serializeTextBody(parent[bodyKey]);
  const childSpec = jit.serializeTextBody(child[bodyKey]);
  const captures = {...parentSpec.captures};
  for (const [name, descriptor] of Object.entries(childSpec.captures)) {
    if (captures[name] && JSON.stringify(captures[name]) !== JSON.stringify(descriptor))
      throw Error('incompatible capture ' + name);
    captures[name] = descriptor;
  }
  const compiled = jit.materializeTextBody({...parentSpec, source: newSource, captures}, caller);
  if (!compiled) throw Error('expanded body failed transport');
  jit.singleSiteInlineTargetBody = originalChild[bodyKey];
  parent[bodyKey] = compiled;
  parent[variant] = newSource;
  // A changed body must not retain stale insertion/fragment metadata.
  parent.jvmRestoringDirectPositionalInsertion = null;
  if (parent.jvmStructuredRegionFragments) delete parent.jvmStructuredRegionFragments[variant];
  // Resume dispatchers mirror fast-leg properties, but transport serializes
  // the leg itself. Publish the replacement there as well; leave the resume
  // body and its continuation contract unchanged.
  if (parent.jvmFastBody && parent.jvmFastBody !== parent) {
    parent.jvmFastBody[bodyKey] = compiled;
    parent.jvmFastBody[variant] = newSource;
    parent.jvmFastBody.jvmRestoringDirectPositionalInsertion = null;
    if (parent.jvmFastBody.jvmStructuredRegionFragments)
      delete parent.jvmFastBody.jvmStructuredRegionFragments[variant];
  }
  jit.publishGeneratedTargetUpgrade(caller, parent);
  jit.singleSiteInlineReport = {caller: spec.caller, callee: spec.callee, pc: site.pc,
    simplify: spec.simplify === true, beforeBytes: source.length, afterBytes: newSource.length,
    childBeforeBytes: originalChild[variant].length, childAfterBytes: child[variant].length,
    retainsChildPolls: true, countEntries: spec.countEntries === true};
  return jit.singleSiteInlineReport;
}
module.exports = {prepare};
