'use strict';

// Minimal browser implementation of the Node net.Socket surface used by the
// Java Socket JRE model. Browsers cannot open raw TCP, so the site terminates a
// same-origin WebSocket at /tcp and its worker forwards the bytes to TCP.
class Socket {
  constructor() {
    this.destroyed = false;
    this.writable = false;
    this.webSocket = null;
    this.listeners = new Map();
    this.pending = [];
    this.localJs5 = false;
    this.localInput = Buffer.alloc(0);
    this.localHandshake = false;
    this.localXorKey = 0;
    this.localDrain = Promise.resolve();
    this.localGroups = new Map();
  }

  on(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push({ listener, once: false });
    return this;
  }

  once(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push({ listener, once: true });
    return this;
  }

  emit(name, value) {
    const entries = (this.listeners.get(name) || []).slice();
    if (entries.some((entry) => entry.once)) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => !entry.once));
    }
    for (const entry of entries) entry.listener(value);
  }

  connect(port, _host, callback) {
    // GeoBlox's update service is a read-only JS5 cache. Keep that service
    // entirely inside the emulated JRE instead of leaving the browser merely
    // to recreate a TCP connection to a local process.
    if (Number(port) === 43594 && globalThis.fetch) {
      this.localJs5 = true;
      this.writable = true;
      queueMicrotask(() => {
        if (callback) callback();
        this.emit('connect');
      });
      return this;
    }
    const protocol = globalThis.location && globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const localDevelopment = globalThis.location && globalThis.location.port === '5173';
    const authority = globalThis.location
      ? localDevelopment ? `${globalThis.location.hostname}:43595` : globalThis.location.host
      : '';
    const bridgePath = localDevelopment ? '/local-tcp' : '/tcp';
    const webSocket = new globalThis.WebSocket(`${protocol}//${authority}${bridgePath}?port=${port}`);
    webSocket.binaryType = 'arraybuffer';
    this.webSocket = webSocket;
    webSocket.addEventListener('open', () => {
      this.writable = true;
      for (const bytes of this.pending.splice(0)) webSocket.send(bytes);
      if (callback) callback();
      this.emit('connect');
    });
    webSocket.addEventListener('message', (event) => {
      this.emit('data', Buffer.from(new Uint8Array(event.data)));
    });
    webSocket.addEventListener('error', () => {
      this.emit('error', new Error(`WebSocket TCP bridge failed for port ${port}`));
    });
    webSocket.addEventListener('close', () => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.writable = false;
      this.emit('end');
      this.emit('close');
    });
    return this;
  }

  write(value) {
    if (this.destroyed) return false;
    const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
    if (this.localJs5) {
      this.localInput = Buffer.concat([this.localInput, Buffer.from(bytes)]);
      this.localDrain = this.localDrain.then(() => this.drainLocalJs5()).catch((error) => {
        this.emit('error', error);
      });
      return true;
    }
    if (this.webSocket && this.webSocket.readyState === globalThis.WebSocket.OPEN) {
      this.webSocket.send(bytes);
    } else {
      this.pending.push(bytes);
    }
    return true;
  }

  setKeepAlive() { return this; }
  setNoDelay() { return this; }
  setTimeout() { return this; }

  async localGroup(archiveId, groupId) {
    const key = `${archiveId}-${groupId}`;
    if (this.localGroups.has(key)) return this.localGroups.get(key);
    const response = await globalThis.fetch(`/jvm-assets/geoblox-js5/${key}.bin`);
    const raw = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    this.localGroups.set(key, raw);
    return raw;
  }

  localSend(value) {
    const bytes = Buffer.from(value);
    if (!this.localXorKey) {
      this.emit('data', bytes);
      return;
    }
    const encoded = Buffer.allocUnsafe(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      encoded[index] = bytes[index] ^ this.localXorKey;
    }
    this.emit('data', encoded);
  }

  localSendFramed(packet) {
    this.localSend(packet.subarray(0, Math.min(512, packet.length)));
    for (let offset = 512; offset < packet.length; offset += 511) {
      this.localSend(Buffer.from([0xff]));
      this.localSend(packet.subarray(offset, Math.min(offset + 511, packet.length)));
    }
  }

  async localFileRequest(priority, archiveId, groupId) {
    let raw = await this.localGroup(archiveId, groupId);
    if (!raw) {
      const empty = Buffer.alloc(10);
      empty[0] = archiveId;
      empty.writeUInt32BE(groupId, 1);
      empty[5] = priority ? 0 : 0x80;
      this.localSendFramed(empty);
      return;
    }
    if (archiveId !== 255) {
      const compressedLength = raw.readUInt32BE(1);
      const containerLength = (raw[0] === 0 ? 5 : 9) + compressedLength;
      raw = raw.subarray(0, containerLength);
    }
    const head = Buffer.alloc(10);
    head[0] = archiveId;
    head.writeUInt32BE(groupId, 1);
    head[5] = (raw[0] & 0x7f) | (priority ? 0 : 0x80);
    head.writeUInt32BE(raw.readUInt32BE(1), 6);
    this.localSendFramed(Buffer.concat([head, raw.subarray(5)]));
  }

  async drainLocalJs5() {
    if (!this.localHandshake) {
      if (this.localInput.length < 13) return;
      const handshake = this.localInput.subarray(0, 13);
      this.localInput = this.localInput.subarray(13);
      if (handshake[0] !== 12 || handshake[8] !== 15) {
        throw new Error('Invalid in-browser JS5 handshake');
      }
      this.localHandshake = true;
      this.localSend(Buffer.from([0]));
    }
    while (this.localInput.length >= 6) {
      const packet = this.localInput.subarray(0, 6);
      this.localInput = this.localInput.subarray(6);
      const opcode = packet[0];
      if (opcode === 0 || opcode === 1) {
        await this.localFileRequest(opcode === 1, packet[1], packet.readUInt32BE(2));
      } else if (opcode === 4) {
        this.localXorKey = packet[1];
      } else if (opcode === 7) {
        this.destroy();
        return;
      }
    }
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (this.webSocket) this.webSocket.close();
    this.emit('close');
    return this;
  }
}

module.exports = { Socket };
