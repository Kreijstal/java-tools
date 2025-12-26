module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/awt/LayoutManager'],
  staticFields: {
    'NORTH:Ljava/lang/String;': 'North',
    'SOUTH:Ljava/lang/String;': 'South',
    'EAST:Ljava/lang/String;': 'East',
    'WEST:Ljava/lang/String;': 'West',
    'CENTER:Ljava/lang/String;': 'Center'
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._hgap = 0;
      obj._vgap = 0;
    },
    '<init>(II)V': (jvm, obj, args) => {
      obj._hgap = args[0];
      obj._vgap = args[1];
    }
  },
};
