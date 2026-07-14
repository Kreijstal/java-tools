const handleMethod = require('./Method');
const handleField = require('./Field');
const handleModifier = require('./Modifier');
const handleAccessibleObject = require('./AccessibleObject');
const handleConstructor = require('./Constructor');

module.exports = {
  Method: handleMethod,
  Field: handleField,
  Modifier: handleModifier,
  AccessibleObject: handleAccessibleObject,
  Constructor: handleConstructor,
};
