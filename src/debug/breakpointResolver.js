'use strict';

// Turn human breakpoint locations into (bytecode offset, class, method).
//
// The engine keys breakpoints by bytecode offset, which is unusable by hand:
// you would have to read a disassembly to learn that "the third statement of
// main" is offset 6.  These resolvers accept what a person actually knows —
// a method name, or a source line — and are also the source of the completion
// candidates the debugger prompt offers on Tab.

const { parseDescriptor } = require('../parsing/typeParser');

// `(Ljava/lang/String;II)V` -> `(String, int, int)`.  A JVM descriptor is the
// precise way to name an overload and the worst possible thing to type, so it
// is only ever shown, never demanded.
function javaSignature(descriptor) {
  try {
    const { params } = parseDescriptor(descriptor);
    return `(${params.map(simpleTypeName).join(', ')})`;
  } catch (error) {
    return descriptor;
  }
}

function simpleTypeName(type) {
  return String(type).replace(/^(?:[\w$]+\.)+/, '');
}

function normalizeTypeName(type) {
  return simpleTypeName(String(type).trim().replace(/\s+/g, ''));
}

/** Java-style parameter list, e.g. `(int, String)` -> ['int','String']. */
function parseJavaParams(text) {
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(normalizeTypeName).filter(Boolean);
}

function paramsMatch(descriptor, wanted) {
  let actual;
  try {
    actual = parseDescriptor(descriptor).params.map(normalizeTypeName);
  } catch (error) {
    return false;
  }
  return actual.length === wanted.length &&
    actual.every((type, index) => type === wanted[index]);
}

function classEntries(jvm) {
  return Object.entries(jvm.classes || {});
}

function codeAttribute(method) {
  const attributes = (method && method.attributes) || [];
  return attributes.find((attribute) => attribute.type === 'code') || null;
}

function methodItems(classData) {
  const items = (classData && classData.ast && classData.ast.classes[0] &&
    classData.ast.classes[0].items) || [];
  return items.filter((item) => item.type === 'method' && item.method);
}

function offsetsOf(method) {
  const code = codeAttribute(method);
  const items = (code && code.code && code.code.codeItems) || [];
  const offsets = [];
  for (const item of items) {
    const label = item && item.labelDef;
    if (typeof label !== 'string') continue;
    const value = Number.parseInt(label.replace(/^L/, '').replace(/:$/, ''), 10);
    if (Number.isFinite(value)) offsets.push(value);
  }
  return offsets;
}

function lineTableOf(method) {
  const code = codeAttribute(method);
  const attributes = (code && code.code && code.code.attributes) || [];
  const table = attributes.find((attribute) => attribute.type === 'linenumbertable');
  if (!table || !table.lines) return [];
  return table.lines.map((line) => ({
    offset: Number.parseInt(String(line.label).replace(/^L/, ''), 10),
    line: Number.parseInt(line.lineNumber, 10),
  })).filter((entry) => Number.isFinite(entry.offset) && Number.isFinite(entry.line));
}

/**
 * Every `Class.method` a breakpoint could name, for completion.
 *
 * An overloaded name is ambiguous on its own, so each overload is also offered
 * with its descriptor.  That way Tab shows the alternatives instead of the
 * resolver having to guess which one was meant.
 */
function methodCandidates(jvm) {
  const names = [];
  for (const [className, classData] of classEntries(jvm)) {
    const byName = new Map();
    for (const item of methodItems(classData)) {
      const list = byName.get(item.method.name) || [];
      list.push(item.method);
      byName.set(item.method.name, list);
    }
    for (const [methodName, overloads] of byName.entries()) {
      names.push(`${className}.${methodName}`);
      if (overloads.length > 1) {
        names.push(`${className}.${methodName}*`);
        for (const method of overloads) {
          // Both selectors are completable.  The Java form is what anyone
          // sane picks; the raw descriptor is the exact escape hatch for
          // overloads whose simple type names collide (two `Result` classes
          // from different packages), and it is useless as an escape hatch if
          // it has to be typed by hand.
          names.push(`${className}.${methodName}${javaSignature(method.descriptor)}`);
          names.push(`${className}.${methodName}${method.descriptor}`);
        }
      }
    }
  }
  return names.sort();
}

function classCandidates(jvm) {
  return classEntries(jvm).map(([className]) => className).sort();
}

function findMethods(jvm, className, methodName) {
  const classData = jvm.classes[className];
  if (!classData) return [];
  return methodItems(classData)
    .filter((item) => item.method.name === methodName)
    .map((item) => item.method);
}

// Class.method, optionally narrowed by one of:
//   (Ljava/lang/String;)V   exact JVM descriptor
//   (String)                Java-style parameter list
//   /2                      arity
//   *                       every overload
// and optionally followed by +offset.
const METHOD_SPEC =
  /^([\w$/.]+)\.([\w$<>]+)(\([^)]*\)[\w$/;[]+|\([^)]*\)|\/\d+|\*)?(?:\+(\d+))?$/;
// `File.java:12`, `Class:12`, or `:12` for the current class.
const LINE_SPEC = /^([\w$/.]*):(\d+)$/;

function resolveMethodSpec(jvm, spec) {
  const match = METHOD_SPEC.exec(spec);
  if (!match) return null;
  const [, rawClass, methodName, descriptor, plusOffset] = match;
  const className = rawClass.replace(/\./g, '/');
  // Distinguish "this class has not been loaded yet" from "this class has no
  // such method".  The first is a timing problem a pending breakpoint solves;
  // the second is a typo.
  if (!jvm.classes[className] && !jvm.classes[rawClass]) {
    const error = new Error(`Class ${rawClass} is not loaded yet`);
    error.classNotLoaded = true;
    error.className = className;
    throw error;
  }
  const candidates = jvm.classes[className]
    ? findMethods(jvm, className, methodName)
    : findMethods(jvm, rawClass, methodName);
  const owner = jvm.classes[className] ? className : rawClass;
  if (!candidates.length) {
    throw new Error(`No method ${rawClass}.${methodName} in ${owner}`);
  }
  // Narrow the overload set by whichever selector was supplied.  Nothing here
  // guesses: a selector that leaves more than one candidate is still an error.
  let matched = candidates;
  let wantsAll = false;
  const selector = descriptor;
  if (selector === '*') {
    wantsAll = true;
  } else if (selector && /^\/\d+$/.test(selector)) {
    const arity = Number(selector.slice(1));
    matched = candidates.filter((entry) => {
      try {
        return parseDescriptor(entry.descriptor).params.length === arity;
      } catch (error) {
        return false;
      }
    });
    if (!matched.length) {
      throw new Error(
        `No ${rawClass}.${methodName} takes ${arity} parameter(s); available: ` +
        candidates.map((entry) => javaSignature(entry.descriptor)).join(', '));
    }
  } else if (selector && /\)[\w$/;[]/.test(selector)) {
    matched = candidates.filter((entry) => entry.descriptor === selector);
    if (!matched.length) {
      throw new Error(`No overload ${rawClass}.${methodName}${selector}`);
    }
  } else if (selector) {
    const wanted = parseJavaParams(selector);
    matched = candidates.filter((entry) => paramsMatch(entry.descriptor, wanted));
    if (!matched.length) {
      throw new Error(
        `No ${rawClass}.${methodName}${selector}; available: ` +
        candidates.map((entry) => javaSignature(entry.descriptor)).join(', '));
    }
  }

  if (!wantsAll && matched.length > 1) {
    // Ambiguity stays visible: silently picking one overload would arm a
    // breakpoint somewhere the user did not ask for, and it would simply never
    // be hit.  The alternatives are shown in a form that can be typed back.
    const shown = matched
      .map((entry) => `${methodName}${javaSignature(entry.descriptor)}`)
      .join('  |  ');
    throw new Error(
      `${rawClass}.${methodName} is overloaded — choose one: ${shown}` +
      `  (or ${methodName}* for all, ${methodName}/N by arity)`);
  }

  if (wantsAll) {
    return matched.map((entry) => buildTarget(
      rawClass, owner, methodName, entry, plusOffset));
  }
  const method = matched[0];
  return buildTarget(rawClass, owner, methodName, method, plusOffset);
}

function buildTarget(rawClass, owner, methodName, method, plusOffset) {
  const offsets = offsetsOf(method);
  if (!offsets.length) {
    throw new Error(`${rawClass}.${methodName} has no code (abstract or native?)`);
  }
  const requested = plusOffset === undefined ? offsets[0] : Number(plusOffset);
  if (!offsets.includes(requested)) {
    throw new Error(
      `Offset ${requested} is not an instruction boundary in ` +
      `${rawClass}.${methodName}; valid offsets start ${offsets.slice(0, 8).join(', ')}…`);
  }
  return {
    pc: requested,
    className: owner,
    methodName: method.name,
    descriptor: method.descriptor,
    signature: `${method.name}${javaSignature(method.descriptor)}`,
  };
}

function resolveLineSpec(jvm, spec, currentClassName) {
  const match = LINE_SPEC.exec(spec);
  if (!match) return null;
  const [, rawTarget, rawLine] = match;
  const line = Number(rawLine);
  const target = rawTarget.replace(/\.java$/, '').replace(/\./g, '/');
  const searched = [];

  for (const [className, classData] of classEntries(jvm)) {
    if (target) {
      const tail = className.split('/').pop();
      if (className !== target && tail !== target.split('/').pop()) continue;
    } else if (currentClassName && className !== currentClassName) {
      continue;
    }
    searched.push(className);
    for (const item of methodItems(classData)) {
      const table = lineTableOf(item.method);
      const exact = table.filter((entry) => entry.line === line);
      if (exact.length) {
        return {
          pc: Math.min(...exact.map((entry) => entry.offset)),
          className,
          methodName: item.method.name,
          descriptor: item.method.descriptor,
          line,
        };
      }
    }
  }
  const where = searched.length ? searched.join(', ') : '(no matching class)';
  throw new Error(
    `No code at line ${line} in ${where}; the class may lack a LineNumberTable`);
}

/**
 * Resolve a user-supplied breakpoint location.
 * Accepts `Class.method`, `Class.method(desc)+off`, `File.java:12`, `:12`,
 * or a bare bytecode offset.
 */
function resolveBreakpoint(jvm, spec, currentClassName = null) {
  const text = String(spec || '').trim();
  if (!text) throw new Error('Expected a breakpoint location');
  if (/^\d+$/.test(text)) return { pc: Number(text) };
  const line = LINE_SPEC.test(text)
    ? resolveLineSpec(jvm, text, currentClassName) : null;
  if (line) return line;
  const method = resolveMethodSpec(jvm, text);
  if (method) return method;
  throw new Error(
    `Cannot parse "${text}"; use Class.method, Class.method+offset, ` +
    'File.java:line, :line, or a bytecode offset');
}

/** Longest common prefix completion over the candidate names. */
function complete(jvm, partial) {
  const text = String(partial || '');
  const pool = text.includes('.')
    ? methodCandidates(jvm) : classCandidates(jvm).concat(methodCandidates(jvm));
  const lower = text.toLowerCase();
  const matches = pool.filter((name) =>
    name.toLowerCase().startsWith(lower) ||
    name.split('/').pop().toLowerCase().startsWith(lower));
  if (!matches.length) return { completion: text, matches: [] };
  let prefix = matches[0];
  for (const name of matches.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  return { completion: prefix.length >= text.length ? prefix : text, matches };
}

module.exports = {
  resolveBreakpoint,
  javaSignature,
  resolveMethodSpec,
  resolveLineSpec,
  methodCandidates,
  classCandidates,
  complete,
  offsetsOf,
  lineTableOf,
};
