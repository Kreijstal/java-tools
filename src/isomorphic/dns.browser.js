'use strict';

// Browser clients cannot perform DNS lookups directly. The browser socket
// transport sends only the requested port to the same-origin TCP bridge, so a
// placeholder IPv4 result is sufficient for java.net.InetAddress while the
// bridge remains responsible for resolving the configured upstream host.
async function lookup(_hostname, options = {}) {
  const family = typeof options === 'number' ? options : options.family;
  if (family && family !== 4) {
    const error = new Error('Only IPv4 lookups are supported in the browser');
    error.code = 'ENOTFOUND';
    throw error;
  }
  return { address: '127.0.0.1', family: 4 };
}

module.exports = {
  lookup,
  promises: { lookup },
};
