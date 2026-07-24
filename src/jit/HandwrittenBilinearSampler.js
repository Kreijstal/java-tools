"use strict";

// Compact semantic lowering for a verified, acyclic, four-neighbour
// fixed-point sampler.  The matcher is deliberately independent of guest
// owner/member names: it uses the descriptor, canonicalized bytecodes,
// constants, control flow, and repeated field-reference relationships.
//
// The fast path performs only reads until the final destination store.  Any
// unusual object/array layout or exceptional index returns the ordinary
// asynchronous-call sentinel before that store, so the canonical generated
// method re-executes from its invoke bytecode and retains exact JVM exception
// frames.  Valid raster calls therefore need neither a child Frame nor the
// large mechanically structured SSA decision tree.

const {
  fingerprintMethods,
} = require("./HandwrittenFusedGradient");

const KNOWN_FINGERPRINTS = new Set([
  1541484005,
]);

function getOp(instruction) {
  return typeof instruction === "string"
    ? instruction : instruction && instruction.op;
}

function refKey(ref) {
  return JSON.stringify(ref);
}

function uniqueRefs(refs) {
  const result = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function countRef(refs, ref) {
  const key = refKey(ref);
  return refs.reduce((count, candidate) =>
    count + (refKey(candidate) === key ? 1 : 0), 0);
}

function analyze(jit, method) {
  if (!method || method.descriptor !== "(IIIII)V") return null;
  const flags = method.flags || [];
  if (flags.includes("static") ||
      (Number(method.accessFlags) & 0x0008) !== 0) return null;
  const fingerprint = fingerprintMethods(jit, [method]);
  if (!KNOWN_FINGERPRINTS.has(fingerprint)) return null;

  const instanceIntRefs = [];
  const instanceArrayRefs = [];
  const staticArrayRefs = [];
  for (const item of jit.getCodeItems(method)) {
    const instruction = item && item.instruction;
    const op = getOp(instruction);
    if (!instruction || typeof instruction !== "object" ||
        !Array.isArray(instruction.arg) ||
        !Array.isArray(instruction.arg[2])) continue;
    const descriptor = instruction.arg[2][1];
    if (op === "getfield" && descriptor === "I") {
      instanceIntRefs.push(instruction.arg);
    } else if (op === "getfield" && descriptor === "[I") {
      instanceArrayRefs.push(instruction.arg);
    } else if (op === "getstatic" && descriptor === "[I") {
      staticArrayRefs.push(instruction.arg);
    }
  }
  const scalarRefs = uniqueRefs(instanceIntRefs);
  const sourceRefs = uniqueRefs(instanceArrayRefs);
  const destinationRefs = uniqueRefs(staticArrayRefs);
  if (scalarRefs.length !== 2 || sourceRefs.length !== 1 ||
      destinationRefs.length !== 1) return null;

  // The canonical shape first reads the row stride, then the height. Retain
  // the complete occurrence relationship as an independent sanity check
  // before assigning those semantic roles.
  const widthRef = scalarRefs[0];
  const heightRef = scalarRefs[1];
  if (countRef(instanceIntRefs, widthRef) !== 5 ||
      countRef(instanceIntRefs, heightRef) !== 1 ||
      instanceArrayRefs.length !== 4 ||
      staticArrayRefs.length !== 2) return null;

  return {
    fingerprint,
    widthRef,
    heightRef,
    sourceRef: sourceRefs[0],
    destinationRef: destinationRefs[0],
  };
}

function install(jit, method) {
  const analysis = analyze(jit, method);
  if (!analysis) return null;
  const methodOwner = method.className ||
    jit.jvm.findClassNameForMethod?.(method) ||
    analysis.widthRef[1];
  const destinationOwner = analysis.destinationRef[1];
  const widthSite = jit.registerFieldSite(analysis.widthRef);
  const heightSite = jit.registerFieldSite(analysis.heightRef);
  const sourceSite = jit.registerFieldSite(analysis.sourceRef);
  const destinationSite = jit.registerFieldSite(analysis.destinationRef);
  const widthKey = jit.fieldSites[widthSite]?.directInstanceKey;
  const heightKey = jit.fieldSites[heightSite]?.directInstanceKey;
  const sourceKey = jit.fieldSites[sourceSite]?.directInstanceKey;
  const destinationTarget = jit.registerDirectStaticTarget(destinationSite);
  if (!methodOwner || !destinationOwner || !widthKey || !heightKey ||
      !sourceKey || !destinationTarget) return null;
  const target = jit.directStaticTargets[destinationTarget.targetId];
  if (!target) return null;

  const fallback = [
    "helpers.semanticBilinearSamplerFallbackCount =",
    "  (helpers.semanticBilinearSamplerFallbackCount | 0) + 1;",
    "return helpers.asyncInvokeSentinel();",
  ];
  const body = [
    "'use strict';",
    `if (thread.status !== "runnable" || helpers.needsBytecodeChecks() ||`,
    `    helpers.jvm.classInitializationState.get(${JSON.stringify(methodOwner)}) !== "INITIALIZED" ||`,
    `    helpers.jvm.classInitializationState.get(${JSON.stringify(destinationOwner)}) !== "INITIALIZED") {`,
    ...fallback.map((line) => `  ${line}`),
    "}",
    "if (receiver === null || receiver === undefined || !receiver.fields) {",
    ...fallback.map((line) => `  ${line}`),
    "}",
    `const widthValue = receiver.fields[${JSON.stringify(widthKey)}];`,
    `const heightValue = receiver.fields[${JSON.stringify(heightKey)}];`,
    `const sourceRef = receiver.fields[${JSON.stringify(sourceKey)}];`,
    "if (widthValue === undefined || heightValue === undefined) {",
    ...fallback.map((line) => `  ${line}`),
    "}",
    "const width = widthValue | 0;",
    "const height = heightValue | 0;",
    "const source = sourceRef && (sourceRef.elements || sourceRef);",
    "let index = (Math.imul(sourceY | 0, width) + (sourceX | 0)) | 0;",
    "fractionX = (fractionX | 0) & 4095;",
    "fractionY = (fractionY | 0) & 4095;",
    "let p00 = 0, p10 = 0, p01 = 0, p11 = 0;",
    "let w00 = 0, w10 = 0, w01 = 0, w11 = 0;",
    "let readIndex;",
    "if ((sourceY | 0) >= 0) {",
    "  if ((sourceX | 0) >= 0) {",
    "    readIndex = index;",
    "    if (!source || readIndex < 0 || readIndex >= source.length) {",
    ...fallback.map((line) => `      ${line}`),
    "    }",
    "    p00 = source[readIndex] | 0;",
    "    if (p00 !== 0) w00 = Math.imul(4096 - fractionX, 4096 - fractionY);",
    "  }",
    "  if ((sourceX | 0) < (width - 1 | 0)) {",
    "    readIndex = (index + 1) | 0;",
    "    if (!source || readIndex < 0 || readIndex >= source.length) {",
    ...fallback.map((line) => `      ${line}`),
    "    }",
    "    p10 = source[readIndex] | 0;",
    "    if (p10 !== 0) w10 = Math.imul(fractionX, 4096 - fractionY);",
    "  }",
    "}",
    "if ((sourceY | 0) < (height - 1 | 0)) {",
    "  if ((sourceX | 0) >= 0) {",
    "    readIndex = (index + width) | 0;",
    "    if (!source || readIndex < 0 || readIndex >= source.length) {",
    ...fallback.map((line) => `      ${line}`),
    "    }",
    "    p01 = source[readIndex] | 0;",
    "    if (p01 !== 0) w01 = Math.imul(4096 - fractionX, fractionY);",
    "  }",
    "  if ((sourceX | 0) < (width - 1 | 0)) {",
    "    readIndex = (index + width + 1) | 0;",
    "    if (!source || readIndex < 0 || readIndex >= source.length) {",
    ...fallback.map((line) => `      ${line}`),
    "    }",
    "    p11 = source[readIndex] | 0;",
    "    if (p11 !== 0) w11 = Math.imul(fractionX, fractionY);",
    "  }",
    "}",
    "w00 >>= 16; w10 >>= 16; w01 >>= 16; w11 >>= 16;",
    "const alpha = (w00 + w10 + w01 + w11) | 0;",
    "if (alpha < 128) {",
    "  helpers.semanticBilinearSamplerRunCount =",
    "    (helpers.semanticBilinearSamplerRunCount | 0) + 1;",
    "  return helpers.returnVoid();",
    "}",
    "let redBlue = (Math.imul(p00 & 16711935, w00) +",
    "  Math.imul(p10 & 16711935, w10) +",
    "  Math.imul(p01 & 16711935, w01) +",
    "  Math.imul(p11 & 16711935, w11)) | 0;",
    "let green = (Math.imul(p00 & 65280, w00) +",
    "  Math.imul(p10 & 65280, w10) +",
    "  Math.imul(p01 & 65280, w01) +",
    "  Math.imul(p11 & 65280, w11)) | 0;",
    "let color;",
    "if (alpha >= 256) {",
    "  color = (((redBlue >>> 8) & 16711935) +",
    "    ((green >>> 8) & 65280)) | 0;",
    "} else {",
    "  color = (((((redBlue >>> 16) / alpha) | 0) << 16) +",
    "    ((((green / alpha) | 0)) & 65280) +",
    "    (((redBlue & 65535) / alpha) | 0)) | 0;",
    "}",
    "if (color === 0) color = 1;",
    "const destinationRef = plan.semantic.destination.kind === 'map'",
    "  ? plan.semantic.destination.fields.get(plan.semantic.destination.key)",
    "  : plan.semantic.destination.fields[plan.semantic.destination.key];",
    "const destination = destinationRef &&",
    "  (destinationRef.elements || destinationRef);",
    "destinationIndex |= 0;",
    "if (!destination || destinationIndex < 0 ||",
    "    destinationIndex >= destination.length) {",
    ...fallback.map((line) => `  ${line}`),
    "}",
    "destination[destinationIndex] = color;",
    "helpers.semanticBilinearSamplerRunCount =",
    "  (helpers.semanticBilinearSamplerRunCount | 0) + 1;",
    "return helpers.returnVoid();",
  ].join("\n");

  const generated = jit.createGeneratedFunction(
    method,
    "semantic-bilinear-sampler",
    [
      "helpers", "plan", "receiver", "destinationIndex",
      "sourceX", "sourceY", "fractionX", "fractionY", "thread",
    ],
    body,
    methodOwner,
  );
  return {
    body: generated,
    source: body,
    plan: {
      fingerprint: analysis.fingerprint,
      destination: target,
    },
  };
}

module.exports = {
  analyze,
  install,
  _test: {
    KNOWN_FINGERPRINTS,
  },
};
