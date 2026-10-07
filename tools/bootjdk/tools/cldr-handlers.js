'use strict';
// SAX handlers of build.tools.cldrconverter: AbstractLDMLHandler, the
// container/entry classes, LDMLParseHandler and the supplemental handlers.

const { JHashMap, JHashSet } = require('./cldr-jhashmap');
const { JTreeSet } = require('./cldr-treemap');

// java.util.List values, told apart from String[] (plain arrays)
class JList extends Array {}

// ---- containers -----------------------------------------------------------

class Container {
  constructor(qName, parent) { this.qName = qName; this.parent = parent; }
  addCharacters(s) { if (this.parent) this.parent.addCharacters(s); }
}
class IgnoredContainer extends Container {
  addCharacters() {}
}
class KeyContainer extends Container {
  constructor(qName, parent, key) { super(qName, parent); this.key = key; }
}
class Entry extends Container {
  constructor(qName, parent, key) { super(qName, parent); this.key = key; }
}
class StringEntry extends Entry {
  constructor(qName, parent, key, value) {
    super(qName, parent, key);
    this.value = value === undefined ? null : value;
  }
  addCharacters(s) { this.value = this.value !== null ? this.value + s : s; }
  getValue() { return this.value; }
}
class AliasEntry extends StringEntry {}
class StringArrayEntry extends Entry {
  constructor(qName, parent, key, length) {
    super(qName, parent, key);
    this.value = new Array(length).fill(null);
  }
  addIndexed(index, s) {
    this.value[index] = this.value[index] !== null ? this.value[index] + s : s;
  }
  getValue() {
    const v = this.value;
    if (this.key.startsWith('Month') && v[0] !== null && v[12] === null) v[12] = '';
    for (const e of v) if (e !== null) return v;
    return null;
  }
}
class StringArrayElement extends Container {
  constructor(qName, parent, index) {
    super(qName, parent);
    while (!(parent instanceof StringArrayEntry)) parent = parent.parent;
    this.array = parent;
    this.index = index;
  }
  addCharacters(s) { this.array.addIndexed(this.index, s); }
}
class StringListEntry extends Entry {
  constructor(qName, parent, key) {
    super(qName, parent, key);
    this.value = new JList();
  }
  addIndexed(index, count, s) {
    const size = this.value.length;
    const elem = (count + ':' + s).replace(/ /g, "' '");
    if (size < index) {
      for (let i = size; i < index; i++) this.value.splice(i, 0, '');
      this.value.splice(index, 0, elem);
    } else if (size === index) {
      this.value.splice(index, 0, elem);
    } else {
      this.value[index] = this.value[index] + ' ' + elem;
    }
  }
  getValue() {
    for (const e of this.value) if (e !== null) return this.value;
    return null;
  }
}
class StringListElement extends Container {
  constructor(qName, parent, index, count) {
    super(qName, parent);
    while (!(parent instanceof StringListEntry)) parent = parent.parent;
    this.list = parent;
    this.index = index;
    this.count = count;
  }
  addCharacters(s) { this.list.addIndexed(this.index, this.count, s); }
}

// ---- AbstractLDMLHandler --------------------------------------------------

const DRAFT = ['unconfirmed', 'provisional', 'contributed', 'approved'];
const DAY_OF_WEEK_MAP = { sun: '1', mon: '2', tue: '3', wed: '4', thu: '5', fri: '6', sat: '7' };

class AbstractLDMLHandler {
  constructor(conv) {
    this.conv = conv;
    this.data = new JHashMap();
    this.currentContainer = new Container('$ROOT', null);
  }
  getData() { return this.data; }
  put(k, v) { return this.data.put(k, v); }
  get(k) { return k === null || k === undefined ? undefined : this.data.get(k); }
  keySet() { return this.data.keys(); }

  isIgnored(attrs) {
    if (attrs.getValue('alt') !== null) return true;
    const d = attrs.getValue('draft');
    if (d !== null) {
      const o = DRAFT.indexOf(d);
      if (o < 0) throw new Error('unknown draft value ' + d);
      return this.conv.draftDefault > o;
    }
    return false;
  }
  pushContainer(q, attrs) {
    this.currentContainer = this.isIgnored(attrs) || this.currentContainer instanceof IgnoredContainer
      ? new IgnoredContainer(q, this.currentContainer) : new Container(q, this.currentContainer);
  }
  pushIgnoredContainer(q) { this.currentContainer = new IgnoredContainer(q, this.currentContainer); }
  pushIfIgnored(q, attrs) {
    if (this.isIgnored(attrs) || this.currentContainer instanceof IgnoredContainer) {
      this.pushIgnoredContainer(q);
      return true;
    }
    return false;
  }
  pushKeyContainer(q, a, key) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new KeyContainer(q, this.currentContainer, key);
  }
  pushStringEntry(q, a, key, value) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new StringEntry(q, this.currentContainer, key, value);
  }
  pushAliasEntry(q, a, key) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new AliasEntry(q, this.currentContainer, key);
  }
  pushStringArrayEntry(q, a, key, len) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new StringArrayEntry(q, this.currentContainer, key, len);
  }
  pushStringArrayElement(q, a, index) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new StringArrayElement(q, this.currentContainer, index);
  }
  pushStringListEntry(q, a, key) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new StringListEntry(q, this.currentContainer, key);
  }
  pushStringListElement(q, a, index, count) {
    if (!this.pushIfIgnored(q, a)) this.currentContainer = new StringListElement(q, this.currentContainer, index, count);
  }
  getContainerKey() {
    for (let c = this.currentContainer; c; c = c.parent) if (c instanceof KeyContainer) return c.key;
    return null;
  }
  characters(s) { this.currentContainer.addCharacters(s); }
  // DefaultHandler.endElement does nothing; handlers that track containers override
  endElement() {}
}

// ---- CalendarType ---------------------------------------------------------

const ERA_DATA = [[0, 2], [0, 2], [0, 1], [232, 5], [0, 2], [0, 1], [0, 1], [0, 1]];
const CalendarType = [
  ['GENERIC', null], ['GREGORIAN', 'gregory'], ['BUDDHIST', null], ['JAPANESE', null], ['ROC', null],
  ['ISLAMIC', null], ['ISLAMIC_CIVIL', 'islamic-civil'], ['ISLAMIC_UMALQURA', 'islamic-umalqura'],
].map(([name, uname], ordinal) => {
  let lname = name.toLowerCase();
  if (lname.startsWith('islamic_')) lname = lname.replace(/_/g, '-');
  return {
    name, ordinal, lname, uname: uname !== null ? uname : lname,
    keyElementName() { return name === 'GREGORIAN' ? '' : lname + '.'; },
    normalizeEraIndex(index) {
      index -= ERA_DATA[ordinal][0];
      if (index >= ERA_DATA[ordinal][1]) index = -1;
      return index;
    },
    getEraLength() { return ERA_DATA[ordinal][1]; },
  };
});
CalendarType.forName = (n) => CalendarType.find((t) => t.lname === n || t.uname === n) || null;
CalendarType.byName = (n) => CalendarType.find((t) => t.name === n);

// ---- LDMLParseHandler -----------------------------------------------------

// DateFormatSymbols(Locale.US).getShortMonths()
const US_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', ''];

const CONTEXTS = ['stand-alone', 'format'];
const WIDTHS = ['wide', 'narrow', 'abbreviated'];
const LENGTHS = ['full', 'long', 'medium', 'short'];

class LDMLParseHandler extends AbstractLDMLHandler {
  constructor(conv, id) {
    super(conv);
    this.id = id;
    this.defaultNumberingSystem = null;
    this.currentNumberingSystem = '';
    this.currentCalendarType = null;
    this.zoneNameStyle = null;
    this.zonePrefix = null;
    this.currentContext = '';
    this.currentWidth = '';
    this.currentStyle = '';
  }

  startElement(qName, attributes) {
    const C = this.conv;
    const cct = this.currentCalendarType;
    let type, prefix;
    switch (qName) {
    case 'identity':
      this.pushIgnoredContainer(qName);
      break;
    case 'localeSeparator':
      this.pushStringEntry(qName, attributes, C.LOCALE_SEPARATOR);
      break;
    case 'localeKeyTypePattern':
      this.pushStringEntry(qName, attributes, C.LOCALE_KEYTYPE);
      break;
    case 'language': case 'script': case 'territory': case 'variant':
      this.pushStringEntry(qName, attributes, C.LOCALE_NAME_PREFIX
        + (qName === 'variant' ? '%%' : '') + attributes.getValue('type'));
      break;
    case 'key': {
      const key = convertOldKeyName(attributes.getValue('type'));
      if (key.length === 2) this.pushStringEntry(qName, attributes, C.LOCALE_KEY_PREFIX + key);
      else this.pushIgnoredContainer(qName);
      break;
    }
    case 'type': {
      const key = convertOldKeyName(attributes.getValue('key'));
      const scope = attributes.getValue('scope');
      if (key.length === 2 && scope === null) {
        this.pushStringEntry(qName, attributes, C.LOCALE_TYPE_PREFIX + key + '.' + attributes.getValue('type'));
      } else this.pushIgnoredContainer(qName);
      break;
    }
    case 'currency':
      this.pushKeyContainer(qName, attributes, attributes.getValue('type'));
      break;
    case 'symbol':
      this.pushStringEntry(qName, attributes, C.CURRENCY_SYMBOL_PREFIX + this.getContainerKey());
      break;
    case 'displayName':
      if (this.currentContainer.qName === 'field') {
        this.pushStringEntry(qName, attributes,
          (cct !== null ? cct.keyElementName() : '') + 'field.' + this.getContainerKey());
      } else {
        const containerKey = this.getContainerKey();
        if (containerKey !== null && attributes.getValue('count') === null) {
          this.pushStringEntry(qName, attributes, C.CURRENCY_NAME_PREFIX + containerKey.toLowerCase(),
            attributes.getValue('type'));
        } else this.pushIgnoredContainer(qName);
      }
      break;
    case 'calendar':
      this.currentCalendarType = CalendarType.forName(attributes.getValue('type'));
      if (this.currentCalendarType !== null) this.pushContainer(qName, attributes);
      else this.pushIgnoredContainer(qName);
      break;
    case 'fields':
      this.pushContainer(qName, attributes);
      break;
    case 'field':
      type = attributes.getValue('type');
      if (['era', 'year', 'month', 'week', 'weekday', 'dayperiod', 'hour', 'minute', 'second', 'zone'].includes(type)) {
        this.pushKeyContainer(qName, attributes, type);
      } else this.pushIgnoredContainer(qName);
      break;
    case 'monthContext': case 'dayContext': case 'dayPeriodContext': case 'quarterContext':
      type = attributes.getValue('type');
      if (type === 'stand-alone' || type === 'format') {
        this.currentContext = type;
        this.pushKeyContainer(qName, attributes, type);
      } else this.pushIgnoredContainer(qName);
      break;
    case 'monthWidth':
      if (cct === null) { this.pushIgnoredContainer(qName); break; }
      prefix = cct.keyElementName();
      this.widthArray(qName, attributes, prefix, 'Month', 13);
      break;
    case 'month':
      this.pushStringArrayElement(qName, attributes, parseInt(attributes.getValue('type'), 10) - 1);
      break;
    case 'dayWidth':
      prefix = cct === null ? '' : cct.keyElementName();
      this.widthArray(qName, attributes, prefix, 'Day', 7);
      break;
    case 'day':
      this.pushStringArrayElement(qName, attributes, parseInt(DAY_OF_WEEK_MAP[attributes.getValue('type')], 10) - 1);
      break;
    case 'dayPeriodWidth':
      this.currentWidth = attributes.getValue('type');
      switch (this.currentWidth) {
      case 'wide': this.pushStringArrayEntry(qName, attributes, 'AmPmMarkers/' + this.getContainerKey(), 12); break;
      case 'narrow': this.pushStringArrayEntry(qName, attributes, 'narrow.AmPmMarkers/' + this.getContainerKey(), 12); break;
      case 'abbreviated': this.pushStringArrayEntry(qName, attributes, 'abbreviated.AmPmMarkers/' + this.getContainerKey(), 12); break;
      default: this.pushIgnoredContainer(qName);
      }
      break;
    case 'dayPeriod':
      if (attributes.getValue('alt') === null) {
        const idx = ['am', 'pm', 'midnight', 'noon', 'morning1', 'morning2', 'afternoon1', 'afternoon2',
          'evening1', 'evening2', 'night1', 'night2'].indexOf(attributes.getValue('type'));
        if (idx >= 0) this.pushStringArrayElement(qName, attributes, idx);
        else this.pushIgnoredContainer(qName);
      } else this.pushIgnoredContainer(qName);
      break;
    case 'eraNames': case 'eraAbbr': case 'eraNarrow':
      if (cct === null) this.pushIgnoredContainer(qName);
      else {
        const key = cct.keyElementName() + { eraNames: 'long.Eras', eraAbbr: 'Eras', eraNarrow: 'narrow.Eras' }[qName];
        this.pushStringArrayEntry(qName, attributes, key, cct.getEraLength(qName));
      }
      break;
    case 'era':
      if (cct === null) this.pushIgnoredContainer(qName);
      else {
        let index = parseInt(attributes.getValue('type'), 10);
        index = cct.normalizeEraIndex(index);
        if (index >= 0) this.pushStringArrayElement(qName, attributes, index);
        else this.pushIgnoredContainer(qName);
        if (this.currentContainer.parent === null) throw new Error('currentContainer: null parent');
      }
      break;
    case 'quarterWidth':
      prefix = cct === null ? '' : cct.keyElementName();
      this.widthArray(qName, attributes, prefix, 'Quarter', 4);
      break;
    case 'quarter':
      this.pushStringArrayElement(qName, attributes, parseInt(attributes.getValue('type'), 10) - 1);
      break;
    case 'timeZoneNames':
      this.pushContainer(qName, attributes);
      break;
    case 'hourFormat':
      this.pushStringEntry(qName, attributes, 'timezone.hourFormat');
      break;
    case 'gmtFormat':
      this.pushStringEntry(qName, attributes, 'timezone.gmtFormat');
      break;
    case 'gmtZeroFormat':
      this.pushStringEntry(qName, attributes, 'timezone.gmtZeroFormat');
      break;
    case 'regionFormat':
      type = attributes.getValue('type');
      this.pushStringEntry(qName, attributes, 'timezone.regionFormat' + (type === null ? '' : '.' + type));
      break;
    case 'zone': {
      const tzid = attributes.getValue('type');
      this.zonePrefix = C.TIMEZONE_ID_PREFIX;
      this.put(this.zonePrefix + tzid, new JHashMap());
      this.pushKeyContainer(qName, attributes, tzid);
      break;
    }
    case 'metazone': {
      const zone = attributes.getValue('type');
      this.zonePrefix = C.METAZONE_ID_PREFIX;
      this.put(this.zonePrefix + zone, new JHashMap());
      this.pushKeyContainer(qName, attributes, zone);
      break;
    }
    case 'long': case 'short':
      this.zoneNameStyle = qName;
      this.pushContainer(qName, attributes);
      break;
    case 'generic': case 'standard': case 'daylight':
      this.pushStringEntry(qName, attributes, C.ZONE_NAME_PREFIX + qName + '.' + this.zoneNameStyle);
      break;
    case 'exemplarCity':
      this.pushStringEntry(qName, attributes, C.EXEMPLAR_CITY_PREFIX);
      break;
    case 'decimalFormatLength':
      type = attributes.getValue('type');
      if (type === null) {
        this.pushStringEntry(qName, attributes, this.currentNumberingSystem + 'NumberPatterns/decimal');
        this.currentStyle = type;
      } else if (type === 'short' || type === 'long') {
        this.pushKeyContainer(qName, attributes, type);
        this.currentStyle = type;
      } else this.pushIgnoredContainer(qName);
      break;
    case 'decimalFormat':
      if (this.currentStyle === null) this.pushContainer(qName, attributes);
      else if (this.currentStyle === 'short' || this.currentStyle === 'long') {
        this.pushStringListEntry(qName, attributes, this.currentStyle + '.CompactNumberPatterns');
      } else this.pushIgnoredContainer(qName);
      break;
    case 'currencyFormat': case 'percentFormat':
      this.pushKeyContainer(qName, attributes, attributes.getValue('type'));
      break;
    case 'pattern': {
      const containerName = this.currentContainer.qName;
      switch (containerName) {
      case 'currencyFormat': case 'percentFormat':
        if (this.currentContainer instanceof KeyContainer) {
          if (attributes.getValue('alt') !== null) this.pushIgnoredContainer(qName);
          else {
            const fStyle = this.currentContainer.key;
            if (fStyle === 'standard') {
              this.pushStringEntry(qName, attributes,
                this.currentNumberingSystem + 'NumberPatterns/' + containerName.replace('Format', ''));
            } else if (fStyle === 'accounting' && containerName === 'currencyFormat') {
              this.pushStringEntry(qName, attributes, this.currentNumberingSystem + 'NumberPatterns/accounting');
            } else this.pushIgnoredContainer(qName);
          }
        } else this.pushIgnoredContainer(qName);
        break;
      case 'decimalFormat':
        if (this.currentStyle === null) this.pushContainer(qName, attributes);
        else if (this.currentStyle === 'short' || this.currentStyle === 'long') {
          this.pushStringListElement(qName, attributes, log10int(attributes.getValue('type')),
            attributes.getValue('count'));
        } else this.pushIgnoredContainer(qName);
        break;
      case 'dateFormat': case 'timeFormat': case 'dateTimeFormat':
        if (this.currentContainer instanceof KeyContainer && this.currentContainer.key !== 'standard') {
          this.pushIgnoredContainer(qName);
        } else {
          prefix = cct === null ? '' : cct.keyElementName();
          this.pushStringEntry(qName, attributes, prefix + 'DateTimePatterns/' + this.currentStyle
            + { dateFormat: '-date', timeFormat: '-time', dateTimeFormat: '-dateTime' }[containerName]);
        }
        break;
      default:
        this.pushContainer(qName, attributes);
      }
      break;
    }
    case 'currencyFormats': case 'decimalFormats': case 'percentFormats': {
      const script = attributes.getValue('numberSystem');
      if (script !== null) {
        this.addNumberingScript(script);
        this.currentNumberingSystem = script + '.';
      }
      this.pushContainer(qName, attributes);
      break;
    }
    case 'currencyFormatLength':
      if (attributes.getValue('type') === null) this.pushContainer(qName, attributes);
      else this.pushIgnoredContainer(qName);
      break;
    case 'defaultNumberingSystem':
      this.pushStringEntry(qName, attributes, 'DefaultNumberingSystem');
      break;
    case 'symbols': {
      const script = attributes.getValue('numberSystem');
      if (script === null) { this.pushIgnoredContainer(qName); break; }
      this.currentNumberingSystem = script + '.';
      const digits = C.handlerNumbering.get(script);
      if (digits === undefined || digits === null) { this.pushIgnoredContainer(qName); break; }
      this.addNumberingScript(script);
      this.put(this.currentNumberingSystem + 'NumberElements/zero', digits.substring(0, 1));
      this.pushContainer(qName, attributes);
      break;
    }
    case 'decimal': case 'group': case 'currencyDecimal': case 'currencyGroup':
      if (this.currentContainer.qName === 'symbols') {
        this.pushStringEntry(qName, attributes, this.currentNumberingSystem + 'NumberElements/' + qName);
      } else this.pushIgnoredContainer(qName);
      break;
    case 'list': case 'percentSign': case 'nativeZeroDigit': case 'patternDigit': case 'minusSign':
    case 'exponential': case 'perMille': case 'infinity': case 'nan':
      this.pushStringEntry(qName, attributes, this.currentNumberingSystem + 'NumberElements/' + {
        list: 'list', percentSign: 'percent', nativeZeroDigit: 'zero', patternDigit: 'pattern',
        minusSign: 'minus', exponential: 'exponential', perMille: 'permille', infinity: 'infinity', nan: 'nan',
      }[qName]);
      break;
    case 'plusSign':
      this.pushIgnoredContainer(qName);
      break;
    case 'dateFormatLength': case 'timeFormatLength': case 'dateTimeFormatLength':
      this.currentStyle = attributes.getValue('type');
      this.pushContainer(qName, attributes);
      break;
    case 'dateFormats': case 'timeFormats': case 'dateTimeFormats':
      this.pushContainer(qName, attributes);
      break;
    case 'dateFormat': case 'timeFormat': case 'dateTimeFormat':
      this.pushKeyContainer(qName, attributes, attributes.getValue('type'));
      break;
    case 'dateFormatItem':
      if (cct !== null) {
        const skeleton = attributes.getValue('id');
        C.availableSkeletons.add(skeleton);
        this.pushStringEntry(qName, attributes, cct.keyElementName() + C.DATEFORMATITEM_KEY_PREFIX + skeleton);
      } else this.pushIgnoredContainer(qName);
      break;
    case 'localizedPatternChars':
      prefix = cct === null ? '' : cct.keyElementName();
      this.pushStringEntry(qName, attributes, prefix + 'DateTimePatternChars');
      break;
    case 'alias': {
      const cq = this.currentContainer.qName;
      if (this.id === 'root' && !this.isIgnored(attributes)
          && (cq === 'decimalFormatLength' || cq === 'currencyFormat' || cq === 'percentFormat'
            || cq === 'listPattern' || (cct !== null && !cct.lname.startsWith('islamic-')))) {
        this.pushAliasEntry(qName, attributes, attributes.getValue('path'));
      } else this.pushIgnoredContainer(qName);
      break;
    }
    case 'listPattern': {
      const t = attributes.getValue('type');
      this.currentStyle = t !== null ? t : 'standard';
      this.pushStringArrayEntry(qName, attributes, 'ListPatterns_' + this.currentStyle, 5);
      break;
    }
    case 'listPatternPart': {
      type = attributes.getValue('type');
      const idx = { start: 0, middle: 1, end: 2, 2: 3, 3: 4 }[type];
      if (idx === undefined) {
        throw new Error(`The "type" attribute value for "listPatternPart" element is not recognized: ${type}\n`);
      }
      this.pushStringArrayElement(qName, attributes, idx);
      break;
    }
    case 'parseLenients':
      if (attributes.getValue('level') === 'lenient') this.pushKeyContainer(qName, attributes, attributes.getValue('scope'));
      else this.pushIgnoredContainer(qName);
      break;
    case 'parseLenient':
      if (this.currentContainer instanceof KeyContainer && this.currentContainer.key === 'number'
          && attributes.getValue('sample') === '-') {
        this.pushStringEntry(qName, attributes, this.currentNumberingSystem + 'NumberElements/lenientMinusSigns');
      } else this.pushIgnoredContainer(qName);
      break;
    default:
      this.pushContainer(qName, attributes);
    }
  }

  widthArray(qName, attributes, prefix, base, len) {
    this.currentWidth = attributes.getValue('type');
    const kind = { wide: 'Names/', abbreviated: 'Abbreviations/', narrow: 'Narrows/' }[this.currentWidth];
    if (kind !== undefined) {
      this.pushStringArrayEntry(qName, attributes, prefix + base + kind + this.getContainerKey(), len);
    } else this.pushIgnoredContainer(qName);
  }

  populateWidthAlias(type, keys) {
    for (const context of CONTEXTS) {
      for (const width of WIDTHS) {
        const keyName = this.toJDKKey(type + 'Width', context, width);
        if (keyName.length > 0) keys.add(keyName + ',' + context + ',' + width);
      }
    }
  }

  populateFormatLengthAlias(type, keys) {
    for (const length of LENGTHS) {
      const keyName = this.toJDKKey(type + 'FormatLength', this.currentContext, length);
      if (keyName.length > 0) keys.add(keyName + ',' + this.currentContext + ',' + length);
    }
  }

  populateAliasKeys(qName, context, width) {
    const ret = new JHashSet();
    switch (qName) {
    case 'monthWidth': case 'dayWidth': case 'quarterWidth': case 'dayPeriodWidth':
    case 'dateFormatLength': case 'timeFormatLength': case 'dateTimeFormatLength':
    case 'eraNames': case 'eraAbbr': case 'eraNarrow':
      ret.add(this.toJDKKey(qName, context, width) + ',' + context + ',' + width);
      break;
    case 'days': this.populateWidthAlias('day', ret); break;
    case 'months': this.populateWidthAlias('month', ret); break;
    case 'quarters': this.populateWidthAlias('quarter', ret); break;
    case 'dayPeriods': this.populateWidthAlias('dayPeriod', ret); break;
    case 'eras':
      ret.add(this.toJDKKey('eraNames', context, width) + ',' + context + ',' + width);
      ret.add(this.toJDKKey('eraAbbr', context, width) + ',' + context + ',' + width);
      ret.add(this.toJDKKey('eraNarrow', context, width) + ',' + context + ',' + width);
      break;
    case 'dateFormats': this.populateFormatLengthAlias('date', ret); break;
    case 'timeFormats': this.populateFormatLengthAlias('time', ret); break;
    }
    return ret;
  }

  translateWidthAlias(qName, context, width) {
    let keyName = qName;
    const type = qName.charAt(0).toUpperCase() + qName.substring(1, qName.indexOf('Width'));
    switch (width) {
    case 'wide': keyName = type + 'Names/' + context; break;
    case 'abbreviated': keyName = type + 'Abbreviations/' + context; break;
    case 'narrow': keyName = type + 'Narrows/' + context; break;
    }
    return keyName;
  }

  toJDKKey(containerqName, context, type) {
    let keyName = containerqName;
    switch (containerqName) {
    case 'monthWidth': case 'dayWidth': case 'quarterWidth':
      keyName = this.translateWidthAlias(keyName, context, type);
      break;
    case 'dayPeriodWidth':
      switch (type) {
      case 'wide': keyName = 'AmPmMarkers/' + context; break;
      case 'narrow': keyName = 'narrow.AmPmMarkers/' + context; break;
      case 'abbreviated': keyName = 'abbreviated.AmPmMarkers/' + context; break;
      }
      break;
    case 'dateFormatLength': case 'timeFormatLength': case 'dateTimeFormatLength':
      keyName = 'DateTimePatterns/' + type + '-' + keyName.substring(0, keyName.indexOf('FormatLength'));
      break;
    case 'eraNames': keyName = 'long.Eras'; break;
    case 'eraAbbr': keyName = 'Eras'; break;
    case 'eraNarrow': keyName = 'narrow.Eras'; break;
    case 'dateFormats': case 'timeFormats': case 'days': case 'months': case 'quarters':
    case 'dayPeriods': case 'eras':
      break;
    case 'decimalFormatLength':
      keyName = type + '.CompactNumberPatterns';
      break;
    case 'currencyFormat': case 'percentFormat':
      keyName = this.currentNumberingSystem + 'NumberPatterns/'
        + (type === 'standard' ? containerqName.replace('Format', '') : type);
      break;
    case 'listPattern':
      keyName = type;
      break;
    default:
      keyName = '';
    }
    return keyName;
  }

  getTarget(path, calType, context, width) {
    const lastSlash = path.lastIndexOf('/');
    let qName = path.substring(lastSlash + 1);
    const bracket = qName.indexOf('[');
    if (bracket !== -1) qName = qName.substring(0, bracket);
    const attr = (typeKey) => {
      const start = path.indexOf(typeKey);
      return start === -1 ? null : path.substring(start + typeKey.length, path.indexOf("']", start));
    };
    let v = attr("/calendar[@type='");
    if (v !== null) calType = v;
    v = attr("Context[@type='");
    if (v !== null) context = v;
    v = attr("Width[@type='");
    if (v !== null) width = v;
    for (const k of ["decimalFormatLength[@type='", "currencyFormat[@type='", "percentFormat[@type='"]) {
      v = attr(k);
      if (v !== null) return this.toJDKKey(qName, '', v);
    }
    if (path.indexOf('../listPattern') !== -1) {
      v = attr("[@type='");
      return this.toJDKKey(qName, '', v !== null ? 'ListPatterns_' + v : 'ListPatterns_standard');
    }
    return calType + '.' + this.toJDKKey(qName, context, width);
  }

  endElement(qName) {
    const C = this.conv;
    switch (qName) {
    case 'calendar':
      this.currentCalendarType = null;
      break;
    case 'defaultNumberingSystem':
      if (this.currentContainer instanceof StringEntry) this.defaultNumberingSystem = this.putIfEntry();
      else this.defaultNumberingSystem = null;
      break;
    case 'timeZoneNames':
      this.zonePrefix = null;
      break;
    case 'generic': case 'standard': case 'daylight': case 'exemplarCity':
      if (this.zonePrefix !== null && this.currentContainer instanceof Entry) {
        const valmap = this.get(this.zonePrefix + this.getContainerKey());
        const entry = this.currentContainer;
        if (qName === 'exemplarCity') {
          this.put(C.EXEMPLAR_CITY_PREFIX + this.getContainerKey(), entry.getValue());
        } else {
          valmap.put(entry.key, entry.getValue());
        }
      }
      break;
    case 'monthWidth': case 'dayWidth': case 'dayPeriodWidth': case 'quarterWidth':
      this.currentWidth = '';
      this.putIfEntry();
      break;
    case 'monthContext': case 'dayContext': case 'dayPeriodContext': case 'quarterContext':
      this.currentContext = '';
      this.putIfEntry();
      break;
    case 'decimalFormatLength':
      this.currentStyle = '';
      this.putIfEntry();
      break;
    case 'currencyFormats': case 'decimalFormats': case 'percentFormats': case 'symbols':
      this.currentNumberingSystem = '';
      this.putIfEntry();
      break;
    case 'dateFormatLength': case 'dateTimeFormatLength': case 'timeFormatLength':
      this.currentStyle = '';
      break;
    case 'listPattern':
      this.currentStyle = '';
      this.putIfEntry();
      break;
    case 'parseLenient':
      if (this.currentContainer instanceof StringEntry) {
        const se = this.currentContainer;
        this.put(se.key, se.getValue().replace(/[[\]\\ ]/g, ''));
      }
      break;
    default:
      this.putIfEntry();
    }
    this.currentContainer = this.currentContainer.parent;
  }

  putIfEntry() {
    const C = this.conv;
    const cur = this.currentContainer;
    if (cur instanceof AliasEntry) {
      const containerqName = cur.parent.qName;
      if (containerqName === 'decimalFormatLength') {
        const srcKey = this.toJDKKey(containerqName, '', this.currentStyle);
        C.aliases.put(srcKey, this.getTarget(cur.key, '', '', ''));
      } else if (containerqName === 'currencyFormat' || containerqName === 'percentFormat') {
        C.aliases.put(this.toJDKKey(containerqName, '', cur.parent.key), this.getTarget(cur.key, '', '', ''));
      } else if (containerqName === 'listPattern') {
        C.aliases.put(this.toJDKKey(containerqName, '', cur.parent.key), this.getTarget(cur.key, '', '', ''));
      } else {
        const keyNames = this.populateAliasKeys(containerqName, this.currentContext, this.currentWidth);
        for (const keyName of keyNames) {
          const tmp = jsplitLimit(keyName, ',', 3);
          const calType = this.currentCalendarType.lname;
          const src = calType + '.' + tmp[0];
          let target = this.getTarget(cur.key, calType,
            tmp[1].length > 0 ? tmp[1] : this.currentContext,
            tmp[2].length > 0 ? tmp[2] : this.currentWidth);
          if (target.substring(target.lastIndexOf('.') + 1) === containerqName) {
            target = target.substring(0, target.indexOf('.')) + '.' + tmp[0];
          }
          C.aliases.put(src.replace(/^gregorian./, ''), target.replace(/^gregorian./, ''));
        }
      }
    } else if (cur instanceof Entry) {
      let value = cur.getValue();
      if (value !== null) {
        const key = cur.key;
        if (this.id === 'root' && key.startsWith('MonthNames')) value = US_SHORT_MONTHS.slice();
        const old = this.put(key, value);
        return old === undefined ? null : old;
      }
    }
    return null;
  }

  addNumberingScript(script) {
    let ns = this.get('numberingScripts');
    if (ns === undefined || ns === null) {
      ns = new JList();
      this.put('numberingScripts', ns);
    }
    if (!ns.includes(script)) ns.push(script);
  }
}

function convertOldKeyName(key) {
  return { calendar: 'ca', currency: 'cu', collation: 'co', numbers: 'nu', timezone: 'tz' }[key] || key;
}

// (int) Math.log10(Double.parseDouble(s))
function log10int(s) {
  if (/^10*$/.test(s)) return s.length - 1;
  return Math.trunc(Math.log10(parseFloat(s)));
}

// String.split(literal, limit)
function jsplitLimit(s, sep, limit) {
  const out = [];
  let from = 0;
  while (out.length < limit - 1) {
    const i = s.indexOf(sep, from);
    if (i < 0) break;
    out.push(s.substring(from, i));
    from = i + sep.length;
  }
  out.push(s.substring(from));
  return out;
}

// ---- supplemental handlers ------------------------------------------------

class SupplementalDataParseHandler extends AbstractLDMLHandler {
  constructor(conv) {
    super(conv);
    this.firstDayMap = new JHashMap();
    this.minDaysMap = new JHashMap();
    this.parentLocalesMap = new JHashMap();
    this.inputSkeletonMap = new JHashMap();
    this.currentParentLocaleComponent = null;
  }

  getDataFor(id) {
    const C = this.conv;
    const values = new JHashMap();
    if (id === 'root') {
      this.parentLocalesMap.forEach((v, k) => values.put(C.PARENT_LOCALE_PREFIX + k, v));
      this.firstDayMap.forEach((v, k) => values.put(C.CALENDAR_FIRSTDAY_PREFIX + v, k));
      this.minDaysMap.forEach((v, k) => values.put(C.CALENDAR_MINDAYS_PREFIX + v, k));
      for (const kind of ['preferred', 'allowed']) {
        this.inputSkeletonMap.get(kind).forEach((v, k) => values.merge(
          C.DATEFORMATITEM_INPUT_REGIONS_PREFIX + kind,
          k + ':' + [...v].join(' ') + ';', (old, nv) => old + nv));
      }
    }
    return values.size === 0 ? null : values;
  }

  startElement(qName, attributes) {
    const C = this.conv;
    switch (qName) {
    case 'firstDay':
      if (!this.isIgnored(attributes)) {
        const fd = { sun: '1', tue: '3', wed: '4', thu: '5', fri: '6', sat: '7' }[attributes.getValue('day')] || '2';
        this.firstDayMap.put(attributes.getValue('territories'), fd);
      }
      break;
    case 'minDays':
      if (!this.isIgnored(attributes)) {
        this.minDaysMap.put(attributes.getValue('territories'), attributes.getValue('count'));
      }
      break;
    case 'parentLocales':
      this.currentParentLocaleComponent = attributes.getValue('component');
      this.pushContainer(qName, attributes);
      break;
    case 'parentLocale':
      if (!this.isIgnored(attributes) && this.currentParentLocaleComponent === null) {
        const parent = attributes.getValue('parent').replace(/_/g, '-');
        this.parentLocalesMap.put(parent, attributes.getValue('locales').replace(/_/g, '-'));
        if (parent === 'root') C.nonlikelyScript = attributes.getValue('localeRules') === 'nonlikelyScript';
      }
      break;
    case 'hours':
      if (!this.isIgnored(attributes)) {
        const preferred = attributes.getValue('preferred');
        const allowed = attributes.getValue('allowed').replace(/ .*/, '').replace('b', 'B');
        // Collectors.toSet(); only fed into TreeSets, so order does not matter
        const regions = attributes.getValue('regions').split(' ').map((r) => r.replace(/_/g, '-'));
        const pmap = this.inputSkeletonMap.computeIfAbsent('preferred', () => new JHashMap());
        const amap = this.inputSkeletonMap.computeIfAbsent('allowed', () => new JHashMap());
        pmap.computeIfAbsent(preferred, () => new JTreeSet()).addAll(regions);
        amap.computeIfAbsent(allowed, () => new JTreeSet()).addAll(regions);
      }
      break;
    default:
      this.pushContainer(qName, attributes);
    }
  }
}

class NumberingSystemsParseHandler extends AbstractLDMLHandler {
  startElement(qName, attributes) {
    switch (qName) {
    case 'numberingSystem':
      ns: if (attributes.getValue('type') === 'numeric') {
        const script = attributes.getValue('id');
        let digits = attributes.getValue('digits');
        const c0 = digits.charCodeAt(0);
        if (c0 >= 0xd800 && c0 <= 0xdfff) {
          this.put(script, '0123456789');
          break ns;
        }
        if (digits.charCodeAt(0) > digits.charCodeAt(digits.length - 1)) {
          digits = [...digits].reverse().join('');
        }
        const z = digits.charCodeAt(0);
        for (let i = 1; i < digits.length; i++) if (digits.charCodeAt(i) !== z + i) break ns;
        this.put(script, digits);
      }
      this.pushIgnoredContainer(qName);
      break;
    case 'version': case 'generation':
      this.pushIgnoredContainer(qName);
      break;
    default:
      this.pushContainer(qName, attributes);
    }
  }
  endElement() { this.currentContainer = this.currentContainer.parent; }
}

class MetaZonesParseHandler extends AbstractLDMLHandler {
  constructor(conv) {
    super(conv);
    this.tzid = null;
    this.metazone = null;
    this.mzoneMapEntryList = [];
    this.zones = new JHashMap();
  }
  startElement(qName, attributes) {
    const C = this.conv;
    switch (qName) {
    case 'timezone':
      this.tzid = attributes.getValue('type');
      this.pushContainer(qName, attributes);
      break;
    case 'usesMetazone': {
      const from = attributes.getValue('from');
      const to = attributes.getValue('to');
      const fromT = from !== null ? mzTime(from) : -Infinity;
      const toT = to !== null ? mzTime(to) : Infinity;
      const now = C.now;
      if (fromT < now && toT > now) {
        this.metazone = attributes.getValue('mzone');
        const dstOffset = attributes.getValue('dstOffset');
        if (dstOffset !== null) C.explicitDstOffsets.put(this.tzid, dstOffset);
      }
      this.pushIgnoredContainer(qName);
      break;
    }
    case 'mapZone': {
      const territory = attributes.getValue('territory');
      if (territory === '001') {
        this.zones.put(attributes.getValue('other'), attributes.getValue('type'));
      } else {
        this.mzoneMapEntryList.push(`        "${C.escape(attributes.getValue('other'))}", "${C.escape(territory)}", "${C.escape(attributes.getValue('type'))}",`);
      }
      this.pushIgnoredContainer(qName);
      break;
    }
    case 'version': case 'generation':
      this.pushIgnoredContainer(qName);
      break;
    default:
      this.pushContainer(qName, attributes);
    }
  }
  endElement(qName) {
    if (qName === 'timezone') {
      if (this.tzid === null) throw new Error('InternalError');
      else if (this.metazone === null) {
        const noMeta = this.get(MetaZonesParseHandler.NO_METAZONE_KEY);
        this.put(MetaZonesParseHandler.NO_METAZONE_KEY,
          noMeta === undefined || noMeta === null ? this.tzid : noMeta + ' ' + this.tzid);
      } else this.put(this.tzid, this.metazone);
      this.tzid = null;
      this.metazone = null;
    }
    this.currentContainer = this.currentContainer.parent;
  }
  zidMap() { return this.zones; }
}
MetaZonesParseHandler.NO_METAZONE_KEY = 'no.metazone.defined';

// MZ_TIME (ISO_LOCAL_DATE + "[ HH[:mm[:ss]]]", lenient) as a comparable number
function mzTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/.exec(s);
  if (!m) throw new Error('cannot parse metazone time ' + s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

class LikelySubtagsParseHandler extends AbstractLDMLHandler {
  startElement(qName, attributes) {
    if (qName === 'likelySubtag') {
      const from = attributes.getValue('from');
      if (!from.startsWith('und')) {
        this.put(this.conv.toLanguageTag(from), this.conv.toLanguageTag(attributes.getValue('to')));
      }
    }
  }
}

class SupplementalMetadataParseHandler extends AbstractLDMLHandler {
  constructor(conv) {
    super(conv);
    this.languageAliasMap = new JHashMap();
  }
  startElement(qName, attributes) {
    if (qName === 'zoneAlias') {
      if (attributes.getValue('reason') === 'deprecated') {
        this.put(attributes.getValue('type'), attributes.getValue('replacement'));
      }
    } else if (qName === 'languageAlias') {
      const r = attributes.getValue('reason');
      if (r === 'deprecated' || r === 'legacy') {
        const tag = attributes.getValue('type');
        if (!(tag.startsWith('no') || tag.startsWith('in') || tag.startsWith('iw') || tag.startsWith('ji'))) {
          this.languageAliasMap.put(tag.replace(/_/g, '-'), attributes.getValue('replacement').replace(/_/g, '-'));
        }
      }
    }
  }
  deprecatedMap() {
    const C = this.conv;
    return [...this.keySet()].map((k) => `        "${C.escape(k)}", "${C.escape(this.get(k))}",`).sort(cmpStr);
  }
  getLanguageAliasData() { return this.languageAliasMap; }
}

class WinZonesParseHandler extends AbstractLDMLHandler {
  startElement(qName, attributes) {
    if (qName === 'mapZone') {
      const zoneName = attributes.getValue('other');
      const territory = attributes.getValue('territory');
      let javatz = attributes.getValue('type').replace(/[ \t\n\x0B\f\r].*/, '');
      javatz = this.conv.handlerTimeZone.ianaAliasMap.getOrDefault(javatz, javatz);
      this.put(zoneName + ':' + territory, javatz);
    }
  }
}

class PluralsParseHandler extends AbstractLDMLHandler {
  startElement(qName, attributes) {
    switch (qName) {
    case 'plurals':
      if (attributes.getValue('type') === 'cardinal') this.pushContainer(qName, attributes);
      else this.pushIgnoredContainer(qName);
      break;
    case 'pluralRules':
      this.pushKeyContainer(qName, attributes, attributes.getValue('locales'));
      break;
    case 'pluralRule':
      this.pushStringEntry(qName, attributes, attributes.getValue('count'));
      break;
    default:
      this.pushContainer(qName, attributes);
    }
  }
  endElement(qName) {
    if (qName === 'pluralRule') {
      const entry = this.currentContainer;
      const count = entry.key;
      if (count !== 'other') {
        const rule = entry.getValue();
        const locales = this.currentContainer.parent.key;
        for (const loc of jsplitWs(locales)) {
          let rules = this.get(loc);
          if (rules === undefined || rules === null) { rules = new JHashMap(); this.put(loc, rules); }
          rules.put(count, rule);
        }
      }
    }
    this.currentContainer = this.currentContainer.parent;
  }
}

class DayPeriodRuleParseHandler extends AbstractLDMLHandler {
  startElement(qName, attributes) {
    switch (qName) {
    case 'dayPeriodRuleSet':
      if (attributes.getValue('type') !== null) this.pushIgnoredContainer(qName);
      else this.pushContainer(qName, attributes);
      break;
    case 'dayPeriodRules':
      if (!this.isIgnored(attributes)) this.pushKeyContainer(qName, attributes, attributes.getValue('locales'));
      else this.pushIgnoredContainer(qName);
      break;
    case 'dayPeriodRule':
      if (!this.isIgnored(attributes) && this.currentContainer instanceof KeyContainer) {
        const at = attributes.getValue('at');
        const output = at === null || at === '' ? attributes.getValue('from') + '-' + attributes.getValue('before') : at;
        this.pushStringEntry(qName, attributes, attributes.getValue('type'), output);
      } else this.pushIgnoredContainer(qName);
      break;
    default:
      this.pushContainer(qName, attributes);
    }
  }
  endElement(qName) {
    if (qName === 'dayPeriodRule' && this.currentContainer instanceof Entry) {
      const entry = this.currentContainer;
      const type = entry.key;
      const rule = entry.getValue();
      const locales = this.currentContainer.parent.key;
      for (const loc of jsplitWs(locales)) {
        let rules = this.get(loc);
        if (rules === undefined || rules === null) { rules = new JHashMap(); this.put(loc, rules); }
        rules.put(type, rule);
      }
    }
    this.currentContainer = this.currentContainer.parent;
  }
}

class TimeZoneParseHandler extends AbstractLDMLHandler {
  constructor(conv) {
    super(conv);
    this.ianaAliasMap = JHashMap.newHashMap(32);
  }
  startElement(qName, attributes) {
    if (qName === 'type') {
      if (!this.isIgnored(attributes) && attributes.getValue('description') !== 'Metazone') {
        if (attributes.getValue('deprecated') === 'true') {
          const preferred = attributes.getValue('preferred');
          if (preferred !== null && preferred !== '') this.put(attributes.getValue('name'), 'preferred:' + preferred);
        } else {
          const alias = attributes.getValue('alias');
          const iana = attributes.getValue('iana');
          if (iana !== null) {
            for (const a of jsplit(alias, /[ \t\n\x0B\f\r]+/)) if (a !== iana) this.ianaAliasMap.put(a, iana);
          }
          this.put(attributes.getValue('name'), alias);
        }
      }
    }
  }
  endDocument() {
    const map = this.getData();
    for (const [k, v] of map.entries()) {
      if (String(v).startsWith('preferred:')) {
        const t = map.get(String(v).substring('preferred:'.length));
        map.put(k, t === undefined ? null : t);
      }
    }
  }
}

// String.split(regex) with Java's trailing-empty-string removal
function jsplit(s, re) {
  const parts = s.split(re);
  if (parts.length === 1) return parts;
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
const jsplitWs = (s) => jsplit(s, /[ \t\n\x0B\f\r]/);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

module.exports = {
  JList, Entry, StringEntry, CalendarType, LDMLParseHandler, SupplementalDataParseHandler,
  NumberingSystemsParseHandler, MetaZonesParseHandler, LikelySubtagsParseHandler,
  SupplementalMetadataParseHandler, WinZonesParseHandler, PluralsParseHandler,
  DayPeriodRuleParseHandler, TimeZoneParseHandler, jsplit, jsplitWs, cmpStr,
};
