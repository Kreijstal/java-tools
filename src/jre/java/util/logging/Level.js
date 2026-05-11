function level(name, value) {
  return { type: 'java/util/logging/Level', name, value };
}

const OFF = level('OFF', 2147483647);
const SEVERE = level('SEVERE', 1000);
const WARNING = level('WARNING', 900);
const INFO = level('INFO', 800);
const CONFIG = level('CONFIG', 700);
const FINE = level('FINE', 500);
const FINER = level('FINER', 400);
const FINEST = level('FINEST', 300);
const ALL = level('ALL', -2147483648);

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'OFF:Ljava/util/logging/Level;': OFF,
    'SEVERE:Ljava/util/logging/Level;': SEVERE,
    'WARNING:Ljava/util/logging/Level;': WARNING,
    'INFO:Ljava/util/logging/Level;': INFO,
    'CONFIG:Ljava/util/logging/Level;': CONFIG,
    'FINE:Ljava/util/logging/Level;': FINE,
    'FINER:Ljava/util/logging/Level;': FINER,
    'FINEST:Ljava/util/logging/Level;': FINEST,
    'ALL:Ljava/util/logging/Level;': ALL,
  },
  methods: {
    '<init>(Ljava/lang/String;I)V': (jvm, obj, args) => {
      obj.name = args[0];
      obj.value = args[1];
    },
    'intValue()I': (jvm, obj) => obj.value || 0,
    'getName()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.name || ''),
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.name || ''),
  },
};
