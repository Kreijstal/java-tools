"use strict";

// Accounting for explicit source/transport metadata on published generated
// functions, not V8's executable code, closures, or total JavaScript heap.
// A cumulative allowance deliberately never refunds replaced bodies: active
// continuations may still own them. No strong references to bodies are kept.
class InstalledSourceRetention {
  constructor(options = {}) {
    this.limit = options.generatedCodeBudgetBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0) {
      throw new RangeError("generatedCodeBudgetBytes must be a nonnegative integer");
    }
    this.retain = options.retainInstalledSource !== false &&
      (options.retainCompilerDiagnostics !== false ||
        options.hotCallGraphRegions === true ||
        (typeof process !== "undefined" && process.env?.JVM_ENABLE_HOT_CALL_GRAPH_REGIONS === "1"));
    this.bytes = 0;
    this.strippedBodies = 0;
    this.seen = new WeakSet();
  }

  apply(body) {
    if (typeof body !== "function" || this.seen.has(body)) return;
    this.seen.add(body);
    const keys = InstalledSourceRetention.sourceKeys;
    let bytes = 0;
    for (const key of keys) {
      const value = body[key];
      if (value != null) bytes += 2 * (typeof value === "string"
        ? value.length : JSON.stringify(value).length);
    }
    if (this.retain && bytes <= this.limit - this.bytes) {
      this.bytes += bytes;
    } else {
      for (const key of keys) delete body[key];
      this.strippedBodies += 1;
    }
    // Only function-valued metadata, never live link records or method ASTs.
    for (const key of Object.keys(body)) {
      if (key.startsWith("jvm") && typeof body[key] === "function") this.apply(body[key]);
    }
  }
}

InstalledSourceRetention.sourceKeys = Object.freeze([
      "jvmGeneratedSource", "jvmHoistedSource", "jvmCaptureDescriptors",
      "jvmStructuredSource", "jvmAdaptivePositionalSource",
      "jvmHotCallGraphRegionSource",
      "jvmDirectPositionalSource", "jvmInternalRegionPositionalSource",
      "jvmRestoringDirectPositionalSource", "jvmHotCallGraphFramedSource",
      "jvmCheckedLeafDirectPositionalSource",
      "jvmTrustedCheckedLeafDirectPositionalSource",
      "jvmPreflightedCheckedLeafDirectPositionalSource",
      "jvmCapturedCheckedLeafDirectPositionalSource",
      "jvmStructuredRecursiveArrayPartitionWorkerSource",
]);

module.exports = InstalledSourceRetention;
