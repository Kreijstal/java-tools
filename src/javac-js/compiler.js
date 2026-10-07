'use strict';

// Driver: parse, enter, attribute, lower and generate class files.

const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');
const { Symtab } = require('./symbols');
const { Enter } = require('./enter');
const { Attr } = require('./attr');
const { Lower } = require('./lower');
const { Gen } = require('./gen');
const { ClassGen } = require('./classgen');
const { JNIWriter } = require('./jni');
const { generateModuleInfo } = require('./modulegen');

class Compiler {
  constructor(options) {
    this.options = options || {};
    this.syms = new Symtab({
      sourceRoots: this.options.sourceRoots || [],
      parseFile: (src, file) => parse(src, file),
    });
    this.types = this.syms.types;
    this.enter = new Enter(this);
    this.attr = new Attr(this);
    this.lower = new Lower(this);
    this.gen = new Gen(this);
    this.classgen = new ClassGen(this);
  }

  parseFiles(files) {
    const units = [];
    for (const f of files) {
      const abs = path.resolve(f);
      if (this.syms.unitsByFile.has(abs)) { units.push(this.syms.unitsByFile.get(abs)); continue; }
      const cu = parse(fs.readFileSync(abs, 'utf8'), abs);
      this.syms.addUnit(cu);
      units.push(cu);
    }
    return units;
  }

  // all classes (top level, member, local, anonymous) declared in the units
  classesOf(units) {
    const set = new Set(units.map((u) => u.info));
    const out = [];
    for (const c of this.syms.classes.values()) if (c.tree && set.has(c.unit)) out.push(c);
    return out;
  }

  // Compile files; write class files under outDir. Returns {written, errors}.
  compile(files, outDir, opts) {
    const options = opts || {};
    const units = this.parseFiles(files);
    const errors = [];
    const written = [];
    for (const cu of units) {
      for (const d of cu.types) {
        try {
          this.attr.attribClass(d.sym);
        } catch (e) {
          errors.push({ file: cu.file, phase: 'attr', error: e });
          cu.failed = true;
          if (options.failFast) throw e;
        }
      }
    }
    for (const c of this.classesOf(units.filter((u) => !u.failed))) {
      if (!this.attr.attributed.has(c) && !c.isLocal) continue;
      try {
        const bytes = this.classgen.generate(c);
        const out = path.join(outDir, `${c.binaryName()}.class`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, bytes);
        written.push(out);
      } catch (e) {
        errors.push({ file: c.unit && c.unit.file, cls: c.flatName, phase: 'gen', error: e });
        if (options.failFast) throw e;
      }
    }
    for (const cu of units) {
      if (!cu.module || cu.failed) continue;
      try {
        const out = path.join(outDir, 'module-info.class');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(out, generateModuleInfo(this, cu));
        written.push(out);
      } catch (e) {
        errors.push({ file: cu.file, phase: 'module', error: e });
        if (options.failFast) throw e;
      }
    }
    // JNI headers (javac -h); nl is the line separator, CRLF on Windows
    if (options.headerDir) {
      const jni = new JNIWriter(this);
      const nl = options.headerNewline || '\n';
      for (const c of this.classesOf(units.filter((u) => !u.failed))) {
        if (!this.attr.attributed.has(c) || !jni.needsHeader(c)) continue;
        try {
          written.push(jni.write(c, options.headerDir, nl));
        } catch (e) {
          errors.push({ file: c.unit && c.unit.file, cls: c.flatName, phase: 'jni', error: e });
          if (options.failFast) throw e;
        }
      }
    }
    return { written, errors };
  }
}

module.exports = { Compiler };
