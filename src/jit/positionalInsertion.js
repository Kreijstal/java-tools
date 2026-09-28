"use strict";

// Allocate the assembler outside the renderer scope. Its closure owns only
// the published insertion, never the SSA analysis and statement caches.
function attachInsertionAssembler(published) {
  published.assemble = ({
    source = published.source, argumentValues, resultName, exitLabel,
    namespace, declareResult = true, entryGuardValue = published.entryGuardValue,
  }) => {
    if (typeof source !== "string" || typeof resultName !== "string" ||
        typeof exitLabel !== "string" ||
        typeof namespace !== "string") return null;
    if (!Array.isArray(argumentValues) ||
        argumentValues.length !== published.argumentNames.length ||
        argumentValues.some((value) => typeof value !== "string")) {
      return null;
    }
    // Late-bound compiler-owned tokens, expanded by exact identity: both
    // names carry this compile's serial and occur nowhere else.
    const retargeted = source
      .split(published.resultToken).join(resultName)
      .split(published.labelToken).join(exitLabel);
    return [
      declareResult ? `let ${resultName};` : null,
      // Staged in the caller's scope. An argument may be spelled with one
      // of the names the inserted block declares, and inside that block
      // every one of them is in its temporal dead zone.
      ...argumentValues.map((value, index) =>
        `const ${namespace}a${index} = ${value};`),
      `${exitLabel}: {`,
      ...published.argumentNames.map((name, index) =>
        `  const ${name} = ${namespace}a${index};`),
      `  const ${published.entryGuardName} = ${entryGuardValue};`,
      ...retargeted.split("\n").map((line) => `  ${line}`),
      "}",
    ].filter((line) => line !== null).join("\n");
  };
  return published;
}

module.exports = {attachInsertionAssembler};
