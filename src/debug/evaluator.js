'use strict';

// Live snippet evaluation against a running JVM.
//
// JShell (src/jshell/JShellSession.js) compiles snippets to .class files on
// disk and runs them in a JVM it creates itself, so it can never observe the
// heap of a program that is already executing.  Debugging a live applet needs
// the opposite: compile in memory, install the snippet into the JVM that is
// already loaded, and run it against that heap.
//
// Evaluation is only permitted while the debugger is enabled.  Running guest
// code has arbitrary side effects on the program under inspection, so it must
// never be reachable from an ordinary production run.

const Frame = require('../core/frame');
const Stack = require('../core/stack');
const { convertJson } = require('../parsing/convert_tree');
const { assembleJasminBytes } = require('../utils/jasminAssembly');
const { getAST } = require('jvm_parser');

const RESULT_FIELD = 'jvmEvalResult';
const ENTRY_METHOD = 'jvmEvalRun';
const DEFAULT_STEP_BUDGET = 2000000;

// A snippet is either a block of statements or a single expression.  The
// result field is always declared Object: the compiler then boxes the
// expression according to its own static type, and the runtime class of the
// box reports the true type back.  Offering concrete types instead (int first,
// then long, double, ...) lets the first candidate win by silently narrowing —
// `1.5 * 4.0` compiles as an int field and yields 6 instead of 6.0.
const RESULT_TYPE = 'Object';

// Boxes produced by that assignment, unwrapped for display.
const BOX_TYPES = new Map([
  ['java/lang/Integer', 'int'],
  ['java/lang/Long', 'long'],
  ['java/lang/Short', 'short'],
  ['java/lang/Byte', 'byte'],
  ['java/lang/Character', 'char'],
  ['java/lang/Float', 'float'],
  ['java/lang/Double', 'double'],
  ['java/lang/Boolean', 'boolean'],
]);

function isProbablyStatements(source) {
  return /;\s*$/.test(source.trim()) || /^\s*[{}]/.test(source) ||
    /^\s*(if|for|while|do|switch|try|return|throw|synchronized)\b/.test(source);
}

function snippetVariants(className, source, resultType = RESULT_TYPE) {
  const body = source.trim();
  const variants = [];
  if (!isProbablyStatements(body)) {
    const expression = body.replace(/;\s*$/, '');
    variants.push({
      kind: 'expression',
      resultType,
      source: `public class ${className} {\n` +
        `  public static ${resultType} ${RESULT_FIELD};\n` +
        `  public static void ${ENTRY_METHOD}() {\n` +
        `    ${RESULT_FIELD} = ${expression};\n` +
        '  }\n}\n',
    });
  }
  variants.push({
    kind: 'statements',
    resultType: null,
    source: `public class ${className} {\n` +
      `  public static void ${ENTRY_METHOD}() {\n` +
      `    ${body}${/[;}]\s*$/.test(body) ? '' : ';'}\n` +
      '  }\n}\n',
  });
  return variants;
}

// Map a live field's descriptor back to the Java type the snippet must declare
// so its read compiles against that exact descriptor.
const DESCRIPTOR_TYPES = new Map([
  ['I', 'int'], ['J', 'long'], ['D', 'double'], ['F', 'float'],
  ['Z', 'boolean'], ['B', 'byte'], ['S', 'short'], ['C', 'char'],
  ['Ljava/lang/String;', 'String'],
]);

function javaTypeForDescriptor(descriptor) {
  if (DESCRIPTOR_TYPES.has(descriptor)) return DESCRIPTOR_TYPES.get(descriptor);
  const object = /^L([^;]+);$/.exec(descriptor);
  if (object) return object[1].replace(/\//g, '.');
  return null;
}

// The Java frontend is the largest dependency here and nothing else in the
// debugger needs it, so it is split into its own chunk and fetched on the
// first evaluation.  A plain require() would be resolved statically by the
// bundler and shipped whether or not anyone ever opens a debug shell.
let frontendPromise = null;

function loadFrontend() {
  if (!frontendPromise) {
    // The path is explicit: Node's ESM loader cannot resolve a directory,
    // and the bundler needs a static specifier to cut the chunk.
    frontendPromise = import(
      /* webpackChunkName: "java-frontend" */ '../java-frontend/index.js'
    ).then((module) => {
      const frontend = module.compileJavaSource ? module : (module.default || {});
      if (typeof frontend.compileJavaSource !== 'function') {
        throw new Error('Java frontend did not export compileJavaSource');
      }
      return frontend.compileJavaSource;
    });
  }
  return frontendPromise;
}

async function compileSnippet(className, source, options, resultType = RESULT_TYPE) {
  const compileJavaSource = await loadFrontend();
  const failures = [];
  for (const variant of snippetVariants(className, source, resultType)) {
    try {
      const compiled = compileJavaSource(variant.source, {
        sourceFileName: `${className}.java`,
        sourceLevel: options.sourceLevel || 8,
        cacheSourceMetadata: false,
      });
      const classes = (compiled.classFileModel &&
        compiled.classFileModel.classes) || [];
      if (!classes.length) throw new Error('snippet produced no classes');
      return { variant, classes };
    } catch (error) {
      failures.push({ resultType: variant.resultType, error });
    }
  }
  const last = failures[failures.length - 1];
  const error = new Error('Unable to compile snippet: ' +
    (last && last.error ? last.error.message : 'unknown error'));
  error.evaluationAttempts = failures;
  throw error;
}

// The Java frontend compiles a snippet standalone: it has no view of the
// classes already loaded in the live JVM, so a reference to one of their
// static fields is typed as Object rather than resolved.  The resulting
// putstatic would silently create a second, phantom field entry
// (`ticks:Ljava/lang/Object;` beside the real `ticks:I`), leaving the program
// unchanged while the snippet appears to succeed.  Refuse instead.
const FIELD_REF = /\b(get|put)static\s+Field\s+(\S+)\s+(\S+)\s+(\S+)/g;

function declaredStaticFields(classData) {
  const items = classData && classData.ast && classData.ast.classes[0] &&
    classData.ast.classes[0].items;
  const byName = new Map();
  for (const item of items || []) {
    const field = item && item.field;
    if (!field || !(field.flags || []).includes('static')) continue;
    byName.set(field.name, field.descriptor);
  }
  return byName;
}

function verifyExternalFieldRefs(jvm, jasmin, snippetClassNames) {
  for (const match of String(jasmin).matchAll(FIELD_REF)) {
    const [, , owner, name, descriptor] = match;
    if (snippetClassNames.has(owner)) continue;
    const live = jvm.classes[owner];
    if (!live) continue;
    const declared = declaredStaticFields(live);
    if (!declared.has(name)) continue;
    const actual = declared.get(name);
    if (actual !== descriptor) {
      const error = new Error(
        `Snippet cannot resolve the type of ${owner}.${name}: it compiled ` +
        `against ${descriptor} but the loaded class declares ${actual}. ` +
        'The Java frontend does not yet read types from the live class ' +
        'table; assign through a same-typed local or use a cast.');
      error.unresolvedField = { owner, name, compiled: descriptor, declared: actual };
      throw error;
    }
  }
}

function verifyAll(jvm, compiled) {
  const names = new Set(compiled.classes.map((entry) => entry.internalName));
  for (const classModel of compiled.classes) {
    verifyExternalFieldRefs(jvm, classModel.jasmin, names);
  }
}

function installClass(jvm, classModel, assemblyOptions) {
  const bytes = assembleJasminBytes(classModel.jasmin, assemblyOptions || {});
  const raw = getAST(bytes);
  const classData = {
    ast: convertJson(raw.ast, raw.constantPool),
    constantPool: raw.constantPool,
    staticFields: new Map(),
  };
  const name = classData.ast.classes[0].className;
  jvm.classes[name] = classData;
  return { name, classData };
}

// Guest code must run without advancing the program being debugged.  The
// scheduler always drives `jvm.threads`, so the live thread list is swapped for
// one holding only the evaluation thread and restored unconditionally.
async function runIsolated(jvm, thread, stepBudget) {
  const savedThreads = jvm.threads;
  const savedIndex = jvm.currentThreadIndex;
  const savedPaused = jvm.debugManager.isPaused;
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.debugManager.resume();
  try {
    let steps = 0;
    while (!thread.callStack.isEmpty()) {
      if (steps++ >= stepBudget) {
        throw new Error(`Evaluation exceeded ${stepBudget} steps; aborted`);
      }
      let result = jvm.executeTick({}, null, false);
      if (result && typeof result.then === 'function') result = await result;
      if (result && result.completed) break;
      if (thread.status === 'terminated') break;
    }
  } finally {
    jvm.threads = savedThreads;
    jvm.currentThreadIndex = Math.min(savedIndex, savedThreads.length - 1);
    if (savedPaused) jvm.debugManager.pause();
  }
}

function describeValue(jvm, value) {
  if (value === null || value === undefined) return { value: null, display: 'null' };
  if (typeof value === 'bigint') {
    return { value: value.toString(), display: value.toString(), type: 'long' };
  }
  if (typeof value === 'boolean') {
    return { value, display: String(value), type: 'boolean' };
  }
  if (typeof value === 'number') {
    // A boxed result carries its Java type; a bare JS number reached here
    // unboxed, so int and double are indistinguishable.  Reporting the JS
    // `typeof` instead printed "1035 (number)" in a Java debugger, which is
    // worse than saying nothing.
    return { value, display: String(value) };
  }
  if (typeof value === 'object' && value.type === 'java/lang/String') {
    const text = typeof jvm.toJsString === 'function'
      ? jvm.toJsString(value) : String(value.value ?? '');
    return { value: text, display: JSON.stringify(text), type: 'java/lang/String' };
  }
  if (typeof value === 'object' && BOX_TYPES.has(value.type)) {
    const type = BOX_TYPES.get(value.type);
    const unboxed = value.value;
    if (type === 'boolean') {
      return { value: Boolean(unboxed), display: String(Boolean(unboxed)), type };
    }
    if (typeof unboxed === 'bigint') {
      return { value: unboxed.toString(), display: unboxed.toString(), type };
    }
    return { value: unboxed, display: String(unboxed), type };
  }
  if (typeof value === 'object' && typeof value.type === 'string') {
    if (value.type.startsWith('[')) {
      return {
        value: null, type: value.type, length: value.length || 0,
        display: `${value.type}#${value.length || 0}`,
      };
    }
    return { value: null, type: value.type, display: `obj:${value.type}` };
  }
  return { value: null, display: String(value) };
}

// Static fields are keyed by `name:descriptor`, so the descriptor for the
// chosen result type is not known to the caller.  Accept either shape.
function readResultField(classData) {
  const fields = classData.staticFields;
  if (fields.has(RESULT_FIELD)) return fields.get(RESULT_FIELD);
  for (const [key, value] of fields.entries()) {
    if (key === RESULT_FIELD || key.startsWith(`${RESULT_FIELD}:`)) return value;
  }
  return null;
}

let evaluationCounter = 0;

/**
 * Compile and run a Java snippet inside an already-running JVM.
 *
 * @param {object} jvm - the live JVM; its debugger must be enabled
 * @param {string} source - a Java expression or block of statements
 * @param {object} options - { stepBudget, sourceLevel, assembly }
 * @returns {Promise<object>} the snippet result and generated class names
 */
/**
 * Compile and install a snippet once, returning a handle that can run it many
 * times.  Re-compiling per evaluation is fine for a REPL and ruinous for a
 * conditional breakpoint, which may be evaluated on every iteration of a hot
 * loop.
 */
async function prepareEvaluation(jvm, source, options = {}) {
  if (!jvm) throw new Error('No JVM to evaluate against');
  if (!jvm.debugManager || !jvm.debugManager.debugMode) {
    throw new Error('Evaluation requires debug mode; enable the debugger first');
  }
  const text = String(source || '').trim();
  if (!text) return null;

  const className = `JvmEval${++evaluationCounter}`;
  const { variant, classes } = await compileSnippet(className, text, options);

  let active = { variant, classes };
  try {
    verifyAll(jvm, active);
  } catch (error) {
    const unresolved = error.unresolvedField;
    const javaType = unresolved && javaTypeForDescriptor(unresolved.declared);
    if (!javaType || variant.kind !== 'expression') throw error;
    active = await compileSnippet(className, text, options, javaType);
    verifyAll(jvm, active);
  }

  const installed = active.classes.map((classModel) =>
    installClass(jvm, classModel, options.assembly));
  const entryClass = installed.find((entry) => entry.name === className) ||
    installed[0];
  const method = jvm.findMethod(entryClass.classData, ENTRY_METHOD, '()V');
  if (!method) throw new Error(`Snippet entry ${ENTRY_METHOD} was not generated`);

  let initialized = false;
  return {
    className: entryClass.name,
    kind: active.variant.kind,
    generatedSource: active.variant.source,
    async run() {
      const thread = {
        id: (jvm.threads || []).reduce((max, t) => Math.max(max, t.id || 0), 0) + 1,
        name: `jvm-eval-${entryClass.name}`,
        callStack: new Stack(),
        status: 'runnable',
      };
      if (!initialized) {
        await jvm.initializeClassIfNeeded(entryClass.name, thread);
        initialized = true;
      }
      const frame = new Frame(method);
      frame.className = entryClass.name;
      thread.callStack.push(frame);
      await runIsolated(jvm, thread, options.stepBudget || DEFAULT_STEP_BUDGET);
      const result = {
        status: 'ok',
        kind: active.variant.kind,
        className: entryClass.name,
        classes: installed.map((entry) => entry.name),
        generatedSource: active.variant.source,
      };
      if (active.variant.resultType) {
        Object.assign(result, describeValue(jvm, readResultField(entryClass.classData)));
        result.resultType = active.variant.resultType;
      } else {
        result.display = null;
      }
      return result;
    },
  };
}

async function evaluateInLiveJvm(jvm, source, options = {}) {
  if (!jvm) throw new Error('No JVM to evaluate against');
  if (!jvm.debugManager || !jvm.debugManager.debugMode) {
    throw new Error('Evaluation requires debug mode; enable the debugger first');
  }
  const text = String(source || '').trim();
  if (!text) return { status: 'empty', display: null };
  const prepared = await prepareEvaluation(jvm, text, options);
  return prepared.run();
}


module.exports = {
  evaluateInLiveJvm, prepareEvaluation, RESULT_FIELD, ENTRY_METHOD,
};
