const instance = {
  type: 'java/util/concurrent/ThreadLocalRandom',
  state: 0x4d595df4d0f33173n,
};

function next(random) {
  let value = BigInt.asUintN(64, random.state);
  value ^= value << 13n;
  value ^= value >> 7n;
  value ^= value << 17n;
  random.state = BigInt.asUintN(64, value);
  return random.state;
}

module.exports = {
  super: 'java/util/Random',
  staticMethods: {
    'current()Ljava/util/concurrent/ThreadLocalRandom;': () => instance,
  },
  methods: {
    'nextLong()J': (jvm, obj) => BigInt.asIntN(64, next(obj)),
    'nextInt()I': (jvm, obj) => Number(BigInt.asIntN(32, next(obj))),
  },
};
