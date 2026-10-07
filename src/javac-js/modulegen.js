'use strict';

// module-info.class from a module declaration (JVMS 4.7.25 Module attribute).
// Service and provider names are resolved to binary names through the
// symbol table so nested classes get their $ names.

const { ByteWriter, ClassFile } = require('./classfile');

const ACC_OPEN = 0x0020;
const ACC_TRANSITIVE = 0x0020;
const ACC_STATIC_PHASE = 0x0040;
const ACC_MANDATED = 0x8000;
const ACC_MODULE = 0x8000;

function qualName(t) {
  return t.tag === 'Select' ? `${qualName(t.selected)}.${t.name}` : t.name;
}

function generateModuleInfo(compiler, cu) {
  const md = cu.module;
  const name = qualName(md.name);
  const cf = new ClassFile();
  const pool = cf.pool;
  cf.access = ACC_MODULE;
  cf.thisClass = 'module-info';
  cf.superClass = null;

  const binaryClass = (t) => {
    const q = qualName(t);
    const c = compiler.syms.findClassByName(q);
    if (!c) throw new Error(`module ${name}: cannot find class ${q}`);
    return pool.clazz(c.binaryName());
  };

  const w = new ByteWriter();
  w.u2(pool.module(name));
  w.u2(md.open ? ACC_OPEN : 0);
  w.u2(0); // no version

  const dirs = (tag) => md.directives.filter((d) => d.tag === tag);
  const requires = dirs('Requires').map((d) => ({
    mod: qualName(d.moduleName),
    flags: (d.isTransitive ? ACC_TRANSITIVE : 0) | (d.isStatic ? ACC_STATIC_PHASE : 0),
  }));
  if (name !== 'java.base' && !requires.some((r) => r.mod === 'java.base')) {
    requires.unshift({ mod: 'java.base', flags: ACC_MANDATED });
  }
  w.u2(requires.length);
  for (const r of requires) { w.u2(pool.module(r.mod)); w.u2(r.flags); w.u2(0); }

  for (const tag of ['Exports', 'Opens']) {
    const list = dirs(tag);
    w.u2(list.length);
    for (const d of list) {
      w.u2(pool.packge(qualName(d.pkg).replace(/\./g, '/')));
      w.u2(0);
      w.u2(d.to.length);
      for (const m of d.to) w.u2(pool.module(qualName(m)));
    }
  }
  const uses = dirs('Uses');
  w.u2(uses.length);
  for (const d of uses) w.u2(binaryClass(d.service));
  const provides = dirs('Provides');
  w.u2(provides.length);
  for (const d of provides) {
    w.u2(binaryClass(d.service));
    w.u2(d.impls.length);
    for (const i of d.impls) w.u2(binaryClass(i));
  }
  cf.attributes.push(cf.attr('Module', w));
  return cf.toBuffer();
}

module.exports = { generateModuleInfo };
