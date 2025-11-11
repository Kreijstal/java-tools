const EventEmitter = require('events');

/**
 * Creates an in-process harness for exercising an LSP-style server without spawning
 * JSON-RPC transports. The harness instantiates the server via the provided factory
 * and exposes helpers for issuing requests/notifications while capturing any
 * server-emitted notifications (diagnostics, logs, etc.).
 *
 * The server factory is invoked with a lightweight connection object that exposes:
 *  - sendNotification(method, params)
 *  - publishDiagnostics(uri, diagnostics) (convenience wrapper)
 *
 * The server instance is expected to implement:
 *  - initialize(params)
 *  - shutdown()
 *  - handleRequest(method, params)
 *  - handleNotification(method, params)
 *
 * All methods are optional; missing handlers are treated as no-ops.
 *
 * @param {{ createServer: function(connection: object): object }} options
 */
function createInProcessLspHarness({ createServer }) {
  if (typeof createServer !== 'function') {
    throw new Error('createServer option must be provided');
  }

  const emitter = new EventEmitter();
  const sentNotifications = [];

  const connection = {
    sendNotification(method, params) {
      const payload = { method, params };
      sentNotifications.push(payload);
      emitter.emit(method, payload);
    },
    publishDiagnostics(uri, diagnostics) {
      connection.sendNotification('textDocument/publishDiagnostics', {
        uri,
        diagnostics,
      });
    },
  };

  const server = createServer(connection) || {};

  const harness = {
    connection,
    server,
    /**
     * Returns a copy of all notifications emitted so far.
     */
    getNotifications() {
      return sentNotifications.slice();
    },
    /**
     * Registers a listener for notifications with the given method name.
     */
    on(method, handler) {
      emitter.on(method, handler);
      return () => emitter.off(method, handler);
    },
    /**
     * Issues an initialize request to the server (if supported).
     */
    async initialize(params = {}) {
      if (typeof server.initialize === 'function') {
        return server.initialize(params);
      }
      return null;
    },
    /**
     * Sends a shutdown request to the server (if supported).
     */
    async shutdown() {
      if (typeof server.shutdown === 'function') {
        return server.shutdown();
      }
      return null;
    },
    /**
     * Sends a JSON-RPC style request to the server and returns its response.
     */
    async request(method, params) {
      if (typeof server.handleRequest !== 'function') {
        throw new Error('Server does not implement handleRequest');
      }
      return server.handleRequest(method, params);
    },
    /**
     * Sends a notification to the server (fire-and-forget).
     */
    notify(method, params) {
      if (typeof server.handleNotification === 'function') {
        server.handleNotification(method, params);
      }
    },
  };

  return harness;
}

module.exports = { createInProcessLspHarness };
