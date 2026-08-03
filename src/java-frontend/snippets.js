'use strict';

const { JavaParser } = require('./parser');
const { tokenizeJava } = require('./lexer');

function hasStatementTerminator(source) {
  const tokens = tokenizeJava(source).tokens;
  return tokens.length > 0 && tokens[tokens.length - 1].text === ';';
}

function isStatementSnippet(source) {
  const statement = new JavaParser().parseStatement(source);
  return (statement.kind !== 'ExpressionStatement' &&
    statement.kind !== 'UnsupportedStatement') || hasStatementTerminator(source);
}

module.exports = { hasStatementTerminator, isStatementSnippet };
