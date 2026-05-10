'use strict';

const REFLECTION_CLASS_METHODS = new Set([
  'java/lang/Class.forName(Ljava/lang/String;)Ljava/lang/Class;',
  'java/lang/ClassLoader.loadClass(Ljava/lang/String;)Ljava/lang/Class;',
  'java/lang/ClassLoader.loadClass(Ljava/lang/String;Z)Ljava/lang/Class;',
]);

const REFLECTION_MEMBER_METHODS = new Set([
  'java/lang/Class.getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;',
  'java/lang/Class.getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;',
  'java/lang/Class.getField(Ljava/lang/String;)Ljava/lang/reflect/Field;',
  'java/lang/Class.getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;',
]);

const CALLBACK_METHOD_NAMES = new Set([
  'init',
  'start',
  'stop',
  'destroy',
  'run',
  'paint',
  'update',
  'finalize',
  'callback',
  'callbackEnumModes',
  'mouseClicked',
  'mouseDragged',
  'mouseEntered',
  'mouseExited',
  'mouseMoved',
  'mousePressed',
  'mouseReleased',
  'mouseWheelMoved',
  'keyPressed',
  'keyReleased',
  'keyTyped',
  'focusGained',
  'focusLost',
  'windowActivated',
  'windowClosed',
  'windowClosing',
  'windowDeactivated',
  'windowDeiconified',
  'windowIconified',
  'windowOpened',
]);

const CALLBACK_INTERFACES = new Set([
  'java/lang/Runnable',
  'java/awt/event/MouseListener',
  'java/awt/event/MouseMotionListener',
  'java/awt/event/MouseWheelListener',
  'java/awt/event/KeyListener',
  'java/awt/event/FocusListener',
  'java/awt/event/WindowListener',
  'java/applet/Applet',
  'com/ms/directX/IEnumModesCallback',
]);

function analyzeRenameSafety(workspace, options = {}) {
  const mainClass = options.mainClass || null;
  const classNames = Object.keys(workspace.workspaceASTs).sort();
  const classNameSet = new Set(classNames);
  const stringRefs = collectStringReferences(workspace);
  const reflectiveClassLoads = collectReflectiveClassLoads(workspace, classNameSet);
  const reflectiveMembers = collectReflectiveMembers(workspace);
  const reflectiveMethodTargets = indexMemberTargets(reflectiveMembers.methods);
  const reflectiveFieldTargets = indexMemberTargets(reflectiveMembers.fields);
  const classResults = {};

  for (const className of classNames) {
    const entry = workspace.workspaceASTs[className];
    const cls = entry.ast.classes[0];
    const reasons = [];
    const warnings = [];

    if (mainClass && className === mainClass) {
      reasons.push({ kind: 'main-class', detail: 'Configured launcher/application main class' });
    }

    for (const ref of stringRefs.get(className) || []) {
      reasons.push({ kind: 'class-name-string', detail: ref });
    }

    for (const ref of reflectiveClassLoads.get(className) || []) {
      reasons.push({ kind: 'reflective-class-load', detail: ref });
    }

    if (isCallbackClass(cls)) {
      warnings.push({ kind: 'callback-class', detail: 'Class extends/implements a common external callback type' });
    }

    const methods = [];
    const fields = [];
    for (const item of cls.items || []) {
      if (item.type === 'method') {
        const methodReasons = [];
        const methodWarnings = [];
        const key = `${className}.${item.method.name}${item.method.descriptor}`;
        for (const ref of reflectiveMethodTargets.specific.get(`${className}.${item.method.name}`) || []) {
          methodReasons.push({ kind: 'reflected-method-name', detail: ref });
        }
        for (const ref of reflectiveMethodTargets.global.get(item.method.name) || []) {
          methodReasons.push({ kind: 'reflected-method-name', detail: ref });
        }
        if (CALLBACK_METHOD_NAMES.has(item.method.name)) {
          methodWarnings.push({ kind: 'callback-method-name', detail: 'Common external callback/lifecycle method name' });
        }
        methods.push({
          id: key,
          name: item.method.name,
          descriptor: item.method.descriptor,
          rename: methodReasons.length > 0 ? 'unsafe' : methodWarnings.length > 0 ? 'risky' : 'safe',
          reasons: methodReasons,
          warnings: methodWarnings,
        });
      } else if (item.type === 'field') {
        const fieldReasons = [];
        const key = `${className}.${item.field.name} ${item.field.descriptor}`;
        for (const ref of reflectiveFieldTargets.specific.get(`${className}.${item.field.name}`) || []) {
          fieldReasons.push({ kind: 'reflected-field-name', detail: ref });
        }
        for (const ref of reflectiveFieldTargets.global.get(item.field.name) || []) {
          fieldReasons.push({ kind: 'reflected-field-name', detail: ref });
        }
        fields.push({
          id: key,
          name: item.field.name,
          descriptor: item.field.descriptor,
          rename: fieldReasons.length > 0 ? 'unsafe' : 'safe',
          reasons: fieldReasons,
        });
      }
    }

    classResults[className] = {
      className,
      rename: reasons.length > 0 ? 'unsafe' : warnings.length > 0 ? 'risky' : 'safe',
      reasons,
      warnings,
      methods,
      fields,
    };
  }

  return {
    classCount: classNames.length,
    summary: summarize(classResults),
    classes: classResults,
    reflectiveClassLoads: mapToObject(reflectiveClassLoads),
    reflectiveMethodNames: memberTargetsToObject(reflectiveMembers.methods),
    reflectiveFieldNames: memberTargetsToObject(reflectiveMembers.fields),
  };
}

function collectStringReferences(workspace) {
  const refs = new Map();
  const classNames = Object.keys(workspace.workspaceASTs);
  const stringToClasses = new Map();

  for (const className of classNames) {
    for (const spelling of classStringSpellings(className)) {
      if (!stringToClasses.has(spelling)) stringToClasses.set(spelling, []);
      stringToClasses.get(spelling).push(className);
    }
  }

  forEachInstruction(workspace, (context, instruction) => {
    if (!isLdcString(instruction)) return;
    const hitClasses = stringToClasses.get(instruction.arg);
    if (!hitClasses) return;
    for (const className of hitClasses) {
      addMapValue(refs, className, `${context.methodId} ldc "${instruction.arg}"`);
    }
  });

  return refs;
}

function collectReflectiveClassLoads(workspace, classNameSet) {
  const refs = new Map();

  forEachMethodCode(workspace, (context, codeItems) => {
    const stack = createStackState();
    for (const item of codeItems) {
      const instruction = normalizeInstruction(item.instruction);
      if (!instruction) continue;
      if (isLdcString(instruction)) {
        stack.push(stringValue(instruction.arg));
        continue;
      }
      if (isLdcClass(instruction)) {
        stack.push(classValue(instruction.arg[1]));
        continue;
      }
      if (handleStackInstruction(stack, instruction)) continue;
      if (!isInvoke(instruction)) continue;
      const invokeId = invocationId(instruction);
      if (!REFLECTION_CLASS_METHODS.has(invokeId)) {
        handleUnknownInvoke(stack, instruction);
        continue;
      }
      const [classNameArg] = popInvokeArgs(stack, instruction);
      const className = classNameArg && classNameArg.kind === 'string' ? normalizeClassName(classNameArg.value) : null;
      if (className && classNameSet.has(className)) {
        addMapValue(refs, className, `${context.methodId} ${invokeId}`);
      }
      stack.push(classObjectValue(className || null));
    }
  });

  return refs;
}

function collectReflectiveMembers(workspace) {
  const methods = new Map();
  const fields = new Map();

  forEachMethodCode(workspace, (context, codeItems) => {
    const stack = createStackState();
    for (const item of codeItems) {
      const instruction = normalizeInstruction(item.instruction);
      if (!instruction) continue;
      if (isLdcString(instruction)) {
        stack.push(stringValue(instruction.arg));
        continue;
      }
      if (isLdcClass(instruction)) {
        stack.push(classValue(instruction.arg[1]));
        continue;
      }
      if (handleStackInstruction(stack, instruction)) continue;
      if (!isInvoke(instruction)) continue;
      const invokeId = invocationId(instruction);
      if (REFLECTION_CLASS_METHODS.has(invokeId)) {
        const [classNameArg] = popInvokeArgs(stack, instruction);
        const className = classNameArg && classNameArg.kind === 'string' ? normalizeClassName(classNameArg.value) : null;
        stack.push(classObjectValue(className || null));
        continue;
      }
      if (REFLECTION_MEMBER_METHODS.has(invokeId)) {
        const args = popInvokeArgs(stack, instruction);
        const receiver = stack.pop();
        const memberNameArg = args[0];
        const memberName = memberNameArg && memberNameArg.kind === 'string' ? memberNameArg.value : null;
        if (memberName && isJavaIdentifier(memberName)) {
          const target = invokeId.includes('Field') ? fields : methods;
          addMemberTarget(target, memberName, receiver && receiver.kind === 'classObject' ? receiver.className : null, `${context.methodId} ${invokeId}`);
        }
        stack.push({ kind: invokeId.includes('Field') ? 'fieldObject' : 'methodObject' });
        continue;
      }
      handleUnknownInvoke(stack, instruction);
    }
  });

  return { methods, fields };
}

function createStackState() {
  return [];
}

function stringValue(value) {
  return { kind: 'string', value };
}

function classValue(className) {
  return { kind: 'classLiteral', className: normalizeClassName(className) };
}

function classObjectValue(className) {
  return { kind: 'classObject', className };
}

function handleStackInstruction(stack, instruction) {
  const op = instruction.op;
  if (!op) return false;

  if (op === 'aconst_null') {
    stack.push({ kind: 'null' });
    return true;
  }
  if (op === 'pop') {
    stack.pop();
    return true;
  }
  if (op === 'dup') {
    stack.push(stack[stack.length - 1] || { kind: 'unknown' });
    return true;
  }
  if (op === 'swap') {
    const a = stack.pop();
    const b = stack.pop();
    stack.push(a || { kind: 'unknown' });
    stack.push(b || { kind: 'unknown' });
    return true;
  }
  if (op.startsWith('aload') || op.startsWith('iload') || op.startsWith('lload') || op.startsWith('fload') || op.startsWith('dload')) {
    stack.push({ kind: 'unknown' });
    return true;
  }
  if (op.startsWith('astore') || op.startsWith('istore') || op.startsWith('lstore') || op.startsWith('fstore') || op.startsWith('dstore')) {
    stack.pop();
    return true;
  }
  if (op === 'getstatic') {
    stack.push({ kind: 'unknown' });
    return true;
  }
  if (op === 'putstatic') {
    stack.pop();
    return true;
  }
  if (op === 'getfield') {
    stack.pop();
    stack.push({ kind: 'unknown' });
    return true;
  }
  if (op === 'putfield') {
    stack.pop();
    stack.pop();
    return true;
  }
  if (op === 'new') {
    stack.push({ kind: 'object', className: instruction.arg });
    return true;
  }
  if (op === 'anewarray' || op === 'newarray') {
    stack.pop();
    stack.push({ kind: 'array' });
    return true;
  }
  if (op.endsWith('astore') && op !== 'astore') {
    stack.pop();
    stack.pop();
    stack.pop();
    return true;
  }
  if (op.endsWith('aload') && op !== 'aload') {
    stack.pop();
    stack.pop();
    stack.push({ kind: 'unknown' });
    return true;
  }
  if (op === 'checkcast' || op === 'instanceof') {
    return true;
  }
  if (op === 'iconst_m1' || /^iconst_/.test(op) || op === 'bipush' || op === 'sipush') {
    stack.push({ kind: 'int' });
    return true;
  }
  if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') {
    stack.push({ kind: 'constant' });
    return true;
  }
  return false;
}

function handleUnknownInvoke(stack, instruction) {
  const args = popInvokeArgs(stack, instruction);
  if (!isStaticInvoke(instruction)) stack.pop();
  const returnType = methodReturnType(instruction);
  if (returnType !== 'V') {
    stack.push({ kind: 'unknown', fromArgs: args });
  }
}

function popInvokeArgs(stack, instruction) {
  const descriptor = invocationDescriptor(instruction);
  const count = countMethodParameters(descriptor);
  const args = [];
  for (let i = 0; i < count; i += 1) {
    args.unshift(stack.pop() || { kind: 'unknown' });
  }
  return args;
}

function countMethodParameters(descriptor) {
  const end = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || end < 0) return 0;
  let count = 0;
  for (let i = 1; i < end; i += 1) {
    let ch = descriptor[i];
    while (ch === '[') {
      i += 1;
      ch = descriptor[i];
    }
    if (ch === 'L') {
      i = descriptor.indexOf(';', i);
      if (i < 0 || i > end) return count;
    }
    count += 1;
  }
  return count;
}

function methodReturnType(instruction) {
  const descriptor = invocationDescriptor(instruction);
  const end = descriptor.indexOf(')');
  return end >= 0 ? descriptor.slice(end + 1) : '';
}

function invocationDescriptor(instruction) {
  const member = instruction.arg && instruction.arg[2];
  return Array.isArray(member) ? member[1] : '';
}

function isStaticInvoke(instruction) {
  return instruction.op === 'invokestatic';
}

function forEachMethodCode(workspace, visitor) {
  for (const [className, entry] of Object.entries(workspace.workspaceASTs)) {
    const cls = entry.ast.classes[0];
    for (const item of cls.items || []) {
      if (item.type !== 'method') continue;
      const codeAttr = (item.method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) continue;
      visitor({
        className,
        methodName: item.method.name,
        descriptor: item.method.descriptor,
        methodId: `${className}.${item.method.name}${item.method.descriptor}`,
      }, codeAttr.code.codeItems);
    }
  }
}

function forEachInstruction(workspace, visitor) {
  forEachMethodCode(workspace, (context, codeItems) => {
    for (const item of codeItems) {
      const instruction = normalizeInstruction(item.instruction);
      if (instruction) visitor(context, instruction);
    }
  });
}

function normalizeInstruction(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return { op: instruction };
  if (typeof instruction === 'object') return instruction;
  return null;
}

function isCallbackClass(cls) {
  if (cls.superClassName && CALLBACK_INTERFACES.has(cls.superClassName)) return true;
  return (cls.interfaces || []).some((interfaceName) => CALLBACK_INTERFACES.has(interfaceName));
}

function classStringSpellings(className) {
  const dotted = className.replace(/\//g, '.');
  return new Set([
    className,
    dotted,
    `${className}.class`,
    `${dotted}.class`,
    `L${className};`,
    `L${dotted};`,
    `[L${className};`,
    `[L${dotted};`,
  ]);
}

function isLdcString(instruction) {
  return (instruction.op === 'ldc' || instruction.op === 'ldc_w') && typeof instruction.arg === 'string';
}

function isLdcClass(instruction) {
  return (instruction.op === 'ldc' || instruction.op === 'ldc_w') &&
    Array.isArray(instruction.arg) &&
    instruction.arg[0] === 'Class';
}

function isInvoke(instruction) {
  return instruction.op && instruction.op.startsWith('invoke') && Array.isArray(instruction.arg);
}

function invocationId(instruction) {
  const [, owner, member] = instruction.arg;
  if (!owner || !Array.isArray(member)) return '';
  return `${owner}.${member[0]}${member[1]}`;
}

function normalizeClassName(value) {
  return value.replace(/\./g, '/');
}

function isJavaIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function addMapValue(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function addMemberTarget(map, memberName, className, detail) {
  if (!map.has(memberName)) {
    map.set(memberName, { global: [], byClass: new Map() });
  }
  const bucket = map.get(memberName);
  if (className) {
    if (!bucket.byClass.has(className)) bucket.byClass.set(className, []);
    bucket.byClass.get(className).push(detail);
  } else {
    bucket.global.push(detail);
  }
}

function indexMemberTargets(memberMap) {
  const specific = new Map();
  const global = new Map();
  for (const [memberName, bucket] of memberMap.entries()) {
    if (bucket.global.length > 0) global.set(memberName, bucket.global);
    for (const [className, details] of bucket.byClass.entries()) {
      specific.set(`${className}.${memberName}`, details);
    }
  }
  return { specific, global };
}

function memberTargetsToObject(memberMap) {
  const out = {};
  for (const [memberName, bucket] of [...memberMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[memberName] = {
      global: bucket.global,
      byClass: mapToObject(bucket.byClass),
    };
  }
  return out;
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function summarize(classResults) {
  const summary = { safe: 0, risky: 0, unsafe: 0 };
  for (const result of Object.values(classResults)) {
    summary[result.rename] += 1;
  }
  return summary;
}

module.exports = {
  analyzeRenameSafety,
  collectReflectiveClassLoads,
  collectReflectiveMembers,
  collectStringReferences,
};
