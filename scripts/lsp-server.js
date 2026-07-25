#!/usr/bin/env node
'use strict';

const { JasminLspServer } = require('../src/lsp/JasminLspServer');

const connection = {
  sendNotification(method, params) {
    sendMessage({ jsonrpc: '2.0', method, params });
  },
};

const server = new JasminLspServer(connection);

let buffer = '';
let contentLength = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  processBuffer();
});

function processBuffer() {
  while (true) {
    if (contentLength == null) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      contentLength = parseInt(lengthMatch[1], 10);
      buffer = buffer.slice(headerEnd + 4);
    }
    if (buffer.length < contentLength) {
      return;
    }
    const message = buffer.slice(0, contentLength);
    buffer = buffer.slice(contentLength);
    contentLength = null;
    handleMessage(message);
  }
}

function handleMessage(message) {
  let request;
  try {
    request = JSON.parse(message);
  } catch (_err) {
    return;
  }
  const { id, method, params } = request;
  const isRequest = typeof id !== 'undefined';
  if (!method) {
    return;
  }

  const handler = async () => {
    if (!isRequest) {
      try {
        server.handleNotification(method, params || {});
      } catch (err) {
        sendError(null, -32603, err.message);
      }
      return;
    }
    try {
      let result;
      if (method === 'initialize') {
        result = await server.initialize(params || {});
      } else if (method === 'shutdown') {
        result = await server.handleRequest('shutdown');
      } else {
        result = await server.handleRequest(method, params || {});
      }
      sendResponse(id, result ?? null);
    } catch (err) {
      sendError(id, -32603, err.message);
    }
  };

  handler();
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendMessage(payload) {
  const body = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}
