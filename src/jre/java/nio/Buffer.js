const { withThrows } = require('../../helpers');

function position(obj) {
  return obj['java/nio/Buffer/position'];
}

function limit(obj) {
  return obj['java/nio/Buffer/limit'];
}

const setPosition = withThrows((jvm, obj, args) => {
  const value = Number(args[0]);
  if (value < 0 || value > limit(obj)) {
    throw { type: 'java/lang/IllegalArgumentException' };
  }
  obj['java/nio/Buffer/position'] = value;
  if (obj['java/nio/Buffer/mark'] > value) obj['java/nio/Buffer/mark'] = -1;
  return obj;
}, ['java/lang/IllegalArgumentException']);

const setLimit = withThrows((jvm, obj, args) => {
  const value = Number(args[0]);
  if (value < 0 || value > obj['java/nio/Buffer/capacity']) {
    throw { type: 'java/lang/IllegalArgumentException' };
  }
  obj['java/nio/Buffer/limit'] = value;
  if (position(obj) > value) obj['java/nio/Buffer/position'] = value;
  if (obj['java/nio/Buffer/mark'] > value) obj['java/nio/Buffer/mark'] = -1;
  return obj;
}, ['java/lang/IllegalArgumentException']);

module.exports = {
  super: 'java/lang/Object',
  methods: {
    'capacity()I': (jvm, obj) => obj['java/nio/Buffer/capacity'],
    'position()I': (jvm, obj) => position(obj),
    'position(I)Ljava/nio/Buffer;': setPosition,
    'limit()I': (jvm, obj) => limit(obj),
    'limit(I)Ljava/nio/Buffer;': setLimit,
    'remaining()I': (jvm, obj) => limit(obj) - position(obj),
    'hasRemaining()Z': (jvm, obj) => position(obj) < limit(obj) ? 1 : 0,
    'clear()Ljava/nio/Buffer;': (jvm, obj) => {
      obj['java/nio/Buffer/position'] = 0;
      obj['java/nio/Buffer/limit'] = obj['java/nio/Buffer/capacity'];
      obj['java/nio/Buffer/mark'] = -1;
      return obj;
    },
    'flip()Ljava/nio/Buffer;': (jvm, obj) => {
      obj['java/nio/Buffer/limit'] = position(obj);
      obj['java/nio/Buffer/position'] = 0;
      obj['java/nio/Buffer/mark'] = -1;
      return obj;
    },
    'rewind()Ljava/nio/Buffer;': (jvm, obj) => {
      obj['java/nio/Buffer/position'] = 0;
      obj['java/nio/Buffer/mark'] = -1;
      return obj;
    },
    'mark()Ljava/nio/Buffer;': (jvm, obj) => {
      obj['java/nio/Buffer/mark'] = position(obj);
      return obj;
    },
    'reset()Ljava/nio/Buffer;': withThrows((jvm, obj) => {
      const mark = obj['java/nio/Buffer/mark'];
      if (mark === undefined || mark < 0) {
        throw { type: 'java/nio/InvalidMarkException' };
      }
      obj['java/nio/Buffer/position'] = mark;
      return obj;
    }, ['java/nio/InvalidMarkException']),
  },
};
