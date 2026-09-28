'use strict';

// A synchronous JIT probe may discover a Promise only after the native has
// performed its side effects. Keep that invocation on the guest thread until
// the canonical invoke path can await it; retrying the native loses reads and
// duplicates writes. Repeated fast-path probes must see the same result too.
function invokeNative(method, jvm, receiver, args, thread, speculative = false) {
  const pending = thread && thread.pendingNativeInvocation;
  if (pending) {
    if (pending.method !== method || pending.receiver !== receiver ||
        pending.args.length !== args.length ||
        pending.args.some((value, index) => !Object.is(value, args[index]))) {
      throw new Error('Native fallback does not match the pending invocation');
    }
    if (!speculative) thread.pendingNativeInvocation = undefined;
    return pending.result;
  }
  const result = method(jvm, receiver, args, thread);
  if (speculative && result && typeof result.then === 'function') {
    thread.pendingNativeInvocation = {method, receiver, args, result};
    // The scheduler may yield before the canonical path attaches its handler.
    // Observe rejection now without changing what that path will await.
    Promise.resolve(result).catch(() => {});
  }
  return result;
}

module.exports = {invokeNative};
