'use strict';
// Port of make/jdk/src/classes/build/tools/tzdb/TzdbZoneRulesCompiler.java
// and TzdbZoneRulesProvider.java, with the parts of java.time (LocalDate,
// LocalDateTime, ZoneOffsetTransition(Rule), ZoneRules and java.time.zone.Ser)
// they rely on: compiles the IANA tzdata files into lib/tzdb.dat.
//
// usage: TzdbZoneRulesCompiler -srcdir <dir> [-dstfile <file>] [-verbose] <files>...
const fs = require('fs');
const path = require('path');
const { LNSEP } = require('./util');
const { compareStrings, DataOutput } = require('./misc-java');

const YEAR_MAX = 999999999, YEAR_MIN = -999999999;
const MIN_EPOCH_DAY = -365243219162, MAX_EPOCH_DAY = 365241780471;
const DAYS_0000_TO_1970 = 719528;

class DateTimeException extends Error {}

const floorDiv = (a, b) => Math.floor(a / b);
const floorMod = (a, b) => a - Math.floor(a / b) * b;
const isLeap = y => (y & 3) === 0 && (y % 100 !== 0 || y % 400 === 0);

// Month 1..12
const monthLength = (m, leap) => m === 2 ? (leap ? 29 : 28) : (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
const monthMaxLength = m => monthLength(m, true);
const monthPlus = (m, n) => floorMod(m - 1 + n, 12) + 1;
// DayOfWeek 1 (Monday) .. 7
const dowPlus = (d, n) => floorMod(d - 1 + (n % 7), 7) + 1;

// LocalDate as epoch day (Number is exact over the whole java.time range)
function dateOf(y, m, d) {
  if (y < YEAR_MIN || y > YEAR_MAX) throw new DateTimeException('Invalid value for Year: ' + y);
  if (d < 1 || d > 31) throw new DateTimeException('Invalid value for DayOfMonth: ' + d);
  if (d > 28 && d > monthLength(m, isLeap(y))) throw new DateTimeException('Invalid date');
  let total = 365 * y;
  if (y >= 0) total += Math.trunc((y + 3) / 4) - Math.trunc((y + 99) / 100) + Math.trunc((y + 399) / 400);
  else total -= Math.trunc(y / -4) - Math.trunc(y / -100) + Math.trunc(y / -400);
  total += Math.trunc((367 * m - 362) / 12);
  total += d - 1;
  if (m > 2) total -= isLeap(y) ? 1 : 2;
  return total - DAYS_0000_TO_1970;
}

function checkEpochDay(ed) {
  if (ed < MIN_EPOCH_DAY || ed > MAX_EPOCH_DAY) throw new DateTimeException('Invalid value for EpochDay: ' + ed);
  return ed;
}

// LocalDate.ofEpochDay -> { y, m, d }
function fromEpochDay(epochDay) {
  checkEpochDay(epochDay);
  let zeroDay = epochDay + DAYS_0000_TO_1970 - 60;
  let adjust = 0;
  if (zeroDay < 0) {
    const adjustCycles = Math.trunc((zeroDay + 1) / 146097) - 1;
    adjust = adjustCycles * 400;
    zeroDay += -adjustCycles * 146097;
  }
  let yearEst = Math.trunc((400 * zeroDay + 591) / 146097);
  let doyEst = zeroDay - (365 * yearEst + Math.trunc(yearEst / 4) - Math.trunc(yearEst / 100) + Math.trunc(yearEst / 400));
  if (doyEst < 0) {
    yearEst--;
    doyEst = zeroDay - (365 * yearEst + Math.trunc(yearEst / 4) - Math.trunc(yearEst / 100) + Math.trunc(yearEst / 400));
  }
  yearEst += adjust;
  const marchDoy0 = doyEst;
  const marchMonth0 = Math.trunc((marchDoy0 * 5 + 2) / 153);
  const month = (marchMonth0 + 2) % 12 + 1;
  const dom = marchDoy0 - Math.trunc((marchMonth0 * 306 + 5) / 10) + 1;
  yearEst += Math.trunc(marchMonth0 / 10);
  return { y: yearEst, m: month, d: dom };
}

const dayOfWeek = epochDay => floorMod(epochDay + 3, 7) + 1;

// LocalDateTime: epoch day + second of day (+ nano, only for MAX)
class LDT {
  constructor(day, sod, nano = 0) { this.day = day; this.sod = sod; this.nano = nano; }
  static of(day, sod) { return new LDT(checkEpochDay(day), sod); }
  get year() { return fromEpochDay(this.day).y; }
  toEpochSecond(offsetSecs) { return BigInt(this.day) * 86400n + BigInt(this.sod - offsetSecs); }
  static ofEpochSecond(epochSec, offsetSecs) {
    const local = epochSec + BigInt(offsetSecs);
    let day = local / 86400n;
    let sod = local % 86400n;
    if (sod < 0n) { sod += 86400n; day -= 1n; }
    return LDT.of(Number(day), Number(sod));
  }
  plusSeconds(s) {
    if (s === 0) return this;
    const total = this.sod + s;
    return LDT.of(this.day + floorDiv(total, 86400), floorMod(total, 86400));
  }
  compareTo(o) {
    return (this.day - o.day) || (this.sod - o.sod) || (this.nano - o.nano);
  }
  equals(o) { return this.compareTo(o) === 0; }
}
const LDT_MIN = new LDT(dateOf(YEAR_MIN, 1, 1), 0);
const LDT_MAX = new LDT(dateOf(YEAR_MAX, 12, 31), 86399, 999999999);

// ZoneOffset is represented by its total seconds
function offsetOf(secs) {
  if (Math.abs(secs) > 18 * 3600) throw new DateTimeException('Zone offset not in valid range: -18:00 to +18:00');
  return secs;
}

// TimeDefinition ordinals
const UTC = 0, WALL = 1, STANDARD = 2;

function createDateTime(td, ldt, std, wall) {
  if (td === UTC) return ldt.plusSeconds(wall);
  if (td === STANDARD) return ldt.plusSeconds(wall - std);
  return ldt;
}

// ZoneOffsetTransition.of
function transitionOf(ldt, before, after) {
  if (before === after) throw new Error('Offsets must not be equal');
  if (ldt.nano !== 0) throw new Error('Nano-of-second must be zero');
  return { ldt, before, after, epochSecond: ldt.toEpochSecond(before) };
}

// ZoneOffsetTransitionRule.of
function transitionRuleOf(month, dom, dow, secsOfDay, timeEndOfDay, timeDefinition, std, before, after) {
  if (dom < -28 || dom > 31 || dom === 0) {
    throw new Error('Day of month indicator must be between -28 and 31 inclusive excluding zero');
  }
  if (timeEndOfDay && secsOfDay !== 0) throw new Error('Time must be midnight when end of day flag is true');
  return { month, dom, dow, secsOfDay, timeEndOfDay, timeDefinition, std, before, after };
}

// java.time.zone.Ser
function writeOffset(secs, out) {
  const offsetByte = secs % 900 === 0 ? secs / 900 : 127;
  out.writeByte(offsetByte);
  if (offsetByte === 127) out.writeInt(secs);
}

function writeEpochSec(epochSec, out) {
  if (epochSec >= -4575744000n && epochSec < 10413792000n && epochSec % 900n === 0n) {
    const store = Number((epochSec + 4575744000n) / 900n);
    out.writeByte((store >>> 16) & 255);
    out.writeByte((store >>> 8) & 255);
    out.writeByte(store & 255);
  } else {
    out.writeByte(255);
    out.writeLong(epochSec);
  }
}

function writeRule(r, out) {
  const timeSecs = r.timeEndOfDay ? 86400 : r.secsOfDay;
  const stdOffset = r.std;
  const beforeDiff = r.before - stdOffset;
  const afterDiff = r.after - stdOffset;
  const timeByte = timeSecs % 3600 === 0 ? (r.timeEndOfDay ? 24 : Math.trunc(r.secsOfDay / 3600)) : 31;
  const stdOffsetByte = stdOffset % 900 === 0 ? stdOffset / 900 + 128 : 255;
  const beforeByte = beforeDiff === 0 || beforeDiff === 1800 || beforeDiff === 3600 ? beforeDiff / 1800 : 3;
  const afterByte = afterDiff === 0 || afterDiff === 1800 || afterDiff === 3600 ? afterDiff / 1800 : 3;
  const dowByte = r.dow === null ? 0 : r.dow;
  const b = ((r.month << 28) + ((r.dom + 32) << 22) + (dowByte << 19) + (timeByte << 14)
    + (r.timeDefinition << 12) + (stdOffsetByte << 4) + (beforeByte << 2) + afterByte) | 0;
  out.writeInt(b);
  if (timeByte === 31) out.writeInt(timeSecs);
  if (stdOffsetByte === 255) out.writeInt(stdOffset);
  if (beforeByte === 3) out.writeInt(r.before);
  if (afterByte === 3) out.writeInt(r.after);
}

// new ZoneRules(...) followed by Ser.write(rules): the serialized form
// carries everything ZoneRules.equals compares, so it doubles as identity
function serializeZoneRules(baseStd, baseWall, stdTransitions, transitions, lastRules) {
  if (lastRules.length > 16) throw new Error('Too many transition rules');
  for (const t of transitions) t.ldt.plusSeconds(t.after - t.before); // getDateTimeAfter range check
  const out = new DataOutput();
  out.writeByte(1); // ZRULES
  out.writeInt(stdTransitions.length);
  for (const t of stdTransitions) writeEpochSec(t.epochSecond, out);
  writeOffset(baseStd, out);
  for (const t of stdTransitions) writeOffset(t.after, out);
  out.writeInt(transitions.length);
  for (const t of transitions) writeEpochSec(t.epochSecond, out);
  writeOffset(baseWall, out);
  for (const t of transitions) writeOffset(t.after, out);
  out.writeByte(lastRules.length);
  for (const r of lastRules) writeRule(r, out);
  return Buffer.from(out.toBuffer());
}

//----------------------------------------------------------------------------
// TzdbZoneRulesProvider

// String.regionMatches(true, 0, other, 0, len)
function regionMatchesIgnoreCase(s, other, len) {
  if (len > s.length || len > other.length || len < 0) return false;
  for (let i = 0; i < len; i++) {
    const a = s[i], b = other[i];
    if (a !== b && a.toUpperCase() !== b.toUpperCase() && a.toLowerCase() !== b.toLowerCase()) return false;
  }
  return true;
}

function parseInt32(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) throw new Error('For input string: "' + s + '"');
  const v = parseInt(s, 10);
  if (v < -2147483648 || v > 2147483647) throw new Error('For input string: "' + s + '"');
  return v;
}

const isDigit = c => c >= '0' && c <= '9';
// Character.isWhitespace for a single char (latin1 input: no other matches)
const isJavaWhitespace = c => '\t\n\x0B\f\r\x1C\x1D\x1E\x1F '.includes(c);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function parseMonth(mon) {
  const i = MONTHS.findIndex(n => regionMatchesIgnoreCase(mon, n, mon.length));
  if (i < 0) throw new Error('Unknown month: ' + mon);
  return i + 1;
}
function parseDayOfWeek(dow) {
  const i = DAYS.findIndex(n => regionMatchesIgnoreCase(dow, n, dow.length));
  if (i < 0) throw new Error('Unknown day-of-week: ' + dow);
  return i + 1;
}
function parseYear(year, defaultYear) {
  const len = year.length;
  if (regionMatchesIgnoreCase(year, 'minimum', len)) return 1900;
  if (regionMatchesIgnoreCase(year, 'maximum', len)) return YEAR_MAX;
  if (regionMatchesIgnoreCase(year, 'only', len)) return defaultYear;
  return parseInt32(year);
}

function parseSecs(time) {
  if (time === '-') return 0;
  let secs = 0, sign = 1, off = 0;
  const len = time.length;
  let c0, c1;
  if (off < len && time[off] === '-') { sign = -1; off++; }
  if (off < len && isDigit(c0 = time[off++])) {
    let hour = +c0;
    if (off < len && isDigit(c1 = time[off])) { hour = hour * 10 + +c1; off++; }
    secs = hour * 3600;
    if (off < len && time[off++] === ':') {
      if (off + 1 < len && isDigit(c0 = time[off++]) && isDigit(c1 = time[off++])) {
        secs += (+c0 * 10 + +c1) * 60;
        if (off < len && time[off++] === ':') {
          if (off + 1 < len && isDigit(c0 = time[off++]) && isDigit(c1 = time[off++])) {
            secs += +c0 * 10 + +c1;
          }
        }
      }
    }
    return secs * sign;
  }
  throw new Error('[' + time + ']');
}

function parseOffset(str) {
  const secs = parseSecs(str);
  if (Math.abs(secs) > 18 * 3600) throw new Error('Zone offset not in valid range: -18:00 to +18:00');
  return secs;
}

function parseTimeDefinition(c) {
  switch (c) {
    case 's': case 'S': return STANDARD;
    case 'u': case 'U': case 'g': case 'G': case 'z': case 'Z': return UTC;
    default: return WALL;
  }
}

class MonthDayTime {
  constructor() {
    this.month = 1;
    this.dayOfMonth = 1;
    this.adjustForwards = true;
    this.dayOfWeek = null;
    this.secsOfDay = 0;
    this.endOfDay = false;
    this.timeDefinition = WALL;
  }
  adjustToForwards(year) {
    if (this.adjustForwards === false && this.dayOfMonth > 0) {
      const adjusted = fromEpochDay(dateOf(year, this.month, this.dayOfMonth) - 6);
      this.dayOfMonth = adjusted.d;
      this.month = adjusted.m;
      this.adjustForwards = true;
    }
  }
  toDateTime(year) {
    let date;
    if (this.dayOfMonth < 0) {
      const monthLen = monthLength(this.month, isLeap(year));
      date = dateOf(year, this.month, monthLen + 1 + this.dayOfMonth);
      if (this.dayOfWeek !== null) date -= floorMod(dayOfWeek(date) - this.dayOfWeek, 7);  // previousOrSame
    } else {
      date = dateOf(year, this.month, this.dayOfMonth);
      if (this.dayOfWeek !== null) date += floorMod(this.dayOfWeek - dayOfWeek(date), 7);  // nextOrSame
    }
    if (this.endOfDay) date += 1;
    return LDT.of(date, this.secsOfDay);
  }
  parseMDT(tokens, off) {
    this.month = parseMonth(tokens[off++]);
    if (off < tokens.length) {
      let dayRule = tokens[off++];
      if (regionMatchesIgnoreCase(dayRule, 'last', 4)) {
        this.dayOfMonth = -1;
        this.dayOfWeek = parseDayOfWeek(dayRule.substring(4));
        this.adjustForwards = false;
      } else {
        let index = dayRule.indexOf('>=');
        if (index > 0) {
          this.dayOfWeek = parseDayOfWeek(dayRule.substring(0, index));
          dayRule = dayRule.substring(index + 2);
        } else {
          index = dayRule.indexOf('<=');
          if (index > 0) {
            this.dayOfWeek = parseDayOfWeek(dayRule.substring(0, index));
            this.adjustForwards = false;
            dayRule = dayRule.substring(index + 2);
          }
        }
        this.dayOfMonth = parseInt32(dayRule);
        if (this.dayOfMonth < -28 || this.dayOfMonth > 31 || this.dayOfMonth === 0) {
          throw new Error('Day of month indicator must be between -28 and 31 inclusive excluding zero');
        }
      }
      if (off < tokens.length) {
        const timeStr = tokens[off++];
        this.secsOfDay = parseSecs(timeStr);
        if (this.secsOfDay === 86400) {
          this.endOfDay = true;
          this.secsOfDay = 0;
        } else if (this.secsOfDay < 0 || this.secsOfDay > 86400) {
          // beyond 0:00-24:00 range. Adjust the cutover date.
          let beyondDays = Math.trunc(this.secsOfDay / 86400);
          this.secsOfDay %= 86400;
          if (this.secsOfDay < 0) {
            this.secsOfDay = 86400 + this.secsOfDay;
            beyondDays -= 1;
          }
          const date = fromEpochDay(dateOf(2004, this.month, this.dayOfMonth) + beyondDays); // leap-year
          this.month = date.m;
          this.dayOfMonth = date.d;
          if (this.dayOfWeek !== null) this.dayOfWeek = dowPlus(this.dayOfWeek, beyondDays);
        }
        this.timeDefinition = parseTimeDefinition(timeStr[timeStr.length - 1]);
      }
    }
  }
}

class RuleLine extends MonthDayTime {
  toTransitionRule(stdOffset, savingsBefore, negativeSavings) {
    // rule shared by different zones, so don't change it
    let month = this.month, dayOfMonth = this.dayOfMonth, dow = this.dayOfWeek, endOfDay = this.endOfDay;
    if (dayOfMonth < 0 && month !== 2) dayOfMonth = monthMaxLength(month) - 6;
    if (endOfDay && dayOfMonth > 0 && (dayOfMonth === 28 && month === 2) === false) {
      const date = fromEpochDay(dateOf(2004, month, dayOfMonth) + 1); // leap-year
      month = date.m;
      dayOfMonth = date.d;
      if (dow !== null) dow = dowPlus(dow, 1);
      endOfDay = false;
    }
    return transitionRuleOf(month, dayOfMonth, dow, this.secsOfDay, endOfDay, this.timeDefinition,
      stdOffset, offsetOf(stdOffset + savingsBefore), offsetOf(stdOffset + this.savingsAmount - negativeSavings));
  }
  parse(tokens) {
    this.startYear = parseYear(tokens[2], 0);
    this.endYear = parseYear(tokens[3], this.startYear);
    if (this.startYear > this.endYear) {
      throw new Error('Invalid <Rule> line/Year order invalid:' + this.startYear + ' > ' + this.endYear);
    }
    this.parseMDT(tokens, 5);
    this.savingsAmount = parseSecs(tokens[8]);
    return this;
  }
}

class ZoneLine extends MonthDayTime {
  constructor() {
    super();
    this.stdOffsetSecs = 0;
    this.fixedSavingsSecs = 0;
    this.savingsRule = null;
    this.year = YEAR_MAX;
    this.ldt = null;
    this.ldtSecs = null;
  }
  toZoneDateTime() {
    if (this.ldt === null) this.ldt = this.toDateTime(this.year);
    return this.ldt;
  }
  toDateTimeEpochSecond(savingsSecs) {
    if (this.ldtSecs === null) this.ldtSecs = this.toZoneDateTime().toEpochSecond(0);
    switch (this.timeDefinition) {
      case UTC: return this.ldtSecs;
      case STANDARD: return this.ldtSecs - BigInt(this.stdOffsetSecs);
      default: return this.ldtSecs - BigInt(this.stdOffsetSecs + savingsSecs);
    }
  }
  parse(tokens, off) {
    this.stdOffsetSecs = parseOffset(tokens[off++]);
    this.savingsRule = tokens[off] === '-' ? null : tokens[off];
    off++;
    const sr = this.savingsRule;
    if (sr !== null && sr.length > 0 && (sr[0] === '-' || isDigit(sr[0]))) {
      try {
        this.fixedSavingsSecs = parseSecs(sr);
        this.savingsRule = null;
      } catch (e) {
        this.fixedSavingsSecs = 0;
      }
    }
    this.text = tokens[off++];
    if (off < tokens.length) {
      this.year = parseInt32(tokens[off++]);
      if (off < tokens.length) this.parseMDT(tokens, off);
      return false;
    }
    return true;
  }
}

class TransRule {
  constructor(year, rule) {
    this.year = year;
    this.rule = rule;
    this.ldt = rule.toDateTime(year);
    this.ldtSecs = this.ldt.toEpochSecond(0);
  }
  toTransition(std, savingsBefore, negativeSavings) {
    const wall = offsetOf(std + savingsBefore);
    const after = offsetOf(std + this.rule.savingsAmount - negativeSavings);
    return transitionOf(createDateTime(this.rule.timeDefinition, this.ldt, std, wall), wall, after);
  }
  toEpochSecond(std, savingsBefore) {
    switch (this.rule.timeDefinition) {
      case UTC: return this.ldtSecs;
      case STANDARD: return this.ldtSecs - BigInt(std);
      default: return this.ldtSecs - BigInt(std + savingsBefore);
    }
  }
  isTransition(savingsBefore, negativeSavings) {
    return this.rule.savingsAmount - negativeSavings !== savingsBefore;
  }
}
const compareTransRules = (a, b) => a.ldtSecs < b.ldtSecs ? -1 : a.ldtSecs === b.ldtSecs ? 0 : 1;

// TzdbZoneRulesProvider.split
function splitTokens(str) {
  const list = [];
  let off = 0;
  const end = str.length;
  while (off < end) {
    let c = str[off];
    if (c === '\t' || c === ' ') { off++; continue; }
    if (c === '#') break;
    const start = off;
    while (off < end) {
      c = str[off];
      if (c === ' ' || c === '\t') break;
      off++;
    }
    if (start !== off) list.push(str.substring(start, off));
  }
  return list;
}

const EXCLUDED_ZONES = new Set(['EST', 'HST', 'MST', 'GMT+0', 'GMT-0', 'ROC']);

class Provider {
  constructor(files) {
    this.regionIds = [];
    this.zones = new Map();  // id -> ZoneLine[] or built rules
    this.links = new Map();
    this.rules = new Map();
    for (const file of files) {
      try {
        this.loadFile(file);
      } catch (e) {
        throw new Error('Unable to load TZDB time-zone rules: Failed while processing file [' + file + ']: ' + e.message);
      }
    }
  }
  loadFile(file) {
    let openZone = null;
    const lines = fs.readFileSync(file, 'latin1').split(/\r\n|\n|\r/);
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      if (line.length === 0 || line[0] === '#') continue;
      const tokens = splitTokens(line);
      if (openZone !== null && isJavaWhitespace(line[0]) && tokens.length > 0) {
        const zLine = new ZoneLine();
        openZone.push(zLine);
        if (zLine.parse(tokens, 0)) openZone = null;
        continue;
      }
      const token0len = tokens.length > 0 ? tokens[0].length : line.length;
      if (regionMatchesIgnoreCase(line, 'Zone', token0len)) {
        const name = tokens[1];
        if (EXCLUDED_ZONES.has(name)) continue;
        if (this.zones.has(name)) {
          throw new Error('Duplicated zone name in file: ' + name + ', line: [' + line + ']');
        }
        openZone = [];
        this.zones.set(name, openZone);
        this.regionIds.push(name);
        const zLine = new ZoneLine();
        openZone.push(zLine);
        if (zLine.parse(tokens, 2)) openZone = null;
      } else if (regionMatchesIgnoreCase(line, 'Rule', token0len)) {
        const name = tokens[1];
        if (!this.rules.has(name)) this.rules.set(name, []);
        this.rules.get(name).push(new RuleLine().parse(tokens));
      } else if (regionMatchesIgnoreCase(line, 'Link', token0len)) {
        if (tokens.length >= 3) {
          const realId = tokens[1], aliasId = tokens[2];
          if (EXCLUDED_ZONES.has(aliasId)) continue;
          this.links.set(aliasId, realId);
          this.regionIds.push(aliasId);
        } else {
          throw new Error('Invalid Link line in file' + file + ', line: [' + line + ']');
        }
      }
    }
  }
  getZoneIds() { return [...new Set(this.regionIds)].sort(compareStrings); }
  getZoneRules(zoneId) {
    let obj = this.zones.get(zoneId);
    if (obj === undefined) {
      if (this.links.has(zoneId)) {
        zoneId = this.links.get(zoneId);
        obj = this.zones.get(zoneId);
      }
      if (obj === undefined) {
        const zoneIdBack = zoneId;
        if (this.links.has(zoneId)) {
          zoneId = this.links.get(zoneId);
          obj = this.zones.get(zoneId);
        }
        if (obj === undefined) throw new Error('Unknown time-zone ID: ' + zoneIdBack);
      }
    }
    if (Buffer.isBuffer(obj)) return obj;
    let zrules;
    try {
      zrules = this.buildRules(zoneId, obj);
    } catch (e) {
      e.message = 'Invalid binary time-zone data: TZDB:' + zoneId + ': ' + e.message;
      throw e;
    }
    this.zones.set(zoneId, zrules);
    return zrules;
  }
  windowRules(name) {
    const r = this.rules.get(name);
    if (r === undefined) throw new Error('<Rule> not found: ' + name);
    return r;
  }
  findNegativeSavings(zoneStart, zl) {
    const zoneEnd = zl.toZoneDateTime();
    if (zl.savingsRule === null) return 0;
    const zs = zoneStart.year, ze = zoneEnd.year;
    let min = 0;
    for (const l of this.windowRules(zl.savingsRule)) {
      const overlap = (zs <= l.startYear && ze >= l.startYear) || (zs <= l.endYear && ze >= l.endYear);
      if (overlap && l.savingsAmount < min) min = l.savingsAmount;
    }
    return min;
  }
  buildRules(zoneId, zones) {
    if (zones.length === 0) throw new Error('No available zone window');
    const standardTransitionList = [];
    const transitionList = [];
    const lastTransitionRuleList = [];
    let stdOffset = offsetOf(zones[0].stdOffsetSecs);
    let savings = zones[0].fixedSavingsSecs;
    let wallOffset = offsetOf(stdOffset + savings);
    let zoneStart = LDT_MIN;
    const firstStdOffset = stdOffset, firstWallOffset = wallOffset;

    for (const zone of zones) {
      // adjust stdOffset if negative DST is observed
      const negativeSavings = Math.min(zone.fixedSavingsSecs, this.findNegativeSavings(zoneStart, zone));
      if (negativeSavings < 0) {
        zone.stdOffsetSecs += negativeSavings;
        if (zone.fixedSavingsSecs < 0) zone.fixedSavingsSecs = 0;
      }
      const stdOffsetPrev = stdOffset;
      if (zone.stdOffsetSecs !== stdOffset) {
        const stdOffsetNew = offsetOf(zone.stdOffsetSecs);
        standardTransitionList.push(transitionOf(
          LDT.ofEpochSecond(zoneStart.toEpochSecond(wallOffset), stdOffset), stdOffset, stdOffsetNew));
        stdOffset = stdOffsetNew;
      }
      const zoneEnd = zone.year === YEAR_MAX ? LDT_MAX : zone.toZoneDateTime();
      if (zoneEnd.compareTo(zoneStart) < 0) throw new Error('Windows must be in date-time order');
      const zoneEndIsMax = zoneEnd.equals(LDT_MAX);

      let trules = null, lastRules = null;
      let effectiveSavings = zone.fixedSavingsSecs;
      if (zone.savingsRule !== null) {
        const tzdbRules = this.windowRules(zone.savingsRule);
        trules = [];
        lastRules = [];
        let lastRulesStartYear = YEAR_MIN;
        const zoneEndYear = zoneEnd.year;
        for (const rule of tzdbRules) {
          if (rule.startYear > zoneEndYear) continue;
          rule.adjustToForwards(2004);
          const startYear = rule.startYear;
          let endYear = rule.endYear;
          if (zoneEndIsMax) {
            if (endYear === YEAR_MAX) {
              endYear = startYear;
              lastRules.push(new TransRule(endYear, rule));
            }
            lastRulesStartYear = Math.max(startYear, lastRulesStartYear);
          } else if (endYear === YEAR_MAX) {
            endYear = zone.year;
          }
          for (let year = startYear; year <= endYear; year++) trules.push(new TransRule(year, rule));
        }
        // last rules, fill the gap years between different last rules
        if (zoneEndIsMax) {
          lastRulesStartYear = Math.max(lastRulesStartYear, zoneStart.year) + 1;
          for (const rule of lastRules) {
            if (rule.year <= lastRulesStartYear) {
              let year = rule.year;
              while (year <= lastRulesStartYear) {
                trules.push(new TransRule(year, rule.rule));
                year++;
              }
              rule.year = lastRulesStartYear;
              rule.ldt = rule.rule.toDateTime(year);
              rule.ldtSecs = rule.ldt.toEpochSecond(0);
            }
          }
          lastRules.sort(compareTransRules);
        }
        trules.sort(compareTransRules);

        effectiveSavings = -negativeSavings;
        const zoneStartSecs = zoneStart.toEpochSecond(wallOffset);
        for (const rule of trules) {
          if (rule.toEpochSecond(stdOffsetPrev, savings) > zoneStartSecs) break;
          effectiveSavings = rule.rule.savingsAmount - negativeSavings;
        }
      }
      const effectiveWallOffset = offsetOf(stdOffset + effectiveSavings);
      if (wallOffset !== effectiveWallOffset) {
        transitionList.push(transitionOf(zoneStart, wallOffset, effectiveWallOffset));
      }
      savings = effectiveSavings;
      if (trules !== null) {
        const zoneStartEpochSecs = zoneStart.toEpochSecond(wallOffset);
        for (const trule of trules) {
          if (trule.isTransition(savings, negativeSavings)) {
            const epochSecs = trule.toEpochSecond(stdOffset, savings);
            if (epochSecs < zoneStartEpochSecs || epochSecs >= zone.toDateTimeEpochSecond(savings)) continue;
            transitionList.push(trule.toTransition(stdOffset, savings, negativeSavings));
            savings = trule.rule.savingsAmount - negativeSavings;
          }
        }
      }
      if (lastRules !== null) {
        for (const trule of lastRules) {
          lastTransitionRuleList.push(trule.rule.toTransitionRule(stdOffset, savings, negativeSavings));
          savings = trule.rule.savingsAmount - negativeSavings;
        }
      }
      wallOffset = offsetOf(stdOffset + savings);
      zoneStart = LDT.ofEpochSecond(zone.toDateTimeEpochSecond(savings), wallOffset);
    }
    return serializeZoneRules(firstStdOffset, firstWallOffset, standardTransitionList, transitionList,
      lastTransitionRuleList);
  }
}

//----------------------------------------------------------------------------
// TzdbZoneRulesCompiler

function outputHelp() {
  process.stdout.write([
    'Usage: TzdbZoneRulesCompiler <options> <tzdb source filenames>',
    'where options include:',
    '   -srcdir  <directory>  Where to find tzdb source directory (required)',
    '   -dstfile <file>       Where to output generated file (default srcdir/tzdb.dat)',
    '   -help                 Print this usage message',
    '   -verbose              Output verbose information during compilation',
    ' The source directory must contain the unpacked tzdb files, such as asia or europe',
  ].map(l => l + LNSEP).join(''));
}

function findRegionIndex(regionArray, region) {
  const index = regionArray.indexOf(region);
  if (index < 0) throw new Error('Unknown region: ' + region);
  return index;
}

function compile(srcDir, srcFiles, version, verbose) {
  const printVerbose = m => { if (verbose) process.stdout.write(m + LNSEP); };
  printVerbose('Compiling TZDB version ' + version);
  const provider = new Provider(srcFiles);
  printVerbose('Building rules');
  const builtZones = new Map();
  for (const zoneId of provider.getZoneIds()) {
    printVerbose('Building zone ' + zoneId);
    builtZones.set(zoneId, provider.getZoneRules(zoneId));
  }
  const links = provider.links;
  for (const aliasId of [...links.keys()].sort(compareStrings)) {
    let realId = links.get(aliasId);
    printVerbose('Linking alias ' + aliasId + ' to ' + realId);
    let realRules = builtZones.get(realId);
    if (realRules === undefined) {
      realId = links.get(realId);
      printVerbose('Relinking alias ' + aliasId + ' to ' + realId);
      realRules = builtZones.get(realId);
      if (realRules === undefined) throw new Error("Alias '" + aliasId + "' links to invalid zone '" + realId);
      links.set(aliasId, realId);
    }
    builtZones.set(aliasId, realRules);
  }

  const out = new DataOutput();
  out.writeByte(1);
  out.writeUTF('TZDB');
  out.writeShort(1);
  out.writeUTF(version);
  const regionArray = [...builtZones.keys()].sort(compareStrings);
  out.writeShort(regionArray.length);
  for (const id of regionArray) out.writeUTF(id);
  // rules, without duplicates (ZoneRules.equals)
  const rulesList = [];
  const rulesIndex = new Map();
  for (const id of regionArray) {
    const key = builtZones.get(id).toString('latin1');
    if (!rulesIndex.has(key)) {
      rulesIndex.set(key, rulesList.length);
      rulesList.push(builtZones.get(id));
    }
  }
  out.writeShort(rulesList.length);
  for (const bytes of rulesList) {
    out.writeShort(bytes.length);
    out.write(bytes);
  }
  out.writeShort(builtZones.size);
  for (const id of regionArray) {
    out.writeShort(findRegionIndex(regionArray, id));
    out.writeShort(rulesIndex.get(builtZones.get(id).toString('latin1')));
  }
  const aliases = [...links.keys()].sort(compareStrings);
  out.writeShort(aliases.length);
  for (const aliasId of aliases) {
    out.writeShort(findRegionIndex(regionArray, aliasId));
    out.writeShort(findRegionIndex(regionArray, links.get(aliasId)));
  }
  return out.toBuffer();
}

function main(args) {
  if (args.length < 2) { outputHelp(); return 0; }
  let srcDir = null, dstFile = null, verbose = false;
  let i;
  for (i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    if (arg === '-srcdir') {
      if (srcDir === null && ++i < args.length) { srcDir = args[i]; continue; }
    } else if (arg === '-dstfile') {
      if (dstFile === null && ++i < args.length) { dstFile = args[i]; continue; }
    } else if (arg === '-verbose') {
      if (!verbose) { verbose = true; continue; }
    } else if (arg !== '-help') {
      process.stdout.write('Unrecognised option: ' + arg + LNSEP);
    }
    outputHelp();
    return 0;
  }
  if (srcDir === null) {
    process.stderr.write('Source directory must be specified using -srcdir' + LNSEP);
    return 1;
  }
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    process.stderr.write('Source does not exist or is not a directory: ' + srcDir + LNSEP);
    return 1;
  }
  let names = args.slice(i);
  if (names.length === 0) {
    names = ['africa', 'antarctica', 'asia', 'australasia', 'europe', 'northamerica', 'southamerica',
      'backward', 'etcetera'];
    process.stdout.write('Source filenames not specified, using default set ( ' + LNSEP
      + names.map(n => n + ' ').join('') + ')' + LNSEP);
  }
  const srcFiles = [];
  for (const name of names) {
    const file = path.join(srcDir, name);
    if (!fs.existsSync(file)) {
      process.stderr.write('Source directory does not contain source file: ' + name + LNSEP);
      return 1;
    }
    srcFiles.push(file);
  }
  if (dstFile === null) {
    dstFile = path.join(srcDir, 'tzdb.dat');
  } else {
    const parent = path.dirname(dstFile);
    if (!fs.existsSync(parent)) {
      process.stderr.write('Destination directory does not exist: ' + parent + LNSEP);
      return 1;
    }
  }
  try {
    const m = /tzdata(?<ver>[0-9]{4}[A-z])/.exec(fs.readFileSync(path.join(srcDir, 'VERSION'), 'latin1'));
    if (!m) return 1;
    fs.writeFileSync(dstFile, compile(srcDir, srcFiles, m.groups.ver, verbose));
  } catch (ex) {
    process.stdout.write('Failed: ' + ex + LNSEP);
    process.stderr.write((ex.stack || String(ex)) + '\n');
    return 1;
  }
  return 0;
}

module.exports = { main, dateOf, fromEpochDay };
