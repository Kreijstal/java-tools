'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('node:child_process');
const frontend = require('../src/java-frontend');

// `record` is a contextual keyword: only `record Name(...)` declares a record.
// Brick-A-Brac's decompiled source names a local `record`.
test('a local named record is an ordinary variable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-record-name-'));
  const source = `public class RecordName {
    static class Entry { int value; }
    public static void main(String[] args) {
      Entry record = null;
      for (int i = 0; i < 3; i++) {
        record = new Entry();
        record.value = i * 7;
      }
      Entry[] records = {record};
      System.out.println(records[0].value);
    }
  }`;
  try {
    const original = path.join(directory, 'original'), compiled = path.join(directory, 'frontend');
    fs.mkdirSync(original); fs.mkdirSync(compiled);
    const file = path.join(directory, 'RecordName.java'); fs.writeFileSync(file, source);
    execFileSync('javac', ['--release', '8', '-d', original, file]);
    const execute = classes => execFileSync('java', ['-Xverify:all', '-cp', classes, 'RecordName'], {encoding:'utf8'});
    assert.equal(execute(original), '14\n');
    frontend.compileJavaSource(source, {sourceFileName:'RecordName.java', outputDir:compiled});
    assert.equal(execute(compiled), '14\n');
  } finally {fs.rmSync(directory, {recursive:true, force:true});}
});
