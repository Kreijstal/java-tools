const runtimeBean = {
  type: 'java/lang/management/RuntimeMXBean',
};

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'getRuntimeMXBean()Ljava/lang/management/RuntimeMXBean;': () => runtimeBean,
  },
};
