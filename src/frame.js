const Stack = require('./stack');

class Frame {
  constructor(method) {
    this.method = method;
    this.stack = new Stack();
    const codeAttr = method.attributes.find(attr => attr.type === 'code');
    if (codeAttr) {
      const code = codeAttr.code;
      this.locals = new Array(parseInt(code.localsSize, 10)).fill(undefined);
      this.instructions = code.codeItems;
      this.exceptionTable = code.exceptionTable;
    } else {
      this.locals = [];
      this.instructions = [];
      this.exceptionTable = [];
    }
    this.pc = 0;
  }
}

module.exports = Frame;
