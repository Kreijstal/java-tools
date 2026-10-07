'use strict';
// The shim boot JDK's `java`. There is no JVM: the main class named on the
// command line is looked up in a table of JavaScript ports of the JDK build
// tools. Launcher and VM options are accepted and ignored.
const fs = require('fs');
const { VERSION } = require('./config');

const TOOLS = {
  // the build compiles modules with javac run as -m jdk.compiler.interim/...
  'com.sun.tools.javac.Main': () => require('./javac'),
  'build.tools.spp.Spp': () => require('./tools/spp'),
  'build.tools.cldrconverter.CLDRConverter': () => require('./tools/cldrconverter'),
  jvmtiGen: () => require('./tools/jvmtigen'),
  'build.tools.jfr.GenerateJfrFiles': () => require('./tools/jfrgen'),
  'build.tools.compileproperties.CompileProperties': () => require('./tools/compileproperties'),
  'compileproperties.CompileProperties': () => require('./tools/compileproperties').langtools,
  'propertiesparser.PropertiesParser': () => require('./tools/propertiesparser'),
  'flagsgenerator.FlagsGenerator': () => require('./tools/flagsgenerator'),
  'build.tools.generatenimbus.Generator': () => require('./tools/generatenimbus'),
  'build.tools.charsetmapping.Main': () => require('./tools/charsetmapping'),
  'build.tools.generatecharacter.GenerateCharacter': () => require('./tools/gencharacter'),
  'build.tools.generatecharacter.GenerateCaseFolding': () => require('./tools/gencasefolding'),
  'build.tools.generatecharacter.CharacterName': () => require('./tools/gencharname'),
  'build.tools.generatespecialcasing.GenerateSpecialCasing': () => require('./tools/genspecialcasing'),
  'build.tools.generateextraproperties.GenerateExtraProperties': () => require('./tools/genextraprops'),
  'build.tools.generatebreakiteratordata.GenerateBreakIteratorData': () => require('./tools/genbreakiter'),
  'build.tools.intpoly.FieldGen': () => require('./tools/fieldgen'),
  'build.tools.generatelsrequivmaps.EquivMapsGenerator': () => require('./tools/equivmaps'),
  'build.tools.methodhandle.VarHandleGuardMethodGenerator': () => require('./tools/varhandleguards'),
  'build.tools.module.GenModuleLoaderMap': () => require('./tools/moduleloadermap'),
  'build.tools.module.GenModuleInfoSource': () => require('./tools/moduleinfosource'),
  'build.tools.tzdb.TzdbZoneRulesCompiler': () => require('./tools/tzdb'),
  'build.tools.generatecurrencydata.GenerateCurrencyData': () => require('./tools/currencydata'),
  'build.tools.makejavasecurity.MakeJavaSecurity': () => require('./tools/makejavasecurity'),
};

// launcher options that take a separate argument
const WITH_ARG = new Set([
  '-cp', '-classpath', '--class-path', '-p', '--module-path', '--upgrade-module-path',
  '--add-modules', '--limit-modules', '--add-exports', '--add-opens', '--add-reads',
  '--patch-module', '--enable-native-access', '--source', '-splash',
]);

function expandArgFiles(args) {
  const out = [];
  for (const a of args) {
    if (a.startsWith('@') && !a.startsWith('@@')) {
      const text = fs.readFileSync(a.slice(1), 'utf8');
      for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
        out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
      }
    } else out.push(a.startsWith('@@') ? a.slice(1) : a);
  }
  return out;
}

function versionText() {
  return [
    `openjdk version "${VERSION}" ${VERSION_DATE}`,
    `OpenJDK Runtime Environment (build ${VERSION}+0-javac-js-shim)`,
    `OpenJDK 64-Bit Server VM (build ${VERSION}+0-javac-js-shim, interpreted mode)`,
    '',
  ].join('\n');
}
const VERSION_DATE = '2026-09-15';

// finish(code) is called once the tool is done; tools whose main takes a
// second parameter finish asynchronously
function main(argv, finish) {
  const done = finish || (() => {});
  const r = run(argv, done);
  if (r !== undefined) done(r);
  return r;
}

function run(argv, finish) {
  const args = expandArgFiles(argv);
  let mainClass = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-version' || a === '--version') {
      process[a === '-version' ? 'stderr' : 'stdout'].write(versionText());
      return 0;
    }
    if (a === '-showversion' || a === '--show-version') { process.stderr.write(versionText()); continue; }
    if (a === '-m' || a === '--module') {
      const mod = args[++i] || '';
      mainClass = mod.includes('/') ? mod.slice(mod.indexOf('/') + 1) : null;
      if (!mainClass) { process.stderr.write(`shim java: module main class required: ${mod}\n`); return 1; }
      i++;
      break;
    }
    if (a === '-jar') { process.stderr.write('shim java: -jar is not supported\n'); return 1; }
    if (WITH_ARG.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    mainClass = a;
    i++;
    break;
  }
  if (!mainClass) { process.stderr.write('shim java: no main class given\n'); return 1; }
  const tool = TOOLS[mainClass];
  if (!tool) {
    process.stderr.write(`shim java: no JavaScript implementation of ${mainClass}\n`);
    return 1;
  }
  const impl = tool();
  if (impl.main.length >= 2) { impl.main(args.slice(i), finish); return undefined; }
  return impl.main(args.slice(i));
}

module.exports = { main, expandArgFiles };
