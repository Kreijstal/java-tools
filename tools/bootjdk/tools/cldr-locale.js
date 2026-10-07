'use strict';
// The parts of java.util.Locale (forLanguageTag, toLanguageTag, Builder) and
// ResourceBundle.Control.getCandidateLocales the CLDR converter relies on.
// Locales are plain frozen objects; key() gives an identity for Map lookups.

const isAlpha = (s) => /^[A-Za-z]+$/.test(s);
const isDigits = (s) => /^[0-9]+$/.test(s);
const isAlnum = (s) => /^[A-Za-z0-9]+$/.test(s);
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upper = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const title = (s) => s.length ? upper(s[0]) + lower(s.slice(1)) : s;

const isLanguage = (s) => s.length >= 2 && s.length <= 8 && isAlpha(s);
const isExtlang = (s) => s.length === 3 && isAlpha(s);
const isScript = (s) => s.length === 4 && isAlpha(s);
const isRegion = (s) => (s.length === 2 && isAlpha(s)) || (s.length === 3 && isDigits(s));
const isVariant = (s) => (s.length >= 5 && s.length <= 8 && isAlnum(s))
  || (s.length === 4 && /^[0-9]/.test(s) && isAlnum(s));
const isSingleton = (s) => s.length === 1 && /^[0-9A-WYZa-wyz]$/.test(s);
const isExtSubtag = (s) => s.length >= 2 && s.length <= 8 && isAlnum(s);
const isPrivSubtag = (s) => s.length >= 1 && s.length <= 8 && isAlnum(s);

function convertOldISOCodes(l) {
  return { iw: 'he', ji: 'yi', in: 'id' }[l] || l;
}

const cache = new Map();
function getInstance(language, script, region, variant, ext) {
  language = lower(language || '');
  region = upper(region || '');
  if (language) language = convertOldISOCodes(language);
  script = title(script || '');
  variant = variant || '';
  ext = ext || '';
  const key = [language, script, region, variant, ext].join('\u0000');
  let l = cache.get(key);
  if (!l) {
    l = Object.freeze({ language, script, country: region, variant, ext, key });
    cache.set(key, l);
  }
  return l;
}

const ROOT = getInstance('', '', '', '', '');

// LanguageTag.parse (lenient) + InternalLocaleBuilder.setLanguageTag
function forLanguageTag(tag) {
  const subtags = tag.split('-');
  let i = 0;
  const cur = () => subtags[i];
  let language = '', script = '', region = '';
  const extlangs = [], variants = [], extensions = [];
  let privateuse = '';
  if (i < subtags.length && isLanguage(cur())) {
    language = cur(); i++;
    if (language.length === 2 || language.length === 3) {
      while (i < subtags.length && isExtlang(cur()) && extlangs.length < 3) extlangs.push(subtags[i++]);
    }
    if (i < subtags.length && isScript(cur())) script = subtags[i++];
    if (i < subtags.length && isRegion(cur())) region = subtags[i++];
    while (i < subtags.length && isVariant(cur())) variants.push(subtags[i++]);
    while (i < subtags.length && isSingleton(cur()) && lower(cur()) !== 'x') {
      const parts = [subtags[i++]];
      while (i < subtags.length && isExtSubtag(cur())) parts.push(subtags[i++]);
      if (parts.length === 1) break;
      extensions.push(parts.join('-'));
    }
  }
  if (i < subtags.length && lower(cur()) === 'x') {
    const parts = [];
    let j = i + 1;
    while (j < subtags.length && isPrivSubtag(subtags[j])) parts.push(subtags[j++]);
    if (parts.length) { privateuse = 'x-' + parts.join('-'); i = j; }
  }
  if (extensions.length || privateuse) throw new Error('locale extensions not supported: ' + tag);
  let lang = extlangs.length ? extlangs[0] : (language === 'und' ? '' : language);
  return getInstance(lang, script, region, variants.join('_'), '');
}

// Locale.toLanguageTag
function toLanguageTag(loc) {
  let language = '', script = '', region = '';
  let hasSubtag = false;
  let baseVariant = loc.variant;
  if (isLanguage(loc.language)) language = convertOldISOCodes(loc.language);
  if (isScript(loc.script)) { script = title(loc.script); hasSubtag = true; }
  if (isRegion(loc.country)) { region = upper(loc.country); hasSubtag = true; }
  if (language === 'no' && region === 'NO' && baseVariant === 'NY' && !script) {
    language = 'nn'; baseVariant = '';
  }
  const variants = [];
  let privuse = '';
  if (baseVariant) {
    const vs = baseVariant.split('_');
    let k = 0;
    while (k < vs.length && isVariant(vs[k])) variants.push(vs[k++]);
    if (variants.length) hasSubtag = true;
    const pv = [];
    while (k < vs.length && isPrivSubtag(vs[k])) pv.push(vs[k++]);
    if (pv.length) privuse = 'lvariant-' + pv.join('-');
  }
  if (!language && (hasSubtag || !privuse)) language = 'und';
  const out = [];
  if (language) out.push(lower(language));
  if (script) out.push(script);
  if (region) out.push(region);
  out.push(...variants);
  let s = out.join('-');
  if (privuse) s += (s ? '-' : '') + 'x-' + privuse;
  return s;
}

// Locale.Builder setters validate; we only need the happy path
function build(language, script, region) {
  return getInstance(language, script, region, '', '');
}

function getDefaultList(language, script, region, variant) {
  let variants = null;
  if (variant) {
    variants = [];
    let idx = variant.length;
    while (idx !== -1) {
      variants.push(variant.substring(0, idx));
      idx = variant.lastIndexOf('_', --idx);
    }
  }
  const list = [];
  if (variants) for (const v of variants) list.push(getInstance(language, script, region, v));
  if (region) list.push(getInstance(language, script, region, ''));
  if (script) {
    list.push(getInstance(language, script, '', ''));
    if (language === 'zh' && !region) {
      if (script === 'Hans') region = 'CN';
      else if (script === 'Hant') region = 'TW';
    }
    if (variants) for (const v of variants) list.push(getInstance(language, '', region, v));
    if (region) list.push(getInstance(language, '', region, ''));
  }
  if (language) list.push(getInstance(language, '', '', ''));
  list.push(ROOT);
  return list;
}

// ResourceBundle.Control.getControl(FORMAT_DEFAULT).getCandidateLocales
function getCandidateLocales(loc) {
  const language = loc.language;
  let script = loc.script, region = loc.country, variant = loc.variant;
  let bokmal = false, nynorsk = false;
  if (language === 'no') {
    if (region === 'NO' && variant === 'NY' && !script) { variant = ''; nynorsk = true; }
    else bokmal = true;
  }
  if (language === 'nb' || bokmal) {
    const tmp = getDefaultList('nb', script, region, variant);
    const out = [];
    for (const lnb of tmp) {
      const isRoot = lnb.language === '';
      const lno = getInstance(isRoot ? '' : 'no', lnb.script, lnb.country, lnb.variant);
      out.push(bokmal ? lno : lnb);
      if (isRoot) break;
      out.push(bokmal ? lnb : lno);
    }
    return out;
  } else if (language === 'nn' || nynorsk) {
    const list = getDefaultList('nn', script, region, variant);
    let idx = list.length - 1;
    list.splice(idx++, 0, getInstance('no', '', 'NO', 'NY'));
    list.splice(idx++, 0, getInstance('no', '', 'NO', ''));
    list.splice(idx++, 0, getInstance('no', '', '', ''));
    return list;
  } else if (language === 'zh') {
    if (!script && region) {
      if (['TW', 'HK', 'MO'].includes(region)) script = 'Hant';
      else if (['CN', 'SG'].includes(region)) script = 'Hans';
    }
  }
  return getDefaultList(language, script, region, variant);
}

module.exports = { ROOT, getInstance, forLanguageTag, toLanguageTag, build, getCandidateLocales };
