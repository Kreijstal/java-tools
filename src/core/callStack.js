const Stack = require('./stack');
const { enumerateFieldKeys, readField } = require('./objectModel');

// ACC_SYNCHRONIZED is not expressed in bytecode: the monitor is implied by the
// method flag, so the runtime owns entering and leaving it. A frame can retire
// through an interpreted return, a generated (JIT/wasm) return, or an exception
// unwind -- but every one of those pops the frame. Releasing here means the
// generated tiers need no per-return bookkeeping and cannot leak the monitor.
//
// The owning thread id is recorded on the frame at acquisition rather than
// passed in, because a pop site does not always have the thread to hand.
function releaseFrameMonitor(frame) {
  frame.monitorEntered = false;
  const monitor = frame.monitorObject;
  // Frames are pooled and reused across call sites with different receivers, so
  // a cached monitor must not outlive the acquisition that computed it.
  frame.monitorObject = null;
  if (!monitor) return;
  // Object.wait() hands the monitor to another thread while the frame is still
  // on the stack; that thread owns it now, so this frame must not release it.
  if (monitor.lockOwner !== frame.monitorOwnerThreadId) return;
  monitor.lockCount--;
  if (monitor.lockCount <= 0) {
    monitor.lockCount = 0;
    monitor.isLocked = false;
    monitor.lockOwner = null;
  }
}

// JVM_DEBUG_INVOKE_TRACE=hi.a,i.a logs every entry to the named methods with
// the guest fields named by JVM_DEBUG_INVOKE_FIELDS (default "f") read off any
// object local. Reconstructing the real call order across tiers is otherwise
// guesswork: a shared-buffer producer and consumer can interleave wrongly
// without either one faulting where the interleaving happened.
const DEBUG_INVOKE_TRACE = (typeof process !== "undefined" &&
  process.env && process.env.JVM_DEBUG_INVOKE_TRACE) || "";
const DEBUG_INVOKE_FIELDS = ((typeof process !== "undefined" &&
  process.env && process.env.JVM_DEBUG_INVOKE_FIELDS) || "f")
  .split(",").map((entry) => entry.trim()).filter(Boolean);
const DEBUG_INVOKE_WANTED = new Set(
  DEBUG_INVOKE_TRACE.split(",").map((entry) => entry.trim()).filter(Boolean));
let debugInvokeSeq = 0;

function traceInvoke(frame) {
  const method = frame && frame.method;
  if (!method) return;
  const owner = frame.className || method.className || "?";
  if (!DEBUG_INVOKE_WANTED.has(`${owner}.${method.name}`) &&
      !DEBUG_INVOKE_WANTED.has(owner)) return;
  const seen = [];
  (frame.locals || []).forEach((item, slot) => {
    // Primitive parameters are the guard values most traces are chasing; an
    // object-only dump silently hides the boolean that decided the branch.
    if (typeof item === "number" || typeof item === "boolean") {
      seen.push(`${slot}=${item}`);
      return;
    }
    if (item === null) {
      seen.push(`${slot}=null`);
      return;
    }
    if (!item || typeof item !== "object") return;
    if (!item.fields) {
      seen.push(`${slot}=<${item.type || typeof item}>`);
      return;
    }
    seen.push(`${slot}=<${item.type || "obj"}>`);
    for (const key of enumerateFieldKeys(item.fields)) {
      if (!DEBUG_INVOKE_FIELDS.includes(String(key).split(".").pop())) continue;
      seen.push(`${slot}:${key}=${readField(item.fields, key)}`);
    }
  });
  debugInvokeSeq += 1;
  console.error(`[invoke] #${debugInvokeSeq} ${owner}.${method.name}`
    + `${method.descriptor || ""} ${seen.join(" ")}`);
}

// Handoff census (diagnostic; JIT option asyncCallCensus). A generated caller
// that cannot complete a call in place hands it to the scheduler, which pushes
// the callee frame and runs it outside the caller's body. The census charges
// the wall time between that push and the callee's pop to the handoff that
// caused it -- the caller's site, callee and reason -- exclusive of any nested
// handoff below it, so the per-handoff figures add up to at most the window
// and never double-count nested execution. Off unless a JIT installs it.
let handoffCensus = null;
const handoffNow = () => (typeof performance !== "undefined" && performance &&
  typeof performance.now === "function") ? performance.now() : Date.now();

class CallStack extends Stack {
  push(frame) {
    if (DEBUG_INVOKE_TRACE) traceInvoke(frame);
    if (handoffCensus !== null) this.censusPush(frame);
    return super.push(frame);
  }

  // Every method return goes through here.
  pop() {
    const items = this.items;
    if (items.length === 0) {
      throw new Error("Stack underflow");
    }
    const frame = items.pop();
    if (frame !== undefined && frame.monitorEntered === true) {
      releaseFrameMonitor(frame);
    }
    if (handoffCensus !== null && frame !== undefined &&
        frame.jitHandoffRecord !== undefined) this.censusPop(frame);
    return frame;
  }

  censusPush(frame) {
    // Frames are pooled: a reused frame must not carry a stale charge.
    frame.jitHandoffRecord = undefined;
    frame.jitHandoffPending = undefined;
    const items = this.items;
    const parent = items[items.length - 1];
    const pending = parent && parent.jitHandoffPending;
    if (!pending) return;
    parent.jitHandoffPending = undefined;
    // The child the scheduler pushes for the handed-off call is the call's
    // own member; anything else is a stale mark left by a call that completed
    // without a child frame (a structured caller's pc is not materialized at
    // the handoff, so the pc cannot be the check).
    const method = frame.method;
    if (!method || method.name !== pending.methodName ||
        method.descriptor !== pending.descriptor) return;
    const record = { key: pending.key, start: pending.at, child: 0 };
    frame.jitHandoffRecord = record;
    if (this.handoffActive === undefined) this.handoffActive = [];
    this.handoffActive.push(record);
  }

  censusPop(frame) {
    const record = frame.jitHandoffRecord;
    frame.jitHandoffRecord = undefined;
    const active = this.handoffActive;
    if (!active) return;
    const index = active.lastIndexOf(record);
    if (index < 0) return;
    // Deeper records that never popped (frames dropped by an unwind) stay
    // inside this record's exclusive time.
    active.length = index;
    const elapsed = handoffNow() - record.start;
    if (index > 0) active[index - 1].child += elapsed;
    handoffCensus.record(record.key, elapsed - record.child, elapsed);
  }
}

module.exports = CallStack;
module.exports.setHandoffCensus = (census) => { handoffCensus = census || null; };
module.exports.handoffNow = handoffNow;
module.exports.releaseFrameMonitor = releaseFrameMonitor;
