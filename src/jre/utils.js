function getClassName(c) {
  if (!c) return '';
  let name = c.name;
  if (c._classData) {
    name = c._classData.ast.classes[0].className;
  } else if (c.className) {
    name = c.className;
  }
  return name;
}

function classToDescriptor(c) {
  const name = getClassName(c);
  if (!name) return '';

  if (name === 'void') return 'V';
  if (name === 'int') return 'I';
  if (name === 'long') return 'J';
  if (name === 'double') return 'D';
  if (name === 'float') return 'F';
  if (name === 'boolean') return 'Z';
  if (name === 'char') return 'C';
  if (name === 'byte') return 'B';
  if (name === 'short') return 'S';
  if (name.startsWith('[')) return name.replace(/\./g, '/');
  return `L${name.replace(/\./g, '/')};`;
}

module.exports = {
  getClassName,
  classToDescriptor,
};
