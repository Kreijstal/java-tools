module.exports = {
  super: 'java/lang/Enum',
  // In a real implementation, this would have static fields for the enum constants
  // (DIRECT, HTTP, SOCKS) and methods like values() and valueOf().
  // For now, this is enough to make it a valid class for the JRE indexer.
  staticFields: {},
  methods: {}
};
