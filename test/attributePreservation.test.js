const test = require('tape');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

function buildClassAstFromFile(classFilePath) {
  const classFileContent = fs.readFileSync(classFilePath);
  const originalAst = getAST(new Uint8Array(classFileContent));
  const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
  const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
  const krak2Ast = parseKrak2Assembly(jContent);
  return convertKrak2AstToClassAst(krak2Ast, { sourceText: jContent });
}

function upsertCodeAttribute(codeAttribute, attribute) {
  const existingIndex = codeAttribute.code.attributes.findIndex((attr) => attr.type === attribute.type);
  if (existingIndex !== -1) {
    codeAttribute.code.attributes[existingIndex] = attribute;
  } else {
    codeAttribute.code.attributes.push(attribute);
  }
}

function ensureLocalVariableTypeTable(codeAttribute, entries) {
  const vars = entries.map((variable) => ({
    index: String(variable.index),
    name: variable.name,
    descriptor: variable.descriptor,
    startLbl: variable.startLbl,
    endLbl: variable.endLbl,
  }));
  upsertCodeAttribute(codeAttribute, {
    type: 'localvariabletypetable',
    vars,
  });
}

function ensureLocalVariableTable(codeAttribute, entries) {
  const vars = entries.map((variable) => ({
    index: String(variable.index),
    name: variable.name,
    descriptor: variable.descriptor,
    startLbl: variable.startLbl,
    endLbl: variable.endLbl,
  }));
  upsertCodeAttribute(codeAttribute, {
    type: 'localvariabletable',
    vars,
  });
}

function ensureStackMapTable(codeAttribute, frames) {
  const normalizedFrames = frames.map((frame) => ({ ...frame }));
  upsertCodeAttribute(codeAttribute, {
    type: 'stackmaptable',
    frames: normalizedFrames,
  });
}

function normalizeLabel(label) {
  if (label == null) {
    return label;
  }
  const text = String(label).trim();
  if (!text) {
    return text;
  }
  return text.endsWith(':') ? text.slice(0, -1) : text;
}

function cloneLocalVariableEntries(attribute) {
  if (!attribute || !Array.isArray(attribute.vars)) {
    return [];
  }
  return attribute.vars.map((variable) => ({
    index: Number(variable.index),
    name: variable.name,
    descriptor: variable.descriptor,
    startLbl: normalizeLabel(variable.startLbl ?? variable.startLabel ?? variable.start),
    endLbl: normalizeLabel(variable.endLbl ?? variable.endLabel ?? variable.end),
  }));
}

function execOrRecordSkip({ t, cleanupPaths, skipState }, command, args, options = {}) {
  if (skipState.shouldSkip) {
    return null;
  }
  try {
    return execFileSync(command, args, options);
  } catch (error) {
    if (error.code === 'EPERM' || error.errno === 'EPERM') {
      skipState.shouldSkip = true;
      skipState.reason = `Skipping attribute preservation: unable to execute '${command}' (${error.message})`;
      return null;
    }
    throw error;
  }
}

test('assembler preserves constant values and debug tables', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-attrs-'));
  const compileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ast-attrs-src-'));
  const cleanupPaths = [outputDir, compileDir];
  const className = 'DebugInfoSample';
  const javaFilePath = path.join(__dirname, `../sources/${className}.java`);
  const compiledClassPath = path.join(compileDir, `${className}.class`);
  const outputClassPath = path.join(outputDir, `${className}.class`);
  const skipState = { shouldSkip: false, reason: null };

  try {
    const javacResult = execOrRecordSkip({ t, cleanupPaths, skipState }, 'javac', ['-g', '-d', compileDir, javaFilePath], { stdio: 'inherit' });
    if (skipState.shouldSkip) {
      return;
    }

    const classAstRoot = buildClassAstFromFile(compiledClassPath);
    const classDef = classAstRoot.classes[0];

    classDef.items.forEach((item) => {
      if (item.type !== 'field') {
        return;
      }
      if (item.field.name === 'ANSWER') {
        item.field.flags = ['public', 'static', 'final'];
        item.field.attrs = { attributes: [{ type: 'constantvalue', value: '42' }] };
      } else if (item.field.name === 'GREETING') {
        item.field.flags = ['public', 'static', 'final'];
        item.field.attrs = { attributes: [{ type: 'constantvalue', value: '"hi"' }] };
      }
    });

    const addMethod = classDef.items.find(
      (item) => item.type === 'method' && item.method && item.method.name === 'add'
    );
    if (!addMethod) {
      throw new Error('Expected add method in DebugInfoSample');
    }
    const addCodeAttribute = addMethod.method.attributes.find((attr) => attr.type === 'code');
    if (!addCodeAttribute) {
      throw new Error('Expected code attribute for add method');
    }
    const originalAddLocalVariableTable = addCodeAttribute.code.attributes.find(
      (attr) => attr.type === 'localvariabletable'
    );
    ensureLocalVariableTable(addCodeAttribute, cloneLocalVariableEntries(originalAddLocalVariableTable));

    const consumeMethod = classDef.items.find(
      (item) => item.type === 'method' && item.method && item.method.name === 'consume'
    );
    if (!consumeMethod) {
      throw new Error('Expected consume method in DebugInfoSample');
    }
    const consumeCodeAttribute = consumeMethod.method.attributes.find((attr) => attr.type === 'code');
    if (!consumeCodeAttribute) {
      throw new Error('Expected code attribute for consume method');
    }
    const originalConsumeLocalVariableTable = consumeCodeAttribute.code.attributes.find(
      (attr) => attr.type === 'localvariabletable'
    );
    const consumeLocalVariables = cloneLocalVariableEntries(originalConsumeLocalVariableTable);
    ensureLocalVariableTable(consumeCodeAttribute, consumeLocalVariables);

    const valueVariable = consumeLocalVariables.find((variable) => variable.name === 'value');
    const inputVariable = consumeLocalVariables.find((variable) => variable.name === 'input');
    if (!valueVariable || !inputVariable) {
      throw new Error('Expected value and input variables in consume LocalVariableTable');
    }
    ensureLocalVariableTypeTable(consumeCodeAttribute, [
      {
        index: valueVariable.index,
        name: 'value',
        descriptor: 'TT;',
        startLbl: valueVariable.startLbl,
        endLbl: valueVariable.endLbl,
      },
      {
        index: inputVariable.index,
        name: 'input',
        descriptor: 'Ljava/util/List<TT;>;',
        startLbl: inputVariable.startLbl,
        endLbl: inputVariable.endLbl,
      },
    ]);
    ensureStackMapTable(consumeCodeAttribute, [
      {
        type: 'append',
        offsetDelta: 7,
        locals: [{ tag: 'object', className: 'java/util/Iterator' }],
      },
      {
        type: 'chop',
        offsetDelta: 28,
        chop: 1,
      },
    ]);

    if (!Array.isArray(classDef.bootstrapMethods)) {
      classDef.bootstrapMethods = [];
    }
    const bootstrapTemplate = classDef.bootstrapMethods[0]
      ? JSON.parse(JSON.stringify(classDef.bootstrapMethods[0].method_ref))
      : {
          type: 'MethodHandle',
          value: {
            kind: 'invokeStatic',
            reference: {
              className: 'java/lang/invoke/StringConcatFactory',
              nameAndType: {
                name: 'makeConcatWithConstants',
                descriptor:
                  '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite;',
              },
            },
          },
        };
    classDef.bootstrapMethods.push({
      method_ref: JSON.parse(JSON.stringify(bootstrapTemplate)),
      arguments: [
        { type: 'String', value: 'unused recipe' },
        { type: 'Integer', value: '123' },
        { type: 'Float', value: '3.25f' },
        { type: 'Double', value: '6.5d' },
        { type: 'Long', value: '16' },
        { type: 'Boolean', value: true },
      ],
    });

    writeClassAstToClassFile(classAstRoot, outputClassPath);

    const runtimeOutput = execOrRecordSkip({ t, cleanupPaths, skipState }, 'java', ['-cp', outputDir, className], { encoding: 'utf8' });
    if (skipState.shouldSkip) {
      return;
    }
    t.ok(runtimeOutput.includes('ANSWER=42'), 'main output should include inlined answer constant');
    t.ok(runtimeOutput.includes('GREETING=hi'), 'main output should include inlined greeting constant');
    t.ok(runtimeOutput.includes('REFL_ANSWER=42'), 'reflection should observe int constant value');
    t.ok(runtimeOutput.includes('REFL_GREETING=hi'), 'reflection should observe string constant value');

    const javapDebug = execOrRecordSkip({ t, cleanupPaths, skipState }, 'javap', ['-classpath', outputDir, '-l', className], { encoding: 'utf8' });
    if (skipState.shouldSkip) {
      return;
    }
    t.ok(javapDebug.includes('LocalVariableTable:'), 'javap -l should list LocalVariableTable');
    t.ok(javapDebug.includes('doubled'), 'LocalVariableTable should retain variable names');

    const javapVerbose = execOrRecordSkip({ t, cleanupPaths, skipState }, 'javap', ['-classpath', outputDir, '-v', className], { encoding: 'utf8' });
    if (skipState.shouldSkip) {
      return;
    }
    t.ok(javapVerbose.includes('ConstantValue: int 42'), 'ConstantValue attribute for int field should be present');
    t.ok(javapVerbose.includes('ConstantValue: String hi'), 'ConstantValue attribute for string field should be present');
    t.ok(javapVerbose.includes('LocalVariableTypeTable:'), 'LocalVariableTypeTable attribute should be present');
    t.ok(javapVerbose.includes('Ljava/util/List<TT;>;'), 'LocalVariableTypeTable should retain generic signature');
    t.ok(javapVerbose.includes('StackMapTable: number_of_entries = 2'), 'StackMapTable attribute should be present');
    t.ok(/#\d+\s+123/.test(javapVerbose), 'BootstrapMethods should include primitive int arguments');
    t.ok(javapVerbose.includes('3.25f'), 'BootstrapMethods should include primitive float arguments');
    t.ok(javapVerbose.includes('6.5d'), 'BootstrapMethods should include primitive double arguments');
    t.ok(javapVerbose.includes('16l'), 'BootstrapMethods should include primitive long arguments');
  } catch (error) {
    t.fail(`Attribute preservation test failed: ${error.message}`);
  } finally {
    cleanupPaths.forEach((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    if (skipState.shouldSkip) {
      t.skip(skipState.reason);
    }
    t.end();
  }
});
