'use strict';

class JavaFrontendError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || 'JavaFrontendError';
    this.code = options.code || 'JAVA_FRONTEND_ERROR';
    this.phase = options.phase || null;
    this.range = options.range || null;
    this.details = options.details || null;
  }
}

class NotImplementedJavaFrontendError extends JavaFrontendError {
  constructor(phase, feature, options = {}) {
    const suffix = feature ? `: ${feature}` : '';
    super(`Java frontend phase is not implemented yet (${phase}${suffix})`, {
      ...options,
      name: 'NotImplementedJavaFrontendError',
      code: 'JAVA_FRONTEND_NOT_IMPLEMENTED',
      phase,
    });
    this.feature = feature || null;
  }
}

class UnsupportedJavaSyntaxError extends JavaFrontendError {
  constructor(feature, options = {}) {
    super(`Unsupported Java syntax${feature ? `: ${feature}` : ''}`, {
      ...options,
      name: 'UnsupportedJavaSyntaxError',
      code: 'JAVA_FRONTEND_UNSUPPORTED_SYNTAX',
      phase: options.phase || 'parse',
    });
    this.feature = feature || null;
  }
}

module.exports = {
  JavaFrontendError,
  NotImplementedJavaFrontendError,
  UnsupportedJavaSyntaxError,
};
