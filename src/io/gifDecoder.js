'use strict';

const zlib = require('zlib');
const jpeg = require('jpeg-js');

function readSubBlocks(bytes, state) {
  const chunks = [];
  let length = 0;
  while (state.pos < bytes.length) {
    const size = bytes[state.pos++];
    if (size === 0) break;
    const chunk = bytes.subarray(state.pos, state.pos + size);
    state.pos += size;
    chunks.push(chunk);
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function readPalette(bytes, state, size) {
  const palette = new Array(size);
  for (let i = 0; i < size; i++) {
    palette[i] = (bytes[state.pos++] << 16) | (bytes[state.pos++] << 8) | bytes[state.pos++];
  }
  return palette;
}

function decodeLzw(data, minimumCodeSize, pixelCount) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = [];
  let bit = 0;

  const reset = () => {
    dictionary = new Array(4096);
    for (let i = 0; i < clearCode; i++) dictionary[i] = [i];
    codeSize = minimumCodeSize + 1;
    nextCode = endCode + 1;
  };
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) {
      if (bit >> 3 >= data.length) return null;
      code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    }
    return code;
  };

  reset();
  const output = [];
  let previous = null;
  while (output.length < pixelCount) {
    const code = readCode();
    if (code === null || code === endCode) break;
    if (code === clearCode) {
      reset();
      previous = null;
      continue;
    }
    let entry = dictionary[code];
    if (!entry && code === nextCode && previous) entry = previous.concat(previous[0]);
    if (!entry) throw new Error(`Invalid GIF LZW code ${code}`);
    output.push(...entry);
    if (previous && nextCode < 4096) {
      dictionary[nextCode++] = previous.concat(entry[0]);
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
  return output.slice(0, pixelCount);
}

function decodeGif(input) {
  const bytes = Uint8Array.from(input, (value) => value & 0xff);
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('Unsupported image format');
  const state = { pos: 6 };
  const u16 = () => bytes[state.pos++] | (bytes[state.pos++] << 8);
  const width = u16();
  const height = u16();
  const packed = bytes[state.pos++];
  state.pos += 2; // background index and pixel aspect ratio
  let palette = packed & 0x80 ? readPalette(bytes, state, 1 << ((packed & 7) + 1)) : null;
  let transparentIndex = -1;
  const pixels = new Array(width * height).fill(0);

  while (state.pos < bytes.length) {
    const marker = bytes[state.pos++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[state.pos++];
      if (label === 0xf9) {
        const size = bytes[state.pos++];
        const gcePacked = bytes[state.pos];
        transparentIndex = gcePacked & 1 ? bytes[state.pos + 3] : -1;
        state.pos += size;
        state.pos++; // terminator
      } else {
        readSubBlocks(bytes, state);
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`Invalid GIF block 0x${marker.toString(16)}`);
    const left = u16();
    const top = u16();
    const imageWidth = u16();
    const imageHeight = u16();
    const imagePacked = bytes[state.pos++];
    const localPalette = imagePacked & 0x80
      ? readPalette(bytes, state, 1 << ((imagePacked & 7) + 1))
      : palette;
    if (!localPalette) throw new Error('GIF has no color table');
    const minimumCodeSize = bytes[state.pos++];
    const indices = decodeLzw(readSubBlocks(bytes, state), minimumCodeSize, imageWidth * imageHeight);
    const rows = [];
    if (imagePacked & 0x40) {
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let y = start; y < imageHeight; y += step) rows.push(y);
      }
    } else {
      for (let y = 0; y < imageHeight; y++) rows.push(y);
    }
    let source = 0;
    for (const y of rows) {
      for (let x = 0; x < imageWidth; x++, source++) {
        const index = indices[source];
        if (index === transparentIndex) continue;
        const rgb = localPalette[index] || 0;
        const target = (top + y) * width + left + x;
        if (target >= 0 && target < pixels.length) pixels[target] = (0xff000000 | rgb) | 0;
      }
    }
    return { width, height, pixels };
  }
  throw new Error('GIF contains no image');
}

function decodePng(input) {
  const bytes = Uint8Array.from(input, (value) => value & 0xff);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('Invalid PNG signature');
  const readU32 = (offset) => (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos + 12 <= bytes.length) {
    const length = readU32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = readU32(pos - length - 4);
      height = readU32(pos - length);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i + 2 < data.length; i += 3) palette.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    } else if (type === 'tRNS') {
      transparency = Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8) throw new Error(`Unsupported PNG dimensions/bit depth ${width}x${height}@${bitDepth}`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  const packed = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = new Uint8Array(height * stride);
  let source = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < height; y++) {
    const filter = packed[source++];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[y * stride + x - channels] : 0;
      const above = y > 0 ? raw[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? raw[(y - 1) * stride + x - channels] : 0;
      let value = packed[source++];
      if (filter === 1) value += left;
      else if (filter === 2) value += above;
      else if (filter === 3) value += Math.floor((left + above) / 2);
      else if (filter === 4) value += paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      raw[y * stride + x] = value & 0xff;
    }
  }
  const pixels = new Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * channels;
    let r, g, b, a = 255;
    if (colorType === 0 || colorType === 4) {
      r = g = b = raw[offset];
      if (colorType === 4) a = raw[offset + 1];
    } else if (colorType === 2 || colorType === 6) {
      r = raw[offset]; g = raw[offset + 1]; b = raw[offset + 2];
      if (colorType === 6) a = raw[offset + 3];
    } else {
      const index = raw[offset];
      const rgb = palette && palette[index] || 0;
      r = rgb >> 16; g = rgb >> 8 & 0xff; b = rgb & 0xff;
      if (transparency && transparency[index] !== undefined) a = transparency[index];
    }
    pixels[i] = a === 0 ? 0 : ((a << 24) | (r << 16) | (g << 8) | b) | 0;
  }
  return { width, height, pixels };
}

function decodeImage(input) {
  const bytes = Uint8Array.from(input, (value) => value & 0xff);
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return decodeGif(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return decodePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    const pixels = new Array(decoded.width * decoded.height);
    for (let i = 0; i < pixels.length; i++) {
      const offset = i * 4;
      const r = decoded.data[offset];
      const g = decoded.data[offset + 1];
      const b = decoded.data[offset + 2];
      const a = decoded.data[offset + 3];
      pixels[i] = a === 0 ? 0 : ((a << 24) | (r << 16) | (g << 8) | b) | 0;
    }
    return { width: decoded.width, height: decoded.height, pixels };
  }
  const head = Buffer.from(bytes.subarray(0, 16)).toString('hex');
  throw new Error(`Unsupported image format length=${bytes.length} head=${head}`);
}

module.exports = { decodeGif, decodePng, decodeImage };
