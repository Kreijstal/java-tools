const { parseDescriptor } = require("../parsing/typeParser");
const { buildCfgFromCode, structure } = require("../decompiler/structurer");
const HandwrittenFusedGradient = require("./HandwrittenFusedGradient");
const HandwrittenFusedFlat = require("./HandwrittenFusedFlat");

const BAILOUT = Symbol("jit.fused.bailout");

// Emit the already verified scanline bytecode directly into a raster body.
// This is used only by a trusted raster entered after the wrapper has proved
// the complete destination/row layout. The plan contains parameter roles
// derived from bytecode data flow; no owner, method, or descriptor identity
// participates in the decision.
function emitTrustedScanline(plan, args, temp) {
  if (!plan || String(args[plan.tag]).trim() !== String(plan.tagValue)) {
    return null;
  }
  const index = temp();
  const count = temp();
  const dest = temp();
  const lines = [
    "{",
    `let ${index}=(${args[plan.index]})|0;`,
    `const ${count}=(${args[plan.count]})|0;`,
    `const ${dest}=${args[plan.array]};`,
    `if(${count}>0){`,
  ];
  if (plan.kind === "packed-color") {
    const colors = plan.accumulators.map(() => temp());
    const steps = plan.steps.map(() => temp());
    const offset = temp();
    lines.push(
      `let ${colors[0]}=(${args[plan.accumulators[0]]})|0;`,
      `let ${colors[1]}=(${args[plan.accumulators[1]]})|0;`,
      `let ${colors[2]}=(${args[plan.accumulators[2]]})|0;`,
      `const ${steps[0]}=(${args[plan.steps[0]]})|0;`,
      `const ${steps[1]}=(${args[plan.steps[1]]})|0;`,
      `const ${steps[2]}=(${args[plan.steps[2]]})|0;`,
      `for(let ${offset}=0;${offset}<${count};${offset}+=1){`,
      `${dest}[${index}]=(((${dest}[${index}]>>1)&8355711)+` +
        `((${colors[0]}>>9)&65280)+((${colors[1]}>>1)&16711680)+` +
        `((${colors[2]}>>17)&255))|0;`,
      `${index}=(${index}+1)|0;`,
      `${colors[0]}=(${colors[0]}+${steps[0]})|0;`,
      `${colors[1]}=(${colors[1]}+${steps[1]})|0;`,
      `${colors[2]}=(${colors[2]}+${steps[2]})|0;`,
      "}",
    );
  } else if (plan.kind === "constant-color") {
    const color = temp();
    const offset = temp();
    lines.push(
      `const ${color}=(${args[plan.color]})|0;`,
      `for(let ${offset}=0;${offset}<${count};${offset}+=1){`,
      `${dest}[${index}]=(${color}+((${dest}[${index}]&16711422)>>1))|0;`,
      `${index}=(${index}+1)|0;`,
      "}",
    );
  } else {
    return null;
  }
  lines.push("}", "}");
  return lines;
}

// Canonicalize identities commonly left behind by integer obfuscators before
// JavaScript reaches the host optimizer. Every operand in a verified integer
// kernel has JVM int32 semantics, so bitwise complement reverses signed order.
// Expressing the original relation directly avoids making the host rediscover
// that fact independently in every generated control-flow arm.
function canonicalIntegerComparison(left, operator, right) {
  const complement = (expression) => {
    const match = /^\((.+)\^-1\)$/.exec(expression);
    return match ? match[1] : null;
  };
  const leftBase = complement(left);
  const rightBase = complement(right);
  if (leftBase !== null && rightBase !== null) {
    const reversed = {
      "<": ">", "<=": ">=", ">": "<", ">=": "<=",
      "===": "===", "!==": "!==",
    }[operator];
    if (reversed) return `${leftBase}${reversed}${rightBase}`;
  }
  const againstComplement = {
    "<": "<", "<=": "<=", ">": ">", ">=": ">=",
    "===": "===", "!==": "!==",
  };
  if (left === "-1" && rightBase !== null && againstComplement[operator]) {
    return `${rightBase}${againstComplement[operator]}0`;
  }
  if (leftBase !== null && right === "-1" && againstComplement[operator]) {
    const reversed = {
      "<": ">", "<=": ">=", ">": "<", ">=": "<=",
      "===": "===", "!==": "!==",
    }[operator];
    return `${leftBase}${reversed}0`;
  }
  return `${left}${operator}${right}`;
}

function canonicalIntegerShift(left, right, operator) {
  if (/^-?\d+$/.test(right)) {
    return `(${left}${operator}${Number(right) & 31})`;
  }
  return `(${left}${operator}(${right}&31))`;
}

function canonicalIntegerArithmetic(left, right, operator) {
  const negated = (expression) => {
    const match = /^\(\(-(.+)\)\|0\)$/.exec(expression);
    return match ? match[1] : null;
  };
  const leftNegated = negated(left);
  const rightNegated = negated(right);
  if (operator === "+") {
    if (rightNegated !== null) return `((${left}-${rightNegated})|0)`;
    if (leftNegated !== null) return `((${right}-${leftNegated})|0)`;
  } else if (operator === "-" && rightNegated !== null) {
    return `((${left}+${rightNegated})|0)`;
  }
  return `((${left}${operator}${right})|0)`;
}

class FusedRegionCompiler {
  constructor(jit, options = {}) {
    this.jit = jit;
    this.jvm = jit.jvm;
    this.enabled = options.fusedRegions !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_FUSED_REGIONS === "1");
    // Fingerprint-selected translations are differential oracles and code-shape
    // targets, not a production compiler tier. Keep them opt-in so normal
    // execution proves the bytecode-derived kernels themselves are fast.
    this.handwrittenKernelsEnabled =
      (options.handwrittenFusedKernels === true ||
        Boolean(typeof process !== "undefined" && process.env &&
          process.env.JVM_ENABLE_HANDWRITTEN_FUSED === "1")) &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_HANDWRITTEN_FUSED === "1");
    // Compact handwritten raster translations are experimental until the
    // checked differential corpus proves every structurally accepted CFG.
    // The generated fused wrapper/raster kernels remain the default.
    this.semanticRasterKernelsEnabled = options.semanticFusedRasters === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_SEMANTIC_FUSED_RASTERS === "1");
    this.directCallsEnabled = options.directFusedCalls !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_DIRECT_FUSED_CALLS === "1");
    this.lexicalKernelsEnabled = options.lexicalFusedKernels !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_LEXICAL_FUSED_KERNELS === "1");
    this.cache = new WeakMap();
    // A missing child class is a normal first-invocation condition.  Negative
    // results are valid only for the current linkage epoch; loading another
    // class must make the candidate eligible for structural verification
    // again.
    this.rejected = new WeakMap();
    this.lastCompileFailure = null;
    this.directEntries = [];
    this.directEntryByMethod = new WeakMap();
    this.profileDirectCalls = Boolean(typeof process !== "undefined" &&
      process.env && process.env.JVM_PROFILE_FUSED_DIRECT_CALLS === "1");
    this.directAttemptCount = 0;
    this.directFallbackCounts = new Map();
  }

  recordDirectFallback(reason) {
    if (!this.profileDirectCalls) return;
    this.directFallbackCounts.set(
      reason, (this.directFallbackCounts.get(reason) || 0) + 1);
  }

  getCompileTimeDirectCall(instruction) {
    if (!this.enabled || !this.directCallsEnabled || getOp(instruction) !== "invokestatic" ||
        !validMemberRef(instruction && instruction.arg)) return null;
    const [, owner, [name, descriptor]] = instruction.arg;
    let parsed;
    try { parsed = parseDescriptor(descriptor); } catch (_) { return null; }
    if (parsed.returnType !== "void" || parsed.params.length > 16) return null;
    const classData = this.jvm.classes[owner];
    const method = classData && this.jvm.findMethod(classData, name, descriptor);
    // A caller commonly becomes hot before the wrapper owner itself has been
    // loaded. Retain an unresolved positional site in that case instead of
    // permanently baking generic dispatch into the caller. Runtime resolution
    // below still requires the exact loaded method identity, static flag, and
    // complete structural fusion proof before the first fused side effect.
    if (!method) {
      const entry = {
        id: this.directEntries.length,
        paramCount: parsed.params.length,
        unresolved: { owner, name, descriptor },
        target: null,
        region: null,
      };
      this.directEntries.push(entry);
      return { id: entry.id, paramCount: entry.paramCount, returnsVoid: true };
    }
    if (!(method.flags || []).includes("static") || !this.mayFuse(method)) return null;

    let entry = this.directEntryByMethod.get(method);
    if (!entry) {
      let region = this.cache.get(method);
      if (!region && this.jvm.classInitializationState.get(owner) === "INITIALIZED") {
        region = this.compile(method, owner);
        if (region) this.cache.set(method, region);
      }
      entry = {
        id: this.directEntries.length,
        paramCount: parsed.params.length,
        target: { method, lookupClass: owner },
        region,
      };
      this.directEntries.push(entry);
      this.directEntryByMethod.set(method, entry);
    }
    return { id: entry.id, paramCount: entry.paramCount, returnsVoid: true };
  }

  // Structured SSA callers already hold operands in scalar JavaScript values.
  // Accept them positionally so the normal fused path needs neither an operand
  // array nor a child Frame.  The structural verifier and all entry guards are
  // identical to tryInvoke; false always means "no fused side effect occurred".
  tryInvokeDirectAt(id, frame, thread,
    a0, a1, a2, a3, a4, a5, a6, a7,
    a8, a9, a10, a11, a12, a13, a14, a15) {
    if (this.profileDirectCalls) this.directAttemptCount += 1;
    if (!this.enabled || !this.directCallsEnabled) {
      this.recordDirectFallback("disabled");
      return false;
    }
    const entry = this.directEntries[id];
    if (!entry || entry.permanentlyRejected) {
      this.recordDirectFallback(!entry ? "missing-entry" : "permanently-rejected");
      return false;
    }
    let target = entry.target;
    if (!target) {
      const unresolved = entry.unresolved;
      const classData = unresolved && this.jvm.classes[unresolved.owner];
      if (!classData) {
        this.recordDirectFallback("owner-not-loaded");
        return false;
      }
      const method = this.jvm.findMethod(
        classData, unresolved.name, unresolved.descriptor);
      if (!method || !(method.flags || []).includes("static") ||
          !this.mayFuse(method)) {
        entry.permanentlyRejected = true;
        this.recordDirectFallback("shape-rejected");
        return false;
      }
      target = { method, lookupClass: unresolved.owner };
      entry.target = target;
      entry.unresolved = null;
      if (!this.directEntryByMethod.has(method)) {
        this.directEntryByMethod.set(method, entry);
      }
    }
    const { paramCount } = entry;
    let region = entry.region || this.cache.get(target.method);
    if (!region) {
      if (this.jvm.classInitializationState.get(target.lookupClass) !== "INITIALIZED") {
        this.recordDirectFallback("owner-not-initialized");
        return false;
      }
      const linkageEpoch = `${this.jvm.classEpoch || 0}:${this.jvm.classInitializationEpoch || 0}`;
      if (entry.rejectedEpoch === linkageEpoch) {
        this.recordDirectFallback("region-rejected-this-epoch");
        return false;
      }
      region = this.compile(target.method, target.lookupClass);
      if (!region) {
        entry.rejectedEpoch = linkageEpoch;
        this.recordDirectFallback("region-compile-failed");
        return false;
      }
      entry.region = region;
      entry.rejectedEpoch = null;
      this.cache.set(target.method, region);
    }
    if (!this.guard(region, target, frame, thread)) {
      this.jit.fusedGuardedFallbackCount += 1;
      this.recordDirectFallback("entry-guard");
      return false;
    }
    const state = region.executionState || (region.executionState = {
      method: null, pc: 0, locals: null, stack: null,
      outerPc: 0, outerExtra: undefined,
    });
    state.method = null;
    state.pc = 0;
    state.locals = null;
    state.stack = null;
    state.outerPc = 0;
    state.outerExtra = undefined;
    const exclusiveTiming = this.jit.exclusiveTimingsEnabled
      ? this.jit.beginExclusiveTiming(
        `${region.wrapperOwner}.${region.wrapperMethod.name}${region.wrapperMethod.descriptor}`,
        "fused-bytecode-region")
      : null;
    const wrapperKernel = region.handwrittenWrapperKernel &&
      this.handwrittenKernelsEnabled
      ? region.handwrittenWrapperKernel : region.wrapperKernel;
    try {
      wrapperKernel(state, region, this.jit,
        a0, a1, a2, a3, a4, a5, a6, a7,
        a8, a9, a10, a11, a12, a13, a14, a15);
      this.jit.fusedRunCount += 1;
      this.jit.fusedDirectRunCount += 1;
      return true;
    } catch (error) {
      if (error === BAILOUT) {
        this.jit.fusedGuardedFallbackCount += 1;
        this.recordDirectFallback("kernel-bailout");
        return false;
      }
      const arguments_ = [a0, a1, a2, a3, a4, a5, a6, a7,
        a8, a9, a10, a11, a12, a13, a14, a15];
      arguments_.length = paramCount;
      this.restoreExceptionFrames(region, state, thread, arguments_);
      throw error;
    } finally {
      if (exclusiveTiming) this.jit.endExclusiveTiming(exclusiveTiming);
    }
  }

  tryInvoke(site, target, frame, thread) {
    if (!this.enabled || site.op !== "invokestatic" || site.returnType !== "void" ||
        !target || !target.method) return { matched: false };

    let region = this.cache.get(target.method);
    if (region === undefined) {
      const linkageEpoch = `${this.jvm.classEpoch || 0}:${this.jvm.classInitializationEpoch || 0}`;
      if (this.rejected.get(target.method) === linkageEpoch) return { matched: false };
      region = this.compile(target.method, target.lookupClass) || null;
      // Callees are commonly loaded by the first baseline invocation. Cache
      // only a completed region so that class loading is a transient guard,
      // not a permanent rejection of an otherwise valid method family.
      if (region) this.cache.set(target.method, region);
      else {
        this.rejected.set(target.method, linkageEpoch);
        return { matched: false };
      }
    }
    if (!region || !this.guard(region, target, frame, thread)) {
      this.jit.fusedGuardedFallbackCount += 1;
      return { matched: true, handled: false };
    }

    const base = frame.stack.items.length - site.params.length;
    const state = region.executionState || (region.executionState = {
      method: null, pc: 0, locals: null, stack: null,
      outerPc: 0, outerExtra: undefined,
    });
    state.method = null;
    state.pc = 0;
    state.locals = null;
    state.stack = null;
    state.outerPc = 0;
    state.outerExtra = undefined;
    const exclusiveTiming = this.jit.exclusiveTimingsEnabled
      ? this.jit.beginExclusiveTiming(
        `${region.wrapperOwner}.${region.wrapperMethod.name}${region.wrapperMethod.descriptor}`,
        "fused-bytecode-region")
      : null;
    const wrapperKernel = region.handwrittenWrapperKernel &&
      this.handwrittenKernelsEnabled
      ? region.handwrittenWrapperKernel : region.wrapperKernel;
    const invokeWrapper = region.invokeWrapper || (region.invokeWrapper =
      createPositionalInvoker(site.params.length));
    try {
      invokeWrapper(wrapperKernel, frame.stack.items, base, state, region, this.jit);
      // All guards are above the kernel entry. Consume the caller arguments
      // only after success, avoiding a per-triangle slice on the normal path.
      frame.stack.items.length = base;
      this.jit.fusedRunCount += 1;
      return { matched: true, handled: true };
    } catch (error) {
      if (error === BAILOUT) {
        // The verifier only permits an early, side-effect-free unsupported
        // call. Caller operands have not been consumed yet.
        this.jit.fusedGuardedFallbackCount += 1;
        return { matched: true, handled: false };
      }
      const outerArguments = frame.stack.items.slice(base);
      frame.stack.items.length = base;
      this.restoreExceptionFrames(region, state, thread, outerArguments);
      throw error;
    } finally {
      if (exclusiveTiming) this.jit.endExclusiveTiming(exclusiveTiming);
    }
  }

  mayFuse(method) {
    if (!this.enabled || !method || !(method.flags || []).includes("static")) return false;
    let descriptor;
    try { descriptor = parseDescriptor(method.descriptor); } catch (_) { return false; }
    if (descriptor.returnType !== "void") return false;
    // Keep the cheap synchronous-call admission test consistent with full
    // region discovery. Obfuscated classes commonly retain unreachable call
    // sites after an unconditional return; counting those here while
    // discoverRegion() considers only verified reachable instructions can
    // reject a region that the structural compiler accepts.
    const verified = this.verifyMethod(method);
    if (!verified) return false;
    const calls = verified.calls;
    if (calls.length < 2) return false;
    const groups = repeatedCallGroups(calls);
    return groups.length === 1 && groups[0].calls.length === calls.length;
  }

  compile(wrapperMethod, wrapperOwner) {
    const discovered = this.discoverRegion(wrapperMethod);
    if (!discovered) return null;
    const { family, wrapper, rasterRef, rasterMethod, raster,
      scanlineRef, scanlineMethod, scanline } = discovered;

    const region = {
      family,
      wrapperOwner,
      wrapperMethod,
      wrapper,
      rasterOwner: rasterRef.owner,
      rasterMethod,
      raster,
      scanlineOwner: scanlineRef.owner,
      scanlineMethod,
      staticTargets: [],
      staticSiteIds: [],
      staticOwners: [],
      dependencies: [],
      nativeCalls: [],
      executionState: {
        method: null, pc: 0, locals: null, stack: null,
        outerPc: 0, outerExtra: undefined,
      },
    };
    for (const [owner, method] of [
      [wrapperOwner, wrapperMethod],
      [rasterRef.owner, rasterMethod],
      [scanlineRef.owner, scanlineMethod],
    ]) {
      const classData = this.jvm.classes[owner];
      const items = classData && classData.ast && classData.ast.classes[0] &&
        classData.ast.classes[0].items;
      const itemIndex = Array.isArray(items)
        ? items.findIndex((item) => item && item.type === "method" && item.method === method)
        : -1;
      const codeAttrIndex = method.attributes.findIndex((attr) => attr.type === "code");
      region.dependencies.push({
        owner, method, classData, items, itemIndex, codeAttrIndex,
        codeAttr: method.attributes[codeAttrIndex],
        codeItems: this.jit.getCodeItems(method),
      });
    }
    if (!this.prepareStatics(region, [...wrapper.staticRefs, ...raster.staticRefs,
      ...this.staticRefs(scanlineMethod)])) return null;
    region.initializedOwners = [...new Set([
      ...region.dependencies.map((dependency) => dependency.owner),
      ...region.staticOwners,
    ])];

    // Both raster implementations cache an obfuscator flag in their highest
    // local. The recognized scanline implementations have an equivalent
    // getstatic flag. A true value selects diagnostic behavior that is not a
    // raster hot path, so it is an entry guard rather than a mid-region deopt.
    region.falseGuardTargets = region.staticTargets.filter((target, index) => {
      const site = this.jit.fieldSites[region.staticSiteIds[index]];
      return site && site.descriptor === "Z";
    });
    region.falseGuardStaticIndices = new Set(region.staticTargets
      .map((target, index) => region.falseGuardTargets.includes(target)
        ? index : -1)
      .filter((index) => index >= 0));

    let compileStage = "scanline";
    try {
      region.scanlineKernel = this.compileKernel(scanlineMethod, scanline, region, "scanline");
      const semanticScanlinePlan = analyzeScanline(scanlineMethod, scanline);
      region.semanticScanlinePlan = semanticScanlinePlan;
      const semanticScanline = semanticScanlinePlan
        ? this.compileSemanticScanline(
          scanlineMethod, scanline, region, semanticScanlinePlan)
        : null;
      if (semanticScanline) {
        region.scanlineKernel = semanticScanline;
        this.jit.semanticFusedScanlineCount =
          (this.jit.semanticFusedScanlineCount | 0) + 1;
      }
      compileStage = "raster";
      region.rasterKernel = this.compileKernel(rasterMethod, raster, region, "raster");
      const gradientRasterPlan = analyzeGradientRaster(
        rasterMethod, raster, region, semanticScanlinePlan);
      const flatRasterPlan = gradientRasterPlan ? null : analyzeFlatRaster(
        rasterMethod, raster, region, semanticScanlinePlan);
      region.genericRasterSafetyPlan = gradientRasterPlan || flatRasterPlan;
      if (region.genericRasterSafetyPlan) {
        region.trustedRasterStaticIndices = [...new Set([
          region.genericRasterSafetyPlan.heightStatic,
          region.genericRasterSafetyPlan.widthStatic,
          region.genericRasterSafetyPlan.rowsStatic,
          region.genericRasterSafetyPlan.strideStatic,
        ])];
        region.trustedRasterKernel = this.compileLexicalKernel(
          rasterMethod, raster, region, "raster", {
            capturedStaticIndices: region.trustedRasterStaticIndices,
            failureRole: "trusted-raster",
            trustedScanlinePlan: semanticScanlinePlan,
          });
        if (flatRasterPlan) {
          const loweredFlatRaster = this.compileVerifiedFlatRaster(
            rasterMethod, region, flatRasterPlan);
          if (loweredFlatRaster) region.trustedRasterKernel = loweredFlatRaster;
        }
      }
      if (this.semanticRasterKernelsEnabled && gradientRasterPlan) {
        region.semanticGradientRasterPlan = gradientRasterPlan;
        region.rasterKernel = HandwrittenFusedGradient.installRaster(
          region, this.jit, gradientRasterPlan);
        region.directRasterKernel = region.rasterKernel.directKernel;
        this.jit.semanticFusedRasterCount =
          (this.jit.semanticFusedRasterCount | 0) + 1;
      } else if (this.semanticRasterKernelsEnabled && flatRasterPlan) {
          region.semanticFlatRasterPlan = flatRasterPlan;
          region.rasterKernel = HandwrittenFusedFlat.installRaster(
            region, this.jit, flatRasterPlan);
          region.directRasterKernel = region.rasterKernel.directKernel;
          this.jit.semanticFusedFlatRasterCount =
            (this.jit.semanticFusedFlatRasterCount | 0) + 1;
      }
      compileStage = "wrapper";
      region.wrapperKernel = this.compileKernel(wrapperMethod, wrapper, region, "wrapper");
      const semanticWrapper = this.compileSemanticWrapper(wrapperMethod, wrapper, region);
      if (semanticWrapper) {
        region.generatedWrapperKernel = region.wrapperKernel;
        region.wrapperKernel = semanticWrapper;
        this.jit.semanticFusedWrapperCount =
          (this.jit.semanticFusedWrapperCount | 0) + 1;
      } else if (region.genericRasterSafetyPlan &&
          region.trustedRasterKernel && !region.directRasterKernel) {
        const bridge = this.compileTrustedRasterBridge(
          rasterMethod, region, region.genericRasterSafetyPlan);
        if (bridge) {
          region.generatedRasterKernel = region.rasterKernel;
          region.rasterKernel = bridge;
        }
      }
      compileStage = "invoker";
      region.invokeWrapper = createPositionalInvoker(
        parseDescriptor(wrapperMethod.descriptor).params.length);
    } catch (error) {
      this.lastCompileFailure = {
        stage: compileStage,
        message: String(error && error.message || error),
      };
      return null;
    }
    this.lastCompileFailure = null;
    if (this.handwrittenKernelsEnabled && HandwrittenFusedGradient.matches(this.jit, region)) {
      // Kept separate from wrapperKernel so the probe can live-toggle
      // handwrittenKernelsEnabled per run for differential attribution.
      region.handwrittenWrapperKernel =
        HandwrittenFusedGradient.install(region, this.jit);
      this.jit.handwrittenFusedRegionCount =
        (this.jit.handwrittenFusedRegionCount | 0) + 1;
    }
    return region;
  }

  discoverRegion(wrapperMethod) {
    const wrapper = this.verifyMethod(wrapperMethod);
    if (!wrapper) return null;
    for (const wrapperGroup of repeatedCallGroups(wrapper.calls)) {
      if (wrapperGroup.calls.length < 2 || wrapper.calls.length !== wrapperGroup.calls.length) continue;
      const rasterRef = wrapperGroup.calls[0];
      const rasterMethod = this.resolveMethod(rasterRef);
      const raster = this.verifyMethod(rasterMethod);
      if (!raster) continue;
      for (const rasterGroup of repeatedCallGroups(raster.calls)) {
        if (rasterGroup.calls.length < 2) continue;
        const scanlineRef = rasterGroup.calls[0];
        const scanlineMethod = this.resolveMethod(scanlineRef);
        const scanline = this.verifyMethod(scanlineMethod);
        if (!scanline || !hasArrayStoreLoop(scanline)) continue;
        const family = {
          name: "bytecode-region",
          wrapper: wrapperMethod.descriptor,
          raster: rasterMethod.descriptor,
          scanline: scanlineMethod.descriptor,
          rasterKey: memberKey(rasterRef),
          scanlineKey: memberKey(scanlineRef),
        };
        if (!this.classifyCalls(wrapper, family.rasterKey, "wrapper") ||
            !this.classifyCalls(raster, family.scanlineKey, "raster") ||
            !this.classifyCalls(scanline, null, "scanline")) continue;
        return { family, wrapper, rasterRef, rasterMethod, raster,
          scanlineRef, scanlineMethod, scanline };
      }
    }
    return null;
  }

  classifyCalls(verified, childKey, role) {
    const childCalls = childKey
      ? verified.calls.filter((call) => memberKey(call) === childKey) : [];
    const effects = role === "scanline"
      ? [...verified.reachable].filter((index) =>
        getOp(verified.codeItems[index]?.instruction) === "iastore")
      : childCalls.map((call) => call.index);
    if (!effects.length) return false;
    const firstEffect = Math.min(...effects);
    for (const call of verified.calls) {
      if (childKey && memberKey(call) === childKey) {
        call.kind = "child";
        continue;
      }
      const instruction = verified.codeItems[call.index]?.instruction;
      const inline = this.jit.getCompileTimeIntegerLeaf(instruction);
      if (inline) {
        call.kind = "integer-inline";
        call.inline = inline;
        continue;
      }
      call.native = this.jvm._jreFindMethod(call.owner, call.name, call.descriptor);
      let parsed;
      try { parsed = parseDescriptor(call.descriptor); } catch (_) { return false; }
      if (typeof call.native === "function" && parsed.returnType === "int" &&
          parsed.params.every((type) => type === "int")) {
        call.kind = "integer-native";
        continue;
      }
      call.kind = "early-bailout";
      if (!(call.index < firstEffect)) return false;
    }
    return true;
  }

  verifyMethod(method) {
    if (!method) return null;
    const codeAttr = method.attributes && method.attributes.find((attr) => attr.type === "code");
    if (!codeAttr || !codeAttr.code) return null;
    const codeItems = this.jit.getCodeItems(method);
    const labels = buildLabelMap(codeItems);
    const depths = computeStackDepths(codeItems, labels);
    if (!depths) return null;
    const reachable = normalReachable(codeItems, labels);
    const allowed = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "astore", "astore_0", "astore_1", "astore_2", "astore_3",
      "bipush", "sipush", "checkcast", "dup", "getstatic", "goto", "goto_w",
      "iadd", "iand", "iaload", "iastore", "iconst_m1", "iconst_0", "iconst_1",
      "iconst_2", "iconst_3", "iconst_4", "iconst_5", "idiv", "irem",
      "if_icmpeq", "if_icmpge", "if_icmpgt", "if_icmple", "if_icmplt",
      "if_icmpne", "ifeq", "ifge", "ifgt", "ifle", "iflt", "ifne",
      "iinc", "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "imul", "ineg", "invokestatic", "ior", "ishl", "ishr", "iushr", "istore",
      "istore_0", "istore_1", "istore_2", "istore_3", "isub", "ixor",
      "ldc", "ldc_w", "nop", "pop", "putstatic", "return",
    ]);
    for (const index of reachable) {
      const op = getOp(codeItems[index] && codeItems[index].instruction);
      if (op && !allowed.has(op)) return null;
    }

    const calls = [];
    const staticRefs = [];
    for (const index of reachable) {
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      if (op === "getstatic" || op === "putstatic") staticRefs.push(instruction.arg);
      if (op !== "invokestatic" || !validMemberRef(instruction.arg)) continue;
      calls.push({
        index,
        owner: instruction.arg[1],
        name: instruction.arg[2][0],
        descriptor: instruction.arg[2][1],
      });
    }
    // Fused exceptions resume in the interpreter, so handler bodies need not
    // be compiled. Their metadata must nevertheless be internally resolvable.
    for (const entry of codeAttr.code.exceptionTable || []) {
      const handler = labels.get(entry.handlerLbl || `L${entry.handler_pc}`);
      if (handler === undefined || entry.catch_type !== "java/lang/RuntimeException") return null;
    }
    return { codeItems, codeItemsRef: codeAttr.code.codeItems, labels, depths,
      reachable, calls, staticRefs, localsSize: Number(codeAttr.code.localsSize) || 0 };
  }

  staticRefs(method) {
    return this.jit.getCodeItems(method).map((item) => item && item.instruction)
      .filter((instruction) => {
        const op = getOp(instruction);
        return op === "getstatic" || op === "putstatic";
      }).map((instruction) => instruction.arg);
  }

  prepareStatics(region, refs) {
    const seen = new Map();
    for (const arg of refs) {
      const key = JSON.stringify(arg);
      if (seen.has(key)) continue;
      const id = this.jit.registerFieldSite(arg);
      let value;
      try {
        value = this.jit.getStaticSyncAt(id);
      } catch (_) {
        return false;
      }
      if (value === this.jit.staticDeopt()) return false;
      const target = this.jit.fieldSites[id].staticTarget;
      if (!target) return false;
      seen.set(key, region.staticTargets.length);
      region.staticTargets.push(target);
      region.staticSiteIds.push(id);
      region.staticOwners.push(this.jit.fieldSites[id].className);
    }
    region.staticIndex = seen;
    return true;
  }

  resolveMethod(ref) {
    const classData = this.jvm.classes[ref.owner];
    return classData && this.jvm.findMethod(classData, ref.name, ref.descriptor);
  }

  guard(region, target, frame, thread) {
    if (target.method !== region.wrapperMethod || target.lookupClass !== region.wrapperOwner) return false;
    // Mode/feature statics are live heap values, not compile-time constants.
    // Check them before the more expensive scheduler, debugger, class, and
    // bytecode-identity guards. A disabled rendering mode can reject millions
    // of otherwise valid direct-call probes without any fused side effect.
    for (const target of region.falseGuardTargets) {
      if (readStatic(target)) return false;
    }
    if (!thread || thread.status !== "runnable" || !thread.callStack ||
        thread.callStack.isEmpty() || thread.callStack.peek() !== frame) return false;
    const debug = this.jvm.debugManager;
    if (!debug || debug.debugMode || debug.breakpoints.size > 0 ||
        debug.hasLocatedBreakpoints && debug.hasLocatedBreakpoints()) return false;
    if (typeof process !== "undefined" && process.env &&
        (process.env.JVM_TRACE || process.env.JVM_PROFILE_HOT_METHODS === "1" ||
         process.env.JVM_PROFILE_HOT_METHODS_WITH_JIT === "1")) return false;
    // The remaining checks prove linkage facts that can change only when a
    // class is loaded/replaced or finishes initialization. Raster-heavy
    // callers can enter the same region thousands of times per frame, so
    // repeating every class-map lookup and bytecode-identity walk at each
    // triangle is disproportionately expensive. Keep all live entry guards
    // above this point, and reuse only a successful linkage proof while both
    // lifecycle epochs remain unchanged.
    const classEpoch = this.jvm.classEpoch || 0;
    const initializationEpoch = this.jvm.classInitializationEpoch || 0;
    if (region.guardClassEpoch === classEpoch &&
        region.guardInitializationEpoch === initializationEpoch) return true;
    for (const owner of region.initializedOwners || [
      ...region.dependencies.map((dependency) => dependency.owner),
      ...region.staticOwners,
    ]) {
      if (this.jvm.classInitializationState.get(owner) !== "INITIALIZED") return false;
    }
    for (const dependency of region.dependencies) {
      const classData = this.jvm.classes[dependency.owner];
      if (!classData) return false;
      if (dependency.classData) {
        if (classData !== dependency.classData ||
            classData.ast.classes[0].items !== dependency.items ||
            dependency.itemIndex < 0 ||
            dependency.items[dependency.itemIndex]?.method !== dependency.method ||
            dependency.method.attributes[dependency.codeAttrIndex] !== dependency.codeAttr ||
            dependency.codeAttr.code.codeItems !== dependency.codeItems) return false;
      } else {
        if (this.jvm.findMethod(classData, dependency.method.name,
            dependency.method.descriptor) !== dependency.method) return false;
        const codeAttr = dependency.method.attributes.find((attr) => attr.type === "code");
        if (!codeAttr || codeAttr.code.codeItems !== dependency.codeItems) return false;
      }
    }
    region.guardClassEpoch = classEpoch;
    region.guardInitializationEpoch = initializationEpoch;
    return true;
  }

  restoreExceptionFrames(region, state, thread, outerArguments = []) {
    const push = (snapshot, method, owner) => {
      if (!snapshot) return;
      const Frame = require("../core/frame");
      const restored = new Frame(method);
      restored.className = owner;
      restored.pc = snapshot.pc;
      restored.locals = snapshot.locals;
      restored.stack.items = snapshot.stack || [];
      thread.callStack.push(restored);
      this.jit.fusedRestoredExceptionFrameCount += 1;
    };
    if (state.method === "raster") {
      const codeAttr = region.wrapperMethod.attributes.find((attr) => attr.type === "code");
      const localsSize = region.wrapper ? region.wrapper.localsSize :
        Number(codeAttr && codeAttr.code.localsSize) || 0;
      const outerLocals = new Array(localsSize).fill(undefined);
      let local = 0;
      const params = parseDescriptor(region.wrapperMethod.descriptor).params;
      for (let index = 0; index < params.length; index += 1) {
        outerLocals[local] = outerArguments[index];
        local += params[index] === "long" || params[index] === "double" ? 2 : 1;
      }
      if (localsSize > local) {
        outerLocals[localsSize - 1] = state.outerExtra;
      }
      push({ pc: state.outerPc, locals: outerLocals, stack: [] },
        region.wrapperMethod, region.wrapperOwner);
      push(state, region.rasterMethod, region.rasterOwner);
    } else if (state.method === "wrapper") {
      push(state, region.wrapperMethod, region.wrapperOwner);
    }
  }

  // Render the verified bytecode CFG as lexical JavaScript. Values crossing a
  // block edge are assigned to fixed join slots; Java operand-stack state is
  // otherwise absent. This is the generic counterpart of the structured
  // handwritten target and is selected solely from the verified CFG.
  compileLexicalKernel(method, verified, region, role, options = {}) {
    const failureRole = options.failureRole || role;
    const reject = (stage, error) => {
      if (!region.lexicalKernelFailures) region.lexicalKernelFailures = {};
      region.lexicalKernelFailures[failureRole] = {
        stage, message: String(error && error.message || error),
      };
      return null;
    };
    let cfg;
    let structured;
    try {
      cfg = buildCfgFromCode(verified.codeItems);
      if (!cfg || cfg.term.some((term) => term.kind === "switch")) return null;
      structured = structure(cfg);
    } catch (error) {
      return reject("structure", error);
    }
    const { codeItems, depths } = verified;
    const descriptor = parseDescriptor(method.descriptor);
    const callByIndex = new Map(verified.calls.map((call) => [call.index, call]));
    const params = descriptor.params;
    const capturedStaticNames = (options.capturedStaticIndices || [])
      .map((_index, capture) => `c${capture}`);
    const capturedStaticByIndex = new Map(
      (options.capturedStaticIndices || []).map((index, capture) =>
        [index, capturedStaticNames[capture]]));
    const localTypes = [];
    let parameterLocal = 0;
    for (const type of params) {
      localTypes[parameterLocal] = type;
      parameterLocal += type === "long" || type === "double" ? 2 : 1;
    }
    const argNames = params.map((_, index) => `a${index}`);
    const reachableBlocks = new Set(structured.rpo);
    const declarations = [];
    const writtenStatics = new Set([...verified.reachable]
      .map((index) => codeItems[index] && codeItems[index].instruction)
      .filter((instruction) => getOp(instruction) === "putstatic")
      .map((instruction) => JSON.stringify(instruction.arg)));
    const hoistedStatics = new Map();
    for (const index of verified.reachable) {
      const instruction = codeItems[index] && codeItems[index].instruction;
      if (getOp(instruction) !== "getstatic") continue;
      const key = JSON.stringify(instruction.arg);
      const staticIndex = region.staticIndex.get(key);
      if (staticIndex === undefined || writtenStatics.has(key) ||
          !this.jit.canEliminateFieldRead(instruction.arg) ||
          hoistedStatics.has(staticIndex)) continue;
      const name = `s${staticIndex}`;
      hoistedStatics.set(staticIndex, name);
      if (region.falseGuardStaticIndices?.has(staticIndex)) {
        declarations.push(`const ${name}=0;`);
      } else if (capturedStaticByIndex.has(staticIndex)) {
        declarations.push(`const ${name}=${capturedStaticByIndex.get(staticIndex)};`);
      } else {
        declarations.push(
          `const ${name}=region.staticTargets[${staticIndex}].kind==="map"?` +
          `region.staticTargets[${staticIndex}].fields.get(` +
          `region.staticTargets[${staticIndex}].key):` +
          `region.staticTargets[${staticIndex}].fields[` +
          `region.staticTargets[${staticIndex}].key];`);
      }
    }
    let argIndex = 0;
    for (let index = 0; index < verified.localsSize; index += 1) {
      if (localTypes[index]) {
        const parameter = argIndex++;
        const input = options.constantArguments?.has(parameter)
          ? options.constantArguments.get(parameter)
          : argNames[parameter];
        declarations.push(`let l${index}=${isIntType(localTypes[index])
          ? `${input}|0` : input};`);
      } else {
        declarations.push(`let l${index};`);
      }
    }
    for (const block of cfg.blocks) {
      if (!reachableBlocks.has(block.id)) continue;
      const depth = depths[block.insns[0]] || 0;
      for (let slot = 0; slot < depth; slot += 1) {
        declarations.push(`let j${block.id}_${slot};`);
      }
    }

    let temporary = 0;
    let trustedScanlineInlineCount = 0;
    const temp = () => `v${temporary++}`;
    const localsSnapshot = () =>
      `[${Array.from({ length: verified.localsSize }, (_unused, index) =>
        `l${index}`).join(",")}]`;
    const captureThrow = (pc, operands, exception) =>
      `{state.method=${JSON.stringify(role)};state.pc=${pc};` +
      `state.locals=${localsSnapshot()};state.stack=[${operands.join(",")}];` +
      `throw ${exception};}`;
    const plans = [];
    let planningIndex = -1;
    let planningOp = null;
    let planningBlock = null;

    try {
      for (const block of cfg.blocks) {
        if (!reachableBlocks.has(block.id)) continue;
        planningBlock = block;
        const lines = [];
        const expressions = Array.from(
          { length: depths[block.insns[0]] || 0 },
          (_unused, slot) => `j${block.id}_${slot}`);
        const pop = () => expressions.pop();
        const binary = (format) => {
          const right = pop();
          const left = pop();
          if (left === undefined || right === undefined) {
            throw new Error("stack underflow");
          }
          expressions.push(format(left, right));
        };
        let condition = null;
        let returned = false;
        for (const index of block.insns) {
          const instruction = codeItems[index] && codeItems[index].instruction;
          const op = getOp(instruction);
          planningIndex = index;
          planningOp = op;
          if (!op || op === "nop") continue;
          if (/^[ai]load(?:_[0-3])?$/.test(op)) {
            const output = temp();
            lines.push(`const ${output}=l${localIndex(instruction, op)};`);
            expressions.push(output);
          } else if (/^[ai]store(?:_[0-3])?$/.test(op)) {
            const input = pop();
            if (input === undefined) throw new Error("stack underflow");
            lines.push(`l${localIndex(instruction, op)}=${input};`);
          } else if (op === "aconst_null") {
            expressions.push("null");
          } else if (/^iconst_(?:m1|[0-5])$/.test(op) || op === "bipush" ||
                     op === "sipush" || op === "ldc" || op === "ldc_w") {
            const constant = constantValue(instruction, op);
            if (constant === null) throw new Error("non-numeric constant");
            expressions.push(constant);
          } else if (op === "checkcast") {
            // Structurally accepted casts are null diagnostic operands.
          } else if (op === "dup") {
            const input = pop();
            if (input === undefined) throw new Error("stack underflow");
            const output = temp();
            lines.push(`const ${output}=${input};`);
            expressions.push(output, output);
          } else if (op === "pop") {
            if (pop() === undefined) throw new Error("stack underflow");
          } else if (op === "iadd") {
            binary((a, b) => canonicalIntegerArithmetic(a, b, "+"));
          } else if (op === "isub") {
            binary((a, b) => canonicalIntegerArithmetic(a, b, "-"));
          }
          else if (op === "imul") binary((a, b) => `Math.imul(${a},${b})`);
          else if (op === "iand") binary((a, b) => `(${a}&${b})`);
          else if (op === "ior") binary((a, b) => `(${a}|${b})`);
          else if (op === "ixor") binary((a, b) => `(${a}^${b})`);
          else if (op === "ishl") {
            binary((a, b) => canonicalIntegerShift(a, b, "<<"));
          } else if (op === "ishr") {
            binary((a, b) => canonicalIntegerShift(a, b, ">>"));
          } else if (op === "iushr") {
            binary((a, b) => canonicalIntegerShift(a, b, ">>>"));
          }
          else if (op === "ineg") {
            const input = pop();
            if (input === undefined) throw new Error("stack underflow");
            expressions.push(`((-${input})|0)`);
          } else if (op === "idiv" || op === "irem") {
            const divisorExpression = pop();
            const dividend = pop();
            if (dividend === undefined || divisorExpression === undefined) {
              throw new Error("stack underflow");
            }
            const divisor = temp();
            lines.push(`const ${divisor}=${divisorExpression};`);
            lines.push(`if(${divisor}===0)${captureThrow(index,
              [dividend, divisor],
              '{type:"java/lang/ArithmeticException",message:"/ by zero"}')}`);
            expressions.push(op === "idiv"
              ? `((${dividend}/${divisor})|0)`
              : `((${dividend}%${divisor})|0)`);
          } else if (op === "iinc") {
            const variable = Number(instruction.varnum ?? instruction.arg);
            const increment = Number(instruction.incr ?? 0);
            lines.push(`l${variable}=(l${variable}+${increment})|0;`);
          } else if (op === "getstatic") {
            const staticIndex =
              region.staticIndex.get(JSON.stringify(instruction.arg));
            if (staticIndex === undefined) throw new Error("unresolved static");
            expressions.push(hoistedStatics.get(staticIndex) ||
              `(region.staticTargets[${staticIndex}].kind==="map"?` +
              `region.staticTargets[${staticIndex}].fields.get(` +
              `region.staticTargets[${staticIndex}].key):` +
              `region.staticTargets[${staticIndex}].fields[` +
              `region.staticTargets[${staticIndex}].key])`);
          } else if (op === "putstatic") {
            const input = pop();
            const staticIndex =
              region.staticIndex.get(JSON.stringify(instruction.arg));
            if (input === undefined || staticIndex === undefined) {
              throw new Error("unresolved static store");
            }
            lines.push(
              `if(region.staticTargets[${staticIndex}].kind==="map")` +
              `region.staticTargets[${staticIndex}].fields.set(` +
              `region.staticTargets[${staticIndex}].key,${input});else ` +
              `region.staticTargets[${staticIndex}].fields[` +
              `region.staticTargets[${staticIndex}].key]=${input};`);
          } else if (op === "iaload") {
            const arrayIndex = pop();
            const array = pop();
            if (array === undefined || arrayIndex === undefined) {
              throw new Error("stack underflow");
            }
            const output = temp();
            lines.push(`if(${array}==null)${captureThrow(index,
              [array, arrayIndex],
              '{type:"java/lang/NullPointerException",message:null}')}`);
            lines.push(`if((${arrayIndex}|0)<0||(${arrayIndex}|0)>=${array}.length)` +
              captureThrow(index, [array, arrayIndex],
                '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}'));
            lines.push(`const ${output}=${array}[${arrayIndex}|0];`);
            expressions.push(output);
          } else if (op === "iastore") {
            const input = pop();
            const arrayIndex = pop();
            const array = pop();
            if (array === undefined || arrayIndex === undefined || input === undefined) {
              throw new Error("stack underflow");
            }
            lines.push(`if(${array}==null)${captureThrow(index,
              [array, arrayIndex, input],
              '{type:"java/lang/NullPointerException",message:null}')}`);
            lines.push(`if((${arrayIndex}|0)<0||(${arrayIndex}|0)>=${array}.length)` +
              captureThrow(index, [array, arrayIndex, input],
                '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}'));
            lines.push(`${array}[${arrayIndex}|0]=${input}|0;`);
          } else if (op === "invokestatic") {
            const parsed = parseDescriptor(instruction.arg[2][1]);
            const args = expressions.splice(
              expressions.length - parsed.params.length);
            const call = callByIndex.get(index);
            if (role === "wrapper" &&
                memberKey(call) === region.family.rasterKey) {
              lines.push(`state.outerPc=${index + 1};` +
                `state.outerExtra=l${verified.localsSize - 1};`);
              lines.push(`region.rasterKernel(state,region,helpers,` +
                `${args.join(",")});`);
            } else if (role === "raster" &&
                memberKey(call) === region.family.scanlineKey) {
              if (options.trustedScanlinePlan) {
                const trustedLines = emitTrustedScanline(
                  options.trustedScanlinePlan, args, temp);
                if (!trustedLines) {
                  throw new Error("trusted scanline arguments do not preserve the verified tag");
                }
                lines.push(...trustedLines);
                trustedScanlineInlineCount += 1;
              } else {
                lines.push(`region.scanlineKernel(state,region,helpers,` +
                  `${args.join(",")});`);
              }
            } else if (call && call.kind === "integer-inline") {
              const output = temp();
              const substitute = (source) => source.replace(
                /stack\[base \+ (\d+)\]/g,
                (_match, argument) => `(${args[Number(argument)]})`);
              lines.push(`let ${output};`, "{",
                ...call.inline.statements.map((statement) =>
                  substitute(statement)),
                `${output}=${substitute(call.inline.result)};`, "}");
              expressions.push(`(${output}|0)`);
            } else if (call && call.kind === "integer-native") {
              const nativeIndex = region.nativeCalls.length;
              region.nativeCalls.push(call.native);
              const output = temp();
              const thrown = temp();
              lines.push(`let ${output};try{${output}=` +
                `helpers.invokeFusedIntegerNative(` +
                `region.nativeCalls[${nativeIndex}],${args[0]},${args[1]});}` +
                `catch(${thrown})${captureThrow(index, args, thrown)}`);
              expressions.push(`(${output}|0)`);
            } else {
              lines.push("throw helpers.fusedBailout();");
              // Keep verifier stack shape available while planning the
              // syntactically following instructions. Runtime cannot reach
              // the placeholder because the bailout above always throws.
              if (parsed.returnType !== "void") expressions.push("undefined");
            }
            if (parsed.returnType !== "void" &&
                !(call && (call.kind === "integer-native" ||
                  call.kind === "integer-inline" ||
                  call.kind === "early-bailout"))) {
              throw new Error("unsupported call result");
            }
          } else if (op === "goto" || op === "goto_w") {
            // The structured tree renders this edge.
          } else if (op && op.startsWith("if")) {
            if (op.startsWith("if_icmp")) {
              const right = pop();
              const left = pop();
              const compare = {
                if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<",
                if_icmpge: ">=", if_icmpgt: ">", if_icmple: "<=",
              }[op];
              if (left === undefined || right === undefined || !compare) {
                throw new Error("invalid conditional stack");
              }
              condition = canonicalIntegerComparison(left, compare, right);
            } else {
              const input = pop();
              const compare = {
                ifeq: "===0", ifne: "!==0", iflt: "<0",
                ifge: ">=0", ifgt: ">0", ifle: "<=0",
              }[op];
              if (input === undefined || !compare) {
                throw new Error("invalid conditional stack");
              }
              condition = `${input}${compare}`;
            }
          } else if (op === "return") {
            lines.push("return;");
            returned = true;
          } else {
            throw new Error(`unsupported lexical fused opcode ${op}`);
          }
        }
        plans[block.id] = { lines, stack: expressions, condition, returned };
      }
    } catch (error) {
      return reject("plan", new Error(
        `${error && error.message || error} at ${planningIndex} ${planningOp} ` +
        `block=${planningBlock && planningBlock.id} ` +
        `first=${planningBlock && planningBlock.insns[0]} ` +
        `depth=${planningBlock && depths[planningBlock.insns[0]]} ` +
        `normal=${Boolean(planningBlock &&
          verified.reachable.has(planningBlock.insns[0]))} ops=${planningBlock &&
          planningBlock.insns.map((index) =>
            getOp(codeItems[index] && codeItems[index].instruction)).join(",")}`));
    }

    const edgeLines = (target, expressions) => {
      const depth = depths[cfg.blocks[target].insns[0]] || 0;
      if (expressions.length !== depth) {
        throw new Error("lexical fused stack-depth mismatch");
      }
      return expressions.map((expression, slot) =>
        `j${target}_${slot}=${expression};`);
    };
    const indent = (lines) => lines.map((line) => `  ${line}`);
    const render = (node) => {
      if (!node) return [];
      if (node.t === "seq") return node.body.flatMap(render);
      if (node.t === "straight") {
        const plan = plans[node.block];
        const term = cfg.term[node.block];
        const lines = [...plan.lines];
        if (!plan.returned &&
            (term.kind === "goto" || term.kind === "fall")) {
          lines.push(...edgeLines(term.target, plan.stack));
        }
        return lines;
      }
      if (node.t === "if") {
        const plan = plans[node.block];
        const term = cfg.term[node.block];
        if (!plan.condition || term.kind !== "cond") {
          throw new Error("missing lexical fused condition");
        }
        return [`if(${plan.condition}){`,
          ...indent([...edgeLines(term.taken, plan.stack),
            ...render(node.then)]),
          "}else{",
          ...indent([...edgeLines(term.fall, plan.stack),
            ...render(node.els)]),
          "}"];
      }
      if (node.t === "loop") {
        return [`${node.label}:while(true){`,
          ...indent(render(node.body)), "}"];
      }
      if (node.t === "block") {
        return [`${node.label}:{`, ...indent(render(node.body)), "}"];
      }
      if (node.t === "break") return [`break ${node.label};`];
      if (node.t === "continue") return [`continue ${node.label};`];
      throw new Error(`unsupported lexical fused node ${node.t}`);
    };

    try {
      const body = ["\"use strict\";", ...declarations,
        ...render(structured.tree)];
      const owner = role === "wrapper" ? region.wrapperOwner
        : role === "raster" ? region.rasterOwner : region.scanlineOwner;
      const generated = this.jit.createGeneratedFunction(method,
        `fused-${region.family.name}-lexical-${failureRole}`,
        ["state", "region", "helpers", ...argNames, ...capturedStaticNames],
        body.join("\n"), owner);
      generated.jvmLexicalFusedKernel = true;
      generated.jvmTrustedFusedRaster = Boolean(options.trustedScanlinePlan);
      generated.jvmTrustedScanlineInlineCount = trustedScanlineInlineCount;
      generated.jvmGuardedFalseStaticCount =
        region.falseGuardStaticIndices?.size || 0;
      generated.jvmCapturedStaticCount = capturedStaticNames.length;
      generated.jvmConstantArgumentCount = options.constantArguments?.size || 0;
      generated.jvmLexicalFusedSource = body.join("\n");
      this.jit.lexicalFusedKernelCount =
        (this.jit.lexicalFusedKernelCount | 0) + 1;
      return generated;
    } catch (error) {
      return reject("render", error);
    }
  }

  compileKernel(method, verified, region, role) {
    const lexical = this.lexicalKernelsEnabled
      ? this.compileLexicalKernel(method, verified, region, role) : null;
    if (lexical) return lexical;
    const { codeItems, labels, depths, reachable } = verified;
    const descriptor = parseDescriptor(method.descriptor);
    const callByIndex = new Map(verified.calls.map((call) => [call.index, call]));
    const leaders = new Set([0]);
    const terminal = new Set(["return"]);
    for (const index of reachable) {
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      if (op === "goto" || op === "goto_w" || op && op.startsWith("if")) {
        leaders.add(branchTarget(instruction, labels));
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      }
      if (op === "invokestatic") {
        leaders.add(index);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      }
      if (terminal.has(op) && index + 1 < codeItems.length) leaders.add(index + 1);
    }
    const ordered = [...leaders].filter((index) => reachable.has(index)).sort((a, b) => a - b);
    const next = new Map(ordered.map((leader, position) =>
      [leader, ordered[position + 1] === undefined ? codeItems.length : ordered[position + 1]]));
    const maxDepth = Math.max(0, ...depths.filter((value) => value !== undefined));
    const params = descriptor.params;
    const localTypes = [];
    let parameterLocal = 0;
    for (const type of params) {
      localTypes[parameterLocal] = type;
      parameterLocal += type === "long" || type === "double" ? 2 : 1;
    }
    const argNames = params.map((_, index) => `a${index}`);
    const body = ["\"use strict\";"];
    let argIndex = 0;
    for (let index = 0; index < verified.localsSize; index += 1) {
      if (localTypes[index]) {
        const value = argNames[argIndex++];
        body.push(`let l${index} = ${isIntType(localTypes[index]) ? `${value} | 0` : value};`);
      } else {
        body.push(`let l${index};`);
      }
    }
    for (let index = 0; index < maxDepth; index += 1) body.push(`let s${index};`);
    body.push("let pc = 0;", "while (true) {", "switch (pc) {");
    let temporary = 0;
    const temp = () => `v${temporary++}`;
    const save = (expressions) => expressions.map((value, index) => `s${index} = ${value};`);
    const transfer = (expressions, target) => [...save(expressions), `pc = ${target}; continue;`];
    const localsSnapshot = () => `[${Array.from({ length: verified.localsSize }, (_, i) => `l${i}`).join(",")}]`;
    const captureThrow = (pc, operands, exception) =>
      `{ state.method=${JSON.stringify(role)}; state.pc=${pc}; state.locals=${localsSnapshot()}; state.stack=[${operands.join(",")}]; throw ${exception}; }`;

    for (const leader of ordered) {
      body.push(`case ${leader}: {`);
      const expressions = Array.from({ length: depths[leader] || 0 }, (_, index) => `s${index}`);
      let terminated = false;
      for (let index = leader; index < next.get(leader); index += 1) {
        if (!reachable.has(index)) break;
        const instruction = codeItems[index] && codeItems[index].instruction;
        const op = getOp(instruction);
        if (!op || op === "nop") continue;
        const pop = () => expressions.pop();
        const binary = (format) => {
          const right = pop(); const left = pop();
          if (left === undefined || right === undefined) throw new Error("stack underflow");
          expressions.push(format(left, right));
        };
        if (/^[ai]load(?:_[0-3])?$/.test(op)) {
          const value = temp();
          body.push(`const ${value}=l${localIndex(instruction, op)};`);
          expressions.push(value);
        } else if (/^[ai]store(?:_[0-3])?$/.test(op)) {
          const value = pop(); if (value === undefined) throw new Error("stack underflow");
          body.push(`l${localIndex(instruction, op)} = ${value};`);
        } else if (op === "aconst_null") {
          expressions.push("null");
        } else if (/^iconst_(?:m1|[0-5])$/.test(op) || op === "bipush" ||
                   op === "sipush" || op === "ldc" || op === "ldc_w") {
          const value = constantValue(instruction, op);
          if (value === null) throw new Error("non-numeric constant");
          expressions.push(value);
        } else if (op === "checkcast") {
          // Every recognized checkcast is an obfuscator's null diagnostic
          // value. Java null is cast-compatible with every reference type.
        } else if (op === "dup") {
          const value = pop(); const name = temp();
          body.push(`const ${name} = ${value};`); expressions.push(name, name);
        } else if (op === "pop") {
          if (pop() === undefined) throw new Error("stack underflow");
        } else if (op === "iadd") binary((a, b) => `((${a}+${b})|0)`);
        else if (op === "isub") binary((a, b) => `((${a}-${b})|0)`);
        else if (op === "imul") binary((a, b) => `Math.imul(${a},${b})`);
        else if (op === "iand") binary((a, b) => `(${a}&${b})`);
        else if (op === "ior") binary((a, b) => `(${a}|${b})`);
        else if (op === "ixor") binary((a, b) => `(${a}^${b})`);
        else if (op === "ishl") binary((a, b) => `(${a}<<(${b}&31))`);
        else if (op === "ishr") binary((a, b) => `(${a}>>(${b}&31))`);
        else if (op === "iushr") binary((a, b) => `(${a}>>>(${b}&31))`);
        else if (op === "ineg") {
          const value = pop(); expressions.push(`((-${value})|0)`);
        } else if (op === "idiv") {
          const divisorExpression = pop(); const dividend = pop(); const divisor = temp();
          body.push(`const ${divisor}=${divisorExpression};`);
          body.push(`if (${divisor}===0) ${captureThrow(index, [dividend, divisor],
            '{type:"java/lang/ArithmeticException",message:"/ by zero"}')}`);
          expressions.push(`((${dividend}/${divisor})|0)`);
        } else if (op === "irem") {
          const divisorExpression = pop(); const dividend = pop(); const divisor = temp();
          body.push(`const ${divisor}=${divisorExpression};`);
          body.push(`if (${divisor}===0) ${captureThrow(index, [dividend, divisor],
            '{type:"java/lang/ArithmeticException",message:"/ by zero"}')}`);
          expressions.push(`((${dividend}%${divisor})|0)`);
        } else if (op === "iinc") {
          const variable = Number(instruction.varnum ?? instruction.arg);
          const increment = Number(instruction.incr ?? 0);
          body.push(`l${variable}=(l${variable}+${increment})|0;`);
        } else if (op === "getstatic") {
          const staticIndex = region.staticIndex.get(JSON.stringify(instruction.arg));
          if (staticIndex === undefined) throw new Error("unresolved static");
          expressions.push(`(region.staticTargets[${staticIndex}].kind==="map"?region.staticTargets[${staticIndex}].fields.get(region.staticTargets[${staticIndex}].key):region.staticTargets[${staticIndex}].fields[region.staticTargets[${staticIndex}].key])`);
        } else if (op === "putstatic") {
          const value = pop();
          const staticIndex = region.staticIndex.get(JSON.stringify(instruction.arg));
          if (staticIndex === undefined) throw new Error("unresolved static");
          body.push(`if(region.staticTargets[${staticIndex}].kind==="map")region.staticTargets[${staticIndex}].fields.set(region.staticTargets[${staticIndex}].key,${value});else region.staticTargets[${staticIndex}].fields[region.staticTargets[${staticIndex}].key]=${value};`);
        } else if (op === "iaload") {
          const arrayIndex = pop(); const array = pop(); const value = temp();
          body.push(`if(${array}==null) ${captureThrow(index, [array, arrayIndex],
            '{type:"java/lang/NullPointerException",message:null}')}`);
          body.push(`if((${arrayIndex}|0)<0||(${arrayIndex}|0)>=${array}.length) ${captureThrow(index,
            [array, arrayIndex], '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}')}`);
          body.push(`const ${value}=${array}[${arrayIndex}|0];`); expressions.push(value);
        } else if (op === "iastore") {
          const value = pop(); const arrayIndex = pop(); const array = pop();
          body.push(`if(${array}==null) ${captureThrow(index, [array, arrayIndex, value],
            '{type:"java/lang/NullPointerException",message:null}')}`);
          body.push(`if((${arrayIndex}|0)<0||(${arrayIndex}|0)>=${array}.length) ${captureThrow(index,
            [array, arrayIndex, value], '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}')}`);
          body.push(`${array}[${arrayIndex}|0]=${value}|0;`);
        } else if (op === "invokestatic") {
          const parsed = parseDescriptor(instruction.arg[2][1]);
          const args = expressions.splice(expressions.length - parsed.params.length);
          const callDescriptor = instruction.arg[2][1];
          const call = callByIndex.get(index);
          if (role === "wrapper" && memberKey(call) === region.family.rasterKey) {
            body.push(`state.outerPc=${index + 1};state.outerExtra=l${verified.localsSize - 1};`);
            body.push(`region.rasterKernel(state,region,helpers,${args.join(",")});`);
          } else if (role === "raster" && memberKey(call) === region.family.scanlineKey) {
            body.push(`region.scanlineKernel(state,region,helpers,${args.join(",")});`);
          } else if (call && call.kind === "integer-inline") {
            const result = temp();
            const substitute = (source) => source.replace(/stack\[base \+ (\d+)\]/g,
              (_match, argument) => `(${args[Number(argument)]})`);
            body.push(`let ${result};`, "{",
              ...call.inline.statements.map((statement) => substitute(statement)),
              `${result}=${substitute(call.inline.result)};`, "}");
            expressions.push(`(${result}|0)`);
          } else if (call && call.kind === "integer-native") {
            const nativeIndex = region.nativeCalls.length;
            region.nativeCalls.push(callByIndex.get(index).native);
            const result = temp(); const thrown = temp();
            body.push(`let ${result};try{${result}=helpers.invokeFusedIntegerNative(region.nativeCalls[${nativeIndex}],${args[0]},${args[1]});}catch(${thrown})${captureThrow(index,
              args, thrown)}`);
            expressions.push(`(${result}|0)`);
          } else {
            body.push("throw helpers.fusedBailout();");
          }
          if (parsed.returnType !== "void" &&
              !(call && (call.kind === "integer-native" || call.kind === "integer-inline" ||
                call.kind === "early-bailout"))) throw new Error("unsupported call result");
        } else if (op === "goto" || op === "goto_w") {
          body.push(...transfer(expressions, branchTarget(instruction, labels))); terminated = true;
        } else if (op && op.startsWith("if")) {
          let condition;
          if (op.startsWith("if_icmp")) {
            const right = pop(); const left = pop();
            const compare = { if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<",
              if_icmpge: ">=", if_icmpgt: ">", if_icmple: "<=" }[op];
            condition = `${left}${compare}${right}`;
          } else {
            const value = pop();
            const compare = { ifeq: "===0", ifne: "!==0", iflt: "<0",
              ifge: ">=0", ifgt: ">0", ifle: "<=0" }[op];
            condition = `${value}${compare}`;
          }
          body.push(...save(expressions));
          body.push(`pc=(${condition})?${branchTarget(instruction, labels)}:${index + 1};continue;`);
          terminated = true;
        } else if (op === "return") {
          body.push("return;"); terminated = true;
        } else {
          throw new Error(`unsupported fused opcode ${op}`);
        }
        if (terminated) break;
      }
      if (!terminated) body.push(...transfer(expressions, next.get(leader)));
      body.push("}");
    }
    body.push("default: throw new Error('invalid fused pc '+pc);", "}", "}");
    const owner = role === "wrapper" ? region.wrapperOwner
      : role === "raster" ? region.rasterOwner : region.scanlineOwner;
    return this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-${role}`,
      ["state", "region", "helpers", ...argNames], body.join("\n"), owner);
  }

  compileSemanticScanline(method, verified, region, analyzedPlan = null) {
    const plan = analyzedPlan || analyzeScanline(method, verified);
    if (!plan) return null;
    const descriptor = parseDescriptor(method.descriptor);
    const args = descriptor.params.map((_, index) => `a${index}`);
    const localValues = args.join(",");
    const value = (parameter) => args[parameter];
    const dest = value(plan.array);
    const index = value(plan.index);
    const count = value(plan.count);
    const tag = value(plan.tag);
    const fail = (operands, exception) =>
      `{state.method="scanline";state.pc=${plan.storePc};state.locals=[${localValues}];` +
      `state.stack=[${operands.join(",")}];throw ${exception};}`;
    const body = ["\"use strict\";",
      `if((${tag}|0)!==${plan.tagValue})throw helpers.fusedBailout();`,
      `let index=${index}|0,count=${count}|0;`,
      `const dest=${dest};`,
      `if(dest==null)${fail(["dest", "index"],
        '{type:"java/lang/NullPointerException",message:null}')}`,
      "if(count<=0)return;",
      `if(index<0||index+count>dest.length)${fail(["dest", "index"],
        '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}')}`,
    ];
    if (plan.kind === "packed-color") {
      body.push(
        `let c0=${value(plan.accumulators[0])}|0;`,
        `let c1=${value(plan.accumulators[1])}|0;`,
        `let c2=${value(plan.accumulators[2])}|0;`,
        `const d0=${value(plan.steps[0])}|0,d1=${value(plan.steps[1])}|0,d2=${value(plan.steps[2])}|0;`,
        "for(let offset=0;offset<count;offset+=1){",
        "dest[index]=(((dest[index]>>1)&8355711)+((c0>>9)&65280)+((c1>>1)&16711680)+((c2>>17)&255))|0;",
        "index+=1;c0=(c0+d0)|0;c1=(c1+d1)|0;c2=(c2+d2)|0;}",
        "return;",
      );
    } else {
      body.push(
        `const color=${value(plan.color)}|0;`,
        "for(let offset=0;offset<count;offset+=1){",
        "dest[index]=(color+((dest[index]&16711422)>>1))|0;index+=1;}",
        "return;",
      );
    }
    return this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-semantic-scanline`,
      ["state", "region", "helpers", ...args], body.join("\n"), region.scanlineOwner);
  }

  compileTrustedRasterBridge(method, region, plan) {
    if (!plan || !Number.isInteger(plan.destinationParameter) ||
        !Number.isInteger(plan.tagParameter) ||
        !Number.isInteger(plan.tagValue)) return null;
    const descriptor = parseDescriptor(method.descriptor);
    const args = descriptor.params.map((_, index) => `a${index}`);
    const fallback = `return region.generatedRasterKernel(state,region,helpers,` +
      `${args.join(",")});`;
    const staticRead = (index) =>
      `(region.staticTargets[${index}].kind==="map"?` +
      `region.staticTargets[${index}].fields.get(region.staticTargets[${index}].key):` +
      `region.staticTargets[${index}].fields[region.staticTargets[${index}].key])`;
    const staticNames = new Map([
      [plan.heightStatic, "rasterHeight"],
      [plan.widthStatic, "rasterWidth"],
      [plan.rowsStatic, "rasterRows"],
      [plan.strideStatic, "rasterStride"],
    ]);
    const captureArguments = (region.trustedRasterStaticIndices || [])
      .map((index) => staticNames.get(index) || staticRead(index));
    // Without relying on renderer-specific coordinate positions, validate
    // every proven entry parameter that can reach a row-table index. Success
    // proves every row-table load used by the child. Rejection occurs before
    // the first raster side effect.
    const rowConditions = (plan.rowParameters || [])
      .map((parameter, candidate) => {
        const name = `rasterRowCandidate${candidate}`;
        return {
          declaration: `const ${name}=(${args[parameter]}|0)>0?(${args[parameter]}|0):0;`,
          condition: `(${name}<rasterHeight&&` +
            `rasterRows[${name}]!==Math.imul(${name},rasterStride))`,
        };
      });
    const body = [
      "\"use strict\";",
      `const rasterHeight=${staticRead(plan.heightStatic)}|0;`,
      `const rasterWidth=${staticRead(plan.widthStatic)}|0;`,
      `const rasterRows=${staticRead(plan.rowsStatic)};`,
      `const rasterStride=${staticRead(plan.strideStatic)}|0;`,
      `const rasterDest=${args[plan.destinationParameter]};`,
      ...rowConditions.map(({ declaration }) => declaration),
      `if((${args[plan.tagParameter]}|0)!==${plan.tagValue}||` +
        "rasterDest==null||rasterRows==null||rasterHeight<=0||" +
        "rasterRows.length<rasterHeight||" +
        "rasterDest.length<(Math.imul(rasterHeight-1,rasterStride)+rasterWidth|0)||" +
        `${rowConditions.map(({ condition }) => condition).join("||")}){${fallback}}`,
      `return region.trustedRasterKernel(state,region,helpers,` +
        `${[...args, ...captureArguments].join(",")});`,
    ];
    const generated = this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-trusted-raster-bridge`,
      ["state", "region", "helpers", ...args], body.join("\n"),
      region.rasterOwner);
    generated.jvmTrustedRasterBridge = true;
    generated.jvmTrustedRasterBridgeRowCandidateCount = rowConditions.length;
    return generated;
  }

  // Lower a fully verified affine-edge triangle into the same compact control
  // vocabulary that a source compiler would use. The admission proof is
  // descriptor/CFG/opcode/callee based and supplies every parameter/static
  // role; this emitter never examines a class or method name. The surrounding
  // bridge proves the destination and row layout before entering this body,
  // while the original lexical raster remains the exact exceptional fallback.
  compileVerifiedFlatRaster(method, region, plan) {
    const roles = plan.affineEdgeParameters;
    if (!roles || !region.semanticScanlinePlan ||
        region.semanticScanlinePlan.kind !== "constant-color") return null;
    const descriptor = parseDescriptor(method.descriptor);
    const args = descriptor.params.map((_, index) => `a${index}`);
    const required = ["xTop", "yMid", "xBottom", "yBottom", "color",
      "xMid", "yTop", "destination"];
    if (required.some((role) => !Number.isInteger(roles[role]) ||
        roles[role] < 0 || roles[role] >= args.length)) return null;
    const value = (role) => args[roles[role]];

    const scanSource = [
      '"use strict";',
      "index|=0;count|=0;color|=0;",
      "for(let offset=0;offset<count;offset+=1){",
      "dest[index]=(color+((dest[index]&16711422)>>1))|0;",
      "index=(index+1)|0;}",
    ].join("\n");
    const scan = this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-verified-flat-scan`,
      ["dest", "index", "count", "color"], scanSource,
      region.scanlineOwner);
    const drawRowSource = [
      '"use strict";',
      "const xLeft=leftFixed>>16;",
      "if(width<=xLeft)return;",
      "let count=((rightFixed>>16)-xLeft)|0;",
      "if(count===0)return;",
      "if(((xLeft+count)|0)>=width)count=(((width-xLeft)|0)-1)|0;",
      "if(xLeft>=0)scan(dest,(rowBase+xLeft)|0,count,color);",
      "else scan(dest,rowBase,(count+xLeft)|0,color);",
    ].join("\n");
    const drawRow = this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-verified-flat-row`,
      ["dest", "rowBase", "width", "leftFixed", "rightFixed", "color"],
      drawRowSource, region.rasterOwner, false, false, { scan });

    const body = [
      '"use strict";',
      `let xTop=${value("xTop")}|0;`,
      `let yMid=${value("yMid")}|0;`,
      `let xBottom=${value("xBottom")}|0;`,
      `let yBottom=${value("yBottom")}|0;`,
      `const color=${value("color")}|0;`,
      `let xMid=${value("xMid")}|0;`,
      `let yTop=${value("yTop")}|0;`,
      `const dest=${value("destination")};`,
      "const height=c0|0,width=c1|0,rows=c2,stride=c3|0;",
      "if(yBottom<0||yTop>=height)return;",
      "if(xTop<0&&xMid<0&&xBottom<0)return;",
      "if(xTop>=width&&xMid>=width&&xBottom>=width)return;",
      "const fullHeight=(yBottom-yTop)|0;",
      "let left=0,right=0,leftStep=0,rightStep=0,middleOnRight=0;",
      "if(yMid!==yTop){",
      "left=xTop<<16;right=left;",
      "const upperHeight=(yMid-yTop)|0;",
      "rightStep=(((xBottom-xTop)|0)<<16)/fullHeight|0;",
      "leftStep=(((xMid-xTop)|0)<<16)/upperHeight|0;",
      "if(leftStep>rightStep){const swap=leftStep;leftStep=rightStep;" +
        "rightStep=swap;middleOnRight=1;}",
      "if(yTop<0){if(yMid>=0){const advance=(-yTop)|0;" +
        "left=(left+Math.imul(advance,leftStep))|0;" +
        "right=(right+Math.imul(advance,rightStep))|0;yTop=0;}else{" +
        "const advance=(yMid-yTop)|0;" +
        "left=(left+Math.imul(leftStep,advance))|0;" +
        "right=(right+Math.imul(rightStep,advance))|0;yTop=yMid;}}",
      "if(yTop<yMid){let rowBase=rows[yTop]|0;while(yTop<yMid){" +
        "drawRow(dest,rowBase,width,left,right,color);yTop=(yTop+1)|0;" +
        "if(yTop>=height)return;left=(left+leftStep)|0;" +
        "right=(right+rightStep)|0;rowBase=(rowBase+stride)|0;}}",
      "const lowerHeight=(yBottom-yMid)|0;",
      "if(lowerHeight!==0){const bottom=xBottom<<16;" +
        "if(middleOnRight!==0)right=xMid<<16;else left=xMid<<16;" +
        "rightStep=((bottom-right)|0)/lowerHeight|0;" +
        "leftStep=((bottom-left)|0)/lowerHeight|0;}else{" +
        "rightStep=0;leftStep=0;}",
      "}else{",
      "if(yTop!==yBottom){const lowerHeight=(yBottom-yTop)|0;" +
        "if(xMid<=xTop){leftStep=(((xBottom-xMid)|0)<<16)/lowerHeight|0;" +
        "rightStep=(((xBottom-xTop)|0)<<16)/fullHeight|0;" +
        "left=xMid<<16;right=xTop<<16;}else{left=xTop<<16;right=xMid<<16;" +
        "leftStep=(((xBottom-xTop)|0)<<16)/fullHeight|0;" +
        "rightStep=(((xBottom-xMid)|0)<<16)/lowerHeight|0;}}else{" +
        "leftStep=0;rightStep=0;left=xTop<<16;right=xMid<<16;}",
      "if(yTop<0){const advance=Math.min((-yTop)|0,(yMid-yTop)|0)|0;" +
        "left=(left+Math.imul(advance,leftStep))|0;" +
        "right=(right+Math.imul(advance,rightStep))|0;yTop=0;}}",
      "if(yTop<0){const advance=(-yTop)|0;" +
        "left=(left+Math.imul(leftStep,advance))|0;" +
        "right=(right+Math.imul(rightStep,advance))|0;yTop=0;}",
      "let rowBase=rows[yTop]|0;",
      plan.singleLowerScanline
        ? "if(yTop<yBottom)drawRow(dest,rowBase,width,left,right,color);return;"
        : "while(yTop<yBottom){drawRow(dest,rowBase,width,left,right,color);" +
          "yTop=(yTop+1)|0;if(yTop>=height)return;" +
          "left=(left+leftStep)|0;right=(right+rightStep)|0;" +
          "rowBase=(rowBase+stride)|0;}",
    ].join("\n");
    const generated = this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-verified-flat-raster`,
      ["state", "region", "helpers", ...args, "c0", "c1", "c2", "c3"],
      body, region.rasterOwner, false, false, { drawRow });
    generated.jvmLexicalFusedKernel = true;
    generated.jvmTrustedFusedRaster = true;
    generated.jvmVerifiedFlatRaster = true;
    generated.jvmTrustedScanlineInlineCount = 0;
    generated.jvmGuardedFalseStaticCount =
      region.falseGuardStaticIndices?.size || 0;
    generated.jvmCapturedStaticCount = 4;
    generated.jvmConstantArgumentCount = 0;
    generated.jvmLexicalFusedSource = body;
    generated.jvmVerifiedFlatScanSource = scanSource;
    generated.jvmVerifiedFlatRowSource = drawRowSource;
    return generated;
  }

  compileSemanticWrapper(method, verified, region) {
    const plan = analyzePermutationWrapper(method, verified, region, this.jit);
    if (!plan) return null;
    region.semanticWrapperPlan = plan;
    if (region.genericRasterSafetyPlan && !region.directRasterKernel) {
      const rasterParameters = parseDescriptor(
        region.rasterMethod.descriptor).params.length;
      const templates = [...plan.templates.values()];
      const constantArguments = new Map();
      for (let parameter = 0; parameter < rasterParameters; parameter += 1) {
        const expression = templates[0]?.arguments[parameter];
        if (/^-?\d+$/.test(String(expression)) && templates.every(
          (template) => template.arguments[parameter] === expression)) {
          constantArguments.set(parameter, expression);
        }
      }
      if (constantArguments.size) {
        const specialized = this.compileLexicalKernel(
          region.rasterMethod, region.raster, region, "raster", {
            capturedStaticIndices: region.trustedRasterStaticIndices,
            constantArguments,
            failureRole: "constant-trusted-raster",
            trustedScanlinePlan: region.semanticScanlinePlan,
          });
        if (specialized) {
          region.trustedRasterKernel = specialized;
          region.trustedRasterConstantArguments = constantArguments;
        }
      }
    }
    const descriptor = parseDescriptor(method.descriptor);
    const args = descriptor.params.map((_, index) => `a${index}`);
    const fallback = `return region.generatedWrapperKernel(state,region,helpers,${args.join(",")});`;
    const relation = (left, right) =>
      `((${left}<${right})?0:((${left}===${right})?1:2))`;
    const [first, second, third] = plan.keys.map((parameter) => args[parameter]);
    const rasterPlan = region.semanticGradientRasterPlan ||
      region.semanticFlatRasterPlan || region.genericRasterSafetyPlan;
    const direct = Boolean(rasterPlan && region.directRasterKernel);
    const trusted = Boolean(!direct && rasterPlan && region.trustedRasterKernel);
    const staticRead = (index) =>
      `(region.staticTargets[${index}].kind==="map"?` +
      `region.staticTargets[${index}].fields.get(region.staticTargets[${index}].key):` +
      `region.staticTargets[${index}].fields[region.staticTargets[${index}].key])`;
    const trustedStaticValues = rasterPlan ? new Map([
      [rasterPlan.heightStatic, "rasterHeight"],
      [rasterPlan.widthStatic, "rasterWidth"],
      [rasterPlan.rowsStatic, "rasterRows"],
      [rasterPlan.strideStatic, "rasterStride"],
    ]) : new Map();
    const trustedCaptureArguments = (region.trustedRasterStaticIndices || [])
      .map((index) => trustedStaticValues.get(index) || staticRead(index));
    const body = ["\"use strict\";",
      ...plan.booleanParameters.map((parameter) =>
        `if((${args[parameter]}|0)!==1){${fallback}}`),
      ...(direct || trusted ? [
        `const rasterHeight=${staticRead(rasterPlan.heightStatic)}|0;`,
        `const rasterWidth=${staticRead(rasterPlan.widthStatic)}|0;`,
        `const rasterRows=${staticRead(rasterPlan.rowsStatic)};`,
        `const rasterStride=${staticRead(rasterPlan.strideStatic)}|0;`,
      ] : []),
      `const order=${relation(first, second)}*9+${relation(first, third)}*3+${relation(second, third)};`,
      "switch(order){",
    ];
    for (const [order, template] of [...plan.templates].sort((a, b) => a[0] - b[0])) {
      if (direct || trusted) {
        const gradient = Boolean(region.semanticGradientRasterPlan ||
          (!region.semanticFlatRasterPlan &&
            region.genericRasterSafetyPlan &&
            region.semanticScanlinePlan?.kind === "packed-color"));
        const dest = template.arguments[gradient ? 12 : 8];
        const yTop = template.arguments[gradient ? 11 : 7];
        const yMid = template.arguments[gradient ? 3 : 1];
        body.push(`case ${order}:{`,
          `const rasterDest=${dest};`,
          `const rasterTop=(${yTop}|0)>0?(${yTop}|0):0;`,
          `const rasterMid=(${yMid}|0)>0?(${yMid}|0):0;`,
          "if(rasterDest==null||rasterRows==null||rasterHeight<=0||" +
            "rasterRows.length<rasterHeight||" +
            "rasterDest.length<(Math.imul(rasterHeight-1,rasterStride)+rasterWidth|0)||" +
            "(rasterTop<rasterHeight&&rasterRows[rasterTop]!==Math.imul(rasterTop,rasterStride))||" +
            "(rasterMid<rasterHeight&&rasterRows[rasterMid]!==Math.imul(rasterMid,rasterStride)))" +
            `{${fallback}}`,
          `state.outerPc=${template.pc};state.outerExtra=undefined;`,
          direct
            ? `region.directRasterKernel(rasterHeight,rasterWidth,rasterRows,rasterStride,` +
              `${template.arguments.join(",")});`
            : `region.trustedRasterKernel(state,region,helpers,` +
              `${[...template.arguments, ...trustedCaptureArguments].join(",")});`,
          "break;}");
      } else {
        body.push(`case ${order}:`,
          `state.outerPc=${template.pc};state.outerExtra=undefined;`,
          `region.rasterKernel(state,region,helpers,${template.arguments.join(",")});`,
          "break;");
      }
    }
    body.push(`default:${fallback}`, "}",
      "helpers.semanticFusedWrapperRunCount=(helpers.semanticFusedWrapperRunCount|0)+1;",
      "return;");
    return this.jit.createGeneratedFunction(method,
      `fused-${region.family.name}-semantic-wrapper`,
      ["state", "region", "helpers", ...args], body.join("\n"), region.wrapperOwner);
  }
}

function analyzePermutationWrapper(method, verified, region, jit) {
  const reject = (reason) => {
    region.semanticWrapperRejection = reason;
    return null;
  };
  let descriptor;
  try { descriptor = parseDescriptor(method.descriptor); } catch (_) { return reject("descriptor"); }
  if (descriptor.returnType !== "void") return reject("non-void");
  if (hasBackwardBranch(verified)) return reject("backward branch");
  const parameterLocals = new Map();
  let slot = 0;
  descriptor.params.forEach((type, parameter) => {
    parameterLocals.set(slot, parameter);
    slot += type === "long" || type === "double" ? 2 : 1;
  });
  const alias = new Map(parameterLocals);
  const items = verified.codeItems;
  const load = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    return /^[ai]load(?:_[0-3])?$/.test(op) ? localIndex(instruction, op) : null;
  };
  const store = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    return /^[ai]store(?:_[0-3])?$/.test(op) ? localIndex(instruction, op) : null;
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 0; index + 1 < items.length; index += 1) {
      const source = load(index), target = store(index + 1);
      if (source !== null && target !== null && alias.has(source)) alias.set(target, alias.get(source));
    }
  }
  const compared = new Set();
  for (let index = 0; index + 2 < items.length; index += 1) {
    const left = load(index), right = load(index + 1);
    const op = getOp(items[index + 2] && items[index + 2].instruction);
    if (left !== null && right !== null && op && op.startsWith("if_icmp") &&
        alias.has(left) && alias.has(right)) {
      compared.add(alias.get(left)); compared.add(alias.get(right));
    }
  }
  let keys = [...compared].sort((a, b) => a - b);
  // Stores through references would make compile-time probing observable.
  // Static stores are isolated in cloned field containers below.
  if ([...verified.reachable].some((index) =>
    ["aastore", "bastore", "castore", "dastore", "fastore", "iastore",
      "lastore", "sastore", "putfield", "monitorenter", "monitorexit"]
      .includes(getOp(items[index] && items[index].instruction)))) return reject("reference side effect");
  const booleanParameters = descriptor.params.map((type, parameter) => ({ type, parameter }))
    .filter(({ type }) => type === "boolean").map(({ parameter }) => parameter);
  if (verified.staticRefs.length && !booleanParameters.length) return reject("unguarded statics");

  const readTarget = (target) => target.kind === "map"
    ? target.fields.get(target.key) : target.fields[target.key];
  const cloneTargets = () => region.staticTargets.map((target) => target.kind === "map"
    ? { ...target, fields: new Map(target.fields) }
    : { ...target, fields: { ...target.fields } });
  const capture = (arguments_) => {
    const fakeTargets = cloneTargets();
    const before = fakeTargets.map(readTarget);
    const calls = [];
    const fakeRegion = { ...region, staticTargets: fakeTargets,
      rasterKernel: (_state, _region, _helpers, ...childArguments) => {
        calls.push(childArguments);
      } };
    try {
      region.wrapperKernel({ method: null }, fakeRegion, jit, ...arguments_);
    } catch (_) { return null; }
    if (calls.length !== 1 || fakeTargets.some((target, index) =>
      readTarget(target) !== before[index])) return null;
    const expressions = calls[0].map((child) => {
      const parameter = arguments_.findIndex((argument) => argument === child);
      if (parameter >= 0) return `a${parameter}`;
      const staticTarget = fakeTargets.findIndex((target) => readTarget(target) === child);
      if (staticTarget >= 0) {
        return `(region.staticTargets[${staticTarget}].kind==="map"?` +
          `region.staticTargets[${staticTarget}].fields.get(region.staticTargets[${staticTarget}].key):` +
          `region.staticTargets[${staticTarget}].fields[region.staticTargets[${staticTarget}].key])`;
      }
      if (child === null) return "null";
      if (Number.isInteger(child)) return String(child | 0);
      return null;
    });
    return expressions.some((expression) => expression === null) ? null : expressions;
  };
  if (keys.length !== 3 || keys.some((parameter) => !isIntType(descriptor.params[parameter]))) {
    keys = [];
    for (let parameter = 0; parameter < descriptor.params.length; parameter += 1) {
      if (!isIntType(descriptor.params[parameter]) ||
          descriptor.params[parameter] === "boolean") continue;
      const makeArguments = (probe) => descriptor.params.map((type, candidate) =>
        type === "int[]" ? { probeArray: candidate }
          : type === "boolean" ? 1
            : candidate === parameter ? probe : (1000000 + candidate * 4099) | 0);
      const low = capture(makeArguments(-100000000));
      const high = capture(makeArguments(100000000));
      if (!low || !high) return reject(`control probe ${parameter}`);
      if (low.join("\0") !== high.join("\0")) keys.push(parameter);
    }
  }
  keys.sort((a, b) => a - b);
  if (keys.length !== 3) return reject(`control key count ${keys.length}`);
  const templates = new Map();
  for (let first = 0; first < 3; first += 1) {
    for (let second = 0; second < 3; second += 1) {
      for (let third = 0; third < 3; third += 1) {
        const arguments_ = descriptor.params.map((type, parameter) =>
          type === "int[]" ? { probeArray: parameter }
            : type === "boolean" ? 1 : (1000000 + parameter * 4099) | 0);
        arguments_[keys[0]] = first;
        arguments_[keys[1]] = second;
        arguments_[keys[2]] = third;
        const expressions = capture(arguments_);
        if (!expressions) return reject(`ordering probe ${first}${second}${third}`);
        const relation = (left, right) => left < right ? 0 : left === right ? 1 : 2;
        const order = relation(first, second) * 9 +
          relation(first, third) * 3 + relation(second, third);
        const encoded = expressions.join("\0");
        const existing = templates.get(order);
        if (existing && existing.encoded !== encoded) return reject(`unstable ordering ${order}`);
        const matchingSite = verified.calls.find((call) => call.kind === "child");
        templates.set(order, { encoded, arguments: expressions,
          pc: matchingSite ? matchingSite.index + 1 : 0 });
      }
    }
  }
  if (templates.size !== 13) return reject(`ordering count ${templates.size}`);
  region.semanticWrapperRejection = null;
  return { keys, booleanParameters, templates };
}

function hasBackwardBranch(verified) {
  for (const index of verified.reachable) {
    const instruction = verified.codeItems[index] && verified.codeItems[index].instruction;
    const op = getOp(instruction);
    if ((op === "goto" || op === "goto_w" || op && op.startsWith("if")) &&
        branchTarget(instruction, verified.labels) <= index) return true;
  }
  return false;
}

function analyzeScanline(method, verified) {
  let descriptor;
  try { descriptor = parseDescriptor(method.descriptor); } catch (_) { return null; }
  if (descriptor.returnType !== "void") return null;
  const parameterLocals = [];
  let slot = 0;
  descriptor.params.forEach((type, parameter) => {
    parameterLocals[slot] = parameter;
    slot += type === "long" || type === "double" ? 2 : 1;
  });
  const arrayParameters = descriptor.params.map((type, parameter) => ({ type, parameter }))
    .filter(({ type }) => type === "int[]");
  if (arrayParameters.length !== 1 ||
      descriptor.params.some((type) => type !== "int[]" && !isIntType(type))) return null;

  const items = verified.codeItems;
  const alias = new Map(parameterLocals.map((parameter, local) => [local, parameter]));
  const loadLocal = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    return /^[ai]load(?:_[0-3])?$/.test(op) ? localIndex(instruction, op) : null;
  };
  const storeLocal = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    return /^[ai]store(?:_[0-3])?$/.test(op) ? localIndex(instruction, op) : null;
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 0; index + 1 < items.length; index += 1) {
      if (!verified.reachable.has(index) || !verified.reachable.has(index + 1)) continue;
      const source = loadLocal(index), target = storeLocal(index + 1);
      if (source !== null && target !== null && alias.has(source)) alias.set(target, alias.get(source));
    }
  }
  const parameterOf = (local) => alias.has(local) ? alias.get(local) : parameterLocals[local];
  const constantAt = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    if (/^iconst_(?:m1|[0-5])$/.test(op)) return Number(constantValue(instruction, op));
    if (["bipush", "sipush", "ldc", "ldc_w"].includes(op)) {
      const value = Number(instruction.arg);
      return Number.isInteger(value) ? value : null;
    }
    return null;
  };

  let tag = null, tagValue = null;
  for (let index = 0; index + 2 < items.length; index += 1) {
    const local = loadLocal(index), constant = constantAt(index + 1);
    const branch = getOp(items[index + 2] && items[index + 2].instruction);
    if (local !== null && constant !== null && branch && branch.startsWith("if_icmp") &&
        parameterOf(local) !== undefined) {
      tag = parameterOf(local); tagValue = constant; break;
    }
  }
  if (tag === null) return null;

  const increments = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const instruction = items[index] && items[index].instruction;
    if (getOp(instruction) !== "iinc" || !verified.reachable.has(index)) continue;
    const parameter = parameterOf(Number(instruction.varnum ?? instruction.arg));
    const increment = Number(instruction.incr ?? 0);
    if (parameter !== undefined) increments.set(parameter, increment);
  }
  const indexParameter = [...increments].find(([, increment]) => increment === 1)?.[0];
  const countParameter = [...increments].find(([, increment]) => increment === -1)?.[0];
  if (indexParameter === undefined || countParameter === undefined) return null;

  const constants = new Set();
  let storePc = null;
  for (let index = 0; index < items.length; index += 1) {
    if (!verified.reachable.has(index)) continue;
    const constant = constantAt(index);
    if (constant !== null) constants.add(constant);
    if (getOp(items[index] && items[index].instruction) === "iastore") storePc = index;
  }
  if (storePc === null) return null;

  const recurrences = new Map();
  for (let index = 0; index + 3 < items.length; index += 1) {
    const left = loadLocal(index), right = loadLocal(index + 1);
    const add = getOp(items[index + 2] && items[index + 2].instruction);
    const target = storeLocal(index + 3);
    if (left === null || right === null || target === null || add !== "iadd") continue;
    const accumulator = parameterOf(left), step = parameterOf(right), stored = parameterOf(target);
    if (accumulator !== undefined && accumulator === stored && step !== undefined) {
      recurrences.set(accumulator, step);
    }
  }

  const shiftOwners = new Map();
  for (let index = 0; index + 2 < items.length; index += 1) {
    const local = loadLocal(index), shift = constantAt(index + 1);
    if (local === null || shift === null ||
        getOp(items[index + 2] && items[index + 2].instruction) !== "ishr") continue;
    const parameter = parameterOf(local);
    if (parameter !== undefined) shiftOwners.set(shift & 31, parameter);
  }
  const packedConstants = [8355711, 65280, 16711680, 255];
  if (packedConstants.every((constant) => constants.has(constant)) &&
      [9, 1, 17].every((shift) => shiftOwners.has(shift))) {
    const accumulators = [shiftOwners.get(9), shiftOwners.get(1), shiftOwners.get(17)];
    const steps = accumulators.map((parameter) => recurrences.get(parameter));
    if (new Set(accumulators).size === 3 && steps.every((parameter) => parameter !== undefined)) {
      return { kind: "packed-color", array: arrayParameters[0].parameter,
        index: indexParameter, count: countParameter, tag, tagValue,
        accumulators, steps, storePc };
    }
  }
  if (constants.has(16711422)) {
    const excluded = new Set([arrayParameters[0].parameter, indexParameter, countParameter, tag]);
    const colors = descriptor.params.map((_, parameter) => parameter)
      .filter((parameter) => !excluded.has(parameter));
    if (colors.length === 1) return { kind: "constant-color",
      array: arrayParameters[0].parameter, index: indexParameter,
      count: countParameter, tag, tagValue, color: colors[0], storePc };
  }
  return null;
}

function analyzeGradientRaster(method, verified, region, scanlinePlan) {
  if (!scanlinePlan || scanlinePlan.kind !== "packed-color") return null;
  let descriptor;
  try { descriptor = parseDescriptor(method.descriptor); } catch (_) { return null; }
  if (descriptor.returnType !== "void" || descriptor.params.length !== 17 ||
      descriptor.params[7] !== "byte" || descriptor.params[12] !== "int[]" ||
      descriptor.params.some((type, index) =>
        index !== 12 && !isIntType(type))) return null;
  const ops = [...verified.reachable].map((index) =>
    getOp(verified.codeItems[index] && verified.codeItems[index].instruction)).filter(Boolean);
  const count = (op) => ops.filter((candidate) => candidate === op).length;
  const scanlineCalls = verified.calls.filter((call) => call.kind === "child").length;
  if (scanlineCalls < 2 || count("idiv") < 8 || count("ishl") < 8 ||
      count("imul") < 4 || count("iaload") < 1 || count("putstatic") !== 0) return null;

  const groups = new Map();
  verified.staticRefs.forEach((ref, order) => {
    const key = JSON.stringify(ref);
    const descriptor = ref && ref[2] && ref[2][1];
    if (!groups.has(key)) groups.set(key, { ref, descriptor, count: 0, order });
    groups.get(key).count += 1;
  });
  const integers = [...groups.values()].filter((group) => group.descriptor === "I");
  const rows = [...groups.values()].filter((group) => group.descriptor === "[I");
  const flags = [...groups.values()].filter((group) => group.descriptor === "Z");
  if (integers.length !== 3 || rows.length !== 1 || flags.length < 1) return null;
  const width = [...integers].sort((left, right) =>
    right.count - left.count || left.order - right.order)[0];
  const remaining = integers.filter((group) => group !== width)
    .sort((left, right) => left.order - right.order);
  const height = remaining[0], stride = remaining[1];
  if (!height || !stride || width.count <= height.count) return null;
  const staticIndex = (group) => region.staticIndex.get(JSON.stringify(group.ref));
  const plan = {
    heightStatic: staticIndex(height),
    widthStatic: staticIndex(width),
    rowsStatic: staticIndex(rows[0]),
    strideStatic: staticIndex(stride),
  };
  if (Object.values(plan).some((index) => index === undefined)) return null;
  return plan;
}

function analyzeFlatRaster(method, verified, region, scanlinePlan) {
  const reject = (reason) => {
    region.semanticFlatRasterRejection = reason;
    return null;
  };
  if (!scanlinePlan || scanlinePlan.kind !== "constant-color") return reject("scanline");
  let descriptor;
  try { descriptor = parseDescriptor(method.descriptor); } catch (_) { return reject("descriptor"); }
  const byteParameters = descriptor.params
    .map((type, parameter) => ({ type, parameter }))
    .filter(({ type }) => type === "byte");
  const arrayParameters = descriptor.params
    .map((type, parameter) => ({ type, parameter }))
    .filter(({ type }) => type === "int[]");
  if (descriptor.returnType !== "void" || descriptor.params.length !== 9 ||
      byteParameters.length !== 1 || arrayParameters.length !== 1 ||
      descriptor.params.some((type) => type !== "int[]" && !isIntType(type))) {
    return reject("parameter shape");
  }
  const tagParameter = byteParameters[0].parameter;
  const destinationParameter = arrayParameters[0].parameter;

  const ops = [...verified.reachable].map((index) =>
    getOp(verified.codeItems[index] && verified.codeItems[index].instruction)).filter(Boolean);
  const count = (op) => ops.filter((candidate) => candidate === op).length;
  const scanlineCalls = verified.calls.filter((call) => call.kind === "child").length;
  if (scanlineCalls !== 6 || count("idiv") !== 8 || count("ishl") !== 16 ||
      count("imul") !== 8 || count("iaload") !== 2 || count("putstatic") !== 0) {
    return reject(`opcode shape calls=${scanlineCalls} idiv=${count("idiv")} ` +
      `ishl=${count("ishl")} imul=${count("imul")} iaload=${count("iaload")} ` +
      `putstatic=${count("putstatic")}`);
  }

  const groups = new Map();
  verified.staticRefs.forEach((ref, order) => {
    const key = JSON.stringify(ref);
    const fieldDescriptor = ref && ref[2] && ref[2][1];
    if (!groups.has(key)) groups.set(key, { ref, descriptor: fieldDescriptor, count: 0, order });
    groups.get(key).count += 1;
  });
  const integers = [...groups.values()].filter((group) => group.descriptor === "I");
  const rows = [...groups.values()].filter((group) => group.descriptor === "[I");
  const flags = [...groups.values()].filter((group) => group.descriptor === "Z");
  if (integers.length !== 3 || rows.length !== 1 || flags.length < 1) {
    return reject(`static shape integers=${integers.length} rows=${rows.length} flags=${flags.length}`);
  }
  const width = [...integers].sort((left, right) =>
    right.count - left.count || left.order - right.order)[0];
  const remaining = integers.filter((group) => group !== width)
    .sort((left, right) => left.order - right.order);
  const height = remaining[0];
  const stride = remaining[1];
  if (!height || !stride || width.count <= height.count) return reject("static roles");
  const tagValues = comparedParameterConstants(method, verified, tagParameter);
  if (tagValues.length !== 1) return reject(`tag values=${tagValues.join(",")}`);
  const childCalls = verified.calls.filter((call) => call.kind === "child");
  const lastChildIndex = Math.max(...childCalls.map((call) => call.index));
  const hasLowerBackedge = [...verified.reachable].some((index) => {
    if (index <= lastChildIndex) return false;
    const instruction = verified.codeItems[index] && verified.codeItems[index].instruction;
    const op = getOp(instruction);
    if (!(op === "goto" || op === "goto_w" || op && op.startsWith("if"))) return false;
    const target = branchTarget(instruction, verified.labels);
    return Number.isInteger(target) && target <= lastChildIndex;
  });
  const staticIndex = (group) => region.staticIndex.get(JSON.stringify(group.ref));
  const plan = {
    heightStatic: staticIndex(height),
    widthStatic: staticIndex(width),
    rowsStatic: staticIndex(rows[0]),
    strideStatic: staticIndex(stride),
    destinationParameter,
    tagParameter,
    tagValue: tagValues[0],
    singleLowerScanline: !hasLowerBackedge,
    // The accepted descriptor has seven geometric/color integer operands,
    // followed by the uniquely derived byte tag and destination roles above.
    // Exact opcode/callee multiplicities make this mapping part of the
    // verified affine-edge family rather than a method-identity shortcut.
    affineEdgeParameters: {
      xTop: 0,
      yMid: 1,
      xBottom: 2,
      yBottom: 3,
      color: 4,
      xMid: 6,
      yTop: 7,
      destination: destinationParameter,
    },
  };
  if (Object.values(plan).some((value) => value === undefined)) return reject("unresolved static");
  plan.rowParameters = analyzeStaticArrayIndexParameters(
    method, verified, region, plan.rowsStatic);
  if (!plan.rowParameters?.length) return reject("row-index provenance");
  region.semanticFlatRasterRejection = null;
  return plan;
}

// Compute which entry parameters can reach indexes of loads from one resolved
// static array. Values are abstract provenance sets, joined across the normal
// CFG (including loops). Unsupported or ambiguous flow rejects the proof; it
// never weakens the checked raster fallback.
function analyzeStaticArrayIndexParameters(method, verified, region, targetStatic) {
  const descriptor = parseDescriptor(method.descriptor);
  const items = verified.codeItems;
  const labels = verified.labels;
  const constant = () => ({ params: new Set(), statics: new Set(), unknown: false });
  const unknown = () => ({ params: new Set(), statics: new Set(), unknown: true });
  const parameter = (index) => ({
    params: new Set([index]), statics: new Set(), unknown: false,
  });
  const staticValue = (index) => ({
    params: new Set(), statics: new Set([index]), unknown: false,
  });
  const copyValue = (value) => ({
    params: new Set(value.params), statics: new Set(value.statics),
    unknown: value.unknown,
  });
  const unionValue = (left, right) => ({
    params: new Set([...left.params, ...right.params]),
    statics: new Set([...left.statics, ...right.statics]),
    unknown: left.unknown || right.unknown,
  });
  const valueKey = (value) => `${value.unknown ? 1 : 0}:` +
    `${[...value.params].sort((a, b) => a - b).join(",")}:` +
    `${[...value.statics].sort((a, b) => a - b).join(",")}`;
  const cloneState = (state) => ({
    locals: state.locals.map(copyValue),
    stack: state.stack.map(copyValue),
  });
  const initial = {
    locals: Array.from({ length: verified.localsSize }, unknown),
    stack: [],
  };
  let slot = 0;
  descriptor.params.forEach((type, index) => {
    initial.locals[slot] = parameter(index);
    slot += type === "long" || type === "double" ? 2 : 1;
  });
  const states = new Array(items.length);
  states[0] = initial;
  const work = [0];
  const queued = new Set(work);
  const rowLoads = new Map();
  const mergeState = (index, incoming) => {
    if (!verified.reachable.has(index)) return;
    const existing = states[index];
    if (!existing) {
      states[index] = cloneState(incoming);
      if (!queued.has(index)) { queued.add(index); work.push(index); }
      return;
    }
    if (existing.stack.length !== incoming.stack.length) throw new Error("provenance stack join");
    let changed = false;
    for (let local = 0; local < existing.locals.length; local += 1) {
      const merged = unionValue(existing.locals[local], incoming.locals[local]);
      if (valueKey(merged) !== valueKey(existing.locals[local])) {
        existing.locals[local] = merged; changed = true;
      }
    }
    for (let stackIndex = 0; stackIndex < existing.stack.length; stackIndex += 1) {
      const merged = unionValue(existing.stack[stackIndex], incoming.stack[stackIndex]);
      if (valueKey(merged) !== valueKey(existing.stack[stackIndex])) {
        existing.stack[stackIndex] = merged; changed = true;
      }
    }
    if (changed && !queued.has(index)) { queued.add(index); work.push(index); }
  };
  try {
    while (work.length) {
      const index = work.shift();
      queued.delete(index);
      const state = cloneState(states[index]);
      const instruction = items[index] && items[index].instruction;
      const op = getOp(instruction);
      const pop = () => state.stack.pop();
      const push = (value) => state.stack.push(value);
      const binary = () => {
        const right = pop(), left = pop();
        if (!left || !right) throw new Error("provenance stack underflow");
        push(unionValue(left, right));
      };
      let terminal = false;
      if (!op || op === "nop") {
        // no effect
      } else if (/^[ai]load(?:_[0-3])?$/.test(op)) {
        push(copyValue(state.locals[localIndex(instruction, op)] || unknown()));
      } else if (/^[ai]store(?:_[0-3])?$/.test(op)) {
        const value = pop();
        if (!value) throw new Error("provenance stack underflow");
        state.locals[localIndex(instruction, op)] = value;
      } else if (op === "aconst_null" || /^iconst_(?:m1|[0-5])$/.test(op) ||
          ["bipush", "sipush"].includes(op)) {
        push(constant());
      } else if (op === "ldc" || op === "ldc_w") {
        push(typeof instruction.arg === "number" ? constant() : unknown());
      } else if (op === "checkcast") {
        // Provenance is unchanged.
      } else if (op === "dup") {
        const value = pop();
        if (!value) throw new Error("provenance stack underflow");
        push(copyValue(value)); push(value);
      } else if (op === "pop") {
        if (!pop()) throw new Error("provenance stack underflow");
      } else if (["iadd", "isub", "imul", "iand", "ior", "ixor",
          "ishl", "ishr", "iushr", "idiv", "irem"].includes(op)) {
        binary();
      } else if (op === "ineg") {
        if (!state.stack.length) throw new Error("provenance stack underflow");
      } else if (op === "iinc") {
        // Adding a constant retains the local's provenance.
      } else if (op === "getstatic") {
        const staticIndex = region.staticIndex.get(JSON.stringify(instruction.arg));
        push(staticIndex === undefined ? unknown() : staticValue(staticIndex));
      } else if (op === "putstatic") {
        if (!pop()) throw new Error("provenance stack underflow");
      } else if (op === "iaload") {
        const arrayIndex = pop(), array = pop();
        if (!arrayIndex || !array) throw new Error("provenance stack underflow");
        const previous = rowLoads.get(index);
        rowLoads.set(index, {
          array: previous ? unionValue(previous.array, array) : copyValue(array),
          index: previous ? unionValue(previous.index, arrayIndex) : copyValue(arrayIndex),
        });
        push(unknown());
      } else if (op === "iastore") {
        if (!pop() || !pop() || !pop()) throw new Error("provenance stack underflow");
      } else if (op === "invokestatic") {
        const parsed = parseDescriptor(instruction.arg[2][1]);
        for (let argument = 0; argument < parsed.params.length; argument += 1) {
          if (!pop()) throw new Error("provenance stack underflow");
        }
        if (parsed.returnType !== "void") push(unknown());
      } else if (op === "goto" || op === "goto_w") {
        terminal = true;
        mergeState(branchTarget(instruction, labels), state);
      } else if (op && op.startsWith("if")) {
        const operands = op.startsWith("if_icmp") || op.startsWith("if_acmp") ? 2 : 1;
        for (let operand = 0; operand < operands; operand += 1) {
          if (!pop()) throw new Error("provenance stack underflow");
        }
        terminal = true;
        mergeState(branchTarget(instruction, labels), state);
        if (index + 1 < items.length) mergeState(index + 1, state);
      } else if (op === "return" || op === "athrow") {
        terminal = true;
      } else {
        return null;
      }
      if (!terminal && index + 1 < items.length) mergeState(index + 1, state);
    }
  } catch (_) {
    return null;
  }
  const parameters = new Set();
  let matchedLoads = 0;
  for (const { array, index } of rowLoads.values()) {
    if (!array.statics.has(targetStatic)) continue;
    matchedLoads += 1;
    if (array.unknown || array.params.size || array.statics.size !== 1 ||
        index.unknown || index.statics.size) return null;
    for (const parameterIndex of index.params) parameters.add(parameterIndex);
  }
  return matchedLoads > 0 ? [...parameters].sort((a, b) => a - b) : null;
}

function comparedParameterConstants(method, verified, parameter) {
  let descriptor;
  try { descriptor = parseDescriptor(method.descriptor); } catch (_) { return []; }
  const parameterLocals = new Map();
  let slot = 0;
  descriptor.params.forEach((type, index) => {
    parameterLocals.set(slot, index);
    slot += type === "long" || type === "double" ? 2 : 1;
  });
  const alias = new Map(parameterLocals);
  const items = verified.codeItems;
  const load = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    return /^[ai]load(?:_[0-3])?$/.test(op) ? localIndex(instruction, op) : null;
  };
  const store = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    return /^[ai]store(?:_[0-3])?$/.test(op) ? localIndex(instruction, op) : null;
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 0; index + 1 < items.length; index += 1) {
      const source = load(index);
      const target = store(index + 1);
      if (source !== null && target !== null && alias.has(source)) alias.set(target, alias.get(source));
    }
  }
  const constant = (index) => {
    const instruction = items[index] && items[index].instruction;
    const op = getOp(instruction);
    const encoded = constantValue(instruction, op);
    if (encoded === null) return null;
    const value = Number(encoded);
    return Number.isInteger(value) ? value | 0 : null;
  };
  const values = new Set();
  for (let index = 0; index + 2 < items.length; index += 1) {
    const branch = getOp(items[index + 2] && items[index + 2].instruction);
    if (!branch || !branch.startsWith("if_icmp")) continue;
    const left = load(index);
    const right = load(index + 1);
    const leftConstant = constant(index);
    const rightConstant = constant(index + 1);
    if (left !== null && alias.get(left) === parameter && rightConstant !== null) {
      values.add(rightConstant);
    } else if (right !== null && alias.get(right) === parameter && leftConstant !== null) {
      values.add(leftConstant);
    }
  }
  return [...values];
}

function createPositionalInvoker(length) {
  if (!Number.isInteger(length) || length < 0 || length > 64) throw new Error("invalid arity");
  const args = Array.from({ length }, (_, index) => `stack[base+${index}]`);
  return new Function("kernel", "stack", "base", "state", "region", "helpers",
    `return kernel(state,region,helpers,${args.join(",")});`);
}

function memberKey(ref) {
  return ref && `${ref.owner}\0${ref.name}\0${ref.descriptor}`;
}

function repeatedCallGroups(calls) {
  const groups = new Map();
  for (const call of calls || []) {
    const key = memberKey(call);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, calls: grouped }))
    .sort((left, right) => right.calls.length - left.calls.length);
}

function hasArrayStoreLoop(verified) {
  let store = false;
  let backward = false;
  for (const index of verified.reachable) {
    const instruction = verified.codeItems[index]?.instruction;
    const op = getOp(instruction);
    if (op === "iastore") store = true;
    if ((op === "goto" || op === "goto_w" || op && op.startsWith("if")) &&
        branchTarget(instruction, verified.labels) <= index) backward = true;
  }
  return store && backward;
}

function readStatic(target) {
  return target.kind === "map" ? target.fields.get(target.key) : target.fields[target.key];
}

function validMemberRef(arg) {
  return Array.isArray(arg) && typeof arg[1] === "string" &&
    Array.isArray(arg[2]) && typeof arg[2][0] === "string" && typeof arg[2][1] === "string";
}

function isIntType(type) {
  return ["boolean", "byte", "char", "short", "int"].includes(type);
}

function localIndex(instruction, op) {
  if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
    return Number(instruction.arg);
  }
  const match = /_([0-3])$/.exec(op || "");
  return match ? Number(match[1]) : NaN;
}

function constantValue(instruction, op) {
  if (op === "iconst_m1") return "-1";
  if (/^iconst_[0-5]$/.test(op)) return op.slice(-1);
  if (!instruction || typeof instruction !== "object") return null;
  const value = Number(instruction.arg);
  return Number.isFinite(value) ? JSON.stringify(value) : null;
}

function getOp(instruction) {
  return typeof instruction === "string" ? instruction : instruction && instruction.op;
}

function buildLabelMap(codeItems) {
  const labels = new Map();
  codeItems.forEach((item, index) => {
    if (item && item.labelDef) labels.set(item.labelDef.replace(/:$/, ""), index);
  });
  return labels;
}

function branchTarget(instruction, labels) {
  if (!instruction || typeof instruction !== "object") return undefined;
  return labels.get(Array.isArray(instruction.arg) ? instruction.arg[0] : instruction.arg);
}

function normalReachable(codeItems, labels) {
  const pending = [0];
  const seen = new Set();
  while (pending.length) {
    const index = pending.pop();
    if (index < 0 || index >= codeItems.length || seen.has(index)) continue;
    seen.add(index);
    const instruction = codeItems[index] && codeItems[index].instruction;
    const op = getOp(instruction);
    if (op === "return" || op === "athrow") continue;
    if (op === "goto" || op === "goto_w") {
      pending.push(branchTarget(instruction, labels));
      continue;
    }
    if (op && op.startsWith("if")) pending.push(branchTarget(instruction, labels));
    pending.push(index + 1);
  }
  return seen;
}

function computeStackDepths(codeItems, labels) {
  if (!codeItems.length) return null;
  const depths = new Array(codeItems.length);
  const pending = [0];
  depths[0] = 0;
  while (pending.length) {
    const index = pending.pop();
    const instruction = codeItems[index] && codeItems[index].instruction;
    const op = getOp(instruction);
    const effect = stackEffect(instruction);
    if (effect === null) return null;
    const after = depths[index] + effect;
    if (after < 0) return null;
    const successors = [];
    if (op === "goto" || op === "goto_w") successors.push(branchTarget(instruction, labels));
    else if (op && op.startsWith("if")) successors.push(index + 1, branchTarget(instruction, labels));
    else if (op !== "return" && op !== "athrow" && index + 1 < codeItems.length) successors.push(index + 1);
    for (const successor of successors) {
      if (successor === undefined || successor < 0 || successor >= codeItems.length) return null;
      if (depths[successor] === undefined) {
        depths[successor] = after; pending.push(successor);
      } else if (depths[successor] !== after) return null;
    }
  }
  return depths;
}

function stackEffect(instruction) {
  const op = getOp(instruction);
  if (!op || op === "nop" || op === "iinc" || op === "goto" || op === "goto_w" ||
      op === "checkcast") return 0;
  if (/^[ai]load(?:_[0-3])?$/.test(op) || /^iconst_(?:m1|[0-5])$/.test(op) ||
      op === "aconst_null" || op === "bipush" || op === "sipush" || op === "ldc" ||
      op === "ldc_w" || op === "getstatic") return 1;
  if (/^[ai]store(?:_[0-3])?$/.test(op) || op === "pop" || op === "putstatic") return -1;
  if (op === "dup") return 1;
  if (["iadd", "isub", "imul", "idiv", "irem", "iand", "ior", "ishl", "ishr",
    "iushr", "ixor", "iaload"].includes(op)) return -1;
  if (op === "iastore") return -3;
  if (op === "ineg") return 0;
  if (op.startsWith("if_icmp")) return -2;
  if (["ifeq", "ifne", "iflt", "ifge", "ifgt", "ifle"].includes(op)) return -1;
  if (op === "return") return 0;
  if (op === "athrow") return -1;
  if (op === "invokestatic" && validMemberRef(instruction.arg)) {
    const parsed = parseDescriptor(instruction.arg[2][1]);
    return -parsed.params.length + (parsed.returnType === "void" ? 0 : 1);
  }
  return null;
}

FusedRegionCompiler.BAILOUT = BAILOUT;
FusedRegionCompiler._test = { buildLabelMap, computeStackDepths, normalReachable,
  repeatedCallGroups, hasArrayStoreLoop };

module.exports = FusedRegionCompiler;
