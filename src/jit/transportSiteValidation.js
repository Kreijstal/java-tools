'use strict';

// Compare symbolic identities before a transported result mutates the JIT's
// numbered tables. This is not resolution: native/static binding may still
// fail later, so callers must not treat this as a complete install transaction.
function fieldSiteMatches(existing, entry) {
  return existing.className === entry.className &&
    existing.fieldName === entry.fieldName &&
    existing.descriptor === entry.descriptor;
}

function callSiteMatches(existing, entry, callerMethod = null) {
  return existing.declaredClassName === entry.className &&
    existing.methodName === entry.methodName &&
    existing.descriptor === entry.descriptor && existing.op === entry.op &&
    (existing.callerPc ?? null) === (entry.callerPc ?? null) &&
    (existing.callerMethod ?? null) === callerMethod;
}

function sameSlots(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOwners(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const owners = new Set(left), incoming = new Set(right);
  return owners.size === incoming.size && [...incoming].every(owner => owners.has(owner));
}

function conflictInTable(entries, current, matches, project = entry => entry) {
  const incoming = new Map();
  for (const entry of entries || []) {
    const existing = incoming.get(entry.index) || current[entry.index];
    if (existing && !matches(existing, entry)) return entry.index;
    incoming.set(entry.index, project(entry));
  }
  return null;
}

function preflightTransportSites(jit, tables, callerMethod = null) {
  let index = conflictInTable(tables.fieldSites, jit.fieldSites, fieldSiteMatches);
  if (index !== null) return `field site ${index} has conflicting identity`;
  index = conflictInTable(tables.syncCallSites, jit.syncCallSites,
    (existing, entry) => callSiteMatches(existing, entry, callerMethod),
    entry => ({...entry, declaredClassName: entry.className, callerMethod}));
  if (index !== null) return `call site ${index} has conflicting invocation identity`;
  index = conflictInTable(tables.classInitializationGuards,
    jit.structuredSsa.classInitializationGuards,
    (existing, entry) => sameOwners(existing.owners, entry.owners));
  if (index !== null) return `initialization guard ${index} has conflicting owners`;
  index = conflictInTable(tables.restoringFrameLayouts,
    jit.structuredSsa.restoringFrameLayouts,
    (existing, entry) => sameSlots(existing, entry.slots), entry => entry.slots);
  if (index !== null) return `restoring frame layout ${index} has conflicting slots`;
  return null;
}

module.exports = {fieldSiteMatches, callSiteMatches, preflightTransportSites};
