'use strict';

// JSON-compatible object graph codec used by portable JVM save states. Java
// heaps contain shared references, cycles, Maps, BigInts and arrays with JVM
// metadata, none of which survive JSON.stringify directly.

const OMITTED_HOST_KEYS = new Set([
  '_awtComponent', '_awtGraphics', '_canvasElement', 'audioOutput', 'fileHandle', 'writer',
]);
const REBUILT_KEYS = new Set(['_ast', '_classData', 'nativeThread', 'toString']);

function encodeGraph(root, options = {}) {
  const seen = new Map();
  const nodes = [];
  const omitted = [];
  const replacements = options.replacements || new Map();

  function encode(value, path = '$') {
    if (value && typeof value === 'object' && replacements.has(value)) {
      value = replacements.get(value);
    }
    if (value === undefined) return { $type: 'undefined' };
    if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { $type: 'number', value: String(value) };
    }
    if (typeof value === 'number' && Object.is(value, -0)) {
      return { $type: 'number', value: '-0' };
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' ||
      typeof value === 'boolean') return value;
    if (typeof value === 'function' || typeof value === 'symbol') {
      omitted.push({ path, reason: typeof value });
      return { $type: 'undefined' };
    }
    if (seen.has(value)) return { $ref: seen.get(value) };

    const id = nodes.length;
    seen.set(value, id);
    const node = { type: 'object', props: {} };
    nodes.push(node);

    if (Array.isArray(value)) {
      node.type = 'array';
      node.items = value.map((item, index) => encode(item, `${path}[${index}]`));
      encodeProperties(value, node.props, path, (key) => !/^\d+$/.test(key));
    } else if (value instanceof Map) {
      node.type = 'map';
      node.entries = [...value.entries()].map(([key, item], index) => [
        encode(key, `${path}.mapKey${index}`), encode(item, `${path}.mapValue${index}`),
      ]);
    } else if (value instanceof Set) {
      node.type = 'set';
      node.items = [...value].map((item, index) => encode(item, `${path}.set${index}`));
    } else if (value instanceof String) {
      node.type = 'stringObject';
      node.value = String(value);
      encodeProperties(value, node.props, path, (key) => !/^\d+$/.test(key));
    } else if (value instanceof Date) {
      node.type = 'date';
      node.value = value.toISOString();
    } else if (ArrayBuffer.isView(value)) {
      node.type = 'typedArray';
      node.ctor = value.constructor && value.constructor.name || 'Uint8Array';
      node.items = Array.from(value);
      encodeProperties(value, node.props, path, (key) => !/^\d+$/.test(key));
    } else {
      encodeProperties(value, node.props, path);
    }
    if (value.type === 'java/net/Socket' && value.socketId !== undefined) {
      omitted.push({ path: `${path}._nativeSocket`, reason: 'host resource' });
    }
    return { $ref: id };
  }

  function encodeProperties(value, target, path, filter = () => true) {
    for (const key of Object.keys(value)) {
      if (!filter(key)) continue;
      if (REBUILT_KEYS.has(key)) continue;
      if (OMITTED_HOST_KEYS.has(key)) {
        if (value[key] !== undefined && value[key] !== null) {
          omitted.push({ path: `${path}.${key}`, reason: 'host resource' });
        }
        target[key] = { $type: 'undefined' };
        continue;
      }
      const item = value[key];
      if (typeof item === 'function' || typeof item === 'symbol') {
        omitted.push({ path: `${path}.${key}`, reason: typeof item });
        continue;
      }
      target[key] = encode(item, `${path}.${key}`);
    }
  }

  return { root: encode(root), nodes, omitted };
}

function decodeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('Invalid JVM save-state graph');
  const values = graph.nodes.map((node) => allocate(node));

  function decode(value) {
    if (!value || typeof value !== 'object') return value;
    if (Object.prototype.hasOwnProperty.call(value, '$ref')) return values[value.$ref];
    if (value.$type === 'undefined') return undefined;
    if (value.$type === 'bigint') return BigInt(value.value);
    if (value.$type === 'number') {
      if (value.value === '-0') return -0;
      return Number(value.value);
    }
    throw new Error(`Invalid encoded JVM value: ${JSON.stringify(value)}`);
  }

  graph.nodes.forEach((node, index) => {
    const target = values[index];
    if (node.type === 'array' || node.type === 'typedArray') {
      node.items.forEach((item, itemIndex) => { target[itemIndex] = decode(item); });
    } else if (node.type === 'map') {
      node.entries.forEach(([key, value]) => target.set(decode(key), decode(value)));
    } else if (node.type === 'set') {
      node.items.forEach((item) => target.add(decode(item)));
    }
    if (node.props) {
      for (const [key, value] of Object.entries(node.props)) target[key] = decode(value);
    }
  });
  return decode(graph.root);
}

function allocate(node) {
  switch (node.type) {
    case 'array': return new Array(node.items.length);
    case 'map': return new Map();
    case 'set': return new Set();
    case 'stringObject': return new String(node.value); // eslint-disable-line no-new-wrappers
    case 'date': return new Date(node.value);
    case 'typedArray': {
      const constructors = typeof globalThis !== 'undefined' ? globalThis : {};
      const Constructor = constructors[node.ctor] || Uint8Array;
      try { return new Constructor(node.items.length); } catch (_error) { return new Uint8Array(node.items.length); }
    }
    case 'object': return {};
    default: throw new Error(`Unknown JVM save-state node type: ${node.type}`);
  }
}

module.exports = { encodeGraph, decodeGraph };
