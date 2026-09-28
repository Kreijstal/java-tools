"use strict";

function methodIdentitySet(values, name) {
  const keys = values ?? [];
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !key.trim())) {
    throw new TypeError(`${name} must be an array of nonempty method identities`);
  }
  return new Set(keys);
}

// Launchers supply identities and measured priorities; the JVM knows no games.
function applyPreparationPolicy(methods, policy = {}) {
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

module.exports = {applyPreparationPolicy, methodIdentitySet};
