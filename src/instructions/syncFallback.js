// A warm opcode handler returns this before consuming operands when loading
// or initialization must continue through the asynchronous dispatcher.
module.exports = Symbol("syncStaticFallback");
