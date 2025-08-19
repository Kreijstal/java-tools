const handleMethod = require('./Method');
const handleField = require('./Field');
const handleModifier = require('./Modifier');
const handleAccessibleObject = require('./AccessibleObject');

module.exports = {
  Method: handleMethod,
  Field: handleField,
  Modifier: handleModifier,
  AccessibleObject: handleAccessibleObject,
};
