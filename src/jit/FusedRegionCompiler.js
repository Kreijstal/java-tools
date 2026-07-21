const { parseDescriptor } = require("../parsing/typeParser");
const HandwrittenFusedGradient = require("./HandwrittenFusedGradient");

const FAMILY_BY_WRAPPER = new Map([
  ["(IIIIIIIIIIIIZIII)V", {
    name: "gradient",
    wrapper: "(IIIIIIIIIIIIZIII)V",
    raster: "(IIIIIIIBIIII[IIIII)V",
    scanline: "(IIIIIII[III)V",
    wrapperCalls: 6,
    rasterCalls: 6,
  }],
  ["(IIIIIIII)V", {
    name: "flat-color",
    wrapper: "(IIIIIIII)V",
    raster: "(IIIIIBII[I)V",
    scanline: "(IB[III)V",
    wrapperCalls: 6,
    rasterCalls: 6,
  }],
]);

const BAILOUT = Symbol("jit.fused.bailout");

class FusedRegionCompiler {
  constructor(jit, options = {}) {
    this.jit = jit;
    this.jvm = jit.jvm;
    this.enabled = options.fusedRegions === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_FUSED_REGIONS === "1");
    this.handwrittenKernelsEnabled = options.handwrittenFusedKernels !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_HANDWRITTEN_FUSED === "1");
    this.cache = new WeakMap();
  }

  tryInvoke(site, target, frame, thread) {
    const family = site.op === "invokestatic" && FAMILY_BY_WRAPPER.get(site.descriptor);
    if (!family) return { matched: false };
    if (!this.enabled) {
      this.jit.fusedGuardedFallbackCount += 1;
      return { matched: true, handled: false };
    }

    let region = this.cache.get(target.method);
    if (region === undefined) {
      region = this.compile(target.method, target.lookupClass, family) || null;
      // Callees are commonly loaded by the first baseline invocation. Cache
      // only a completed region so that class loading is a transient guard,
      // not a permanent rejection of an otherwise valid method family.
      if (region) this.cache.set(target.method, region);
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
        `fused-${family.name}`)
      : null;
    const wrapperKernel = region.handwrittenWrapperKernel &&
      this.handwrittenKernelsEnabled
      ? region.handwrittenWrapperKernel : region.wrapperKernel;
    try {
      invokePositionalFromStack(wrapperKernel, frame.stack.items, base,
        site.params.length, state, region, this.jit);
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

  compile(wrapperMethod, wrapperOwner, family) {
    const wrapper = this.verifyMethod(wrapperMethod, family, "wrapper");
    if (!wrapper) return null;
    const rasterRef = wrapper.calls.find((call) => call.descriptor === family.raster);
    if (!rasterRef) return null;
    const rasterMethod = this.resolveMethod(rasterRef);
    if (!rasterMethod) return null;
    const raster = this.verifyMethod(rasterMethod, family, "raster");
    if (!raster) return null;
    const scanlineRef = raster.calls.find((call) => call.descriptor === family.scanline);
    if (!scanlineRef) return null;
    const scanlineMethod = this.resolveMethod(scanlineRef);
    if (!scanlineMethod || !this.jit.getSynchronousIntrinsic(scanlineMethod, family.scanline)) {
      return null;
    }

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

    try {
      region.rasterKernel = this.compileKernel(rasterMethod, raster, region, "raster");
      region.wrapperKernel = this.compileKernel(wrapperMethod, wrapper, region, "wrapper");
    } catch (_) {
      return null;
    }
    if (this.handwrittenKernelsEnabled && family.name === "gradient" &&
        HandwrittenFusedGradient.matches(this.jit, region)) {
      // Kept separate from wrapperKernel so the probe can live-toggle
      // handwrittenKernelsEnabled per run for differential attribution.
      region.handwrittenWrapperKernel =
        HandwrittenFusedGradient.install(region, this.jit);
      this.jit.handwrittenFusedRegionCount =
        (this.jit.handwrittenFusedRegionCount | 0) + 1;
    }
    return region;
  }

  verifyMethod(method, family, role) {
    if (!method || method.descriptor !== (role === "wrapper" ? family.wrapper : family.raster)) {
      return null;
    }
    const codeAttr = method.attributes && method.attributes.find((attr) => attr.type === "code");
    if (!codeAttr || !codeAttr.code) return null;
    const codeItems = this.jit.getCodeItems(method);
    const labels = buildLabelMap(codeItems);
    const depths = computeStackDepths(codeItems, labels);
    if (!depths) return null;
    const reachable = normalReachable(codeItems, labels);
    const allowed = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "bipush", "checkcast", "dup", "getstatic", "goto", "goto_w",
      "iadd", "iaload", "iconst_m1", "iconst_0", "iconst_1", "idiv",
      "if_icmpeq", "if_icmpge", "if_icmpgt", "if_icmple", "if_icmplt",
      "if_icmpne", "ifeq", "ifge", "ifgt", "ifle", "iflt", "ifne",
      "iinc", "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "imul", "ineg", "invokestatic", "ishl", "ishr", "istore",
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
    const expected = role === "wrapper" ? family.raster : family.scanline;
    const expectedCount = role === "wrapper" ? family.wrapperCalls : family.rasterCalls;
    if (calls.filter((call) => call.descriptor === expected).length !== expectedCount) return null;
    if (new Set(calls.filter((call) => call.descriptor === expected)
      .map((call) => `${call.owner}\0${call.name}`)).size !== 1) return null;
    const otherCalls = calls.filter((call) => call.descriptor !== expected);
    if (role === "wrapper" && otherCalls.length !== 0) return null;
    for (const call of otherCalls) {
      call.native = this.jvm._jreFindMethod(call.owner, call.name, call.descriptor);
      call.kind = typeof call.native === "function" && call.descriptor === "(II)I"
        ? "integer-native" : "early-bailout";
    }
    if (role === "raster" &&
        otherCalls.filter((call) => call.kind === "integer-native").length !== 1) return null;
    if (role === "raster" &&
        otherCalls.filter((call) => call.kind === "early-bailout").length > 1) return null;
    const firstEffect = Math.min(...calls.filter((call) => call.descriptor === expected)
      .map((call) => call.index));
    if (otherCalls.some((call) => call.kind === "early-bailout" && call.index > firstEffect)) {
      return null;
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
    if (!thread || thread.status !== "runnable" || !thread.callStack ||
        thread.callStack.isEmpty() || thread.callStack.peek() !== frame) return false;
    const debug = this.jvm.debugManager;
    if (!debug || debug.debugMode || debug.breakpoints.size > 0 ||
        debug.hasLocatedBreakpoints && debug.hasLocatedBreakpoints()) return false;
    if (typeof process !== "undefined" && process.env &&
        (process.env.JVM_TRACE || process.env.JVM_PROFILE_HOT_METHODS === "1" ||
         process.env.JVM_PROFILE_HOT_METHODS_WITH_JIT === "1")) return false;
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
    for (const target of region.falseGuardTargets) {
      if (readStatic(target)) return false;
    }
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

  compileKernel(method, verified, region, role) {
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
        } else if (/^istore(?:_[0-3])?$/.test(op)) {
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
        else if (op === "ixor") binary((a, b) => `(${a}^${b})`);
        else if (op === "ishl") binary((a, b) => `(${a}<<(${b}&31))`);
        else if (op === "ishr") binary((a, b) => `(${a}>>(${b}&31))`);
        else if (op === "ineg") {
          const value = pop(); expressions.push(`((-${value})|0)`);
        } else if (op === "idiv") {
          const divisorExpression = pop(); const dividend = pop(); const divisor = temp();
          body.push(`const ${divisor}=${divisorExpression};`);
          body.push(`if (${divisor}===0) ${captureThrow(index, [dividend, divisor],
            '{type:"java/lang/ArithmeticException",message:"/ by zero"}')}`);
          expressions.push(`((${dividend}/${divisor})|0)`);
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
        } else if (op === "invokestatic") {
          const parsed = parseDescriptor(instruction.arg[2][1]);
          const args = expressions.splice(expressions.length - parsed.params.length);
          const callDescriptor = instruction.arg[2][1];
          if (role === "wrapper" && callDescriptor === region.family.raster) {
            body.push(`state.outerPc=${index + 1};state.outerExtra=l${verified.localsSize - 1};`);
            body.push(`region.rasterKernel(state,region,helpers,${args.join(",")});`);
          } else if (role === "raster" && callDescriptor === region.family.scanline) {
            // The scanline bytecode shape was verified against the structural
            // intrinsic above. Emit its loop into the raster kernel so every
            // triangle does not bounce through six JavaScript helper calls.
            const values = args.map(() => temp());
            body.push("{");
            args.forEach((argument, argumentIndex) => {
              body.push(`const ${values[argumentIndex]}=${argument};`);
            });
            if (region.family.name === "gradient") {
              const [green, scanIndex, greenStep, redStep, red, count, tag,
                dest, blue, blueStep] = values;
              const offset = temp();
              body.push(`if((${tag}|0)!==9)throw helpers.fusedBailout();`);
              body.push(`if(${dest}==null)${captureThrow(index, values,
                '{type:"java/lang/NullPointerException",message:null}')}`);
              body.push(`let ${scanIndex}Value=${scanIndex}|0,${count}Value=${count}|0;`);
              body.push(`let ${green}Value=${green}|0,${red}Value=${red}|0,${blue}Value=${blue}|0;`);
              body.push(`const ${greenStep}Value=${greenStep}|0,${redStep}Value=${redStep}|0,${blueStep}Value=${blueStep}|0;`);
              body.push(`if(${count}Value>0){`);
              body.push(`if(${scanIndex}Value<0||${scanIndex}Value+${count}Value>${dest}.length)${captureThrow(index,
                values, '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}')}`);
              body.push(`for(let ${offset}=0;${offset}<${count}Value;${offset}+=1){`);
              body.push(`${dest}[${scanIndex}Value]=(((${dest}[${scanIndex}Value]>>1)&8355711)+((${green}Value>>9)&65280)+((${red}Value>>1)&16711680)+((${blue}Value>>17)&255))|0;`);
              body.push(`${scanIndex}Value+=1;${green}Value=(${green}Value+${greenStep}Value)|0;${red}Value=(${red}Value+${redStep}Value)|0;${blue}Value=(${blue}Value+${blueStep}Value)|0;`);
              body.push("}", "}");
            } else {
              const [scanIndex, tag, dest, color, count] = values;
              const offset = temp();
              body.push(`if((${tag}|0)!==57)throw helpers.fusedBailout();`);
              body.push(`if(${dest}==null)${captureThrow(index, values,
                '{type:"java/lang/NullPointerException",message:null}')}`);
              body.push(`let ${scanIndex}Value=${scanIndex}|0;const ${color}Value=${color}|0,${count}Value=${count}|0;`);
              body.push(`if(${count}Value>0){`);
              body.push(`if(${scanIndex}Value<0||${scanIndex}Value+${count}Value>${dest}.length)${captureThrow(index,
                values, '{type:"java/lang/ArrayIndexOutOfBoundsException",message:null}')}`);
              body.push(`for(let ${offset}=0;${offset}<${count}Value;${offset}+=1){${dest}[${scanIndex}Value]=(${color}Value+((${dest}[${scanIndex}Value]&16711422)>>1))|0;${scanIndex}Value+=1;}`);
              body.push("}");
            }
            body.push("}");
          } else if (callByIndex.get(index) && callByIndex.get(index).kind === "integer-native") {
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
              !(callByIndex.get(index) && callByIndex.get(index).kind === "integer-native") &&
              !(callByIndex.get(index) && callByIndex.get(index).kind === "early-bailout") &&
              callDescriptor !== region.family.scanline) throw new Error("unsupported call result");
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
}

function invokePositionalFromStack(kernel, stack, base, length, state, region, helpers) {
  switch (length) {
    case 8: return kernel(state, region, helpers,
      stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
      stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7]);
    case 16: return kernel(state, region, helpers,
      stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
      stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
      stack[base + 8], stack[base + 9], stack[base + 10], stack[base + 11],
      stack[base + 12], stack[base + 13], stack[base + 14], stack[base + 15]);
    default: throw BAILOUT;
  }
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
  if (/^istore(?:_[0-3])?$/.test(op) || op === "pop" || op === "putstatic") return -1;
  if (op === "dup") return 1;
  if (["iadd", "isub", "imul", "idiv", "ishl", "ishr", "ixor", "iaload"].includes(op)) return -1;
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
FusedRegionCompiler.FAMILY_BY_WRAPPER = FAMILY_BY_WRAPPER;
FusedRegionCompiler._test = { buildLabelMap, computeStackDepths, normalReachable };

module.exports = FusedRegionCompiler;
