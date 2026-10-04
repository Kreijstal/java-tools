'use strict';

// Modifier and access flags. The low 16 bits match the class file access
// flags; source-only flags live above them.
const F = {
  PUBLIC: 0x0001,
  PRIVATE: 0x0002,
  PROTECTED: 0x0004,
  STATIC: 0x0008,
  FINAL: 0x0010,
  SYNCHRONIZED: 0x0020,
  SUPER: 0x0020,
  VOLATILE: 0x0040,
  BRIDGE: 0x0040,
  TRANSIENT: 0x0080,
  VARARGS: 0x0080,
  NATIVE: 0x0100,
  INTERFACE: 0x0200,
  ABSTRACT: 0x0400,
  STRICTFP: 0x0800,
  SYNTHETIC: 0x1000,
  ANNOTATION: 0x2000,
  ENUM: 0x4000,
  MANDATED: 0x8000,
  MODULE: 0x8000,

  // source-only
  DEFAULT: 1 << 16,
  SEALED: 1 << 17,
  NON_SEALED: 1 << 18,
  RECORD: 1 << 19,
  COMPACT_RECORD_CONSTRUCTOR: 1 << 20,
  GENERATED_CONSTRUCTOR: 1 << 21,
  DEPRECATED: 1 << 22,
  HAS_INIT: 1 << 23,
  LAMBDA_PARAM: 1 << 24,
  EFFECTIVELY_FINAL: 1 << 25,
  VALUE_BASED: 1 << 26,
};

const MODIFIER_KEYWORDS = {
  public: F.PUBLIC,
  private: F.PRIVATE,
  protected: F.PROTECTED,
  static: F.STATIC,
  final: F.FINAL,
  synchronized: F.SYNCHRONIZED,
  volatile: F.VOLATILE,
  transient: F.TRANSIENT,
  native: F.NATIVE,
  abstract: F.ABSTRACT,
  strictfp: F.STRICTFP,
  default: F.DEFAULT,
};

const ACCESS_MASK = F.PUBLIC | F.PRIVATE | F.PROTECTED;

module.exports = { F, MODIFIER_KEYWORDS, ACCESS_MASK };
