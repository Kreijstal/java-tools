"use strict";

// Names an inline integer plan is rendered against. The plan is built once
// per callee; each structured call site binds these names to its own operands
// by declaration, so the rendered statements are never rewritten.
function inlineIntegerArgumentName(position) {
  return `ssaInlineIntegerArgument${position}`;
}

module.exports = { inlineIntegerArgumentName };
