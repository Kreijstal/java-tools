'use strict';

// Address-ordered AVL tree of proven-dead storage. Each subtree records the
// largest usable extent for each supported alignment, so a request does not
// scan the free lists. Adjacent extents coalesce; taking a subrange preserves
// both remainders. Live allocations never enter this tree or move in memory.
const alignments = [1, 2, 4, 8];
const aligned = (base, align) => base + ((-base) & (align - 1));
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

// Rebasing stays inside the old extent and its adjacent free gap, so it
// cannot cross another key. No node allocation or tree rotation is needed.
function resize(node, base, nextBase, bytes) {
  if (base < node.base) node.left = resize(node.left, base, nextBase, bytes);
  else if (base > node.base) node.right = resize(node.right, base, nextBase, bytes);
  else { node.base = nextBase; node.bytes = bytes; }
  return update(node);
}
function extent(base, bytes) {
  return update({base, bytes, left: null, right: null, max: [0, 0, 0, 0]});
}
function take(node, bytes, align, index, pool) {
  if (node.left && node.left.max[index] >= bytes) {
    node.left = take(node.left, bytes, align, index, pool);
    return balance(node);
  }
  const base = aligned(node.base, align), end = node.base + node.bytes;
  if (base + bytes > end) {
    node.right = take(node.right, bytes, align, index, pool);
    return balance(node);
  }
  pool.takenBase = base;
  const prefix = base - node.base, suffix = end - base - bytes;
  if (!prefix && !suffix) return remove(node, node.base);
  if (!prefix) {
    node.base = base + bytes; node.bytes = suffix;
    return update(node);
  }
  node.bytes = prefix;
  if (suffix) node.right = insert(node.right, extent(base + bytes, suffix));
  return balance(node);
}

class FreeExtents {
  constructor() { this.root = null; this.bytes = 0; this.takenBase = -1; }

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
      if (next && base + bytes === nextBase) {
        this.root = remove(this.root, nextBase);
        bytes += nextBytes;
      }
      this.root = resize(this.root, previousBase, previousBase, previousBytes + bytes);
    } else if (next && base + bytes === nextBase) {
      this.root = resize(this.root, nextBase, base, nextBytes + bytes);
    } else this.root = insert(this.root, extent(base, bytes));
  }

  take(bytes, align) {
    const index = alignments.indexOf(align);
    if (index < 0 || !Number.isSafeInteger(bytes) || bytes <= 0) return -1;
    if (!this.root || this.root.max[index] < bytes) return -1;
    this.root = take(this.root, bytes, align, index, this);
    this.bytes -= bytes;
    return this.takenBase;
  }
}

module.exports = {FreeExtents};
