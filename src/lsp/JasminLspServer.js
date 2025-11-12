'use strict';

const fs = require('fs');
const { fileURLToPath } = require('url');
const { formatJasminSource, normalizeNewlines } = require('../jasminFormatter');

class JasminLspServer {
  constructor(connection) {
    this.connection = connection;
    this.documents = new Map();
    this.shutdownRequested = false;
  }

  async initialize() {
    return {
      capabilities: {
        textDocumentSync: 1,
        documentFormattingProvider: true,
      },
    };
  }

  async shutdown() {
    this.documents.clear();
    this.shutdownRequested = true;
    return null;
  }

  handleNotification(method, params) {
    switch (method) {
      case 'textDocument/didOpen':
        if (params?.textDocument?.uri) {
          this.documents.set(params.textDocument.uri, params.textDocument.text || '');
        }
        break;
      case 'textDocument/didChange': {
        const uri = params?.textDocument?.uri;
        if (!uri) break;
        const change = params.contentChanges?.[0];
        const text = typeof change?.text === 'string' ? change.text : '';
        this.documents.set(uri, text);
        break;
      }
      case 'textDocument/didClose':
        if (params?.textDocument?.uri) {
          this.documents.delete(params.textDocument.uri);
        }
        break;
      case 'exit':
        process.exit(this.shutdownRequested ? 0 : 1);
        break;
      default:
        break;
    }
  }

  async handleRequest(method, params) {
    if (method === 'shutdown') {
      return this.shutdown();
    }
    if (method === 'textDocument/formatting') {
      return this.handleFormatting(params);
    }
    throw new Error(`Unsupported request: ${method}`);
  }

  handleFormatting(params) {
    if (!params || !params.textDocument || !params.textDocument.uri) {
      throw new Error('textDocument.uri is required');
    }
    const uri = params.textDocument.uri;
    const currentText = this._getDocumentText(uri);
    if (typeof currentText !== 'string') {
      throw new Error(`Document not open or unreadable: ${uri}`);
    }
    const formatted = formatJasminSource(currentText);
    if (normalizeNewlines(formatted) === normalizeNewlines(currentText)) {
      return [];
    }
    const lineCount = normalizeNewlines(currentText).split('\n').length;
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lineCount, character: 0 },
        },
        newText: formatted,
      },
    ];
  }

  _getDocumentText(uri) {
    if (this.documents.has(uri)) {
      return this.documents.get(uri);
    }
    if (uri.startsWith('file://')) {
      try {
        return fs.readFileSync(fileURLToPath(uri), 'utf8');
      } catch (_err) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { JasminLspServer };
