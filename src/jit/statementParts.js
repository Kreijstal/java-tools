'use strict';

// The statement-IR "parts" model: what a rendered statement is made of, and
// every question that can be answered by looking at it.
//
// A statement is emitted as parts -- literal text plus operand and label
// references that the emitter states explicitly -- so no consumer has to recover
// meaning from the generated characters. Everything here is a pure function of
// the parts it is given.
//
// What is deliberately NOT here: `e`, `buildParts`, `exprConcat`, `labelPart`
// and `appendPartValue`. Those read the render-scoped bindings
// `activeEmittedNames` and `activeOperandExpressions`, so they belong with the
// render that owns that state and stay in JvmSsaBlockRenderer.

class Expr {
  constructor(parts) { this.parts = parts; }
  toString() { return renderParts(this.parts); }
}

function renderParts(parts) {
  let text = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // A reference may render as something other than its name while a later
    // stage still owns it: an array-range access token renders as
    // `false /*token*/` until a proof replaces the whole reference by a guard.
    // A label part renders as the label it names.
    text += typeof part === "string" ? part
      : part.label !== undefined ? part.label
        : part.text !== undefined ? part.text : part.ref;
  }
  return text;
}

const AMBIENT_GENERATED_NAMES = [
  "helpers", "frame", "locals", "stack", "ssaRestoredFrame", "thread", "plan",
  "restorationDepth", "safePointBudget", "nestedEntryGuarded",
  "framelessEntry", "initialBytecodeChecks",
];

function substituteLabelParts(parts, rename) {
  const out = [];
  let changed = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === "string" || part.label === undefined) {
      out.push(part);
      continue;
    }
    const renamed = rename(part.label);
    if (renamed === part.label) { out.push(part); continue; }
    changed = true;
    out.push(part.ref === undefined
      ? {label: renamed} : {label: renamed, ref: renamed});
  }
  return changed ? out : parts;
}

function partsMentionLiteralName(parts, names) {
  if (!names || names.size === 0) return false;
  const skeleton = partsSkeleton(parts);
  for (const name of names) {
    let position = skeleton.indexOf(name);
    while (position >= 0) {
      if (!isPartsWordCharacter(skeleton[position - 1]) &&
          !isPartsWordCharacter(skeleton[position + name.length])) return true;
      position = skeleton.indexOf(name, position + 1);
    }
  }
  return false;
}

function substituteParts(parts, replacements) {
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // A label names a statement, not a value: no operand substitution
    // replaces one.
    if (typeof part === "string" || part.label !== undefined) {
      out.push(part);
      continue;
    }
    const replacement = replacements.get(part.ref);
    if (replacement === undefined) { out.push(part); continue; }
    const replacementParts = replacement instanceof Expr
      ? replacement.parts : replacement;
    for (let position = 0; position < replacementParts.length; position += 1) {
      out.push(replacementParts[position]);
    }
  }
  return out;
}

const PARTS_OPERAND_PLACEHOLDER = "\u0000";

function partsSkeleton(parts) {
  let text = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    text += typeof part === "string" ? part : PARTS_OPERAND_PLACEHOLDER;
  }
  return text;
}

function isPartsWordCharacter(character) {
  return character !== undefined && character !== "" &&
    (character >= "a" && character <= "z" ||
      character >= "A" && character <= "Z" ||
      character >= "0" && character <= "9" ||
      character === "_" || character === "$");
}

function partsWriteImpureCall(parts, builtSkeleton = null) {
  const skeleton = builtSkeleton === null ? partsSkeleton(parts) : builtSkeleton;
  if (skeleton.includes("helpers.")) return true;
  let position = skeleton.indexOf("new");
  while (position >= 0) {
    if (!isPartsWordCharacter(skeleton[position - 1]) &&
        !isPartsWordCharacter(skeleton[position + 3])) return true;
    position = skeleton.indexOf("new", position + 1);
  }
  return false;
}

function partsAmbientNames(parts, builtSkeleton = null) {
  const skeleton = builtSkeleton === null ? partsSkeleton(parts) : builtSkeleton;
  const found = [];
  for (let index = 0; index < AMBIENT_GENERATED_NAMES.length; index += 1) {
    const name = AMBIENT_GENERATED_NAMES[index];
    let position = skeleton.indexOf(name);
    while (position >= 0) {
      if (!isPartsWordCharacter(skeleton[position - 1]) &&
          !isPartsWordCharacter(skeleton[position + name.length])) {
        found.push(name);
        break;
      }
      position = skeleton.indexOf(name, position + 1);
    }
  }
  return found;
}

const BODY_HELPER_NAME_PREFIXES = ["ssaMaterialize"];

function partsBodyHelperNames(parts) {
  const skeleton = partsSkeleton(parts);
  const found = [];
  let position = skeleton.indexOf("spillLocals");
  if (position >= 0 && !isPartsWordCharacter(skeleton[position - 1])) {
    found.push("spillLocals");
  }
  for (const prefix of BODY_HELPER_NAME_PREFIXES) {
    position = skeleton.indexOf(prefix);
    while (position >= 0) {
      if (!isPartsWordCharacter(skeleton[position - 1])) {
        let end = position + prefix.length;
        while (isPartsWordCharacter(skeleton[end])) end += 1;
        const name = skeleton.slice(position, end);
        if (name !== prefix && !found.includes(name)) found.push(name);
      }
      position = skeleton.indexOf(prefix, position + 1);
    }
  }
  return found;
}

function skeletonCodeMask(skeleton) {
  const mask = new Array(skeleton.length).fill(true);
  let index = 0;
  while (index < skeleton.length) {
    const character = skeleton[index];
    if (character === "'" || character === "\"" || character === "`") {
      mask[index] = false;
      index += 1;
      while (index < skeleton.length) {
        mask[index] = false;
        if (skeleton[index] === "\\") { index += 2; continue; }
        if (skeleton[index] === character) { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (character === "/" && skeleton[index + 1] === "/") {
      while (index < skeleton.length) mask[index++] = false;
      continue;
    }
    if (character === "/" && skeleton[index + 1] === "*") {
      mask[index] = false;
      mask[index + 1] = false;
      index += 2;
      while (index < skeleton.length) {
        mask[index] = false;
        if (skeleton[index] === "*" && skeleton[index + 1] === "/") {
          mask[index + 1] = false;
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return mask;
}

function skeletonKeywordPositions(skeleton, keyword, mask = null) {
  const codeMask = mask || skeletonCodeMask(skeleton);
  const positions = [];
  let position = skeleton.indexOf(keyword);
  while (position >= 0) {
    if (codeMask[position] &&
        !isPartsWordCharacter(skeleton[position - 1]) &&
        !isPartsWordCharacter(skeleton[position + keyword.length])) {
      positions.push(position);
    }
    position = skeleton.indexOf(keyword, position + 1);
  }
  return positions;
}

function partsCarriesNestedFunction(parts) {
  const skeleton = partsSkeleton(parts);
  return skeleton.includes("=>") ||
    skeletonKeywordPositions(skeleton, "function").length > 0;
}

const RELOCATION_HOSTILE_KEYWORDS = ["this", "super", "await", "arguments",
  "eval", "var", "new.target"];

function partsRelocationHostile(parts) {
  const skeleton = partsSkeleton(parts);
  for (const keyword of RELOCATION_HOSTILE_KEYWORDS) {
    if (skeletonKeywordPositions(skeleton, keyword).length) return true;
  }
  return false;
}

function partsAmbientWrites(parts) {
  const skeleton = partsSkeleton(parts);
  const mask = skeletonCodeMask(skeleton);
  const found = [];
  // The one destructuring target the emitters write: a bracketed list at the
  // head of the statement, assigned as a whole.
  let destructuringEnd = -1;
  const head = skeleton.length - skeleton.trimStart().length;
  if (skeleton[head] === "[" && mask[head]) {
    let depth = 0;
    for (let index = head; index < skeleton.length; index += 1) {
      if (!mask[index]) continue;
      if (skeleton[index] === "[") depth += 1;
      else if (skeleton[index] === "]") {
        depth -= 1;
        if (depth === 0) {
          let after = index + 1;
          while (skeleton[after] === " ") after += 1;
          if (skeleton[after] === "=" && skeleton[after + 1] !== "=") {
            destructuringEnd = index;
          }
          break;
        }
      }
    }
  }
  const assignsAt = (position, length) => {
    if (destructuringEnd > 0 && position > head &&
        position + length <= destructuringEnd) return true;
    let before = position - 1;
    while (skeleton[before] === " ") before -= 1;
    if (before >= 1 && (skeleton[before] === "+" || skeleton[before] === "-") &&
        skeleton[before - 1] === skeleton[before]) return true;
    let after = position + length;
    while (skeleton[after] === " ") after += 1;
    if ((skeleton[after] === "+" || skeleton[after] === "-") &&
        skeleton[after + 1] === skeleton[after]) return true;
    let operators = 0;
    while (operators < 3 &&
      "+-*/%&|^<>".includes(skeleton[after + operators])) operators += 1;
    return skeleton[after + operators] === "=" &&
      skeleton[after + operators + 1] !== "=" &&
      (operators > 0 || skeleton[after + 1] !== ">");
  };
  for (const name of AMBIENT_GENERATED_NAMES) {
    for (const position of skeletonKeywordPositions(skeleton, name, mask)) {
      if (!assignsAt(position, name.length)) continue;
      found.push(name);
      break;
    }
  }
  return found;
}

function partsDeclaresAmbient(parts) {
  const skeleton = partsSkeleton(parts).trimStart();
  for (const keyword of ["let ", "const ", "var "]) {
    if (!skeleton.startsWith(keyword)) continue;
    let start = keyword.length;
    while (skeleton[start] === " ") start += 1;
    let end = start;
    while (isPartsWordCharacter(skeleton[end])) end += 1;
    return AMBIENT_GENERATED_NAMES.includes(skeleton.slice(start, end));
  }
  return false;
}

function partsContinuesBlock(parts) {
  const skeleton = partsSkeleton(parts).trim();
  return skeleton.startsWith("}") && skeleton.endsWith("{");
}

function partsOpenCondition(parts, builtSkeleton = null) {
  const skeleton = builtSkeleton === null ? partsSkeleton(parts) : builtSkeleton;
  return skeleton.trimStart().startsWith("if (") && skeleton.endsWith(") {");
}

function partsWriteThrowOrTry(parts, builtSkeleton = null) {
  const skeleton = builtSkeleton === null ? partsSkeleton(parts) : builtSkeleton;
  return skeleton.includes("throw ") || skeleton.includes("try {");
}

function partsWriteDivision(parts, builtSkeleton = null) {
  const skeleton = builtSkeleton === null ? partsSkeleton(parts) : builtSkeleton;
  return skeleton.includes(" / ") || skeleton.includes(" % ");
}

function partsWriteIndex(parts, builtSkeleton = null) {
  const skeleton = builtSkeleton === null ? partsSkeleton(parts) : builtSkeleton;
  let open = -1;
  for (let index = 0; index < skeleton.length; index += 1) {
    const character = skeleton[index];
    if (character === "[") { open = index; continue; }
    if (character !== "]" || open < 0) continue;
    if (index > open + 1) return true;
    open = -1;
  }
  return false;
}

function partsLoadEntryArrayElement(parts, entryArrayDataNames) {
  for (let index = 0; index + 1 < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === "string" || !entryArrayDataNames.has(part.ref)) {
      continue;
    }
    const next = parts[index + 1];
    if (typeof next === "string" && next.startsWith("[")) return true;
  }
  return false;
}

function partsReferences(parts) {
  const names = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // A label part that names no value contributes no operand: it names a
    // statement. A label the compile minted is also a name the generated
    // scope carries, so it keeps its operand identity as well.
    if (typeof part !== "string" && part.ref !== undefined) {
      names.push(part.ref);
    }
  }
  return names;
}

module.exports = {
  Expr,
  renderParts,
  AMBIENT_GENERATED_NAMES,
  substituteLabelParts,
  partsMentionLiteralName,
  substituteParts,
  PARTS_OPERAND_PLACEHOLDER,
  partsSkeleton,
  isPartsWordCharacter,
  partsWriteImpureCall,
  partsAmbientNames,
  BODY_HELPER_NAME_PREFIXES,
  partsBodyHelperNames,
  skeletonCodeMask,
  skeletonKeywordPositions,
  partsCarriesNestedFunction,
  RELOCATION_HOSTILE_KEYWORDS,
  partsRelocationHostile,
  partsAmbientWrites,
  partsDeclaresAmbient,
  partsContinuesBlock,
  partsOpenCondition,
  partsWriteThrowOrTry,
  partsWriteDivision,
  partsWriteIndex,
  partsLoadEntryArrayElement,
  partsReferences,
};
