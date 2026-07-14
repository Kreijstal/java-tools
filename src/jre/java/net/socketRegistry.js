'use strict';

// Shared registry for native TCP sockets and their receive buffers, used by
// Socket.js, SocketInputStream.js, and SocketOutputStream.js.

const Sockets = new Map(); // socketId -> net.Socket
const Buffers = new Map(); // socketId -> { chunks: Buffer[], size, closed, waiters: fn[] }
let nextSocketId = 0;

function allocId() {
  return nextSocketId++;
}

function register(socketId, nativeSocket) {
  Sockets.set(socketId, nativeSocket);
  const state = { chunks: [], size: 0, closed: false, waiters: [] };
  Buffers.set(socketId, state);
  nativeSocket.on('data', (chunk) => {
    state.chunks.push(chunk);
    state.size += chunk.length;
    const waiters = state.waiters.splice(0);
    for (const w of waiters) w();
  });
  const markClosed = () => {
    state.closed = true;
    const waiters = state.waiters.splice(0);
    for (const w of waiters) w();
  };
  nativeSocket.on('end', markClosed);
  nativeSocket.on('close', markClosed);
  nativeSocket.on('error', markClosed);
}

function readByte(state) {
  if (!state || state.size === 0) return -1;
  const chunk = state.chunks[0];
  const b = chunk[0];
  if (chunk.length === 1) {
    state.chunks.shift();
  } else {
    state.chunks[0] = chunk.subarray(1);
  }
  state.size -= 1;
  return b;
}

function readInto(state, target, off, len) {
  if (!state || state.size === 0) return state && state.closed ? -1 : 0;
  let copied = 0;
  while (copied < len && state.size > 0) {
    const chunk = state.chunks[0];
    const take = Math.min(chunk.length, len - copied);
    for (let i = 0; i < take; i++) {
      // Java byte arrays hold signed bytes.
      target[off + copied + i] = (chunk[i] << 24) >> 24;
    }
    if (take === chunk.length) {
      state.chunks.shift();
    } else {
      state.chunks[0] = chunk.subarray(take);
    }
    state.size -= take;
    copied += take;
  }
  return copied;
}

// Resolves when data is available or the socket closes.
function waitForData(state) {
  if (!state || state.size > 0 || state.closed) return Promise.resolve();
  return new Promise((resolve) => state.waiters.push(resolve));
}

module.exports = { Sockets, Buffers, allocId, register, readByte, readInto, waitForData };
