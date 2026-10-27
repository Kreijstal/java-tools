'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('node:child_process');
const frontend = require('../src/java-frontend');

test('sibling, loop and labeled scopes retain distinct locals and restore field lookup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-local-scopes-'));
  const source = `public class ScopeLifetimes {
    static int item = 17;
    static int run(int mode) {
      int sum = 0;
      for (int k = 0; k < 3; k++) {
        {Object item = new Object(); if (item != null) sum++;}
        {int item = k * 3; sum += item;}
        First: {long carry = 10L + k; sum += (int)carry;
          if (mode == 1) break First; sum += 2;}
        int after = 5; sum += after;
        int n = 2;
        do {double value = n + 0.5; sum += (int)value;} while (--n > 0);
        int tail = 7; sum += tail;
      }
      for (int item = 0; item < 2; item++) sum += item;
      for (int item : new int[]{4, 6}) sum += item;
      return sum + item;
    }
    static int caught() {
      try {throw new IllegalArgumentException();}
      catch (RuntimeException item) {if (item == null) return -1;}
      {int item = 9; return item;}
    }
    public static void main(String[] args) {
      System.out.println(run(0)); System.out.println(run(1)); System.out.println(caught());
    }
  }`;
  try {
    const original = path.join(directory, 'original'), compiled = path.join(directory, 'frontend');
    fs.mkdirSync(original); fs.mkdirSync(compiled);
    const file = path.join(directory, 'ScopeLifetimes.java'); fs.writeFileSync(file, source);
    execFileSync('javac', ['--release', '8', '-d', original, file]);
    const execute = classes => execFileSync('java', ['-Xverify:all', '-cp', classes, 'ScopeLifetimes'], {encoding:'utf8'});
    assert.equal(execute(original), '124\n118\n9\n', 'independent arithmetic and scope oracle');
    const result = frontend.compileJavaSource(source, {sourceFileName:'ScopeLifetimes.java',outputDir:compiled});
    assert.equal(execute(compiled), '124\n118\n9\n', 'frontend bytecode verifies and matches lexical lifetimes');
    for (const method of result.javaIr.classes[0].methods) {
      assert.equal(new Set(method.locals.map(local => local.id)).size, method.locals.length, method.name + ' identities');
      const occupied = new Set();
      for (const local of method.locals) {
        for (let index = 0; index < (['J','D'].includes(local.descriptor) ? 2 : 1); index++) {
          const slot = local.slotHint + index;
          assert.ok(!occupied.has(slot), method.name + ' overlapping slot ' + slot);occupied.add(slot);
        }
      }
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
