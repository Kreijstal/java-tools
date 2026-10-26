'use strict';

// Address-ordered AVL tree of proven-dead storage. Each subtree records the
// largest usable extent for each supported alignment, so a request does not
// scan the free lists. Adjacent extents coalesce; taking a subrange preserves
// both remainders. Live allocations never enter this tree or move in memory.
const alignments = [1, 2, 4, 8];
const aligned = (base, align) => Math.ceil(base / align) * align;
const height = node => node ? node.height : 0;
function update(node) {
  node.height = 1 + Math.max(height(node.left), height(node.right));
  for (let i = 0; i < alignments.length; i++) {
    node.max[i] = Math.max(node.base + node.bytes - aligned(node.base, alignments[i]),
      node.left?.max[i] || 0, node.right?.max[i] || 0);
  }
  return node;
}
function rotateLeft(node) {
  const root = node.right;
  node.right = root.left;
  root.left = update(node);
  return update(root);
}
function rotateRight(node) {
  const root = node.left;
  node.left = root.right;
  root.right = update(node);
  return update(root);
}
function balance(node) {
  update(node);
  if (height(node.left) - height(node.right) > 1) {
    if (height(node.left.left) < height(node.left.right)) node.left = rotateLeft(node.left);
    return rotateRight(node);
  }
  if (height(node.right) - height(node.left) > 1) {
    if (height(node.right.right) < height(node.right.left)) node.right = rotateRight(node.right);
    return rotateLeft(node);
  }
  return node;
}
function insert(node, extent) {
  if (!node) return extent;
  if (extent.base < node.base) node.left = insert(node.left, extent);
  else node.right = insert(node.right, extent);
  return balance(node);
}
function remove(node, base) {
  if (base < node.base) node.left = remove(node.left, base);
  else if (base > node.base) node.right = remove(node.right, base);
  else {
    if (!node.left) return node.right;
    if (!node.right) return node.left;
    let successor = node.right;
    while (successor.left) successor = successor.left;
    node.base = successor.base;
    node.bytes = successor.bytes;
    node.right = remove(node.right, successor.base);
  }
  return balance(node);
}

class FreeExtents {
  constructor() { this.root = null; this.bytes = 0; }

  release(base, bytes) {
    if (!Number.isSafeInteger(base) || base <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0)
      throw new RangeError('Invalid free extent');
    let node = this.root, previous = null, next = null;
    while (node) {
      if (node.base < base) { previous = node; node = node.right; }
      else { next = node; node = node.left; }
    }
    if ((previous && previous.base + previous.bytes > base) || (next && base + bytes > next.base))
      throw new RangeError('Overlapping free extents');
    this.bytes += bytes;
    // Removal may replace a tree node's contents, so save neighbour values
    // before changing the tree.
    const previousBase = previous?.base, previousBytes = previous?.bytes;
    const nextBase = next?.base, nextBytes = next?.bytes;
    if (previous && previousBase + previousBytes === base) {
      this.root = remove(this.root, previousBase);
      base = previousBase;
      bytes += previousBytes;
    }
    if (next && base + bytes === nextBase) {
      this.root = remove(this.root, nextBase);
      bytes += nextBytes;
    }
    this.root = insert(this.root, update({base, bytes, left: null, right: null, max: [0, 0, 0, 0]}));
  }

  take(bytes, align) {
    const index = alignments.indexOf(align);
    if (index < 0 || !Number.isSafeInteger(bytes) || bytes <= 0) return -1;
    let node = this.root;
    if (!node || node.max[index] < bytes) return -1;
    while (node) {
      if (node.left && node.left.max[index] >= bytes) { node = node.left; continue; }
      const base = aligned(node.base, align);
      if (base + bytes <= node.base + node.bytes) {
        const start = node.base, end = node.base + node.bytes;
        this.root = remove(this.root, start);
        this.bytes -= end - start;
        if (base > start) this.release(start, base - start);
        if (base + bytes < end) this.release(base + bytes, end - base - bytes);
        return base;
      }
      node = node.right;
    }
    return -1;
  }
}

module.exports = {FreeExtents};
