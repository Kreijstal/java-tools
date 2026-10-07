'use strict';
// Port of build.tools.cldrconverter.CLDRConverter (with Bundle and
// ResourceBundleGenerator): converts CLDR LDML data into the JDK's locale
// resource bundles, CLDR(Base)LocaleDataMetaInfo, java.time ZoneName.java and
// the Windows tzmappings. Java HashMap/TreeMap iteration order is reproduced
// (cldr-jhashmap.js, cldr-treemap.js) wherever it reaches the output.

const fs = require('fs');
const path = require('path');
const { LNSEP } = require('./util');
const { parseFile } = require('./cldr-sax');
const { JHashMap, JHashSet, stringHash } = require('./cldr-jhashmap');
const { JTreeMap, JTreeSet } = require('./cldr-treemap');
const L = require('./cldr-locale');
const H = require('./cldr-handlers');
const { JList, CalendarType, jsplit, jsplitWs, cmpStr } = H;

const C = {
  LOCALE_NAME_PREFIX: 'locale.displayname.',
  LOCALE_SEPARATOR: 'locale.displayname.separator',
  LOCALE_KEYTYPE: 'locale.displayname.keytype',
  LOCALE_KEY_PREFIX: 'locale.displayname.key.',
  LOCALE_TYPE_PREFIX: 'locale.displayname.type.',
  LOCALE_TYPE_PREFIX_CA: 'locale.displayname.type.ca.',
  CURRENCY_SYMBOL_PREFIX: 'currency.symbol.',
  CURRENCY_NAME_PREFIX: 'currency.displayname.',
  CALENDAR_NAME_PREFIX: 'calendarname.',
  CALENDAR_FIRSTDAY_PREFIX: 'firstDay.',
  CALENDAR_MINDAYS_PREFIX: 'minDays.',
  TIMEZONE_ID_PREFIX: 'timezone.id.',
  EXEMPLAR_CITY_PREFIX: 'timezone.excity.',
  ZONE_NAME_PREFIX: 'timezone.displayname.',
  METAZONE_ID_PREFIX: 'metazone.id.',
  METAZONE_DSTOFFSET_PREFIX: 'metazone.dstoffset.',
  PARENT_LOCALE_PREFIX: 'parentLocale.',
  LIKELY_SCRIPT_PREFIX: 'likelyScript.',
  META_EMPTY_ZONE_NAME: 'EMPTY_ZONE',
  META_ETCUTC_ZONE_NAME: 'ETC_UTC',
  DATEFORMATITEM_KEY_PREFIX: 'DateFormatItem.',
  DATEFORMATITEM_INPUT_REGIONS_PREFIX: 'DateFormatItemInputRegions.',
};
const EMPTY_ZONE = ['', '', '', '', '', ''];
const NBSP = ' ';

const SHORT_IDS = [
  ['ACT', 'Australia/Darwin'], ['AET', 'Australia/Sydney'], ['AGT', 'America/Argentina/Buenos_Aires'],
  ['ART', 'Africa/Cairo'], ['AST', 'America/Anchorage'], ['BET', 'America/Sao_Paulo'],
  ['BST', 'Asia/Dhaka'], ['CAT', 'Africa/Harare'], ['CNT', 'America/St_Johns'],
  ['CST', 'America/Chicago'], ['CTT', 'Asia/Shanghai'], ['EAT', 'Africa/Addis_Ababa'],
  ['ECT', 'Europe/Paris'], ['IET', 'America/Indiana/Indianapolis'], ['IST', 'Asia/Kolkata'],
  ['JST', 'Asia/Tokyo'], ['MIT', 'Pacific/Apia'], ['NET', 'Asia/Yerevan'], ['NST', 'Pacific/Auckland'],
  ['PLT', 'Asia/Karachi'], ['PNT', 'America/Phoenix'], ['PRT', 'America/Puerto_Rico'],
  ['PST', 'America/Los_Angeles'], ['SST', 'Pacific/Guadalcanal'], ['VST', 'Asia/Ho_Chi_Minh'],
  ['EST', 'America/Panama'], ['MST', 'America/Phoenix'], ['HST', 'Pacific/Honolulu'],
];

const TZDB_FILES = ['africa', 'antarctica', 'asia', 'australasia', 'europe', 'northamerica',
  'southamerica', 'backward', 'etcetera', 'gmt', 'jdk11_backward'];
const TZ_FILES = /^(africa|antarctica|asia|australasia|backward|etcetera|europe|northamerica|southamerica)$/;

// ---- small Java helpers ---------------------------------------------------

function escape(s) {
  if (s === null || s === undefined) return '';
  let out = '';
  for (let x = 0; x < s.length; x++) {
    const c = s[x];
    switch (c) {
    case ' ': out += x === 0 ? '\\ ' : ' '; break;
    case '\\': case '"': out += '\\' + c; break;
    case '\t': out += '\\t'; break;
    case '\n': out += '\\n'; break;
    case '\r': out += '\\r'; break;
    case '\f': out += '\\f'; break;
    default:
      if (c.charCodeAt(0) < 0x20) out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      else out += c;
    }
  }
  return out;
}
C.escape = escape;

const isNull = (v) => v === null || v === undefined;
const nn = (v) => (v === undefined ? null : v);

// Objects.deepEquals for the value kinds found in the bundle maps
function deepEquals(a, b) {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if ((a instanceof JList) !== (b instanceof JList)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (nn(a[i]) !== nn(b[i])) return false;
    return true;
  }
  if (a instanceof JHashMap && b instanceof JHashMap) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) {
      if (!b.has(k) || nn(b.get(k)) !== nn(v)) return false;
    }
    return true;
  }
  return false;
}

// Arrays.equals for String[]
const arraysEqual = (a, b) => a.length === b.length && a.every((x, i) => nn(x) === nn(b[i]));

function readLines(file) {
  let t = fs.readFileSync(file, 'utf8');
  if (t === '') return [];
  const lines = t.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const isBlank = (s) => /^[\s]*$/.test(s);

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.map((l) => l + LNSEP).join(''));
}

// java.util.Properties keys (simple subset: key=value lines)
function propertyKeys(file) {
  const keys = [];
  for (const raw of readLines(file)) {
    const line = raw.replace(/^[ \t\f]+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    const m = /^((?:[^=: \t\f\\]|\\.)*)/.exec(line);
    keys.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return keys;
}

// ZoneOffset.of accepts the string
function isZoneOffset(f) {
  if (f === 'Z') return true;
  const m = /^[+-](?:(\d)|(\d\d)|(\d\d):(\d\d)|(\d\d)(\d\d)|(\d\d):(\d\d):(\d\d)|(\d\d)(\d\d)(\d\d))$/.exec(f);
  if (!m) return false;
  const h = +(m[1] || m[2] || m[3] || m[5] || m[7] || m[10]);
  const mi = +(m[4] || m[6] || m[8] || m[11] || 0);
  const s = +(m[9] || m[12] || 0);
  if (h > 18 || mi > 59 || s > 59) return false;
  if (h === 18 && (mi || s)) return false;
  return true;
}

// ---- the converter --------------------------------------------------------

class Converter {
  constructor() {
    Object.assign(this, C);
    this.escape = escape;
    this.draftDefault = 2; // contributed
    this.isBaseModule = false;
    this.BASE_LOCALES = new Set();
    this.parentLocalesMap = new JHashMap();
    this.nonlikelyScript = false;
    this.likelyScriptMap = new JHashMap();
    this.AVAILABLE_TZIDS = null;
    this.copyrightYear = 0;
    this.jdkHeaderTemplate = null;
    this.canonicalTZMap = new JHashMap();
    this.tzdbShortNamesMap = JHashMap.newHashMap(512);
    this.tzdbSubstLetters = JHashMap.newHashMap(512);
    this.tzdbLinks = JHashMap.newHashMap(512);
    this.explicitDstOffsets = JHashMap.newHashMap(32);
    this.cldrBundles = new JHashMap();
    this.metaInfo = new JHashMap();
    this.metaInfo.put('AvailableLocales', new JTreeSet());
    this.aliases = new JHashMap();
    this.availableSkeletons = new JHashSet();
    this.childToParentLocaleMap = null;
    this.DESTINATION_DIR = 'build/gensrc';
    this.verbose = false;
    // LocalDateTime.now(), as a value comparable with the metazone times
    const d = process.env.BOOTJDK_CLDR_NOW ? new Date(process.env.BOOTJDK_CLDR_NOW) : new Date();
    this.now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(),
      d.getSeconds(), d.getMilliseconds());
    this.baseModuleLocales = new Map();
  }

  toLanguageTag(locName) {
    if (locName.indexOf('_') === -1) return locName;
    return L.toLanguageTag(L.forLanguageTag(locName.replace(/_/g, '-')));
  }

  info(msg) { if (this.verbose) process.stdout.write(msg + LNSEP); }

  run(args) {
    let base = null, zoneNameTempFile = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      switch (a) {
      case '-draft': {
        const d = ['unconfirmed', 'provisional', 'contributed', 'approved'].indexOf(args[++i]);
        if (d < 0) { process.stderr.write(`Error: Error: incorrect draft value: ${args[i]}${LNSEP}`); return 1; }
        this.draftDefault = d;
        break;
      }
      case '-base': base = args[++i]; if (!base.endsWith('/')) base += '/'; break;
      case '-baselocales': this.setupBaseLocales(args[++i]); break;
      case '-basemodule': this.isBaseModule = true; break;
      case '-o': this.DESTINATION_DIR = args[++i]; break;
      case '-verbose': this.verbose = true; break;
      case '-year': this.copyrightYear = parseInt(args[++i], 10); break;
      case '-zntempfile': zoneNameTempFile = args[++i]; break;
      case '-tzdatadir': this.tzDataDir = args[++i]; break;
      case '-jdk-header-template': this.jdkHeaderTemplate = fs.readFileSync(args[++i], 'utf8'); break;
      default:
        process.stderr.write(`Error: unknown or incomplete arg(s): ${a}${LNSEP}`);
        return 1;
      }
    }
    this.CLDR_BASE = base;
    this.SOURCE_FILE_DIR = base + '/main';
    if (this.BASE_LOCALES.size === 0) this.setupBaseLocales('en-US');
    if (this.copyrightYear === 0) this.copyrightYear = new Date().getFullYear();

    this.parseBCP47();
    this.parseSupplemental();
    this.pluralRules = this.generateRules(this.handlerPlurals);
    this.dayPeriodRules = this.generateRules(this.handlerDayPeriodRule);
    this.generateTZDBShortNamesMap();

    const bundles = this.readBundleList();
    this.convertBundles(bundles);

    if (this.isBaseModule) {
      this.generateZoneName(zoneNameTempFile);
      this.generateWindowsTZMappings();
    }
    return 0;
  }

  setupBaseLocales(list) {
    for (const tag of list.split(',')) {
      const l = L.forLanguageTag(tag);
      const withScript = L.getInstance(l.language, 'Latn', l.country, l.variant);
      for (const c of L.getCandidateLocales(withScript)) this.BASE_LOCALES.add(c.key);
    }
  }

  parse(file, handler) {
    this.info(`..... Parsing ${path.basename(file)} .....`);
    parseFile(file, handler);
  }

  // ---- data independent of locales ----

  parseBCP47() {
    this.handlerTimeZone = new H.TimeZoneParseHandler(this);
    this.parse(this.CLDR_BASE + '/bcp47/timezone.xml', this.handlerTimeZone);
    this.handlerTimeZone.getData().forEach((v, k) => {
      const ids = jsplitWs(v);
      for (let i = 1; i < ids.length; i++) this.canonicalTZMap.put(ids[i], ids[0]);
    });
  }

  parseSupplemental() {
    const B = this.CLDR_BASE;
    this.handlerSuppl = new H.SupplementalDataParseHandler(this);
    this.parse(B + '/supplemental/supplementalData.xml', this.handlerSuppl);
    const parentData = this.handlerSuppl.getDataFor('root');
    for (const key of parentData.keys()) {
      if (key.startsWith(C.PARENT_LOCALE_PREFIX)) {
        this.parentLocalesMap.put(key, new JTreeSet(parentData.get(key).split(' ')));
      }
    }
    this.handlerNumbering = new H.NumberingSystemsParseHandler(this);
    this.parse(B + '/supplemental/numberingSystems.xml', this.handlerNumbering);
    this.handlerMetaZones = new H.MetaZonesParseHandler(this);
    this.parse(B + '/supplemental/metaZones.xml', this.handlerMetaZones);
    this.handlerLikelySubtags = new H.LikelySubtagsParseHandler(this);
    this.parse(B + '/supplemental/likelySubtags.xml', this.handlerLikelySubtags);
    this.handlerLikelySubtags.getData().forEach((to, from) => {
      if (!from.includes('-')) {
        const script = to.split('-')[1];
        const key = C.LIKELY_SCRIPT_PREFIX + script;
        const prev = this.likelyScriptMap.putIfAbsent(key, new JTreeSet([from]));
        if (!isNull(prev)) prev.add(from);
      }
    });
    this.handlerSupplMeta = new H.SupplementalMetadataParseHandler(this);
    this.parse(B + '/supplemental/supplementalMetadata.xml', this.handlerSupplMeta);
    this.handlerWinZones = new H.WinZonesParseHandler(this);
    this.parse(B + '/supplemental/windowsZones.xml', this.handlerWinZones);
    this.handlerPlurals = new H.PluralsParseHandler(this);
    this.parse(B + '/supplemental/plurals.xml', this.handlerPlurals);
    this.handlerDayPeriodRule = new H.DayPeriodRuleParseHandler(this);
    this.parse(B + '/supplemental/dayPeriods.xml', this.handlerDayPeriodRule);
  }

  generateRules(handler) {
    const out = new Map();
    handler.getData().forEach((rules, k) => {
      const parts = [];
      rules.forEach((v, rk) => parts.push((rk + ':' + v.replace(/@.*/, '')).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')));
      out.set(k, parts.join(';'));
    });
    return out;
  }

  tzFiles() {
    // Files.walk order: the Windows directory listing (case-insensitive name order)
    return fs.readdirSync(this.tzDataDir)
      .filter((n) => TZ_FILES.test(n) && fs.statSync(path.join(this.tzDataDir, n)).isFile())
      .sort((a, b) => cmpStr(a.toLowerCase(), b.toLowerCase()))
      .map((n) => path.join(this.tzDataDir, n));
  }

  generateTZDBShortNamesMap() {
    const regionMatches = (tok, s) => tok.length > 0 && tok.length <= s.length
      && tok.toLowerCase() === s.substring(0, tok.length).toLowerCase();
    for (const p of this.tzFiles()) {
      let zone = null, rule = null, format = null, inVanguard = false;
      for (let line of readLines(p)) {
        if (line.startsWith('# Vanguard section')) { inVanguard = true; continue; }
        if (inVanguard && line.startsWith('# Rearguard section')) { inVanguard = false; continue; }
        if (isBlank(line) || /^[ \t]*#.*$/.test(line)) continue;
        line = line.replace(/[ \t]*#.*/g, '');
        const tokens = line.split(/[ \t]+/);
        const t0 = tokens[0];
        if (regionMatches(t0, 'Zone')) {
          if (zone !== null) this.tzdbShortNamesMap.put(zone, format + NBSP + rule);
          zone = tokens[1];
          rule = tokens[3];
          format = flipIfNeeded(inVanguard, tokens[4]);
        } else if (zone !== null) {
          if (regionMatches(t0, 'Rule') || regionMatches(t0, 'Link')) {
            this.tzdbShortNamesMap.put(zone, format + NBSP + rule);
            zone = rule = format = null;
          } else {
            rule = tokens[2];
            format = flipIfNeeded(inVanguard, tokens[3]);
          }
        }
        if (regionMatches(t0, 'Rule')) {
          this.tzdbSubstLetters.put(tokens[1] + NBSP + (tokens[8] === '0' ? 'std' : 'dst'),
            tokens[9].split('-').join(''));
        }
        if (regionMatches(t0, 'Link')) this.tzdbLinks.put(tokens[2], tokens[1]);
      }
      if (zone !== null) this.tzdbShortNamesMap.put(zone, format + NBSP + rule);
    }
  }

  // ---- bundles ----

  coverageLevelsMap() {
    const cov = new Set();
    for (const line of readLines(this.CLDR_BASE + '/properties/coverageLevels.txt')) {
      if (isBlank(line) || line.startsWith('#')) continue;
      const a = jsplitLimitRe(line, /[ \t]*;[ \t]*/, 3);
      if (/^(basic|moderate|modern|comprehensive)$/.test(a[1])) {
        cov.add(L.forLanguageTag(a[0].replace(/_/g, '-')).key);
      }
    }
    const props = path.resolve(this.CLDR_BASE, '../../../jdk/src/classes/build/tools/cldrconverter/OtherCommonLocales.properties');
    for (const k of propertyKeys(props)) cov.add(L.forLanguageTag(k).key);
    return cov;
  }

  readBundleList() {
    const ret = [];
    const coverage = this.coverageLevelsMap();
    for (const fileName of fs.readdirSync(this.SOURCE_FILE_DIR)) {
      if (!fileName.endsWith('.xml')) continue;
      const id = fileName.substring(0, fileName.indexOf('.'));
      const cldrLoc = L.forLanguageTag(this.toLanguageTag(id));
      const candList = this.getCandidateLocales(cldrLoc);
      if (id !== 'root' && !candList.some((l) => coverage.has(l.key))) continue;
      let sb = '';
      for (const loc of candList) {
        if (loc !== L.ROOT) sb += toLocaleName(L.toLanguageTag(loc)) + ',';
      }
      if (sb.indexOf('root') === -1) sb += 'root';
      ret.push(new Bundle(this, id, sb));
    }
    const k = (b) => (b.id === 'root' ? '' : b.id);
    ret.sort((a, b) => cmpStr(k(a), k(b)));
    return ret;
  }

  getCandidateLocales(loc) {
    return this.applyParentLocales(L.getCandidateLocales(loc));
  }

  applyParentLocales(candidates) {
    if (this.childToParentLocaleMap === null) {
      this.childToParentLocaleMap = new Map();
      this.parentLocalesMap.forEach((children, key) => {
        const parent = key.substring(C.PARENT_LOCALE_PREFIX.length).replace(/_/g, '-');
        for (const child of children) {
          this.childToParentLocaleMap.set(L.forLanguageTag(child).key,
            parent === 'root' ? L.ROOT : L.forLanguageTag(parent));
        }
      });
    }
    for (let i = 0; i < candidates.length; i++) {
      const l = candidates[i];
      const p = this.getParentLocale(l);
      if (l !== L.ROOT && p !== null && candidates[i + 1] !== p) {
        const applied = candidates.slice(0, i + 1);
        if (applied.includes(p)) continue;
        return applied.concat(this.applyParentLocales(L.getCandidateLocales(p)));
      }
    }
    return candidates;
  }

  getParentLocale(child) {
    let parent = this.childToParentLocaleMap.get(child.key) || null;
    if (this.nonlikelyScript && parent === null && child.country === '') {
      const lang = ' ' + child.language + ' ';
      const script = child.script;
      if (script !== '') {
        for (const [k, v] of this.likelyScriptMap.entries()) {
          if (v.has(lang)) { parent = k === script ? null : L.ROOT; break; }
        }
      }
    }
    return parent;
  }

  getCLDRBundle(id) {
    let bundle = this.cldrBundles.get(id);
    if (!isNull(bundle)) return bundle;
    const file = this.SOURCE_FILE_DIR + '/' + id + '.xml';
    if (!fs.existsSync(file)) return new JHashMap();
    this.info('..... main directory .....');
    const handler = new H.LDMLParseHandler(this, id);
    this.parse(file, handler);
    bundle = handler.getData();
    this.cldrBundles.put(id, bundle);
    if (id === 'root') {
      bundle = this.handlerSuppl.getDataFor('root');
      if (bundle !== null) {
        const temp = this.cldrBundles.remove(id);
        bundle.putAll(temp);
        this.cldrBundles.put(id, bundle);
      }
    }
    return bundle;
  }

  handleAliases(bundleMap) {
    for (const key of this.aliases.keys()) {
      let sourceKey = this.aliases.get(key);
      if (key.startsWith('ListPatterns_')) {
        let k;
        while (!isNull(k = this.aliases.get(sourceKey))) sourceKey = k;
      }
      const source = isNull(sourceKey) ? undefined : bundleMap.get(sourceKey);
      if (!isNull(source)) {
        const sa = bundleMap.get(key);
        if (Array.isArray(sa) && !(sa instanceof JList)) {
          for (let i = 0; i < sa.length; i++) {
            if (sa[i] === null && !isNull(source[i])) sa[i] = source[i];
          }
        }
        bundleMap.putIfAbsent(key, source);
      }
    }
  }

  convertBundles(bundles) {
    const available = this.metaInfo.get('AvailableLocales');
    if (this.isBaseModule) {
      this.metaInfo.putAll(this.parentLocalesMap);
      this.metaInfo.putAll(this.likelyScriptMap);
    }
    for (const bundle of bundles) {
      const targetMap = bundle.getTargetMap();
      const id = bundle.id;
      if (bundle.isRoot()) targetMap.put('DateTimePatternChars', 'GyMdkHmsSEDFwWahKzZ');

      const ln = this.extractLocaleNames(targetMap, id);
      if (ln.size || bundle.isRoot()) this.generateBundle('util', 'LocaleNames', id, ln, 'OPEN');
      const cn = this.extractCurrencyNames(targetMap);
      if (cn.size || bundle.isRoot()) this.generateBundle('util', 'CurrencyNames', id, cn, 'OPEN');
      const zn = this.extractZoneNames(targetMap, id);
      if (zn.size || bundle.isRoot()) this.generateBundle('util', 'TimeZoneNames', id, zn, 'TIMEZONE');
      const cd = this.extractCalendarData(targetMap, id);
      if (cd.size || bundle.isRoot()) this.generateBundle('util', 'CalendarData', id, cd, 'PLAIN');
      const fd = this.extractFormatData(targetMap, id);
      if (fd.size || bundle.isRoot()) this.generateBundle('text', 'FormatData', id, fd, 'PLAIN');

      const langTag = this.toLanguageTag(id);
      available.add(langTag);
      const likely = this.handlerLikelySubtags.get(langTag);
      if (!isNull(likely)) {
        available.add(likely.replace(/-[A-Z][a-z]{3}/, ''));
        available.add(likely);
      }
    }
    for (const [k, v] of this.handlerLikelySubtags.getData().entries()) {
      if (available.has(v) && k !== 'in' && k !== 'iw' && k !== 'ji') available.add(k);
    }
    this.generateMetaInfo();
  }

  extractLocaleNames(map, id) {
    const names = new JTreeMap(keyComparator);
    for (const key of map.keys()) {
      if (key.startsWith(C.LOCALE_NAME_PREFIX)) {
        if (key === C.LOCALE_SEPARATOR) names.put('ListCompositionPattern', map.get(key));
        else if (key === C.LOCALE_KEYTYPE) names.put('ListKeyTypePattern', map.get(key));
        else names.put(key.substring(C.LOCALE_NAME_PREFIX.length), map.get(key));
      }
    }
    if (id === 'root') names.put('DisplayNamePattern', '{0,choice,0#|1#{1}|2#{1} ({2})}');
    return names;
  }

  extractCurrencyNames(map) {
    const names = new JTreeMap(keyComparator);
    for (const key of map.keys()) {
      if (key.startsWith(C.CURRENCY_NAME_PREFIX)) names.put(key.substring(C.CURRENCY_NAME_PREFIX.length), map.get(key));
      else if (key.startsWith(C.CURRENCY_SYMBOL_PREFIX)) names.put(key.substring(C.CURRENCY_SYMBOL_PREFIX.length), map.get(key));
    }
    return names;
  }

  getAvailableZoneIds() {
    if (this.AVAILABLE_TZIDS === null) {
      this.AVAILABLE_TZIDS = JHashSet.of(this.timeZoneAvailableIDs());
      for (const k of this.handlerMetaZones.keySet()) this.AVAILABLE_TZIDS.add(k);
      this.AVAILABLE_TZIDS.delete(H.MetaZonesParseHandler.NO_METAZONE_KEY);
    }
    return this.AVAILABLE_TZIDS;
  }

  // TimeZone.getAvailableIDs(): the region ids of tzdb.dat (zones and links of
  // the files GendataTZDB.gmk compiles, sorted, minus the excluded ones)
  // followed by the short ids
  timeZoneAvailableIDs() {
    const excluded = new Set(['EST', 'HST', 'MST', 'GMT+0', 'GMT-0', 'ROC']);
    const ids = new Set();
    const rm = (line, tok, s) => line.length > 0 && tok.length <= s.length
      && line.substring(0, tok.length).toLowerCase() === s.substring(0, tok.length).toLowerCase();
    for (const n of TZDB_FILES) {
      const p = path.join(this.tzDataDir, n);
      for (const line of fs.readFileSync(p, 'latin1').split('\n')) {
        if (line.length === 0 || line[0] === '#') continue;
        const tokens = line.replace(/#.*/, '').split(/[ \t]+/).filter((t) => t.length);
        if (/^[ \t]/.test(line)) continue;
        const t0 = tokens.length ? tokens[0] : line;
        if (rm(line, t0, 'Zone')) { if (!excluded.has(tokens[1])) ids.add(tokens[1]); }
        else if (rm(line, t0, 'Link')) { if (!excluded.has(tokens[2])) ids.add(tokens[2]); }
      }
    }
    return [...[...ids].sort(cmpStr), ...SHORT_IDS.map((e) => e[0])];
  }

  getTZDBLink(tzid) {
    let link = null;
    for (let k = tzid; this.tzdbLinks.has(k);) k = link = this.tzdbLinks.get(k);
    return link;
  }

  extractZoneNames(map, id) {
    const names = new JTreeMap(keyComparator);
    const availableIds = this.getAvailableZoneIds();
    const MZ = this.handlerMetaZones;
    for (const tzid of availableIds) {
      const dep = this.handlerSupplMeta.get(tzid);
      const tzKey = isNull(dep) ? tzid : dep;
      let tzLink = this.getTZDBLink(tzKey);
      if (tzLink === null && this.tzdbLinks.containsValue(tzKey)) {
        tzLink = null;
        for (const [k, v] of this.tzdbLinks.entries()) if (v === tzKey) { tzLink = k; break; }
      }
      let data = map.get(C.TIMEZONE_ID_PREFIX + tzKey);
      if (isNull(data) && tzLink !== null) data = map.get(C.TIMEZONE_ID_PREFIX + tzLink);
      let meta = MZ.get(tzKey);
      if (isNull(meta) && tzLink !== null) meta = MZ.get(tzLink);
      meta = nn(meta);
      const metaKey = meta !== null ? C.METAZONE_ID_PREFIX + meta : null;
      const isArr = (x) => Array.isArray(x) && !(x instanceof JList);
      if (isArr(data)) {
        if (tzid === 'Etc/UTC' && !map.has(C.TIMEZONE_ID_PREFIX + 'UTC')) {
          names.put(C.METAZONE_ID_PREFIX + C.META_ETCUTC_ZONE_NAME, data);
          names.put(tzid, C.META_ETCUTC_ZONE_NAME);
          names.put('UTC', C.META_ETCUTC_ZONE_NAME);
        } else {
          const tznames = data.slice();
          this.fillTZDBShortNames(tzKey, tznames);
          names.put(tzid, tznames);
          if (meta !== null && isArr(map.get(metaKey))) this.recordMetazone(names, meta, tzKey, map.get(metaKey));
        }
      } else if (meta !== null) {
        if (isArr(map.get(metaKey))) {
          this.recordMetazone(names, meta, tzKey, map.get(metaKey));
          names.put(tzid, meta);
          if (tzLink !== null && availableIds.has(tzLink)) names.put(tzLink, meta);
        }
      } else if (id === 'root') {
        if (this.tzdbShortNamesMap.has(tzid)) {
          const tznames = new Array(6).fill(null);
          this.fillTZDBShortNames(tzid, tznames);
          names.put(tzid, tznames);
        }
      }
    }
    for (const [k, v] of map.entries()) if (k.startsWith(C.EXEMPLAR_CITY_PREFIX)) names.put(k, v);
    if (id === 'root') this.explicitDstOffsets.forEach((v, k) => names.put(C.METAZONE_DSTOFFSET_PREFIX + k, v));
    if (names.size !== 0 && !names.has('UTC')) {
      names.putIfAbsent(C.METAZONE_ID_PREFIX + C.META_EMPTY_ZONE_NAME, EMPTY_ZONE);
      names.put('UTC', C.META_EMPTY_ZONE_NAME);
    }
    for (const [k, v] of SHORT_IDS) {
      if (!names.has(k) && names.has(v)) names.put(k, names.get(v));
    }
    return names;
  }

  fillTZDBShortNames(tzid, names) {
    const link = this.getTZDBLink(tzid);
    const val = this.tzdbShortNamesMap.getOrDefault(tzid, link === null ? undefined : this.tzdbShortNamesMap.get(link));
    if (isNull(val)) return;
    const format = val.split(NBSP)[0];
    const rule = val.split(NBSP)[1];
    const formatted = (arg) => format.replace('%s', String(nn(arg)));
    for (const i of [1, 3, 5]) {
      if (isNull(names[i]) || names[i] === '') {
        if (format.includes('%s')) {
          names[i] = i === 1 ? formatted(this.tzdbSubstLetters.get(rule + NBSP + 'std'))
            : i === 3 ? formatted(this.tzdbSubstLetters.get(rule + NBSP + 'dst')) : formatted('');
        } else if (format.includes('/')) {
          names[i] = i === 3 ? convertGMTName(format.substring(format.indexOf('/') + 1))
            : convertGMTName(format.substring(0, format.indexOf('/')));
        } else {
          names[i] = convertGMTName(format);
        }
      }
    }
  }

  recordMetazone(names, meta, tzid, tznames) {
    const zone001 = nn(this.handlerMetaZones.zidMap().get(meta));
    const tzLink = this.getTZDBLink(tzid);
    const canon = (z) => { const c = this.canonicalTZMap.get(z); return isNull(c) ? z : c; };
    if (canon(tzid) === zone001 || (tzLink !== null && canon(tzLink) === zone001)) {
      const copy = tznames.slice();
      this.fillTZDBShortNames(tzid, copy);
      names.put(C.METAZONE_ID_PREFIX + meta, copy);
    }
  }

  extractCalendarData(map, id) {
    const out = new Map();
    if (id === 'root') {
      const join = (from, to, prefix) => {
        const parts = [];
        for (let d = from; d < to; d++) {
          if (map.has(prefix + d)) parts.push(d + ': ' + map.get(prefix + d));
        }
        return parts.join(';');
      };
      out.set('firstDayOfWeek', join(1, 8, C.CALENDAR_FIRSTDAY_PREFIX));
      out.set('minimalDaysInFirstWeek', join(0, 7, C.CALENDAR_MINDAYS_PREFIX));
    }
    return out;
  }

  extractFormatData(map, id) {
    const fd = new Map();
    const copyIfPresent = (key) => {
      const v = map.get(key);
      if (!isNull(v)) fd.set(key, v);
    };
    for (const ct of CalendarType) {
      const prefix = ct.keyElementName();
      for (const elem of FORMAT_DATA_ELEMENTS) {
        copyIfPresent('java.time.' + prefix + elem);
        copyIfPresent(prefix + elem);
      }
      for (const s of this.availableSkeletons) copyIfPresent(prefix + 'DateFormatItem.' + s);
    }
    for (const key of map.keys()) {
      if (key.startsWith(C.LOCALE_TYPE_PREFIX_CA)) {
        const type = key.substring(C.LOCALE_TYPE_PREFIX_CA.length);
        for (const ct of CalendarType) {
          if (type === ct.lname) {
            const value = map.get(key);
            const dataKey = key.split(C.LOCALE_TYPE_PREFIX_CA).join(C.CALENDAR_NAME_PREFIX);
            fd.set(dataKey, value);
            const ukey = C.CALENDAR_NAME_PREFIX + ct.uname;
            if (dataKey !== ukey) fd.set(ukey, value);
          }
        }
      }
    }
    copyIfPresent('DefaultNumberingSystem');
    const numberingScripts = nn(map.remove('numberingScripts'));
    if (numberingScripts !== null) {
      for (const script of numberingScripts) {
        copyIfPresent(script + '.NumberElements');
        copyIfPresent(script + '.NumberPatterns');
      }
    } else {
      copyIfPresent('NumberElements');
      copyIfPresent('NumberPatterns');
    }
    copyIfPresent('short.CompactNumberPatterns');
    copyIfPresent('long.CompactNumberPatterns');
    if (id === 'root') {
      for (const k of this.handlerNumbering.keySet()) {
        if (numberingScripts.includes(k)) continue;
        const ne = map.get('latn.NumberElements');
        const neNew = ne.slice();
        neNew[4] = this.handlerNumbering.get(k).substring(0, 1);
        fd.set(k + '.NumberElements', neNew);
      }
    }
    for (const lpKey of LIST_PATTERN_KEYS) {
      copyIfPresent(lpKey);
      copyIfPresent(lpKey + '-short');
      copyIfPresent(lpKey + '-narrow');
    }
    return fd;
  }

  // ---- ResourceBundleGenerator ----

  isBaseLocale(localeID) {
    localeID = localeID.replace(/-/g, '_');
    const lang = localeID === 'root' ? '' : L.forLanguageTag(localeID.replace(/_/g, '-')).language;
    const tag = L.forLanguageTag(localeID.replace(/_/g, '-'));
    return this.BASE_LOCALES.has(L.build(lang, tag.script, tag.country).key);
  }

  copyright() {
    if (this.jdkHeaderTemplate !== null) return this.jdkHeaderTemplate.replace('%d', String(this.copyrightYear));
    return (this.copyrightYear > 2012 ? OPENJDK_AFTER2012 : OPENJDK2012).replace('%d', String(this.copyrightYear));
  }

  generateBundle(packageName, baseName, localeID, map, type) {
    let dirName = path.join(this.DESTINATION_DIR, 'sun', packageName, 'resources', 'cldr');
    packageName = packageName + '.resources.cldr';
    if (this.isBaseModule !== this.isBaseLocale(localeID)) return;
    if (this.isBaseModule) {
      if (localeID !== 'root') {
        for (const l of L.getCandidateLocales(L.forLanguageTag(this.toLanguageTag(localeID)))) {
          this.baseModuleLocales.set(l.key, l);
        }
      }
    } else {
      dirName = path.join(dirName, 'ext');
      packageName += '.ext';
    }
    fs.mkdirSync(dirName, { recursive: true });
    const cls = baseName + (localeID === 'root' ? '' : '_' + localeID);
    const file = path.join(dirName, cls + '.java');
    this.info('\tWriting file ' + file);

    let fmt = null;
    let ordered;
    if (type === 'TIMEZONE') {
      fmt = '';
      const metaKeys = new Set();
      for (const [key, value] of map.entries()) {
        if (key.startsWith(C.METAZONE_ID_PREFIX)) {
          const meta = key.substring(C.METAZONE_ID_PREFIX.length);
          if (Array.isArray(value)) {
            fmt += `        final String[] ${escape(meta)} = new String[] {\n`;
            for (const s of value) fmt += `               "${escape(s)}",\n`;
            fmt += '            };\n';
            metaKeys.add(key);
          }
        }
      }
      for (const key of metaKeys) map.remove(key);
      ordered = new Map();
      for (const preferred of PREFERRED_TZIDS) {
        if (map.has(preferred)) {
          ordered.set(preferred, nn(map.remove(preferred)));
        } else if ((preferred === 'GMT' || preferred === 'UTC') && metaKeys.has(C.METAZONE_ID_PREFIX + preferred)) {
          ordered.set(preferred, preferred);
        }
      }
      for (const [k, v] of map.entries()) ordered.set(k, v);
    } else {
      ordered = new Map(map.entries());
      const dedup = new Map();
      for (const [key, val] of map.entries()) {
        const id = typeof val === 'string' ? 'S' + val : 'A' + JSON.stringify(val);
        const old = dedup.get(id);
        if (old === undefined) {
          dedup.set(id, { key, metaKey: null });
          continue;
        }
        if (old.metaKey === null) {
          old.metaKey = 'metaValue_' + old.key.replace(/[.-]/g, '_');
          if (fmt === null) fmt = '';
          const metaVal = escape(old.metaKey);
          if (Array.isArray(val)) {
            fmt += `        final String[] ${metaVal} = new String[] {\n`;
            for (const s of val) fmt += `            "${escape(s)}",\n`;
            fmt += '        };\n';
          } else {
            fmt += `        final String ${metaVal} = "${escape(val)}";\n`;
          }
          ordered.set(old.key, old.metaKey);
        }
        ordered.set(key, old.metaKey);
      }
    }

    const T = BUNDLE_TYPES[type];
    let out = '';
    const println = (s) => { out += s + LNSEP; };
    println(this.copyright());
    println(UNICODE);
    println('package sun.' + packageName + ';\n');
    out += `import ${T.path};\n\n`;
    out += `public class ${cls} extends ${T.cls} {\n`;
    println('    @Override\n    protected final Object[][] getContents() {');
    if (fmt !== null) out += fmt;
    println('        final Object[][] data = new Object[][] {');
    for (const [key, value] of ordered) {
      const keyStr = escape(key);
      if (isNull(value)) {
        process.stderr.write('Warning: ');
        process.stderr.write('null value for ' + key + LNSEP);
      } else if (typeof value === 'string') {
        const ev = escape(value);
        if ((type === 'TIMEZONE' && !(key.startsWith(C.EXEMPLAR_CITY_PREFIX) || key.startsWith(C.METAZONE_DSTOFFSET_PREFIX)))
            || value.startsWith('metaValue_')) {
          out += `            { "${keyStr}", ${ev} },\n`;
        } else {
          out += `            { "${keyStr}", "${ev}" },\n`;
        }
      } else if (Array.isArray(value)) {
        println('            { "' + keyStr + '",\n                new String[] {');
        for (const s of value) println('                    "' + escape(s) + '",');
        println('                }\n            },');
      } else {
        throw new Error('unknown value type for ' + key);
      }
    }
    println('        };\n        return data;\n    }\n}');
    fs.writeFileSync(file, out);
  }

  generateMetaInfo() {
    const base = this.isBaseModule;
    const dirName = base ? path.join(this.DESTINATION_DIR, 'sun', 'util', 'cldr')
      : path.join(this.DESTINATION_DIR, 'sun', 'util', 'resources', 'cldr', 'provider');
    fs.mkdirSync(dirName, { recursive: true });
    const className = base ? 'CLDRBaseLocaleDataMetaInfo' : 'CLDRLocaleDataMetaInfo';
    const file = path.join(dirName, className + '.java');
    this.info('Generating file ' + file);
    let out = this.copyright();
    out += `package sun.util.${base ? 'cldr' : 'resources.cldr.provider'};

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import sun.util.locale.provider.LocaleDataMetaInfo;
import sun.util.locale.provider.LocaleProviderAdapter;

public class ${className} implements LocaleDataMetaInfo {
`;
    const metaKeys = [...this.metaInfo.keys()];
    const aliasData = this.handlerSupplMeta.getLanguageAliasData();
    if (base) {
      out += `    private static final Map<Locale, String[]> parentLocalesMap = HashMap.newHashMap(${metaKeys.filter((k) => k.startsWith(C.PARENT_LOCALE_PREFIX)).length});
    private static final Map<String, String> languageAliasMap = HashMap.newHashMap(${aliasData.size});
    private static final Set<Locale> baseModuleLocales;
    static final boolean nonlikelyScript = ${this.nonlikelyScript}; // package access from CLDRLocaleProviderAdapter

    static {
`;
      for (const key of metaKeys) {
        if (!key.startsWith(C.PARENT_LOCALE_PREFIX)) continue;
        const parentTag = key.substring(C.PARENT_LOCALE_PREFIX.length);
        if (parentTag === 'root') out += '        parentLocalesMap.put(Locale.ROOT,\n';
        else out += `        parentLocalesMap.put(Locale.forLanguageTag("${escape(parentTag)}"),\n`;
        out += this.generateStringArray(this.metaInfo.get(key));
      }
      out += LNSEP;
      aliasData.forEach((v, k) => { out += `        languageAliasMap.put("${escape(k)}", "${escape(v)}");\n`; });
      out += LNSEP;
      out += '        baseModuleLocales = Set.of(\n';
      const tags = [...this.baseModuleLocales.values()].map((l) => L.toLanguageTag(l));
      const sk = (t) => (t === 'und' ? '' : t);
      tags.sort((a, b) => cmpStr(sk(a), sk(b)));
      out += '            ' + tags.map((t) => ({ und: 'Locale.ROOT', en: 'Locale.ENGLISH', 'en-US': 'Locale.US' }[t]
        || `Locale.forLanguageTag("${t}")`)).join(',\n            ');
      out += '\n        );';
      out += '\n    }\n' + LNSEP;
      const tzData = this.handlerTimeZone.getData();
      out += `    private static class CLDRMapHolder {
        private static final Map<String, String> tzCanonicalIDMap = HashMap.newHashMap(${tzData.size});
        private static final Map<String, String> likelyScriptMap = HashMap.newHashMap(${metaKeys.filter((k) => k.startsWith(C.LIKELY_SCRIPT_PREFIX)).length});

        static {
`;
      for (const [k, v] of tzData.entries()) {
        const ids = jsplitWs(v);
        out += `            tzCanonicalIDMap.put("${escape(k)}", "${escape(ids[0])}");\n`;
        for (let i = 1; i < ids.length; i++) out += `            tzCanonicalIDMap.put("${escape(ids[i])}", "${escape(ids[0])}");\n`;
      }
      out += LNSEP;
      for (const key of metaKeys) {
        if (!key.startsWith(C.LIKELY_SCRIPT_PREFIX)) continue;
        out += `            likelyScriptMap.put("${escape(key.substring(C.LIKELY_SCRIPT_PREFIX.length))}", "${' ' + [...this.metaInfo.get(key)].map(escape).join(' ') + ' '}");\n`;
      }
      out += '        }\n    }\n';
    }
    out += LNSEP;
    const avail = this.applyLanguageAliases(this.metaInfo.get('AvailableLocales'));
    out += `    @Override
    public LocaleProviderAdapter.Type getType() {
        return LocaleProviderAdapter.Type.CLDR;
    }

    @Override
    public String availableLanguageTags(String category) {
        return " ${escape(this.toLocaleList(avail, false))}";
    }
`;
    if (base) {
      out += `
    @Override
    public Map<String, String> getLanguageAliasMap() {
        return languageAliasMap;
    }

    @Override
    public Map<String, String> tzCanonicalIDs() {
        return CLDRMapHolder.tzCanonicalIDMap;
    }

    public Map<Locale, String[]> parentLocales() {
        return parentLocalesMap;
    }

    public Set<Locale> baseModuleLocales() {
        return baseModuleLocales;
    }

    // package access from CLDRLocaleProviderAdapter
    Map<String, String> likelyScriptMap() {
        return CLDRMapHolder.likelyScriptMap;
    }
`;
    }
    out += '}\n';
    fs.writeFileSync(file, out);
  }

  generateStringArray(set) {
    const children = this.toLocaleList(set, true).split(' ').sort(cmpStr);
    let out = '            new String[] {\n                ';
    let count = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      out += `"${escape(child)}", `;
      count += child.length + 4;
      if (i !== children.length - 1 && count > 64) {
        out += '\n                ';
        count = 0;
      }
    }
    return out + '\n            });\n';
  }

  toLocaleList(set, all) {
    const parts = [];
    for (const id of set) {
      if (id === 'root') continue;
      if (!all && this.isBaseModule !== this.isBaseLocale(id)) continue;
      parts.push(id);
    }
    return parts.join(' ');
  }

  applyLanguageAliases(tags) {
    this.handlerSupplMeta.getLanguageAliasData().forEach((v, k) => {
      if (tags.delete(k)) tags.add(v);
    });
    return tags;
  }

  // ---- ZoneName.java and tzmappings ----

  generateZoneName(template) {
    const dir = path.join(this.DESTINATION_DIR, 'java', 'time', 'format');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    for (const l of readLines(template)) {
      if (l === '%%%%ZIDMAP%%%%') lines.push(...this.zidMapEntry());
      else if (l === '%%%%MZONEMAP%%%%') lines.push(...this.handlerMetaZones.mzoneMapEntryList);
      else if (l === '%%%%DEPRECATED%%%%') lines.push(...this.handlerSupplMeta.deprecatedMap());
      else if (l === '%%%%TZDATALINK%%%%') lines.push(...this.tzDataLinkEntry());
      else lines.push(l);
    }
    writeLines(path.join(dir, 'ZoneName.java'), lines);
  }

  zidMapEntry() {
    const out = [];
    for (const id of this.getAvailableZoneIds()) {
      const c = this.canonicalTZMap.get(id);
      const canonId = isNull(c) ? id : c;
      const meta = nn(this.handlerMetaZones.get(canonId));
      const zone001 = meta === null ? null : nn(this.handlerMetaZones.zidMap().get(meta));
      if (zone001 !== null) out.push(`        "${escape(id)}", "${escape(meta)}", "${escape(zone001)}",`);
    }
    return out.sort(cmpStr);
  }

  tzDataLinkEntry() {
    const out = [];
    for (const p of this.tzFiles()) {
      for (const l of readLines(p)) {
        if (!l.startsWith('Link')) continue;
        out.push(l.replace(/^Link[ \t\n\x0B\f\r]+([^ \t\n\x0B\f\r]+)[ \t\n\x0B\f\r]+([^ \t\n\x0B\f\r]+).*/,
          '        "$2", "$1",'));
      }
    }
    return out.sort(cmpStr);
  }

  generateWindowsTZMappings() {
    const dir = path.join(this.DESTINATION_DIR, 'windows', 'conf');
    fs.mkdirSync(dir, { recursive: true });
    const W = this.handlerWinZones;
    const override = path.join(this.tzDataDir, 'tzmappings.override');
    if (fs.existsSync(override)) {
      for (let o of readLines(override)) {
        o = o.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
        if (isBlank(o) || o.startsWith('#')) continue;
        const m = /^(?<win>([^:]+:[^:]+)):(?<java>[^:]+):$/.exec(o);
        if (m) W.put(m.groups.win, m.groups.java);
        else process.stdout.write(`Unrecognized tzmappings override: ${o}. Ignored${LNSEP}`);
      }
    }
    const lines = [];
    for (const k of W.keySet()) {
      const other = W.get(k.replace(/:\w{2,3}$/, ':001'));
      if (k.endsWith(':001') || W.get(k) !== nn(other)) lines.push(k + ':' + W.get(k) + ':');
    }
    lines.sort((t1, t2) => {
      const s1 = jsplit(t1, ':'), s2 = jsplit(t2, ':');
      if (s1[0] === s2[0]) {
        if (s1[1] === '001') return 1;
        if (s2[1] === '001') return -1;
        return cmpStr(s1[1], s2[1]);
      }
      return cmpStr(s1[0], s2[0]);
    });
    writeLines(path.join(dir, 'tzmappings'), lines);
  }
}

function flipIfNeeded(inVanguard, format) {
  if (inVanguard) {
    const sd = jsplit(format, '/');
    if (sd.length === 2) return sd[1] + '/' + sd[0];
  }
  return format;
}

function convertGMTName(f) {
  if (f === '%z' || isZoneOffset(f)) return null;
  return f;
}

function toLocaleName(tag) {
  return tag.indexOf('-') === -1 ? tag : tag.replace(/-/g, '_');
}

function jsplitLimitRe(s, re, limit) {
  const out = [];
  let rest = s;
  while (out.length < limit - 1) {
    const m = re.exec(rest);
    if (!m) break;
    out.push(rest.substring(0, m.index));
    rest = rest.substring(m.index + m[0].length);
  }
  out.push(rest);
  return out;
}

function keyComparator(o1, o2) {
  const d1 = o1.charCodeAt(0) >= 48 && o1.charCodeAt(0) <= 57;
  const d2 = o2.charCodeAt(0) >= 48 && o2.charCodeAt(0) <= 57;
  if (!d1 && !d2) {
    if (o1.length < o2.length) return -1;
    if (o1.length > o2.length) return 1;
  }
  return cmpStr(o1, o2);
}

const FORMAT_DATA_ELEMENTS = [
  'MonthNames', 'standalone.MonthNames', 'MonthAbbreviations', 'standalone.MonthAbbreviations',
  'MonthNarrows', 'standalone.MonthNarrows', 'DayNames', 'standalone.DayNames', 'DayAbbreviations',
  'standalone.DayAbbreviations', 'DayNarrows', 'standalone.DayNarrows', 'QuarterNames',
  'standalone.QuarterNames', 'QuarterAbbreviations', 'standalone.QuarterAbbreviations', 'QuarterNarrows',
  'standalone.QuarterNarrows', 'AmPmMarkers', 'narrow.AmPmMarkers', 'abbreviated.AmPmMarkers', 'long.Eras',
  'Eras', 'narrow.Eras', 'field.era', 'field.year', 'field.month', 'field.week', 'field.weekday',
  'field.dayperiod', 'field.hour', 'timezone.hourFormat', 'timezone.gmtFormat', 'timezone.gmtZeroFormat',
  'timezone.regionFormat', 'timezone.regionFormat.daylight', 'timezone.regionFormat.standard',
  'field.minute', 'field.second', 'field.zone', 'TimePatterns', 'DatePatterns', 'DateTimePatterns',
  'DateTimePatternChars', 'PluralRules', 'DayPeriodRules', 'DateFormatItemInputRegions.allowed',
  'DateFormatItemInputRegions.preferred', 'ListPatterns',
];

const PREFERRED_TZIDS = [
  'America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York',
  'America/Indianapolis', 'Pacific/Honolulu', 'America/Anchorage', 'America/Halifax', 'America/Sitka',
  'America/St_Johns', 'Europe/Paris', 'GMT', 'Africa/Casablanca', 'Asia/Jerusalem', 'Asia/Tokyo',
  'Europe/Bucharest', 'Asia/Shanghai', 'UTC',
];

const BUNDLE_TYPES = {
  PLAIN: { path: 'java.util.ListResourceBundle', cls: 'ListResourceBundle' },
  OPEN: { path: 'sun.util.resources.OpenListResourceBundle', cls: 'OpenListResourceBundle' },
  TIMEZONE: { path: 'sun.util.resources.TimeZoneNamesBundle', cls: 'TimeZoneNamesBundle' },
};

// ---- Bundle ---------------------------------------------------------------

const NUMBER_PATTERN_KEYS = ['NumberPatterns/decimal', 'NumberPatterns/currency', 'NumberPatterns/percent',
  'NumberPatterns/accounting'];
const COMPACT_NUMBER_PATTERN_KEYS = ['short.CompactNumberPatterns', 'long.CompactNumberPatterns'];
const NUMBER_ELEMENT_KEYS = ['NumberElements/decimal', 'NumberElements/group', 'NumberElements/list',
  'NumberElements/percent', 'NumberElements/zero', 'NumberElements/pattern', 'NumberElements/minus',
  'NumberElements/exponential', 'NumberElements/permille', 'NumberElements/infinity', 'NumberElements/nan',
  'NumberElements/currencyDecimal', 'NumberElements/currencyGroup', 'NumberElements/lenientMinusSigns'];
const TIME_PATTERN_KEYS = ['DateTimePatterns/full-time', 'DateTimePatterns/long-time',
  'DateTimePatterns/medium-time', 'DateTimePatterns/short-time'];
const DATE_PATTERN_KEYS = ['DateTimePatterns/full-date', 'DateTimePatterns/long-date',
  'DateTimePatterns/medium-date', 'DateTimePatterns/short-date'];
const DATETIME_PATTERN_KEYS = ['DateTimePatterns/full-dateTime', 'DateTimePatterns/long-dateTime',
  'DateTimePatterns/medium-dateTime', 'DateTimePatterns/short-dateTime'];
const ERA_KEYS = ['long.Eras', 'Eras', 'narrow.Eras'];
const LIST_PATTERN_KEYS = ['ListPatterns_standard', 'ListPatterns_or', 'ListPatterns_unit'];
const ZONE_NAME_KEYS = ['timezone.displayname.standard.long', 'timezone.displayname.standard.short',
  'timezone.displayname.daylight.long', 'timezone.displayname.daylight.short',
  'timezone.displayname.generic.long', 'timezone.displayname.generic.short'];

class Bundle {
  constructor(conv, id, cldrPath) {
    this.conv = conv;
    this.id = id;
    this.cldrPath = cldrPath;
    this.targetMap = null;
  }

  isRoot() { return this.id === 'root'; }

  getTargetMap() {
    if (this.targetMap !== null) return this.targetMap;
    const conv = this.conv;
    const cldrBundles = jsplit(this.cldrPath, ',');
    const myMap = new JHashMap();
    let index;
    for (index = 0; index < cldrBundles.length; index++) {
      if (cldrBundles[index] === this.id) {
        myMap.putAll(conv.getCLDRBundle(cldrBundles[index]));
        break;
      }
    }
    let parentsMap = new JHashMap();
    for (let i = cldrBundles.length - 1; i > index; i--) parentsMap.putAll(conv.getCLDRBundle(cldrBundles[i]));
    if (cldrBundles[0] === 'root') parentsMap.putAll(myMap);

    const scripts = nn(myMap.get('numberingScripts'));
    if (scripts !== null) {
      for (const script of scripts) {
        myMap.put(script + '.NumberPatterns', this.createNumberArray(myMap, parentsMap, NUMBER_PATTERN_KEYS, script));
        myMap.put(script + '.NumberElements', this.createNumberArray(myMap, parentsMap, NUMBER_ELEMENT_KEYS, script));
      }
    }

    for (const k of COMPACT_NUMBER_PATTERN_KEYS) {
      const patterns = nn(myMap.remove(k));
      if (patterns !== null) {
        const pList = nn(parentsMap.get(k));
        const size = patterns.length;
        const psize = pList !== null ? pList.length : 0;
        const arr = [];
        for (let i = 0; i < Math.max(size, psize); i++) {
          let v = '';
          if (i < size && patterns[i] !== '') v = '{' + patterns[i] + '}';
          else if (i < psize && pList[i] !== '') v = '{' + pList[i] + '}';
          arr.push(v);
        }
        myMap.put(k, arr);
      }
    }

    conv.handleAliases(myMap);

    if (this.isRoot()) parentsMap = null;

    for (const ct of CalendarType) {
      const p = ct.keyElementName();
      for (const k of ['MonthNames', 'MonthAbbreviations', 'MonthNarrows', 'DayNames', 'DayAbbreviations',
        'DayNarrows', 'AmPmMarkers', 'narrow.AmPmMarkers', 'abbreviated.AmPmMarkers', 'QuarterNames',
        'QuarterAbbreviations', 'QuarterNarrows']) {
        this.handleMultipleInheritance(myMap, parentsMap, p + k);
      }
      this.adjustEraNames(myMap, parentsMap, ct);
      this.handleDateTimeFormatPatterns(TIME_PATTERN_KEYS, myMap, parentsMap, ct, 'TimePatterns');
      this.handleDateTimeFormatPatterns(DATE_PATTERN_KEYS, myMap, parentsMap, ct, 'DatePatterns');
      this.handleDateTimeFormatPatterns(DATETIME_PATTERN_KEYS, myMap, parentsMap, ct, 'DateTimePatterns');
      this.handleSkeletonPatterns(myMap, ct);
    }

    if (this.isRoot()) {
      const collected = new JHashMap();
      for (const [k, v] of myMap.entries()) {
        if (k.startsWith(C.DATEFORMATITEM_INPUT_REGIONS_PREFIX)) collected.putIfAbsent(k, v.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''));
      }
      myMap.putAll(collected);
    }

    const isTzKey = (key) => key.startsWith(C.TIMEZONE_ID_PREFIX) || key.startsWith(C.METAZONE_ID_PREFIX);
    for (const [key, v] of myMap.entries()) {
      if (isTzKey(key) && v.size === 0) myMap.remove(key);
    }
    for (const [key, nameMap] of myMap.entries()) {
      if (!isTzKey(key)) continue;
      const names = new Array(ZONE_NAME_KEYS.length).fill(null);
      ZONE_NAME_KEYS.forEach((nameKey, ix) => {
        let name = nn(nameMap.get(nameKey));
        if (name === null && parentsMap !== null) {
          const parentNames = nn(parentsMap.get(key));
          if (parentNames !== null) name = nn(parentNames.get(nameKey));
        }
        names[ix] = name;
      });
      if (names.includes(null)) {
        const metaKey = this.toMetaZoneKey(key);
        if (metaKey !== null) {
          const obj = nn(myMap.get(metaKey));
          if (Array.isArray(obj)) {
            for (let i = 0; i < names.length; i++) if (names[i] === null) names[i] = nn(obj[i]);
          } else if (obj instanceof JHashMap) {
            for (let i = 0; i < names.length; i++) if (names[i] === null) names[i] = nn(obj.get(ZONE_NAME_KEYS[i]));
          }
        }
      }
      myMap.put(key, names);
    }

    for (const key of ERA_KEYS) {
      const value = nn(myMap.get(key));
      if (Array.isArray(value)) {
        for (const s of value) {
          if (s === null || s === '') this.fillInElements(parentsMap, key, value);
        }
      }
    }

    let rule = conv.pluralRules.get(this.id);
    if (rule !== undefined) myMap.put('PluralRules', rule);
    rule = conv.dayPeriodRules.get(this.id);
    if (rule !== undefined) myMap.put('DayPeriodRules', rule);

    if (parentsMap !== null) {
      for (const [key, v] of myMap.entries()) {
        if (key !== 'numberingScripts' && deepEquals(parentsMap.get(key), v)) myMap.remove(key);
      }
    }

    this.targetMap = myMap;
    return myMap;
  }

  handleMultipleInheritance(map, parents, key) {
    const formatMapKey = key + '/format';
    const format = nn(map.get(formatMapKey));
    if (format !== null) {
      map.remove(formatMapKey);
      map.put(key, format);
      if (this.fillInElements(parents, formatMapKey, format)) map.remove(key);
    }
    const standaloneMapKey = key + '/stand-alone';
    const standalone = nn(map.get(standaloneMapKey));
    if (standalone !== null) {
      map.remove(standaloneMapKey);
      const rk = 'standalone.' + key;
      map.put(rk, standalone);
      if (this.fillInElements(parents, standaloneMapKey, standalone)) map.remove(rk);
    }
  }

  fillInElements(parents, key, value) {
    if (parents === null) return false;
    if (Array.isArray(value) && !(value instanceof JList)) {
      const alias = this.conv.aliases.get(key);
      const def = isNull(alias) ? undefined : parents.get(alias);
      const pvalue = nn(parents.getOrDefault(key, def));
      if (Array.isArray(pvalue) && !(pvalue instanceof JList)) {
        for (let i = 0; i < value.length; i++) {
          if (value[i] === null || value[i].length === 0) value[i] = pvalue[i];
        }
        return arraysEqual(value, pvalue);
      }
    }
    return false;
  }

  adjustEraNames(map, pMap, type) {
    const eraNames = [];
    const realKeys = [];
    for (const key of ERA_KEYS) {
      const realKey = type.keyElementName() + key;
      let value = nn(map.get(realKey));
      if (value !== null) {
        this.fillInElements(pMap, realKey, value);
        switch (type.name) {
        case 'JAPANESE': {
          const nv = new Array(value.length + 1).fill(null);
          const julian = nn(map.get(key));
          nv[0] = julian !== null && julian.length >= 2 ? julian[1] : '';
          for (let i = 0; i < value.length; i++) nv[i + 1] = value[i];
          value = nv;
          if (value[value.length - 1] === null) value[value.length - 1] = key.startsWith('narrow.') ? 'R' : 'Reiwa';
          break;
        }
        case 'BUDDHIST': value = ['BC', value[0]]; break;
        case 'ISLAMIC': value = ['', value[0]]; break;
        }
        map.put(realKey, value);
        map.put('java.time.' + realKey, value);
      }
      realKeys.push(realKey);
      eraNames.push(value);
    }
    for (let i = 0; i < eraNames.length; i++) if (eraNames[i] === null) map.put(realKeys[i], null);
  }

  handleDateTimeFormatPatterns(patternKeys, myMap, parentsMap, ct, name) {
    const prefix = ct.keyElementName();
    for (const k of patternKeys) {
      if (!myMap.has(prefix + k)) continue;
      const len = patternKeys.length;
      const dtp = [], sdf = [];
      for (let i = 0; i < len; i++) {
        const key = prefix + patternKeys[i];
        let pattern = nn(myMap.remove(key));
        if (pattern === null) pattern = nn(parentsMap.remove(key));
        if (pattern !== null) {
          let trans = key.endsWith('-dateTime') ? pattern : escapeReservedChars(pattern);
          trans = translateDateFormatLetters(ct, key, trans, convertDateTimePatternLetter);
          dtp.push(trans);
          sdf.push(translateDateFormatLetters(ct, key, trans, convertSDFLetter));
        } else {
          dtp.push(null);
          sdf.push(null);
        }
      }
      const key = prefix + name;
      if (!arraysEqual(dtp, sdf)) myMap.put('java.time.' + key, dtp);
      myMap.put(key, sdf);
      break;
    }
  }

  toMetaZoneKey(tzKey) {
    if (tzKey.startsWith(C.TIMEZONE_ID_PREFIX)) {
      const meta = nn(this.conv.handlerMetaZones.get(tzKey.substring(C.TIMEZONE_ID_PREFIX.length)));
      if (meta !== null) return C.METAZONE_ID_PREFIX + meta;
    }
    return null;
  }

  handleSkeletonPatterns(myMap, ct) {
    const prefix = ct.keyElementName();
    const collected = new JHashMap();
    for (const [k, v] of myMap.entries()) {
      if (k.startsWith(C.DATEFORMATITEM_KEY_PREFIX)) {
        collected.putIfAbsent(prefix + k,
          translateDateFormatLetters(ct, k, escapeReservedChars(v), convertDateTimePatternLetter));
      }
    }
    myMap.putAll(collected);
  }

  createNumberArray(myMap, parentsMap, keys, script) {
    const arr = new Array(keys.length).fill(null);
    for (let i = 0; i < keys.length; i++) {
      const key = script + '.' + keys[i];
      const v = nn(myMap.getOrDefault(key, parentsMap.getOrDefault(key,
        parentsMap.getOrDefault(keys[i], parentsMap.get('latn.' + keys[i])))));
      if (v !== null) arr[i] = v;
      else if (keys === NUMBER_PATTERN_KEYS) {
        if (!key.endsWith('accounting')) throw new Error(`NumberPatterns: null for ${key}, id: ${this.id}`);
      } else if (key.endsWith('/pattern')) arr[i] = '#';
      else if (!key.endsWith('currencyDecimal') && !key.endsWith('currencyGroup')) {
        throw new Error(`NumberElements: null for ${key}, id: ${this.id}`);
      }
    }
    return arr;
  }
}

function escapeReservedChars(pattern) {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "'") {
      if (i + 1 < pattern.length && pattern[i + 1] === "'") { out += "''"; i++; }
      else { inQuote = !inQuote; out += c; }
    } else if (!inQuote && '#{}[]'.includes(c)) {
      out += "'" + c + "'";
    } else out += c;
  }
  return out;
}

function translateDateFormatLetters(ct, patternKey, cldrFormat, converter) {
  const pattern = cldrFormat;
  const length = pattern.length;
  let inQuote = false;
  const sb = { s: '' };
  let count = 0;
  let last = '';
  for (let i = 0; i < length; i++) {
    const c = pattern[i];
    if (c === "'") {
      if (i + 1 < length && pattern[i + 1] === "'") {
        i++;
        if (count !== 0) { converter(ct, patternKey, last, count, sb); last = ''; count = 0; }
        sb.s += "''";
        continue;
      }
      if (!inQuote) {
        if (count !== 0) { converter(ct, patternKey, last, count, sb); last = ''; count = 0; }
        inQuote = true;
      } else inQuote = false;
      sb.s += c;
      continue;
    }
    if (inQuote) { sb.s += c; continue; }
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
      if (count !== 0) { converter(ct, patternKey, last, count, sb); last = ''; count = 0; }
      sb.s += c;
      continue;
    }
    if (last === '' || last === c) { last = c; count++; continue; }
    converter(ct, patternKey, last, count, sb);
    last = c;
    count = 1;
  }
  if (inQuote) throw new Error('Unterminated quote in date-time pattern: ' + cldrFormat);
  if (count !== 0) converter(ct, patternKey, last, count, sb);
  return sb.s;
}

function convertDateTimePatternLetter(ct, key, letter, count, sb) {
  sb.s += (letter === 'u' || letter === 'U' ? 'y' : letter).repeat(count);
}

function convertSDFLetter(ct, key, letter, count, sb) {
  switch (letter) {
  case 'G':
    if (ct.name !== 'GREGORIAN') {
      if (count === 5) count = 1;
      else if (count === 1) count = 4;
    }
    sb.s += letter.repeat(count);
    break;
  case 'c': case 'e':
    if (count === 1) sb.s += 'u';
    else if (count === 3 || count === 4) sb.s += 'E'.repeat(count);
    else if (count === 5) sb.s += 'EEE';
    break;
  case 'v': case 'V':
    sb.s += 'z'.repeat(count);
    break;
  case 'y':
    if (ct.name === 'JAPANESE' && (key.includes('full-') || key.includes('long-'))) count = 4;
    sb.s += letter.repeat(count);
    break;
  case 'Z':
    if (count === 4 || count === 5) sb.s += 'XXX';
    break;
  case 'B':
    sb.s += 'a'.repeat(count);
    break;
  default:
    sb.s += letter.repeat(count);
  }
}

// ---- copyright headers ----------------------------------------------------

const GPL_BODY = ' * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.\n'
  + ' *\n'
  + ' * This code is free software; you can redistribute it and/or modify it\n'
  + ' * under the terms of the GNU General Public License version 2 only, as\n'
  + ' * published by the Free Software Foundation.  Oracle designates this\n'
  + ' * particular file as subject to the "Classpath" exception as provided\n'
  + ' * by Oracle in the LICENSE file that accompanied this code.\n'
  + ' *\n'
  + ' * This code is distributed in the hope that it will be useful, but WITHOUT\n'
  + ' * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or\n'
  + ' * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License\n'
  + ' * version 2 for more details (a copy is included in the LICENSE file that\n'
  + ' * accompanied this code).\n'
  + ' *\n'
  + ' * You should have received a copy of the GNU General Public License version\n'
  + ' * 2 along with this work; if not, write to the Free Software Foundation,\n'
  + ' * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.\n'
  + ' *\n'
  + ' * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA\n'
  + ' * or visit www.oracle.com if you need additional information or have any\n'
  + ' * questions.\n'
  + ' */\n';
const OPENJDK2012 = '/*\n * Copyright (c) %d, Oracle and/or its affiliates. All rights reserved.\n' + GPL_BODY;
const OPENJDK_AFTER2012 = '/*\n * Copyright (c) 2012, %d, Oracle and/or its affiliates. All rights reserved.\n' + GPL_BODY;

const UNICODE = `/*
 * UNICODE LICENSE V3
 *
 * COPYRIGHT AND PERMISSION NOTICE
 *
 * Copyright © 1991-2025 Unicode, Inc.
 *
 * NOTICE TO USER: Carefully read the following legal agreement. BY
 * DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
 * SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
 * TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
 * DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of data files and any associated documentation (the "Data Files") or
 * software and any associated documentation (the "Software") to deal in the
 * Data Files or Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, and/or sell
 * copies of the Data Files or Software, and to permit persons to whom the
 * Data Files or Software are furnished to do so, provided that either (a)
 * this copyright and permission notice appear with all copies of the Data
 * Files or Software, or (b) this copyright and permission notice appear in
 * associated Documentation.
 *
 * THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
 * THIRD PARTY RIGHTS.
 *
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
 * BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
 * OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
 * WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
 * FILES OR SOFTWARE.
 *
 * Except as contained in this notice, the name of a copyright holder shall
 * not be used in advertising or otherwise to promote the sale, use or other
 * dealings in these Data Files or Software without prior written
 * authorization of the copyright holder.
 *
 * SPDX-License-Identifier: Unicode-3.0
 */
`;

function main(args) {
  return new Converter().run(args);
}

module.exports = { main, Converter, escape, keyComparator, stringHash };
