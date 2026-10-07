'use strict';
// zlib's deflate at the default level (6), as java.util.zip.Deflater /
// DeflaterOutputStream produce it. Node's own zlib is Chromium's fork, whose
// match finder emits different (equally valid) streams; this follows
// deflate.c (deflate_slow) and trees.c so the bytes match the JDK's.

const MIN_MATCH = 3, MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const W_BITS = 15, W_SIZE = 1 << W_BITS, W_MASK = W_SIZE - 1;
const MAX_DIST = W_SIZE - MIN_LOOKAHEAD;
const HASH_BITS = 15, HASH_SIZE = 1 << HASH_BITS, HASH_MASK = HASH_SIZE - 1;
const HASH_SHIFT = Math.floor((HASH_BITS + MIN_MATCH - 1) / MIN_MATCH);
const LIT_BUFSIZE = 1 << (8 + 6);
const TOO_FAR = 4096;
// configuration_table[6]
const GOOD_LENGTH = 8, MAX_LAZY = 16, NICE_LENGTH = 128, MAX_CHAIN = 128;

const LENGTH_CODES = 29, LITERALS = 256, L_CODES = LITERALS + 1 + LENGTH_CODES;
const D_CODES = 30, BL_CODES = 19, HEAP_SIZE = 2 * L_CODES + 1;
const MAX_BITS = 15, MAX_BL_BITS = 7, END_BLOCK = 256;
const REP_3_6 = 16, REPZ_3_10 = 17, REPZ_11_138 = 18;

const extraLbits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const extraDbits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const extraBlbits = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const blOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function biReverse(code, len) {
  let res = 0;
  do { res |= code & 1; code >>>= 1; res <<= 1; } while (--len > 0);
  return res >>> 1;
}

// a tree: freq/code share storage in zlib, as do dad/len
function newTree(n) {
  return { freq: new Uint16Array(n), code: new Uint16Array(n), dad: new Uint16Array(n), len: new Uint16Array(n) };
}

function genCodes(tree, maxCode, blCount) {
  const nextCode = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let n = 0; n <= maxCode; n++) {
    const len = tree.len[n];
    if (len === 0) continue;
    tree.code[n] = biReverse(nextCode[len]++, len);
  }
}

// tr_static_init
const baseLength = new Int32Array(LENGTH_CODES), baseDist = new Int32Array(D_CODES);
const lengthCode = new Uint8Array(MAX_MATCH - MIN_MATCH + 1), distCode = new Uint8Array(512);
const staticLtree = newTree(L_CODES + 2), staticDtree = newTree(D_CODES);
{
  let length = 0, code;
  for (code = 0; code < LENGTH_CODES - 1; code++) {
    baseLength[code] = length;
    for (let n = 0; n < (1 << extraLbits[code]); n++) lengthCode[length++] = code;
  }
  lengthCode[length - 1] = code;
  let dist = 0;
  for (code = 0; code < 16; code++) {
    baseDist[code] = dist;
    for (let n = 0; n < (1 << extraDbits[code]); n++) distCode[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    baseDist[code] = dist << 7;
    for (let n = 0; n < (1 << (extraDbits[code] - 7)); n++) distCode[256 + dist++] = code;
  }
  const blCount = new Uint16Array(MAX_BITS + 1);
  let n = 0;
  while (n <= 143) { staticLtree.len[n++] = 8; blCount[8]++; }
  while (n <= 255) { staticLtree.len[n++] = 9; blCount[9]++; }
  while (n <= 279) { staticLtree.len[n++] = 7; blCount[7]++; }
  while (n <= 287) { staticLtree.len[n++] = 8; blCount[8]++; }
  genCodes(staticLtree, L_CODES + 1, blCount);
  for (n = 0; n < D_CODES; n++) { staticDtree.len[n] = 5; staticDtree.code[n] = biReverse(n, 5); }
}
const dCode = dist => dist < 256 ? distCode[dist] : distCode[256 + (dist >>> 7)];

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length;) {
    const end = Math.min(buf.length, i + 3800);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

class Deflater {
  constructor(input) {
    this.input = input; this.inPos = 0;
    this.out = []; this.cur = new Uint8Array(65536); this.curLen = 0;
    this.biBuf = 0; this.biValid = 0;
    this.window = new Uint8Array(2 * W_SIZE); this.windowSize = 2 * W_SIZE;
    this.highWater = 0;
    this.prev = new Uint16Array(W_SIZE); this.head = new Uint16Array(HASH_SIZE);
    this.insH = 0; this.strstart = 0; this.blockStart = 0; this.lookahead = 0; this.insert = 0;
    this.matchLength = MIN_MATCH - 1; this.prevLength = MIN_MATCH - 1;
    this.matchAvailable = 0; this.matchStart = 0; this.prevMatch = 0;
    this.ltree = newTree(HEAP_SIZE); this.dtree = newTree(2 * D_CODES + 1); this.bltree = newTree(2 * BL_CODES + 1);
    this.lDesc = { tree: this.ltree, stree: staticLtree, extra: extraLbits, base: LITERALS + 1, elems: L_CODES, maxLength: MAX_BITS, maxCode: 0 };
    this.dDesc = { tree: this.dtree, stree: staticDtree, extra: extraDbits, base: 0, elems: D_CODES, maxLength: MAX_BITS, maxCode: 0 };
    this.blDesc = { tree: this.bltree, stree: null, extra: extraBlbits, base: 0, elems: BL_CODES, maxLength: MAX_BL_BITS, maxCode: 0 };
    this.blCount = new Uint16Array(MAX_BITS + 1);
    this.heap = new Int32Array(2 * L_CODES + 1); this.heapLen = 0; this.heapMax = 0;
    this.depth = new Uint8Array(2 * L_CODES + 1);
    this.symDist = new Uint16Array(LIT_BUFSIZE); this.symLc = new Uint8Array(LIT_BUFSIZE); this.symNext = 0;
    this.optLen = 0; this.staticLen = 0;
    this.initBlock();
  }

  putByte(b) {
    if (this.curLen === this.cur.length) { this.out.push(this.cur); this.cur = new Uint8Array(65536); this.curLen = 0; }
    this.cur[this.curLen++] = b;
  }
  sendBits(value, length) {
    this.biBuf |= value << this.biValid;
    this.biValid += length;
    while (this.biValid >= 8) { this.putByte(this.biBuf & 0xff); this.biBuf >>>= 8; this.biValid -= 8; }
  }
  biWindup() {
    if (this.biValid > 0) this.putByte(this.biBuf & 0xff);
    this.biBuf = 0; this.biValid = 0;
  }
  sendCode(c, tree) { this.sendBits(tree.code[c], tree.len[c]); }

  initBlock() {
    this.ltree.freq.fill(0, 0, L_CODES); this.dtree.freq.fill(0, 0, D_CODES); this.bltree.freq.fill(0, 0, BL_CODES);
    this.ltree.freq[END_BLOCK] = 1;
    this.optLen = this.staticLen = 0;
    this.symNext = 0;
  }

  smaller(tree, n, m) {
    return tree.freq[n] < tree.freq[m] || (tree.freq[n] === tree.freq[m] && this.depth[n] <= this.depth[m]);
  }
  pqdownheap(tree, k) {
    const heap = this.heap, v = heap[k];
    let j = k << 1;
    while (j <= this.heapLen) {
      if (j < this.heapLen && this.smaller(tree, heap[j + 1], heap[j])) j++;
      if (this.smaller(tree, v, heap[j])) break;
      heap[k] = heap[j]; k = j; j <<= 1;
    }
    heap[k] = v;
  }

  genBitlen(desc) {
    const tree = desc.tree, stree = desc.stree, maxCode = desc.maxCode, heap = this.heap;
    const blCount = this.blCount;
    let overflow = 0, h;
    blCount.fill(0);
    tree.len[heap[this.heapMax]] = 0;
    for (h = this.heapMax + 1; h < HEAP_SIZE; h++) {
      const n = heap[h];
      let bits = tree.len[tree.dad[n]] + 1;
      if (bits > desc.maxLength) { bits = desc.maxLength; overflow++; }
      tree.len[n] = bits;
      if (n > maxCode) continue;
      blCount[bits]++;
      const xbits = n >= desc.base ? desc.extra[n - desc.base] : 0;
      const f = tree.freq[n];
      this.optLen += f * (bits + xbits);
      if (stree) this.staticLen += f * (stree.len[n] + xbits);
    }
    if (overflow === 0) return;
    do {
      let bits = desc.maxLength - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[desc.maxLength]--;
      overflow -= 2;
    } while (overflow > 0);
    for (let bits = desc.maxLength; bits !== 0; bits--) {
      let n = blCount[bits];
      while (n !== 0) {
        const m = heap[--h];
        if (m > maxCode) continue;
        if (tree.len[m] !== bits) {
          this.optLen += (bits - tree.len[m]) * tree.freq[m];
          tree.len[m] = bits;
        }
        n--;
      }
    }
  }

  buildTree(desc) {
    const tree = desc.tree, stree = desc.stree, elems = desc.elems, heap = this.heap;
    let maxCode = -1, n, m, node;
    this.heapLen = 0; this.heapMax = HEAP_SIZE;
    for (n = 0; n < elems; n++) {
      if (tree.freq[n] !== 0) { heap[++this.heapLen] = maxCode = n; this.depth[n] = 0; }
      else tree.len[n] = 0;
    }
    while (this.heapLen < 2) {
      node = heap[++this.heapLen] = maxCode < 2 ? ++maxCode : 0;
      tree.freq[node] = 1;
      this.depth[node] = 0;
      this.optLen--;
      if (stree) this.staticLen -= stree.len[node];
    }
    desc.maxCode = maxCode;
    for (n = this.heapLen >> 1; n >= 1; n--) this.pqdownheap(tree, n);
    node = elems;
    do {
      n = heap[1];
      heap[1] = heap[this.heapLen--];
      this.pqdownheap(tree, 1);
      m = heap[1];
      heap[--this.heapMax] = n;
      heap[--this.heapMax] = m;
      tree.freq[node] = tree.freq[n] + tree.freq[m];
      this.depth[node] = (Math.max(this.depth[n], this.depth[m]) + 1) & 0xff;
      tree.dad[n] = tree.dad[m] = node;
      heap[1] = node++;
      this.pqdownheap(tree, 1);
    } while (this.heapLen >= 2);
    heap[--this.heapMax] = heap[1];
    this.genBitlen(desc);
    genCodes(tree, maxCode, this.blCount);
  }

  scanTree(tree, maxCode) {
    const bl = this.bltree;
    let prevlen = -1, curlen, nextlen = tree.len[0], count = 0, maxCount = 7, minCount = 4;
    if (nextlen === 0) { maxCount = 138; minCount = 3; }
    tree.len[maxCode + 1] = 0xffff; // guard
    for (let n = 0; n <= maxCode; n++) {
      curlen = nextlen; nextlen = tree.len[n + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      else if (count < minCount) bl.freq[curlen] += count;
      else if (curlen !== 0) {
        if (curlen !== prevlen) bl.freq[curlen]++;
        bl.freq[REP_3_6]++;
      } else if (count <= 10) bl.freq[REPZ_3_10]++;
      else bl.freq[REPZ_11_138]++;
      count = 0; prevlen = curlen;
      if (nextlen === 0) { maxCount = 138; minCount = 3; }
      else if (curlen === nextlen) { maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  }

  sendTree(tree, maxCode) {
    const bl = this.bltree;
    let prevlen = -1, curlen, nextlen = tree.len[0], count = 0, maxCount = 7, minCount = 4;
    if (nextlen === 0) { maxCount = 138; minCount = 3; }
    for (let n = 0; n <= maxCode; n++) {
      curlen = nextlen; nextlen = tree.len[n + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      else if (count < minCount) {
        do { this.sendCode(curlen, bl); } while (--count !== 0);
      } else if (curlen !== 0) {
        if (curlen !== prevlen) { this.sendCode(curlen, bl); count--; }
        this.sendCode(REP_3_6, bl); this.sendBits(count - 3, 2);
      } else if (count <= 10) {
        this.sendCode(REPZ_3_10, bl); this.sendBits(count - 3, 3);
      } else {
        this.sendCode(REPZ_11_138, bl); this.sendBits(count - 11, 7);
      }
      count = 0; prevlen = curlen;
      if (nextlen === 0) { maxCount = 138; minCount = 3; }
      else if (curlen === nextlen) { maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  }

  buildBlTree() {
    this.scanTree(this.ltree, this.lDesc.maxCode);
    this.scanTree(this.dtree, this.dDesc.maxCode);
    this.buildTree(this.blDesc);
    let maxBlindex;
    for (maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) {
      if (this.bltree.len[blOrder[maxBlindex]] !== 0) break;
    }
    this.optLen += 3 * (maxBlindex + 1) + 5 + 5 + 4;
    return maxBlindex;
  }

  sendAllTrees(lcodes, dcodes, blcodes) {
    this.sendBits(lcodes - 257, 5);
    this.sendBits(dcodes - 1, 5);
    this.sendBits(blcodes - 4, 4);
    for (let rank = 0; rank < blcodes; rank++) this.sendBits(this.bltree.len[blOrder[rank]], 3);
    this.sendTree(this.ltree, lcodes - 1);
    this.sendTree(this.dtree, dcodes - 1);
  }

  compressBlock(ltree, dtree) {
    for (let i = 0; i < this.symNext; i++) {
      let dist = this.symDist[i], lc = this.symLc[i];
      if (dist === 0) this.sendCode(lc, ltree);
      else {
        let code = lengthCode[lc];
        this.sendCode(code + LITERALS + 1, ltree);
        let extra = extraLbits[code];
        if (extra !== 0) { lc -= baseLength[code]; this.sendBits(lc, extra); }
        dist--;
        code = dCode(dist);
        this.sendCode(code, dtree);
        extra = extraDbits[code];
        if (extra !== 0) { dist -= baseDist[code]; this.sendBits(dist, extra); }
      }
    }
    this.sendCode(END_BLOCK, ltree);
  }

  storedBlock(start, storedLen, last) {
    this.sendBits(last, 3); // STORED_BLOCK << 1
    this.biWindup();
    this.putByte(storedLen & 0xff); this.putByte((storedLen >>> 8) & 0xff);
    this.putByte(~storedLen & 0xff); this.putByte((~storedLen >>> 8) & 0xff);
    for (let i = 0; i < storedLen; i++) this.putByte(this.window[start + i]);
  }

  flushBlock(last) {
    const start = this.blockStart, storedLen = this.strstart - this.blockStart;
    this.buildTree(this.lDesc);
    this.buildTree(this.dDesc);
    const maxBlindex = this.buildBlTree();
    let optLenb = (this.optLen + 3 + 7) >>> 3;
    const staticLenb = (this.staticLen + 3 + 7) >>> 3;
    if (staticLenb <= optLenb) optLenb = staticLenb;
    if (storedLen + 4 <= optLenb && start >= 0) {
      this.storedBlock(start, storedLen, last);
    } else if (staticLenb === optLenb) {
      this.sendBits((1 << 1) + last, 3);
      this.compressBlock(staticLtree, staticDtree);
    } else {
      this.sendBits((2 << 1) + last, 3);
      this.sendAllTrees(this.lDesc.maxCode + 1, this.dDesc.maxCode + 1, maxBlindex + 1);
      this.compressBlock(this.ltree, this.dtree);
    }
    this.initBlock();
    if (last) this.biWindup();
    this.blockStart = this.strstart;
  }

  tally(dist, lc) {
    this.symDist[this.symNext] = dist;
    this.symLc[this.symNext++] = lc;
    if (dist === 0) this.ltree.freq[lc]++;
    else {
      dist--;
      this.ltree.freq[lengthCode[lc] + LITERALS + 1]++;
      this.dtree.freq[dCode(dist)]++;
    }
    return this.symNext === LIT_BUFSIZE - 1;
  }

  slideHash() {
    for (let n = 0; n < HASH_SIZE; n++) { const m = this.head[n]; this.head[n] = m >= W_SIZE ? m - W_SIZE : 0; }
    for (let n = 0; n < W_SIZE; n++) { const m = this.prev[n]; this.prev[n] = m >= W_SIZE ? m - W_SIZE : 0; }
  }

  fillWindow() {
    const win = this.window;
    do {
      let more = this.windowSize - this.lookahead - this.strstart;
      if (this.strstart >= W_SIZE + MAX_DIST) {
        win.copyWithin(0, W_SIZE, W_SIZE + W_SIZE - more);
        this.matchStart -= W_SIZE;
        this.strstart -= W_SIZE;
        this.blockStart -= W_SIZE;
        if (this.insert > this.strstart) this.insert = this.strstart;
        this.slideHash();
        more += W_SIZE;
      }
      const availIn = this.input.length - this.inPos;
      if (availIn === 0) break;
      const n = Math.min(availIn, more);
      win.set(this.input.subarray(this.inPos, this.inPos + n), this.strstart + this.lookahead);
      this.inPos += n;
      this.lookahead += n;
      if (this.lookahead + this.insert >= MIN_MATCH) {
        let str = this.strstart - this.insert;
        this.insH = win[str];
        this.insH = ((this.insH << HASH_SHIFT) ^ win[str + 1]) & HASH_MASK;
        while (this.insert) {
          this.insH = ((this.insH << HASH_SHIFT) ^ win[str + MIN_MATCH - 1]) & HASH_MASK;
          this.prev[str & W_MASK] = this.head[this.insH];
          this.head[this.insH] = str;
          str++;
          this.insert--;
          if (this.lookahead + this.insert < MIN_MATCH) break;
        }
      }
    } while (this.lookahead < MIN_LOOKAHEAD && this.inPos < this.input.length);
    // zero the bytes after the current data (WIN_INIT = MAX_MATCH)
    if (this.highWater < this.windowSize) {
      const curr = this.strstart + this.lookahead;
      if (this.highWater < curr) {
        const init = Math.min(this.windowSize - curr, MAX_MATCH);
        win.fill(0, curr, curr + init);
        this.highWater = curr + init;
      } else if (this.highWater < curr + MAX_MATCH) {
        const init = Math.min(curr + MAX_MATCH - this.highWater, this.windowSize - this.highWater);
        win.fill(0, this.highWater, this.highWater + init);
        this.highWater += init;
      }
    }
  }

  insertString(str) {
    this.insH = ((this.insH << HASH_SHIFT) ^ this.window[str + MIN_MATCH - 1]) & HASH_MASK;
    const h = this.prev[str & W_MASK] = this.head[this.insH];
    this.head[this.insH] = str;
    return h;
  }

  longestMatch(curMatch) {
    const win = this.window;
    let chainLength = MAX_CHAIN, scan = this.strstart, bestLen = this.prevLength, niceMatch = NICE_LENGTH;
    const limit = this.strstart > MAX_DIST ? this.strstart - MAX_DIST : 0;
    const strend = this.strstart + MAX_MATCH;
    let scanEnd1 = win[scan + bestLen - 1], scanEnd = win[scan + bestLen];
    if (this.prevLength >= GOOD_LENGTH) chainLength >>= 2;
    if (niceMatch > this.lookahead) niceMatch = this.lookahead;
    do {
      let match = curMatch;
      if (win[match + bestLen] !== scanEnd || win[match + bestLen - 1] !== scanEnd1 ||
          win[match] !== win[scan] || win[++match] !== win[scan + 1]) continue;
      scan += 2; match++;
      do {} while (win[++scan] === win[++match] && win[++scan] === win[++match] &&
        win[++scan] === win[++match] && win[++scan] === win[++match] &&
        win[++scan] === win[++match] && win[++scan] === win[++match] &&
        win[++scan] === win[++match] && win[++scan] === win[++match] && scan < strend);
      const len = MAX_MATCH - (strend - scan);
      scan = strend - MAX_MATCH;
      if (len > bestLen) {
        this.matchStart = curMatch;
        bestLen = len;
        if (len >= niceMatch) break;
        scanEnd1 = win[scan + bestLen - 1];
        scanEnd = win[scan + bestLen];
      }
    } while ((curMatch = this.prev[curMatch & W_MASK]) > limit && --chainLength !== 0);
    return bestLen <= this.lookahead ? bestLen : this.lookahead;
  }

  // deflate_slow with Z_FINISH
  run() {
    for (;;) {
      if (this.lookahead < MIN_LOOKAHEAD) {
        this.fillWindow();
        if (this.lookahead === 0) break;
      }
      let hashHead = 0;
      if (this.lookahead >= MIN_MATCH) hashHead = this.insertString(this.strstart);
      this.prevLength = this.matchLength; this.prevMatch = this.matchStart;
      this.matchLength = MIN_MATCH - 1;
      if (hashHead !== 0 && this.prevLength < MAX_LAZY && this.strstart - hashHead <= MAX_DIST) {
        this.matchLength = this.longestMatch(hashHead);
        if (this.matchLength <= 5 && this.matchLength === MIN_MATCH && this.strstart - this.matchStart > TOO_FAR) {
          this.matchLength = MIN_MATCH - 1;
        }
      }
      if (this.prevLength >= MIN_MATCH && this.matchLength <= this.prevLength) {
        const maxInsert = this.strstart + this.lookahead - MIN_MATCH;
        const bflush = this.tally(this.strstart - 1 - this.prevMatch, this.prevLength - MIN_MATCH);
        this.lookahead -= this.prevLength - 1;
        this.prevLength -= 2;
        do {
          if (++this.strstart <= maxInsert) this.insertString(this.strstart);
        } while (--this.prevLength !== 0);
        this.matchAvailable = 0;
        this.matchLength = MIN_MATCH - 1;
        this.strstart++;
        if (bflush) this.flushBlock(0);
      } else if (this.matchAvailable) {
        if (this.tally(0, this.window[this.strstart - 1])) this.flushBlock(0);
        this.strstart++;
        this.lookahead--;
      } else {
        this.matchAvailable = 1;
        this.strstart++;
        this.lookahead--;
      }
    }
    if (this.matchAvailable) {
      this.tally(0, this.window[this.strstart - 1]);
      this.matchAvailable = 0;
    }
    this.flushBlock(1);
  }
}

// zlib-wrapped stream (Deflater default: level 6, nowrap false)
function deflate(input) {
  const d = new Deflater(input);
  d.putByte(0x78); d.putByte(0x9c);
  d.run();
  const a = adler32(input);
  d.putByte(a >>> 24); d.putByte((a >>> 16) & 0xff); d.putByte((a >>> 8) & 0xff); d.putByte(a & 0xff);
  d.out.push(d.cur.subarray(0, d.curLen));
  return Buffer.concat(d.out);
}

module.exports = { deflate };
