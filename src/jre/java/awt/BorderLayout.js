// The browser AWT peer currently uses left-to-right component orientation.
function resolveRegions(components) {
  const regions = new Map();
  for (const component of components || []) {
    regions.set(String(component._layoutConstraint || 'Center').toLowerCase(), component);
  }
  for (const [alias, region] of [['first', 'north'], ['last', 'south'], ['before', 'west'], ['after', 'east']]) {
    if (regions.has(alias)) regions.set(region, regions.get(alias));
  }
  return regions;
}

module.exports = {
  resolveRegions,
  super: 'java/lang/Object',
  interfaces: ['java/awt/LayoutManager'],
  staticFields: {
    'NORTH:Ljava/lang/String;': 'North',
    'SOUTH:Ljava/lang/String;': 'South',
    'EAST:Ljava/lang/String;': 'East',
    'WEST:Ljava/lang/String;': 'West',
    'CENTER:Ljava/lang/String;': 'Center',
    'PAGE_START:Ljava/lang/String;': 'First',
    'PAGE_END:Ljava/lang/String;': 'Last',
    'LINE_START:Ljava/lang/String;': 'Before',
    'LINE_END:Ljava/lang/String;': 'After',
    'BEFORE_FIRST_LINE:Ljava/lang/String;': 'First',
    'AFTER_LAST_LINE:Ljava/lang/String;': 'Last',
    'BEFORE_LINE_BEGINS:Ljava/lang/String;': 'Before',
    'AFTER_LINE_ENDS:Ljava/lang/String;': 'After'
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
