'use strict';
// Port of build.tools.compileproperties.CompileProperties (make/jdk) and of
// the langtools variant compileproperties.CompileProperties: .properties ->
// ListResourceBundle subclass source.

const fs = require('fs');
const { LNSEP } = require('./util');
const { readUtf8Strict, loadProperties } = require('./props-load');

const HEX = '0123456789ABCDEF';

function escape(s) {
  let out = '';
  for (let x = 0; x < s.length; x++) {
    const c = s[x];
    const code = s.charCodeAt(x);
    switch (c) {
      case '\\': out += '\\\\'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\f': out += '\\f'; break;
      default:
        if (code < 0x20 || code > 0x7e) {
          out += '\\u' + HEX[(code >> 12) & 15] + HEX[(code >> 8) & 15] + HEX[(code >> 4) & 15] + HEX[code & 15];
        } else {
          if (c === '"') out += '\\';
          out += c;
        }
    }
  }
  return out;
}

const WIN = process.platform === 'win32';

// new File(p).getPath() then split on File.separator (String.split drops
// trailing empty strings)
function pathParts(p) {
  if (WIN) p = p.replace(/\//g, '\\');
  const sep = WIN ? '\\' : '/';
  // java.io.File normalisation: collapse duplicate separators, drop trailing one
  const lead = WIN && p.startsWith('\\\\') ? '\\' : '';
  p = lead + p.replace(WIN ? /\\+/g : /\/+/g, sep);
  if (p.length > 1 && p.endsWith(sep)) p = p.slice(0, -1);
  const parts = p.split(sep);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function inferPackageName(inputPath, outputPath, langtools) {
  const inputs = pathParts(inputPath);
  const outputs = pathParts(outputPath);
  const inEnd = inputs.length - 2;
  const outEnd = outputs.length - 2;
  let i = inEnd, j = outEnd;
  while (i >= 0 && j >= 0) {
    if (inputs[i] !== outputs[j]
        // (sic) the jdk tool compares inputs[j]
        || (langtools ? inputs[i] === 'gensrc' && outputs[j] === 'gensrc'
          : inputs[i] === 'gensrc' && inputs[j] === 'gensrc')
        || (langtools && inputs[i].includes('.'))) {
      ++i; ++j;
      break;
    }
    --i; --j;
  }
  if (i < 0 || j < 0 || i >= inEnd || j >= outEnd) return '';
  if (!langtools) {
    if (inputs[i] === 'classes' && outputs[j] === 'classes') ++i;
    if (i > 0 && inputs[i - 1] === 'modules') ++i;
  }
  return inputs.slice(i, inEnd + 1).join('.');
}

function toAscii(s) {
  return Buffer.from(s.replace(/[^\x00-\x7f]/g, '?'), 'latin1');
}

function makeTool(langtools) {
  const ERR = langtools ? 'ERROR: CompileProperties: ' : 'ERROR: compileproperties: ';
  let quiet = false;
  const log = {
    error(msg, e) {
      process.stderr.write(ERR + msg + LNSEP);
      if (e) process.stderr.write('EXCEPTION: ' + (e.javaClass ? e.javaClass + ': ' + e.message : String(e)) + LNSEP);
    },
    info(msg) { process.stdout.write(msg + LNSEP); },
    verbose(msg) { if (!quiet) process.stdout.write(msg + LNSEP); },
  };

  function createFile(propertiesPath, outputPath, superClass) {
    log.verbose('parsing: ' + propertiesPath);
    let props;
    try {
      props = loadProperties(readUtf8Strict(propertiesPath));
    } catch (e) {
      if (e.code === 'ENOENT') {
        e.javaClass = 'java.nio.file.NoSuchFileException';
        e.message = propertiesPath;
      } else if (!e.javaClass) throw e;
      log.error('IO error on file ' + propertiesPath, e);
      return false;
    }
    const packageName = inferPackageName(propertiesPath, outputPath, langtools);
    log.verbose('inferred package name: ' + packageName);
    const keys = [...props.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let data = '';
    for (const k of keys) data += '            { "' + escape(k) + '", "' + escape(props.get(k)) + '" },\n';

    const name = pathParts(outputPath).pop() || '';
    const dot = name.lastIndexOf('.');
    const className = dot === -1 ? name : name.slice(0, dot);
    const packageString = packageName ? 'package ' + packageName + ';\n\n' : '';
    const text = packageString
      + (langtools ? '' : 'import java.util.ListResourceBundle;\n\n')
      + 'public final class ' + className + ' extends ' + superClass + ' {\n'
      + '    protected final Object[][] getContents() {\n'
      + '        return new Object[][] {\n'
      + data
      + '        };\n'
      + '    }\n'
      + '}\n';
    try {
      fs.writeFileSync(outputPath, toAscii(text));
    } catch (e) {
      log.error('IO error writing to file ' + outputPath, e);
      return false;
    }
    log.verbose('wrote: ' + outputPath);
    return true;
  }

  const jobs = [];
  function parseOptions(args) {
    let ok = true;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-compile' && i + 3 < args.length) {
        jobs.push([args[++i], args[++i], args[++i]]);
      } else if (langtools ? args[i].startsWith('@') && args[i].length > 1 : args[i].charAt(0) === '@') {
        const filename = args[i].slice(1);
        let contents = null;
        try {
          contents = fs.readFileSync(filename);
          if (contents.length <= 0) {
            log.error(langtools ? 'The @-file file is empty' : 'The @file is empty', null);
            ok = false;
            contents = null;
          }
        } catch (e) {
          log.error('cannot open ' + filename, e);
          ok = false;
        }
        if (langtools) ok = true;
        if (ok && contents !== null) {
          // new String(bytes).split("\\s+")
          const tokens = contents.toString('utf8').split(/[ \t\n\x0b\f\r]+/);
          while (tokens.length > 1 && tokens[tokens.length - 1] === '') tokens.pop();
          if (tokens.length > 0) ok = parseOptions(tokens);
        }
        if (!ok) break;
      } else if (args[i] === '') {
        if (!langtools) throw new Error('java.lang.StringIndexOutOfBoundsException: Index 0 out of bounds for length 0');
        log.error('argument error', null);
        ok = false;
      } else if (langtools && args[i] === '-quiet') {
        quiet = true;
      } else {
        log.error('argument error', null);
        ok = false;
      }
    }
    return ok;
  }

  function usage() {
    if (langtools) {
      for (const l of [
        'usage:',
        '    java CompileProperties {-compile path_to_properties_file path_to_java_output_file super_class} -or- @optionsfile',
        '',
        'Example:',
        '    java CompileProperties -compile test.properties test.java java.util.ListResourceBundle',
        '    java CompileProperties @optionsfile',
        'optionsfile contains: -compile test.properties test.java java.util.ListResourceBundle',
      ]) log.info(l);
      return;
    }
    for (const l of [
      'usage:',
      '    java -jar compileproperties.jar path_to_properties_file path_to_java_output_file [super_class]',
      '      -OR-',
      '    java -jar compileproperties.jar {-compile path_to_properties_file path_to_java_output_file super_class} -or- @filename',
      '',
      'Example:',
      '    java -jar compileproperties.jar -compile test.properties test.java ListResourceBundle',
      '    java -jar compileproperties.jar @option_file',
      'option_file contains: -compile test.properties test.java ListResourceBundle',
    ]) process.stderr.write(l + LNSEP);
  }

  function runBatch(args) {
    let ok = parseOptions(args);
    if (ok && jobs.length === 0) {
      log.error('options parsed but no files to compile', null);
      ok = false;
    }
    if (!ok) { usage(); return false; }
    for (let i = 0; i < jobs.length && ok; i++) ok = createFile(...jobs[i]);
    return ok;
  }

  return function main(args) {
    if (langtools) return runBatch(args) ? 0 : 1;
    let ok;
    if (args.length >= 1 && args[0] === '-quiet') { quiet = true; args = args.slice(1); }
    if (args.length === 2 && args[0].charAt(0) !== '-') ok = createFile(args[0], args[1], 'ListResourceBundle');
    else if (args.length === 3) ok = createFile(args[0], args[1], args[2]);
    else if (args.length === 0) { usage(); ok = false; }
    else ok = runBatch(args);
    return ok ? 0 : 1;
  };
}

module.exports = {
  main: (args) => makeTool(false)(args),
  langtools: { main: (args) => makeTool(true)(args) },
  escape, inferPackageName,
};
