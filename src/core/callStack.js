const Stack = require('./stack');

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
    if (!item || typeof item !== "object" || !item.fields) return;
    for (const key of Object.keys(item.fields)) {
      if (!DEBUG_INVOKE_FIELDS.includes(String(key).split(".").pop())) continue;
      seen.push(`${slot}:${key}=${item.fields[key]}`);
    }
  });
  debugInvokeSeq += 1;
  console.error(`[invoke] #${debugInvokeSeq} ${owner}.${method.name}`
    + `${method.descriptor || ""} ${seen.join(" ")}`);
}

class CallStack extends Stack {
  push(frame) {
    if (DEBUG_INVOKE_TRACE) traceInvoke(frame);
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
    return frame;
  }
}

module.exports = CallStack;
module.exports.releaseFrameMonitor = releaseFrameMonitor;
