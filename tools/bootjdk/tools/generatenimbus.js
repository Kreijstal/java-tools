'use strict';
// Port of build.tools.generatenimbus.Generator (make/jdk/src/classes/build/
// tools/generatenimbus): skin.laf -> javax/swing/plaf/nimbus Painter, State
// and NimbusDefaults sources. The tool's templates are classpath resources
// copied from the directory of skin.laf (CompileToolsJdk.gmk), so they are
// read from there.

const fs = require('fs');
const path = require('path');
const { LNSEP, javaTrim } = require('./util');
const { doubleToString, floatToString, JHashMap } = require('./props-javalang');

const f32 = Math.fround;
const fstr = (v) => floatToString(f32(v));
const dstr = doubleToString;

// ---- a pull parser giving the XMLStreamReader events the tool looks at

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (all, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  if (!(e in ENTITIES)) throw new Error(`skin file: undefined entity &${e};`);
  return ENTITIES[e];
});
const localName = (n) => n.slice(n.indexOf(':') + 1);

function xmlEvents(text) {
  text = text.replace(/\r\n?/g, '\n');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const ev = [];
  let i = 0;
  const skipTo = (s) => {
    const e = text.indexOf(s, i);
    if (e < 0) throw new Error('skin file: expected ' + s);
    i = e + s.length;
    return e;
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) ev.push({ type: 'text', text: decode(text.slice(i, lt)) });
    i = lt;
    if (text.startsWith('<!--', i)) { skipTo('-->'); continue; }
    if (text.startsWith('<?', i)) { skipTo('?>'); continue; }
    if (text.startsWith('<![CDATA[', i)) {
      const s = i + 9;
      ev.push({ type: 'text', text: text.slice(s, skipTo(']]>')) });
      continue;
    }
    if (text.startsWith('<!', i)) { skipTo('>'); continue; }
    if (text[i + 1] === '/') {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i, i + 256));
      ev.push({ type: 'end', name: localName(m[1]) });
      i += m[0].length;
      continue;
    }
    const nm = /^<([^\s/>]+)/.exec(text.slice(i, i + 256));
    const name = localName(nm[1]);
    i += nm[0].length;
    const attrs = new Map();
    for (;;) {
      i += /^\s*/.exec(text.slice(i, i + 4096))[0].length;
      if (text.startsWith('/>', i)) { i += 2; ev.push({ type: 'start', name, attrs }, { type: 'end', name }); break; }
      if (text[i] === '>') { i++; ev.push({ type: 'start', name, attrs }); break; }
      const am = /^([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(text.slice(i, i + 65536));
      if (!am) throw new Error(`skin file: malformed attribute in <${name}>`);
      const raw = am[3] !== undefined ? am[3] : am[4];
      attrs.set(localName(am[1]), decode(raw.replace(/[\t\n]/g, ' ')));
      i += am[0].length;
    }
  }
  return ev;
}

class Reader {
  constructor(events) { this.ev = events; this.pos = -1; }
  hasNext() { return this.pos + 1 < this.ev.length; }
  next() { this.pos++; return this.ev[this.pos].type; }
  get cur() { return this.ev[this.pos]; }
  getLocalName() { return this.cur.name; }
  attr(name) { const v = this.cur.attrs.get(name); return v === undefined ? null : v; }
  getElementText() {
    let s = '';
    for (;;) {
      const t = this.next();
      if (t === 'text') s += this.cur.text;
      else if (t === 'end') return s;
      else throw new Error('XMLStreamException: elementGetText() function expects text only elment but START_ELEMENT was encountered.');
    }
  }
}

// ---- Java parsing helpers

function parseInt32(s) {
  if (s === null || !/^[-+]?\d+$/.test(s)) throw new Error('java.lang.NumberFormatException: For input string: "' + s + '"');
  const v = parseInt(s, 10);
  if (v > 2147483647 || v < -2147483648) throw new Error('java.lang.NumberFormatException: For input string: "' + s + '"');
  return v;
}
function parseDouble(s) {
  if (s === null) throw new Error('java.lang.NullPointerException');
  const t = javaTrim(s).replace(/[dDfF]$/, '');
  const v = Number(t);
  if (t === '' || Number.isNaN(v) && t !== 'NaN') throw new Error('java.lang.NumberFormatException: For input string: "' + s + '"');
  return v;
}
const parseFloat32 = (s) => f32(parseDouble(s));
const parseBoolean = (s) => s !== null && s.toLowerCase() === 'true';
function valueOf(values, s, what) {
  if (s === null) throw new Error('java.lang.NullPointerException: Name is null');
  if (!values.includes(s)) throw new Error(`java.lang.IllegalArgumentException: No enum constant ${what}.${s}`);
  return s;
}
const tryOr = (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } };
const S = (v) => (v === null || v === undefined ? 'null' : String(v));

// ---- model

class Insets {
  constructor(r) {
    if (!r) { this.top = this.left = this.bottom = this.right = 0; return; }
    this.top = parseInt32(r.attr('top'));
    this.left = parseInt32(r.attr('left'));
    this.bottom = parseInt32(r.attr('bottom'));
    this.right = parseInt32(r.attr('right'));
  }
  write(ui) { return `new Insets${ui ? 'UIResource' : ''}(${this.top}, ${this.left}, ${this.bottom}, ${this.right})`; }
}

class Dimension {
  constructor(r) { this.width = parseInt32(r.attr('width')); this.height = parseInt32(r.attr('height')); }
  write(ui) { return `new Dimension${ui ? 'UIResource' : ''}(${this.width}, ${this.height})`; }
}

class Border {
  constructor(r) {
    const t = r.attr('type');
    if (t === null) throw new Error('java.lang.NullPointerException');
    this.type = t === 'empty' ? 'EMPTY' : t === 'painter' ? 'PAINTER' : null;
    this.painter = r.attr('painter');
    this.top = parseInt32(r.attr('top'));
    this.left = parseInt32(r.attr('left'));
    this.bottom = parseInt32(r.attr('bottom'));
    this.right = parseInt32(r.attr('right'));
  }
  write() {
    if (this.type === 'PAINTER') return `new PainterBorder("${S(this.painter)}", new Insets(${this.top}, ${this.left}, ${this.bottom}, ${this.right}))`;
    if (this.type === 'EMPTY') return `BorderFactory.createEmptyBorder(${this.top}, ${this.left}, ${this.bottom}, ${this.right})`;
    throw new Error('java.lang.NullPointerException');
  }
}

class Matte {
  constructor(r) {
    this.kind = 'matte';
    this.red = parseInt32(r.attr('red'));
    this.green = parseInt32(r.attr('green'));
    this.blue = parseInt32(r.attr('blue'));
    this.alpha = parseInt32(r.attr('alpha'));
    this.uiDefaultParentName = r.attr('uiDefaultParentName');
    this.hueOffset = parseFloat32(r.attr('hueOffset'));
    this.saturationOffset = parseFloat32(r.attr('saturationOffset'));
    this.brightnessOffset = parseFloat32(r.attr('brightnessOffset'));
    this.alphaOffset = parseInt32(r.attr('alphaOffset'));
    this.componentPropertyName = r.attr('componentPropertyName');
    const ui = r.attr('uiResource');
    this.uiResource = parseBoolean(ui === null ? 'true' : ui);
  }
  isAbsolute() { return this.uiDefaultParentName === null; }
  getDeclaration() {
    if (this.isAbsolute()) return `new Color(${this.red}, ${this.green}, ${this.blue}, ${this.alpha})`;
    return `decodeColor("${this.uiDefaultParentName}", ${fstr(this.hueOffset)}f, ${fstr(this.saturationOffset)}f, ${fstr(this.brightnessOffset)}f, ${this.alphaOffset})`;
  }
  write() {
    if (this.isAbsolute()) return `${this.red}, ${this.green}, ${this.blue}, ${this.alpha}`;
    let s = `"${this.uiDefaultParentName}", ${fstr(this.hueOffset)}f, ${fstr(this.saturationOffset)}f, ${fstr(this.brightnessOffset)}f, ${this.alphaOffset}`;
    if (!this.uiResource) s += ', false';
    return s;
  }
  createComponentColor(variableName) {
    return {
      propertyName: this.componentPropertyName, defaultColorVariableName: variableName,
      saturationOffset: this.saturationOffset, brightnessOffset: this.brightnessOffset, alphaOffset: this.alphaOffset,
    };
  }
}

// Float.compare(a, b) == 0
const floatSame = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
const ccEquals = (a, b) => a.alphaOffset === b.alphaOffset
  && floatSame(a.saturationOffset, b.saturationOffset) && floatSame(a.brightnessOffset, b.brightnessOffset)
  && a.defaultColorVariableName === b.defaultColorVariableName && a.propertyName === b.propertyName;
const ccWrite = (cc) => '                     getComponentColor(c, "' + S(cc.propertyName) + '", '
  + S(cc.defaultColorVariableName) + ', ' + fstr(cc.saturationOffset) + 'f, ' + fstr(cc.brightnessOffset) + 'f, ' + cc.alphaOffset;

const DERIVE = { Default: 'null', Off: 'false', On: 'true' };
class Typeface {
  constructor(r) {
    this.uiDefaultParentName = r.attr('uiDefaultParentName');
    this.name = r.attr('family');
    this.size = tryOr(() => parseInt32(r.attr('size')), 0);
    this.bold = tryOr(() => valueOf(Object.keys(DERIVE), r.attr('bold'), 'DeriveStyle'), 'Default');
    this.italic = tryOr(() => valueOf(Object.keys(DERIVE), r.attr('italic'), 'DeriveStyle'), 'Default');
    this.sizeOffset = tryOr(() => parseFloat32(r.attr('sizeOffset')), 1);
  }
  write() {
    if (this.uiDefaultParentName === null) {
      let style = 0;
      if (this.bold === 'On') style |= 1;
      if (this.italic === 'On') style |= 2;
      return `new javax.swing.plaf.FontUIResource("${S(this.name)}", ${style}, ${this.size})`;
    }
    return `new DerivedFont("${this.uiDefaultParentName}", ${fstr(this.sizeOffset)}f, ${DERIVE[this.bold]}, ${DERIVE[this.italic]})`;
  }
}

// reads <tag> children until the end element (UIColor/UIFont/GradientStop
// style: the first START creates the value, the first END returns)
function firstChild(r, make) {
  let v = null;
  while (r.hasNext()) {
    const t = r.next();
    if (t === 'start') v = make(r);
    else if (t === 'end') return v;
  }
  return v;
}

class UIColor {
  constructor(r) { this.name = r.attr('name'); this.value = firstChild(r, (x) => new Matte(x)); }
  write() { return `        addColor(d, "${S(this.name)}", ${this.value.write()});\n`; }
}

class UIFont {
  constructor(r) { this.name = r.attr('name'); this.value = firstChild(r, (x) => new Typeface(x)); }
  write() { return `        d.put("${S(this.name)}", ${this.value.write()});\n`; }
}

// loop over events until </endName>, calling onStart for start elements
function loop(r, endName, onStart) {
  while (r.hasNext()) {
    const t = r.next();
    if (t === 'start') onStart(r.getLocalName());
    else if (t === 'end' && (endName === null ? true : r.getLocalName() === endName)) return;
  }
}

const PROPERTY_TYPES = ['BOOLEAN', 'INT', 'FLOAT', 'DOUBLE', 'STRING', 'FONT', 'COLOR', 'INSETS', 'DIMENSION', 'BORDER'];
class UIProperty {
  constructor(r) {
    this.name = r.attr('name');
    this.value = r.attr('value');
    this.type = tryOr(() => valueOf(PROPERTY_TYPES, r.attr('type'), 'PropertyType'), null);
    loop(r, 'uiProperty', (n) => {
      if (n === 'border') this.border = new Border(r);
      else if (n === 'dimension') this.dimension = new Dimension(r);
      else if (n === 'insets') this.insets = new Insets(r);
      else if (n === 'matte') this.matte = new Matte(r);
      else if (n === 'typeface') this.typeface = new Typeface(r);
    });
  }
  write(prefix) {
    const k = prefix + S(this.name);
    switch (this.type) {
      case 'BOOLEAN': return `        d.put("${k}", Boolean.${this.value.toUpperCase()});\n`;
      case 'STRING': return `        d.put("${k}", "${S(this.value)}");\n`;
      case 'INT': return `        d.put("${k}", Integer.valueOf(${S(this.value)}));\n`;
      case 'FLOAT': return `        d.put("${k}", Float.valueOf(${S(this.value)}f));\n`;
      case 'DOUBLE': return `        d.put("${k}", Double.valueOf(${S(this.value)}));\n`;
      case 'COLOR': return `        addColor(d, "${k}", ${this.matte.write()});\n`;
      case 'FONT': return `        d.put("${k}", ${this.typeface.write()});\n`;
      case 'INSETS': return `        d.put("${k}", ${this.insets.write(true)});\n`;
      case 'DIMENSION': return `        d.put("${k}", new DimensionUIResource(${this.dimension.width}, ${this.dimension.height}));\n`;
      case 'BORDER': return `        d.put("${k}", new BorderUIResource(${this.border.write()}));\n`;
      default: throw new Error('java.lang.NullPointerException: UIProperty without type');
    }
  }
}

const CACHE_MODES = ['NO_CACHING', 'FIXED_SIZES', 'NINE_SQUARE_SCALE'];
class UIStyle {
  constructor(r) {
    this.textForeground = null; this.textForegroundInherited = true;
    this.textBackground = null; this.textBackgroundInherited = true;
    this.background = null; this.backgroundInherited = true;
    this.cacheSettingsInherited = true;
    this.cacheMode = 'FIXED_SIZES';
    this.maxHozCachedImgScaling = '1.0';
    this.maxVertCachedImgScaling = '1.0';
    this.uiProperties = [];
    this.parentStyle = null;
    if (!r) return;
    loop(r, 'style', (n) => {
      switch (n) {
        case 'textForeground': this.textForeground = new UIColor(r); break;
        case 'textBackground': this.textBackground = new UIColor(r); break;
        case 'background': this.background = new UIColor(r); break;
        case 'uiProperty': this.uiProperties.push(new UIProperty(r)); break;
        case 'inherit-textForeground': this.textForegroundInherited = parseBoolean(r.getElementText()); break;
        case 'inherit-textBackground': this.textBackgroundInherited = parseBoolean(r.getElementText()); break;
        case 'cacheSettingsInherited': this.cacheSettingsInherited = parseBoolean(r.getElementText()); break;
        case 'inherit-background': this.backgroundInherited = parseBoolean(r.getElementText()); break;
        case 'cacheMode': this.cacheMode = valueOf(CACHE_MODES, r.getElementText(), 'CacheMode'); break;
        case 'maxHozCachedImgScaling': this.maxHozCachedImgScaling = r.getElementText(); break;
        case 'maxVertCachedImgScaling': this.maxVertCachedImgScaling = r.getElementText(); break;
      }
    });
  }
  getCacheMode() {
    if (this.cacheSettingsInherited) return this.parentStyle === null ? 'FIXED_SIZES' : this.parentStyle.getCacheMode();
    return this.cacheMode;
  }
  getMaxHozCachedImgScaling() {
    if (this.cacheSettingsInherited) return this.parentStyle === null ? '1.0' : this.parentStyle.getMaxHozCachedImgScaling();
    return this.maxHozCachedImgScaling;
  }
  getMaxVertCachedImgScaling() {
    if (this.cacheSettingsInherited) return this.parentStyle === null ? '1.0' : this.parentStyle.getMaxVertCachedImgScaling();
    return this.maxVertCachedImgScaling;
  }
  write(prefix) {
    let sb = '';
    if (!this.textForegroundInherited) sb += `        addColor(d, "${prefix}textForeground", ${this.textForeground.value.write()});\n`;
    if (!this.textBackgroundInherited) sb += `        addColor(d, "${prefix}textBackground", ${this.textBackground.value.write()});\n`;
    if (!this.backgroundInherited) sb += `        addColor(d, "${prefix}background", ${this.background.value.write()});\n`;
    for (const p of this.uiProperties) sb += p.write(prefix);
    return sb;
  }
}

class PaintPoints {
  constructor(r) {
    this.x1 = parseDouble(r.attr('x1'));
    this.x2 = parseDouble(r.attr('x2'));
    this.y1 = parseDouble(r.attr('y1'));
    this.y2 = parseDouble(r.attr('y2'));
  }
}

class GradientStop {
  constructor(r) {
    this.position = parseFloat32(r.attr('position'));
    this.midpoint = parseFloat32(r.attr('midpoint'));
    this.matte = firstChild(r, (x) => new Matte(x));
  }
}

function gradient(r, kind) {
  const g = { kind, stops: [] };
  while (r.hasNext()) {
    const t = r.next();
    if (t === 'start') { if (r.getLocalName() === 'stop') g.stops.push(new GradientStop(r)); }
    else if (t === 'end' && r.getLocalName() !== 'stop') return g;
  }
  return g;
}

function shapeChild(shape, r, n) {
  if (n === 'matte') shape.paint = new Matte(r);
  else if (n === 'gradient') shape.paint = gradient(r, 'gradient');
  else if (n === 'radialGradient') shape.paint = gradient(r, 'radial');
  else if (n === 'paintPoints') shape.paintPoints = new PaintPoints(r);
}

class Point {
  constructor(r) {
    for (const k of ['x', 'y', 'cp1x', 'cp1y', 'cp2x', 'cp2y']) this[k] = parseDouble(r.attr(k));
  }
  isP1Sharp() { return this.cp1x === this.x && this.cp1y === this.y; }
  isP2Sharp() { return this.cp2x === this.x && this.cp2y === this.y; }
}

class Path {
  constructor(r) {
    this.kind = 'path'; this.paint = null; this.paintPoints = null;
    this.controlPoints = [];
    loop(r, 'path', (n) => {
      if (n === 'points') this.controlPoints = [];
      else if (n === 'point') this.controlPoints.push(new Point(r));
      else shapeChild(this, r, n);
    });
  }
}

class Rectangle {
  constructor(r) {
    this.kind = 'rect'; this.paint = null; this.paintPoints = null;
    this.x1 = parseDouble(r.attr('x1'));
    this.x2 = parseDouble(r.attr('x2'));
    this.y1 = parseDouble(r.attr('y1'));
    this.y2 = parseDouble(r.attr('y2'));
    let rounding = parseDouble(r.attr('rounding'));
    if (rounding > 0 && rounding < 2) rounding = 0;
    this.roundingX = rounding / 2 + this.x1;
    loop(r, 'rectangle', (n) => shapeChild(this, r, n));
  }
  getRounding() {
    const rounding = Math.abs(this.roundingX - this.x1) * 2;
    return rounding > 2 ? rounding : 0;
  }
  isRounded() { return this.getRounding() > 0; }
}

class Ellipse {
  constructor(r) {
    this.kind = 'ellipse'; this.paint = null; this.paintPoints = null;
    this.x1 = parseDouble(r.attr('x1'));
    this.x2 = parseDouble(r.attr('x2'));
    this.y1 = parseDouble(r.attr('y1'));
    this.y2 = parseDouble(r.attr('y2'));
    loop(r, 'ellipse', (n) => shapeChild(this, r, n));
  }
}

class Layer {
  constructor(r) {
    this.shapes = [];
    loop(r, 'layer', (n) => {
      if (n === 'shapes') this.shapes = [];
      else if (n === 'ellipse') this.shapes.push(new Ellipse(r));
      else if (n === 'path') this.shapes.push(new Path(r));
      else if (n === 'rectangle') this.shapes.push(new Rectangle(r));
    });
  }
}

class Canvas {
  constructor(r) {
    this.size = null; this.layers = []; this.stretchingInsets = null;
    loop(r, 'canvas', (n) => {
      if (n === 'size') this.size = new Dimension(r);
      else if (n === 'layer') this.layers.push(new Layer(r));
      else if (n === 'stretchingInsets') this.stretchingInsets = new Insets(r);
    });
  }
  isBlank() { return this.layers.length === 0 || (this.layers.length === 1 && this.layers[0].shapes.length === 0); }
}

class UIStateType {
  constructor(r) {
    this.key = r.attr('key');
    this.codeSnippet = null;
    loop(r, 'stateType', (n) => { if (n === 'codeSnippet') this.codeSnippet = r.getElementText(); });
  }
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// String.split(regex) with trailing empty strings removed
function javaSplit(s, sep) {
  if (!s.includes(sep)) return [s];
  const parts = s.split(sep);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

class UIState {
  constructor(r) {
    this.stateKeys = r.attr('stateKeys');
    this.inverted = parseBoolean(r.attr('inverted'));
    this.canvas = null; this.style = null; this.cachedName = null;
    loop(r, 'state', (n) => {
      if (n === 'canvas') this.canvas = new Canvas(r);
      else if (n === 'style') this.style = new UIStyle(r);
    });
  }
  hasCanvas() { return !this.canvas.isBlank(); }
  getName() {
    if (this.cachedName === null) this.cachedName = javaSplit(this.stateKeys, '+').sort(cmpStr).join('+');
    return this.cachedName;
  }
  write(gen, prefix, pkg, fileNamePrefix, painterPrefix) {
    const statePrefix = prefix + '[' + this.getName() + ']';
    let sb = this.style.write(statePrefix + '.');
    if (this.hasCanvas()) {
      const cacheModeString = 'AbstractRegionPainter.PaintContext.CacheMode.' + this.style.getCacheMode();
      const stateConstant = statesToConstantName(painterPrefix + '_' + this.stateKeys);
      sb += `        d.put("${statePrefix}.${painterPrefix}Painter", new LazyPainter("${pkg}.${fileNamePrefix}", `
        + `${fileNamePrefix}.${stateConstant}, ${this.canvas.stretchingInsets.write(false)}, ${this.canvas.size.write(false)}, `
        + `${this.inverted}, ${cacheModeString}, ${formatDouble(this.style.getMaxHozCachedImgScaling())}, `
        + `${formatDouble(this.style.getMaxVertCachedImgScaling())}));\n`;
    }
    return sb;
  }
}

class UIRegion {
  constructor(r, parse) {
    this.name = r.attr('name');
    this.key = r.attr('key');
    this.opaque = parseBoolean(r.attr('opaque'));
    this.contentMargins = new Insets(null);
    this.backgroundStates = [];
    this.foregroundStates = [];
    this.borderStates = [];
    this.style = new UIStyle(null);
    this.subRegions = [];
    this.states = [];
    if (!parse) return;
    loop(r, 'region', () => this.parse(r));
  }
  parse(r) {
    switch (r.getLocalName()) {
      case 'backgroundStates': this.backgroundStates = this.states = []; break;
      case 'foregroundStates': this.foregroundStates = this.states = []; break;
      case 'borderStates': this.borderStates = this.states = []; break;
      case 'style': this.style = new UIStyle(r); break;
      case 'region': this.subRegions.push(new UIRegion(r, true)); break;
      case 'uiComponent': this.subRegions.push(new UIComponent(r)); break;
      case 'uiIconRegion': this.subRegions.push(new UIIconRegion(r)); break;
      case 'contentMargins': this.contentMargins = new Insets(r); break;
      case 'state': this.states.push(new UIState(r)); break;
    }
  }
  initStyles(parentStyle) {
    this.style.parentStyle = parentStyle;
    for (const s of [...this.backgroundStates, ...this.foregroundStates, ...this.borderStates]) s.style.parentStyle = this.style;
    for (const sub of this.subRegions) sub.initStyles(this.style);
  }
  getKey() { return this.key === null || this.key === '' ? this.name : this.key; }
  hasCanvas() {
    for (const s of this.backgroundStates) if (s.hasCanvas()) return true;
    for (const s of this.borderStates) if (s.hasCanvas()) return true;
    for (const s of this.foregroundStates) if (s.hasCanvas()) return true;
    for (const sub of this.subRegions) if (sub.hasCanvas()) return true;
    return false;
  }
  write(gen, out, comp, prefix, pkg) {
    out.sb += `        d.put("${prefix}.contentMargins", ${this.contentMargins.write(true)});\n`;
    if (this.opaque) out.sb += `        d.put("${prefix}.opaque", Boolean.TRUE);\n`;
    out.style += `        register(Region.${regionNameToCaps(this.name)}, "${prefix}");\n`;
    const types = comp.stateTypes;
    const regString = types.map((t) => S(t.key)).join(',');
    // (sic) StringBuffer.equals(String) is always false
    if (types.length > 0) out.sb += `        d.put("${prefix}.States", "${regString}");\n`;
    for (const type of types) {
      const synthState = type.key;
      if (!['Enabled', 'MouseOver', 'Pressed', 'Disabled', 'Focused', 'Selected', 'Default'].includes(synthState)) {
        const className = normalize(prefix) + S(synthState) + 'State';
        out.sb += `        d.put("${prefix}.${S(synthState)}", new ${className}());\n`;
        const vars = gen.getVariables();
        vars.put('STATE_NAME', className);
        vars.put('STATE_KEY', synthState);
        vars.put('BODY', type.codeSnippet);
        gen.writeSrcFile('StateImpl', vars, className);
      }
    }
    out.sb += this.style.write(prefix + '.');
    const fileName = normalize(prefix) + 'Painter';
    if (this.hasCanvas()) writePainter(gen, this, fileName);
    for (const s of this.backgroundStates) out.sb += s.write(gen, prefix, pkg, fileName, 'background');
    for (const s of this.foregroundStates) out.sb += s.write(gen, prefix, pkg, fileName, 'foreground');
    for (const s of this.borderStates) out.sb += s.write(gen, prefix, pkg, fileName, 'border');
    for (const sub of this.subRegions) {
      const p = sub instanceof UIIconRegion ? prefix : prefix + ':' + escape(sub.getKey());
      sub.write(gen, out, sub instanceof UIComponent ? sub : comp, p, pkg);
    }
  }
}

class UIComponent extends UIRegion {
  constructor(r) {
    super(r, false);
    this.componentName = r.attr('componentName');
    this.stateTypes = [];
    loop(r, 'uiComponent', (n) => {
      if (n === 'stateType') this.stateTypes.push(new UIStateType(r));
      else this.parse(r);
    });
  }
  getKey() {
    if (this.key === null || this.key === '') {
      return this.componentName === null || this.componentName === '' ? this.name : '"' + this.componentName + '"';
    }
    return this.key;
  }
}

class UIIconRegion extends UIRegion {
  constructor(r) {
    super(r, false);
    this.basicKey = r.attr('basicKey');
    loop(r, 'uiIconRegion', () => this.parse(r));
  }
  write(gen, out, comp, prefix, pkg) {
    let size = null;
    const fileNamePrefix = normalize(prefix) + 'Painter';
    for (const s of this.backgroundStates) {
      if (!s.canvas.isBlank()) {
        out.sb += s.write(gen, prefix, pkg, fileNamePrefix, this.getKey());
        size = s.canvas.size;
      }
    }
    if (size !== null) {
      const k = this.basicKey === null ? prefix + '.' + S(this.getKey()) : this.basicKey;
      out.sb += `        d.put("${k}", new NimbusIcon("${prefix}", "${S(this.getKey())}Painter", ${size.width}, ${size.height}));\n`;
    }
  }
}

class SynthModel {
  constructor(r) {
    this.style = null; this.colors = null; this.fonts = null; this.components = null;
    while (r.hasNext()) {
      if (r.next() !== 'start') continue;
      switch (r.getLocalName()) {
        case 'style': this.style = new UIStyle(r); break;
        case 'colors': this.colors = []; break;
        case 'fonts': this.fonts = []; break;
        case 'components': this.components = []; break;
        case 'uiColor': this.colors.push(new UIColor(r)); break;
        case 'uiFont': this.fonts.push(new UIFont(r)); break;
        case 'uiComponent': this.components.push(new UIComponent(r)); break;
      }
    }
  }
  initStyles() { for (const c of this.components) c.initStyles(this.style); }
  write(gen, out, packageName) {
    out.sb += '        //Color palette\n';
    for (const c of this.colors) out.sb += c.write();
    out.sb += '\n';
    out.sb += '        //Font palette\n';
    out.sb += '        d.put("defaultFont", new FontUIResource(defaultFont));\n';
    for (const f of this.fonts) out.sb += f.write();
    out.sb += '\n';
    out.sb += '        //Border palette\n';
    out.sb += '\n';
    out.sb += '        //The global style definition\n';
    out.sb += this.style.write('');
    out.sb += '\n';
    for (const c of this.components) {
      const prefix = escape(c.getKey());
      out.sb += '        //Initialize ' + prefix + '\n';
      c.write(gen, out, c, prefix, packageName);
      out.sb += '\n';
    }
  }
}

// ---- Utils

const escape = (s) => S(s).replace(/"/g, '\\"');

function upperChar(c) { const u = c.toUpperCase(); return u.length === 1 ? u : c; }

function normalize(s) {
  const parts = [];
  let buf = '';
  let capitalize = false;
  for (const ch of S(s)) {
    if (ch === '\\' || ch === '"') continue;
    if (ch === '.') capitalize = true;
    else if (ch === ':') { parts.push(buf); buf = ''; capitalize = true; }
    else {
      // per UTF-16 unit in Java; skins use BMP characters only
      buf += capitalize ? upperChar(ch) : ch;
      capitalize = false;
    }
  }
  parts.push(buf);
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) result = parts[i].startsWith(result) ? parts[i] : result + parts[i];
  return result;
}

// javax.swing.plaf.synth.Region names -> constant names
const REGIONS = {
  ArrowButton: 'ARROW_BUTTON', Button: 'BUTTON', CheckBox: 'CHECK_BOX', CheckBoxMenuItem: 'CHECK_BOX_MENU_ITEM',
  ColorChooser: 'COLOR_CHOOSER', ComboBox: 'COMBO_BOX', DesktopIcon: 'DESKTOP_ICON', DesktopPane: 'DESKTOP_PANE',
  EditorPane: 'EDITOR_PANE', FileChooser: 'FILE_CHOOSER', FormattedTextField: 'FORMATTED_TEXT_FIELD',
  InternalFrame: 'INTERNAL_FRAME', InternalFrameTitlePane: 'INTERNAL_FRAME_TITLE_PANE', Label: 'LABEL', List: 'LIST',
  Menu: 'MENU', MenuBar: 'MENU_BAR', MenuItem: 'MENU_ITEM', MenuItemAccelerator: 'MENU_ITEM_ACCELERATOR',
  OptionPane: 'OPTION_PANE', Panel: 'PANEL', PasswordField: 'PASSWORD_FIELD', PopupMenu: 'POPUP_MENU',
  PopupMenuSeparator: 'POPUP_MENU_SEPARATOR', ProgressBar: 'PROGRESS_BAR', RadioButton: 'RADIO_BUTTON',
  RadioButtonMenuItem: 'RADIO_BUTTON_MENU_ITEM', RootPane: 'ROOT_PANE', ScrollBar: 'SCROLL_BAR',
  ScrollBarThumb: 'SCROLL_BAR_THUMB', ScrollBarTrack: 'SCROLL_BAR_TRACK', ScrollPane: 'SCROLL_PANE',
  Separator: 'SEPARATOR', Slider: 'SLIDER', SliderThumb: 'SLIDER_THUMB', SliderTrack: 'SLIDER_TRACK',
  Spinner: 'SPINNER', SplitPane: 'SPLIT_PANE', SplitPaneDivider: 'SPLIT_PANE_DIVIDER', TabbedPane: 'TABBED_PANE',
  TabbedPaneContent: 'TABBED_PANE_CONTENT', TabbedPaneTab: 'TABBED_PANE_TAB', TabbedPaneTabArea: 'TABBED_PANE_TAB_AREA',
  Table: 'TABLE', TableHeader: 'TABLE_HEADER', TextArea: 'TEXT_AREA', TextField: 'TEXT_FIELD', TextPane: 'TEXT_PANE',
  ToggleButton: 'TOGGLE_BUTTON', ToolBar: 'TOOL_BAR', ToolBarContent: 'TOOL_BAR_CONTENT',
  ToolBarDragWindow: 'TOOL_BAR_DRAG_WINDOW', ToolBarSeparator: 'TOOL_BAR_SEPARATOR', ToolTip: 'TOOL_TIP',
  Tree: 'TREE', TreeCell: 'TREE_CELL', Viewport: 'VIEWPORT',
};
function regionNameToCaps(name) {
  if (Object.prototype.hasOwnProperty.call(REGIONS, name)) return REGIONS[name];
  throw new Error('java.lang.RuntimeException: Bad Region name ' + name);
}

// (sic) the space-stripped string is discarded
const statesToConstantName = (states) => states.replace(/\+/g, '_').toUpperCase();
const statesToClassName = (states) => states.replace(/\+/g, 'And');
const formatDouble = (s) => S(s).replace(/INF/g, 'Double.POSITIVE_INFINITY');

// ---- PainterGenerator

function encode(x, a, b, w) {
  let r;
  if (x < a) r = f32(x / a);
  else if (x > b) r = f32(2 + f32(f32(x - b) / f32(w - b)));
  else if (x === a && x === b) return f32(1.5);
  else r = f32(1 + f32(f32(x - a) / f32(b - a)));
  if (Number.isNaN(r) || !Number.isFinite(r) || r < 0) return 0;
  if (r > 3) return 3;
  return r;
}
const decX = (v) => 'decodeX(' + fstr(v) + 'f)';
const decY = (v) => 'decodeY(' + fstr(v) + 'f)';
// float ex widened to double, printed with Double.toString
const bezX = (ex, x, cpx) => 'decodeAnchorX(' + dstr(ex) + 'f, ' + dstr(cpx - x) + 'f)';
const bezY = (ey, y, cpy) => 'decodeAnchorY(' + dstr(ey) + 'f, ' + dstr(cpy - y) + 'f)';

class PainterGenerator {
  constructor(region) {
    Object.assign(this, {
      colorCounter: 1, gradientCounter: 1, radialCounter: 1, pathCounter: 1, rectCounter: 1,
      roundRectCounter: 1, ellipseCounter: 1, stateTypeCounter: 1,
      colors: new Map(), methods: new Map(),
      stateTypeCode: '', switchCode: '', paintingCode: '', getExtendedCacheKeysCode: '',
      gradientsCode: '', colorCode: '', shapesCode: '',
      componentColorsMap: new Map(), componentColors: null,
    });
    this.generateRegion(region);
  }

  generateRegion(r) {
    for (const s of r.backgroundStates) this.generateState(s, s.canvas, r instanceof UIIconRegion ? r.getKey() : 'Background');
    for (const s of r.foregroundStates) this.generateState(s, s.canvas, 'Foreground');
    for (const s of r.borderStates) this.generateState(s, s.canvas, 'Border');
    for (const sub of r.subRegions) if (sub instanceof UIIconRegion) this.generateRegion(sub);
    if (this.componentColorsMap.size > 0) {
      let c = '    protected Object[] getExtendedCacheKeys(JComponent c) {\n'
        + '        Object[] extendedCacheKeys = null;\n'
        + '        switch(state) {\n';
      for (const [key, list] of this.componentColorsMap) {
        c += '            case ' + key + ':\n' + '                extendedCacheKeys = new Object[] {\n';
        list.forEach((cc, i) => { c += ccWrite(cc) + (i + 1 < list.length ? '),\n' : ')'); });
        c += '};\n' + '                break;\n';
      }
      c += '        }\n' + '        return extendedCacheKeys;\n' + '    }';
      this.getExtendedCacheKeysCode += c;
    }
  }

  generateState(state, canvas, type) {
    const states = state.stateKeys;
    const stateType = statesToConstantName(type + '_' + S(states));
    const paintMethodName = 'paint' + type + statesToClassName(S(states));
    this.componentColors = [];
    this.stateTypeCode += '    static final int ' + stateType + ' = ' + (this.stateTypeCounter++) + ';\n';
    if (canvas.isBlank()) return;
    this.switchCode += '            case ' + stateType + ': ' + paintMethodName + '(g); break;\n';
    this.paintingCode += '    private void ' + paintMethodName + '(Graphics2D g) {\n';

    const ins = canvas.stretchingInsets;
    const a = f32(ins.left);
    const b = f32(canvas.size.width - ins.right);
    const c = f32(ins.top);
    const d = f32(canvas.size.height - ins.bottom);
    const width = f32(canvas.size.width);
    const height = f32(canvas.size.height);
    const ex = (v) => encode(f32(v), a, b, width);
    const ey = (v) => encode(f32(v), c, d, height);

    for (let li = canvas.layers.length - 1; li >= 0; li--) {
      const shapes = canvas.layers[li].shapes;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const shape = shapes[i];
        const paint = shape.paint;
        let body, variable;
        if (shape.kind === 'rect') {
          const x1 = ex(shape.x1), y1 = ey(shape.y1), x2 = ex(shape.x2), y2 = ey(shape.y2);
          if (shape.isRounded()) {
            const rounding = fstr(shape.getRounding());
            body = '        roundRect.setRoundRect(' + decX(x1) + ', //x\n'
              + '                               ' + decY(y1) + ', //y\n'
              + '                               ' + decX(x2) + ' - ' + decX(x1) + ', //width\n'
              + '                               ' + decY(y2) + ' - ' + decY(y1) + ', //height\n'
              + '                               ' + rounding + 'f, ' + rounding + 'f); //rounding';
            variable = 'roundRect';
          } else {
            body = '            rect.setRect(' + decX(x1) + ', //x\n'
              + '                         ' + decY(y1) + ', //y\n'
              + '                         ' + decX(x2) + ' - ' + decX(x1) + ', //width\n'
              + '                         ' + decY(y2) + ' - ' + decY(y1) + '); //height';
            variable = 'rect';
          }
        } else if (shape.kind === 'ellipse') {
          const x1 = ex(shape.x1), y1 = ey(shape.y1), x2 = ex(shape.x2), y2 = ey(shape.y2);
          body = '        ellipse.setFrame(' + decX(x1) + ', //x\n'
            + '                         ' + decY(y1) + ', //y\n'
            + '                         ' + decX(x2) + ' - ' + decX(x1) + ', //width\n'
            + '                         ' + decY(y2) + ' - ' + decY(y1) + '); //height';
          variable = 'ellipse';
        } else {
          const cps = shape.controlPoints;
          const first = cps[0];
          let last = first;
          let buf = '        path.reset();\n';
          buf += '        path.moveTo(' + decX(ex(first.x)) + ', ' + decY(ey(first.y)) + ');\n';
          const seg = (from, to) => {
            if (from.isP2Sharp() && to.isP1Sharp()) {
              return '        path.lineTo(' + decX(ex(to.x)) + ', ' + decY(ey(to.y)) + ');\n';
            }
            const x1 = ex(from.x), y1 = ey(from.y), x2 = ex(to.x), y2 = ey(to.y);
            return '        path.curveTo(' + bezX(x1, from.x, from.cp2x) + ', '
              + bezY(y1, from.y, from.cp2y) + ', '
              + bezX(x2, to.x, to.cp1x) + ', '
              + bezY(y2, to.y, to.cp1y) + ', '
              + decX(x2) + ', ' + decY(y2) + ');\n';
          };
          for (let j = 1; j < cps.length; j++) { buf += seg(last, cps[j]); last = cps[j]; }
          buf += seg(last, first);
          buf += '        path.closePath();';
          body = buf;
          variable = 'path';
        }

        let methodName = this.methods.get(body);
        if (methodName === undefined) {
          let returnType;
          if (variable === 'rect') { methodName = 'decodeRect' + this.rectCounter++; returnType = 'Rectangle2D'; }
          else if (variable === 'roundRect') { methodName = 'decodeRoundRect' + this.roundRectCounter++; returnType = 'RoundRectangle2D'; }
          else if (variable === 'ellipse') { methodName = 'decodeEllipse' + this.ellipseCounter++; returnType = 'Ellipse2D'; }
          else { methodName = 'decodePath' + this.pathCounter++; returnType = 'Path2D'; }
          this.methods.set(body, methodName);
          this.shapesCode += '    private ' + returnType + ' ' + methodName + '() {\n' + body + '\n'
            + '        return ' + variable + ';\n' + '    }\n\n';
        }
        this.paintingCode += '        ' + variable + ' = ' + methodName + '();\n';
        if (paint instanceof Matte) {
          this.paintingCode += '        g.setPaint(' + this.encodeMatte(paint) + ');\n';
        } else if (paint && paint.kind === 'gradient') {
          this.paintingCode += '        g.setPaint(' + this.encodeGradient(shape, paint) + '(' + variable + '));\n';
        } else if (paint && paint.kind === 'radial') {
          this.paintingCode += '        g.setPaint(' + this.encodeRadial(shape, paint) + '(' + variable + '));\n';
        }
        this.paintingCode += '        g.fill(' + variable + ');\n';
      }
    }
    this.paintingCode += '\n    }\n\n';
    if (this.componentColors.length > 0) {
      this.componentColorsMap.set(stateType, this.componentColors);
      this.componentColors = null;
    }
  }

  encodeMatte(m) {
    const decl = m.getDeclaration();
    let v = this.colors.get(decl);
    if (v === undefined) {
      v = 'color' + this.colorCounter++;
      this.colors.set(decl, v);
      this.colorCode += `    private Color ${v} = ${decl};\n`;
    }
    if (m.componentPropertyName !== null) {
      const cc = m.createComponentColor(v);
      let index = this.componentColors.findIndex((x) => ccEquals(x, cc));
      if (index === -1) { index = this.componentColors.length; this.componentColors.push(cc); }
      return '(Color)componentColors[' + index + ']';
    }
    return v;
  }

  gradientMethod(body, prefix, counter) {
    let name = this.methods.get(body);
    if (name === undefined) {
      name = prefix + this[counter]++;
      this.gradientsCode += '    private Paint ' + name + '(Shape s) {\n'
        + '        Rectangle2D bounds = s.getBounds2D();\n'
        + '        float x = (float)bounds.getX();\n'
        + '        float y = (float)bounds.getY();\n'
        + '        float w = (float)bounds.getWidth();\n'
        + '        float h = (float)bounds.getHeight();\n'
        + body + '\n    }\n\n';
      this.methods.set(body, name);
    }
    return name;
  }

  encodeGradient(ps, g) {
    const pp = ps.paintPoints;
    const body = '        return decodeGradient((' + fstr(pp.x1) + 'f * w) + x, (' + fstr(pp.y1) + 'f * h) + y, ('
      + fstr(pp.x2) + 'f * w) + x, (' + fstr(pp.y2) + 'f * h) + y,\n'
      + this.encodeGradientColorsAndFractions(g) + ');';
    return this.gradientMethod(body, 'decodeGradient', 'gradientCounter');
  }

  encodeRadial(ps, g) {
    const pp = ps.paintPoints;
    const cx = f32(pp.x1), cy = f32(pp.y1), x2 = f32(pp.x2), y2 = f32(pp.y2);
    const dx = cx - x2, dy = cy - y2;
    const radius = f32(Math.sqrt(dx * dx + dy * dy));
    const body = '        return decodeRadialGradient((' + fstr(cx) + 'f * w) + x, (' + fstr(cy) + 'f * h) + y, '
      + fstr(radius) + 'f,\n' + this.encodeGradientColorsAndFractions(g) + ');';
    return this.gradientMethod(body, 'decodeRadial', 'radialCounter');
  }

  encodeGradientColorsAndFractions(g) {
    const stops = g.stops;
    let fractions = new Array(Math.max(stops.length * 2 - 1, 0)).fill(0);
    let colors = new Array(fractions.length).fill(null);
    let index = 0;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      colors[index] = this.encodeMatte(s.matte);
      fractions[index] = s.position;
      if (index < fractions.length - 1) {
        const f1 = s.position;
        const f2 = stops[i + 1].position;
        index++;
        fractions[index] = f32(f1 + f32(f32(f2 - f1) * s.midpoint));
        colors[index] = 'decodeColor(' + colors[index - 1] + ',' + this.encodeMatte(stops[i + 1].matte) + ',0.5f)';
      }
      index++;
    }
    for (let i = 1; i < fractions.length; i++) {
      if (fractions[i] <= fractions[i - 1]) fractions[i] = f32(fractions[i - 1] + f32(0.000001));
    }
    const oob = fractions.findIndex((f) => f > 1);
    if (oob >= 0) { fractions = fractions.slice(0, oob); colors = colors.slice(0, oob); }
    return '                new float[] { ' + fractions.map((f) => fstr(f) + 'f').join(',')
      + ' },\n                new Color[] { ' + colors.map(S).join(',\n                            ') + '}';
  }
}

function writePainter(gen, region, painterName) {
  const pg = new PainterGenerator(region);
  process.stdout.write('Generating source file: ' + painterName + '.java' + LNSEP);
  const vars = gen.getVariables();
  vars.put('PAINTER_NAME', painterName);
  vars.put('STATIC_DECL', pg.stateTypeCode);
  vars.put('COLORS_DECL', pg.colorCode);
  vars.put('DO_PAINT_SWITCH_BODY', pg.switchCode);
  vars.put('PAINTING_DECL', pg.paintingCode);
  vars.put('GET_EXTENDED_CACHE_KEYS', pg.getExtendedCacheKeysCode);
  vars.put('SHAPES_DECL', pg.shapesCode);
  vars.put('GRADIENTS_DECL', pg.gradientsCode);
  gen.writeSrcFile('PainterImpl', vars, painterName);
}

// ---- Generator

class Generator {
  constructor(buildDir, packagePrefix, lafName, model, templateDir) {
    this.variables = new JHashMap();
    this.variables.put('PACKAGE', packagePrefix);
    this.variables.put('LAF_NAME', lafName);
    this.buildPackageRoot = path.join(buildDir, packagePrefix.replace(/\./g, '/'));
    fs.mkdirSync(this.buildPackageRoot, { recursive: true });
    this.packageNamePrefix = packagePrefix;
    this.lafName = lafName;
    this.model = model;
    this.templateDir = templateDir;
  }
  getVariables() { return new JHashMap(this.variables); }
  writeSrcFile(templateName, vars, outputName) {
    const file = path.join(this.templateDir, templateName + '.template');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      // getResourceAsStream returned null
      throw new Error('java.lang.NullPointerException: no template ' + file);
    }
    const entries = vars.entries();
    let out = '';
    if (text !== '') {
      const lines = text.split(/\r\n|\r|\n/);
      if (lines[lines.length - 1] === '') lines.pop();
      for (let line of lines) {
        for (const [k, v] of entries) line = line.split('${' + k + '}').join(S(v));
        out += line + LNSEP;
      }
    }
    fs.writeFileSync(path.join(this.buildPackageRoot, outputName + '.java'), out, 'utf8');
  }
  generate() {
    const out = { sb: '', style: '' };
    this.model.write(this, out, this.packageNamePrefix);
    const vars = this.getVariables();
    vars.put('UI_DEFAULT_INIT', out.sb);
    vars.put('STYLE_INIT', out.style);
    this.writeSrcFile('Defaults', vars, this.lafName + 'Defaults');
  }
}

const USAGE = 'Usage: generator [-options]\n'
  + '    -full <true|false>     True if we should build the whole LAF or false for building just states and painters.\n'
  + '    -skinFile <value>      Path to the skin.laf file for the LAF to be generated from.\n'
  + '    -buildDir <value>      The directory beneath which the build-controlled artifacts (such as the Painters) should\n'
  + '                           be placed. This is the root directory beneath which the necessary packages and source\n'
  + '                           files will be created.\n'
  + '    -resourcesDir <value>  The resources directory containing templates and images.\n'
  + '    -packagePrefix <value> The package name associated with this synth look and feel. For example,\n'
  + '                           "org.mypackage.mylaf"\n'
  + '    -lafName <value>       The name of the laf, such as "MyLAF".\n';

function main(args) {
  if (args.length === 0 || args.length % 2 !== 0) {
    process.stdout.write(USAGE + LNSEP);
    return 0;
  }
  let full = false;
  let skinFile = process.cwd(), buildDir = process.cwd(), resourcesDir = process.cwd();
  let packagePrefix = 'org.mypackage.mylaf', lafName = 'MyLAF';
  for (let i = 0; i < args.length; i += 2) {
    const key = javaTrim(args[i]).toLowerCase();
    const value = javaTrim(args[i + 1]);
    if (key === '-full') full = value.toLowerCase() === 'true';
    else if (key === '-skinfile') skinFile = value;
    else if (key === '-builddir') buildDir = value;
    else if (key === '-resourcesdir') resourcesDir = value;
    else if (key === '-packageprefix') packagePrefix = value;
    else if (key === '-lafname') lafName = value;
  }
  const p = (s) => process.stdout.write(s + LNSEP);
  p('### GENERATING LAF CODE ################################');
  p('   full          :' + full);
  p('   skinFile      :' + path.resolve(skinFile));
  p('   buildDir      :' + path.resolve(buildDir));
  p('   resourcesDir  :' + path.resolve(resourcesDir));
  p('   packagePrefix :' + packagePrefix);
  p('   lafName       :' + lafName);
  if (full) throw new Error('generatenimbus: -full true needs the LookAndFeel templates, which the build does not use');

  const model = new SynthModel(new Reader(xmlEvents(fs.readFileSync(skinFile, 'utf8'))));
  const gen = new Generator(buildDir, packagePrefix, lafName, model,
    process.env.BOOTJDK_NIMBUS_TEMPLATES || path.dirname(path.resolve(skinFile)));
  model.initStyles();
  gen.generate();
  return 0;
}

module.exports = { main };
