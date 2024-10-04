class Reference {
  constructor(name, type, parent = null) {
    this.name = name;
    this.type = type;
    this.parent = parent;
    this.children = [];
  }

  addChild(child) {
    this.children.push(child);
  }

  getReferees() {
    return this.children.map(child => child.name);
  }
}

module.exports = { Reference };
