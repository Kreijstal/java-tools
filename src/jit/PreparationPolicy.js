"use strict";

function methodIdentitySet(values, name) {
  const keys = values ?? [];
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !key.trim())) {
    throw new TypeError(`${name} must be an array of nonempty method identities`);
  }
  return new Set(keys);
}

// Launchers supply identities and measured priorities; the JVM knows no games.
// Preparation selection, not dead-code removal: unselected code retains the
// ordinary execution paths. Follow bytecode calls, active class uses and virtual
// implementations on allocated types. Unknown native/dynamic targets remain
// runtime work, rather than turning a bounded preparation scope into everything.
function reachablePreparationMethods(methods, roots, classes) {
  methodIdentitySet(roots, "preparationPolicy.entryMethods");
  if (!classes) throw new TypeError("entryMethods requires loaded classes");
  const headers = new Map(Object.entries(classes).map(([name, data]) =>
    [name, data?.ast?.classes?.[0]]));
  const index = new Map();
  for (const [className, header] of headers) {
    for (const item of header?.items || []) {
      if (item.type === "method") index.set(
        `${className}.${item.method.name}${item.method.descriptor}`, {className, method:item.method});
    }
  }
  const seen = new Set(), initialized = new Set(), queue = [];
  const allocated = new Set(), virtualSites = [];
  const add = entry => { if (entry && !seen.has(entry.method)) {
    seen.add(entry.method); queue.push(entry);
  }};
  const initialize = name => {
    if (!name || initialized.has(name)) return;
    initialized.add(name);
    const header = headers.get(name);
    initialize(header?.superClassName);
    for (const parent of header?.interfaces || []) initialize(parent);
    add(index.get(`${name}.<clinit>()V`));
  };
  const resolve = (owner, name, descriptor, visited = new Set()) => {
    if (!owner || visited.has(owner)) return null;
    visited.add(owner);
    const own = index.get(`${owner}.${name}${descriptor}`);
    if (own || name === "<init>") return own;
    const header = headers.get(owner);
    for (const parent of [header?.superClassName, ...(header?.interfaces || [])]) {
      const target = resolve(parent, name, descriptor, visited);
      if (target) return target;
    }
    return null;
  };
  const subtype = (name, target, visited = new Set()) => {
    if (name === target) return true;
    if (!name || visited.has(name)) return false;
    visited.add(name);
    const header = headers.get(name);
    return [header?.superClassName, ...(header?.interfaces || [])]
      .some(parent => subtype(parent, target, visited));
  };
  const allocate = owner => {
    initialize(owner);
    if (allocated.has(owner)) return;
    allocated.add(owner);
    // A factory reached later can provide receivers for an earlier call site.
    for (const [type, name, descriptor] of virtualSites) {
      if (subtype(owner, type)) add(resolve(owner, name, descriptor));
    }
  };
  for (const key of roots) {
    const entry = index.get(key);
    if (!entry) throw new TypeError(`Unknown preparation entry method: ${key}`);
    initialize(entry.className); add(entry);
    if (!(entry.method.flags || []).includes("static")) allocate(entry.className);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const {method} = queue[cursor];
    const code = method.attributes?.find(attribute => attribute.type === "code")?.code;
    for (const item of code?.codeItems || []) {
      const instruction = item.instruction;
      const op = typeof instruction === "string" ? instruction : instruction?.op;
      const arg = instruction?.arg;
      if (op === "new") allocate(Array.isArray(arg) ? arg[1] : arg);
      if (["getstatic", "putstatic"].includes(op)) initialize(arg?.[1]);
      if (!["invokestatic", "invokespecial", "invokevirtual", "invokeinterface"].includes(op)) continue;
      if (!Array.isArray(arg?.[2])) continue;
      const [, owner, [name, descriptor]] = arg;
      const target = resolve(owner, name, descriptor);
      if (op === "invokestatic") initialize(target?.className || owner);
      add(target);
      if (op === "invokevirtual" || op === "invokeinterface") {
        virtualSites.push([owner, name, descriptor]);
        for (const candidate of allocated) {
          if (subtype(candidate, owner)) add(resolve(candidate, name, descriptor));
        }
      }
    }
  }
  return methods.filter(entry => seen.has(entry.method));
}

function applyPreparationPolicy(methods, policy = {}, classes = null) {
  if (policy.entryMethods !== undefined) {
    methods = reachablePreparationMethods(methods, policy.entryMethods, classes);
  }
  const limit = policy.maxMethods ?? methods.length;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("preparationPolicy.maxMethods must be a nonnegative integer");
  }
  const priorities = policy.priorityMethods ?? [];
  if (!Array.isArray(priorities) || priorities.some(key => typeof key !== "string")) {
    throw new TypeError("preparationPolicy.priorityMethods must be an array of method identities");
  }
  const rank = new Map(priorities.map((key, index) => [key, index]));
  const score = ({className, method}) => rank.get(
    `${className}.${method.name}${method.descriptor}`) ?? Infinity;
  return methods.slice().sort((a, b) => score(a) - score(b)).slice(0, limit);
}

module.exports = {applyPreparationPolicy, methodIdentitySet, reachablePreparationMethods};
