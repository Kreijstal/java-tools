const ACCESS_FLAG_SPEC = Object.freeze({
  class: Object.freeze({
    public: 0x0001,
    final: 0x0010,
    super: 0x0020,
    interface: 0x0200,
    abstract: 0x0400,
    synthetic: 0x1000,
    annotation: 0x2000,
    enum: 0x4000,
    module: 0x8000
  }),
  field: Object.freeze({
    public: 0x0001,
    private: 0x0002,
    protected: 0x0004,
    static: 0x0008,
    final: 0x0010,
    volatile: 0x0040,
    transient: 0x0080,
    synthetic: 0x1000,
    enum: 0x4000
  }),
  method: Object.freeze({
    public: 0x0001,
    private: 0x0002,
    protected: 0x0004,
    static: 0x0008,
    final: 0x0010,
    synchronized: 0x0020,
    bridge: 0x0040,
    varargs: 0x0080,
    native: 0x0100,
    abstract: 0x0400,
    strictfp: 0x0800,
    synthetic: 0x1000
  })
});

function computeAccessFlags(flags = [], context) {
  const spec = ACCESS_FLAG_SPEC[context];
  if (!spec) {
    return 0;
  }

  return flags.reduce((mask, flag) => {
    const bit = spec[flag];
    return bit ? mask | bit : mask;
  }, 0);
}

function decodeAccessFlags(accessFlags = 0, context) {
  const spec = ACCESS_FLAG_SPEC[context];
  if (!spec) {
    return [];
  }

  const numericFlags = Number(accessFlags);
  if (!Number.isFinite(numericFlags)) {
    return [];
  }

  const flags = [];
  for (const [flagName, bit] of Object.entries(spec)) {
    if (numericFlags & bit) {
      flags.push(flagName);
    }
  }

  return flags;
}

module.exports = {
  ACCESS_FLAG_SPEC,
  computeAccessFlags,
  decodeAccessFlags
};
