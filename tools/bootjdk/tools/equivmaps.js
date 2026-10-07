'use strict';
// Port of make/jdk/src/classes/build/tools/generatelsrequivmaps/
// EquivMapsGenerator.java: IANA language-subtag-registry ->
// sun/util/locale/LocaleEquivalentMaps.java.
//
// usage: EquivMapsGenerator [-jdk-header-template <file>]
//            language-subtag-registry.txt LocaleEquivalentMaps.java copyrightYear
const fs = require('fs');
const { LNSEP } = require('./util');
const { compareStrings } = require('./misc-java');

// java.util.TreeMap<String, V> stand-in: a Map whose keys() are sorted
const sortedKeys = m => [...m.keys()].sort(compareStrings);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// String.split(regex) drops trailing empty strings
function javaSplit(s, sep) {
  const parts = s.split(sep);
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const COPYRIGHT = `/*
 * Copyright (c) 2012, %d, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 only, as
 * published by the Free Software Foundation.  Oracle designates this
 * particular file as subject to the "Classpath" exception as provided
 * by Oracle in the LICENSE file that accompanied this code.
 *
 * This code is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * version 2 for more details (a copy is included in the LICENSE file that
 * accompanied this code).
 *
 * You should have received a copy of the GNU General Public License version
 * 2 along with this work; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA
 * or visit www.oracle.com if you need additional information or have any
 * questions.
*/
`;

const HEADER_TEXT = `package sun.util.locale;

import java.util.HashMap;
import java.util.Map;

final class LocaleEquivalentMaps {

    static final Map<String, String> singleEquivMap;
    static final Map<String, String[]> multiEquivsMap;
    static final Map<String, String> regionVariantEquivMap;

`;

const FOOTER_TEXT = '    }\n\n}\n';

function generate(lsrText, copyrightYear, headerTemplate) {
  let revisionDate = null;
  const initialLanguageMap = new Map();      // preferred -> [string]
  const initialRegionVariantMap = new Map();

  function processDeprecatedData(type, tag, preferred, prefix) {
    if (type === null || tag === null || preferred === null) return;
    if (type === 'extlang' && prefix !== null) tag = prefix + '-' + tag;
    if (type === 'region' || type === 'variant') {
      // (the Java tool checks the unprefixed key but stores "-"+preferred)
      if (initialRegionVariantMap.has(preferred)) {
        throw new Error('New case, need implementation. A region/variant subtag "'
          + preferred + '" is registered for more than one subtags.');
      }
      initialRegionVariantMap.set('-' + preferred, { s: '-' + preferred + ',-' + tag });
    } else if (!initialLanguageMap.has(preferred)) {
      const pattern = new RegExp(',' + escapeRe(preferred) + '(,|$)');
      const doublePrefs = sortedKeys(initialLanguageMap).map(k => initialLanguageMap.get(k))
        .filter(e => pattern.test(e.s));
      for (const other of doublePrefs) other.s += ',' + tag;
      if (doublePrefs.length === 0) initialLanguageMap.set(preferred, { s: preferred + ',' + tag });
    } else {
      initialLanguageMap.get(preferred).s += ',' + tag;
    }
  }

  let type = null, tag = null, preferred = null, prefix = null;
  const lines = lsrText.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  for (let line of lines) {
    line = line.toLowerCase();
    const index = line.indexOf(' ') + 1;
    if (line.startsWith('file-date:')) revisionDate = line.substring(index);
    else if (line.startsWith('type:')) type = line.substring(index);
    else if (line.startsWith('tag:') || line.startsWith('subtag:')) tag = line.substring(index);
    else if (line.startsWith('preferred-value:')) preferred = line.substring(index);
    else if (line.startsWith('prefix:')) prefix = line.substring(index);
    else if (line === '%%') {
      processDeprecatedData(type, tag, preferred, prefix);
      type = tag = preferred = prefix = null;
    }
  }
  processDeprecatedData(type, tag, preferred, prefix);

  const map1 = new Map(), map2 = new Map(), regionMap = new Map();
  for (const pref of sortedKeys(initialLanguageMap)) {
    const subtags = [...new Set(javaSplit(initialLanguageMap.get(pref).s, ','))];
    if (subtags.length === 2) {
      map1.set(subtags[0], subtags[1]);
      map1.set(subtags[1], subtags[0]);
    } else if (subtags.length > 2) {
      subtags.forEach((s, i) => map2.set(s, subtags.filter((_, j) => j !== i)));
    } else {
      throw new Error('New case, need implementation. A language subtag "' + pref
        + '" is registered for more than two subtags. ');
    }
  }
  for (const pref of sortedKeys(initialRegionVariantMap)) {
    const subtags = javaSplit(initialRegionVariantMap.get(pref).s, ',');
    regionMap.set(subtags[0], subtags[1]);
    regionMap.set(subtags[1], subtags[0]);
  }

  let out = (headerTemplate !== null ? headerTemplate : COPYRIGHT).replace(/%d/, String(copyrightYear));
  out += '\n' + HEADER_TEXT;
  out += '    static {\n'
    + `        singleEquivMap = HashMap.newHashMap(${map1.size});\n`
    + `        multiEquivsMap = HashMap.newHashMap(${map2.size});\n`
    + `        regionVariantEquivMap = HashMap.newHashMap(${regionMap.size});\n\n`;
  out += '        // This is an auto-generated file and should not be manually edited.\n'
    + `        //   LSR Revision: ${revisionDate}\n`;
  const writeEquiv = (name, m) => {
    for (const k of sortedKeys(m)) out += `        ${name}.put("${k}", "${m.get(k)}");` + LNSEP;
  };
  writeEquiv('singleEquivMap', map1);
  out += LNSEP;
  for (const k of sortedKeys(map2)) {
    const values = map2.get(k);
    if (values.length >= 2) {
      out += `        multiEquivsMap.put("${k}", new String[] {${values.map(v => `"${v}"`).join(', ')}});` + LNSEP;
    }
  }
  out += LNSEP;
  writeEquiv('regionVariantEquivMap', regionMap);
  return out + FOOTER_TEXT;
}

function main(args) {
  let i = 0;
  let headerTemplate = null;
  let valid = args.length === 5 || args.length === 3;
  if (args.length === 5) {
    if (args[i] === '-jdk-header-template') {
      headerTemplate = fs.readFileSync(args[++i], 'utf8');
      i++;
    } else valid = false;
  }
  if (!valid) {
    process.stderr.write('Usage: java EquivMapsGenerator [-jdk-header-template <file>]'
      + ' language-subtag-registry.txt LocaleEquivalentMaps.java copyrightYear' + LNSEP);
    return 1;
  }
  const lsrFile = args[i++];
  const outputFile = args[i++];
  const year = parseInt(args[i++], 10);
  fs.writeFileSync(outputFile, generate(fs.readFileSync(lsrFile, 'utf8'), year, headerTemplate));
  return 0;
}

module.exports = { main, generate };
