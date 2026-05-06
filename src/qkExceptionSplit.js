'use strict';

// Targeted cleanup for Dekobloko qk.run() exception ranges.
//
// CFR fails to structure qk.run when the broad obfuscation wrappers protect
// the loop, the cleanup try/catch island, and the reporting handler as one
// region. The hand reduction shows CFR accepts the same CFG when the wrappers
// are split around that cleanup island. This rewrites only the verified qk
// exception-table shape; it does not inspect CFR output.

const RUN_DESC = '()V';

const REWRITE = [
  {
    from: { startLbl: 'L5', endLbl: 'L240', handlerLbl: 'L243' },
    to: [
      { startLbl: 'L5', endLbl: 'L177', handlerLbl: 'L243' },
      { startLbl: 'L235', endLbl: 'L240', handlerLbl: 'L243' },
    ],
  },
  {
    from: { startLbl: 'L5', endLbl: 'L252', handlerLbl: 'L255' },
    to: [
      { startLbl: 'L5', endLbl: 'L177', handlerLbl: 'L255' },
      { startLbl: 'L235', endLbl: 'L243', handlerLbl: 'L255' },
    ],
  },
];

function runQkExceptionSplit(astRoot) {
  let fired = 0;
  for (const cls of astRoot.classes || []) {
    if (!cls || cls.className !== 'qk') continue;
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      if (item.method.name !== 'run' || item.method.descriptor !== RUN_DESC) continue;
      const codeAttr = (item.method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.exceptionTable)) continue;
      fired += rewriteExceptionTable(codeAttr.code.exceptionTable);
    }
  }
  return { changed: fired > 0, fired };
}

function rewriteExceptionTable(exceptionTable) {
  let fired = 0;
  for (const spec of REWRITE) {
    const idx = exceptionTable.findIndex((entry) => matches(entry, spec.from));
    if (idx < 0) continue;
    const original = exceptionTable[idx];
    const replacements = spec.to.map((labels) => {
      const entry = { ...original, ...labels };
      delete entry.start_pc;
      delete entry.end_pc;
      delete entry.handler_pc;
      return entry;
    });
    exceptionTable.splice(idx, 1, ...replacements);
    fired += 1;
  }
  return fired;
}

function matches(entry, labels) {
  return entry &&
    entry.startLbl === labels.startLbl &&
    entry.endLbl === labels.endLbl &&
    entry.handlerLbl === labels.handlerLbl &&
    (entry.catch_type === 'any' || entry.catchType === 'any');
}

module.exports = { runQkExceptionSplit };
