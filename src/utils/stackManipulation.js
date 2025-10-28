'use strict';

function isValueOfWidth(value, width) {
  return Boolean(value) && value.width === width;
}

function ensureAll(values, prepare) {
  if (!prepare) {
    return true;
  }
  for (const value of values) {
    if (value && !prepare(value)) {
      return false;
    }
  }
  return true;
}

function applyStackManipulation(effect, consumed, stack, operations) {
  if (!effect || !effect.special || !Array.isArray(consumed) || !Array.isArray(stack)) {
    return false;
  }

  const [v1, v2, v3, v4] = consumed;
  const { prepareValue = () => true, pushOriginal, pushDuplicate } = operations || {};

  if (typeof pushOriginal !== 'function' || typeof pushDuplicate !== 'function') {
    return false;
  }

  const pushOrig = (value) => pushOriginal(value, stack);
  const pushDup = (value) => pushDuplicate(value, stack);
  const prepare = (values) => ensureAll(values, prepareValue);

  switch (effect.special) {
    case 'dup': {
      if (consumed.length !== 1 || !isValueOfWidth(v1, 1)) {
        return false;
      }
      if (!prepare([v1])) {
        return false;
      }
      return pushOrig(v1) && pushDup(v1);
    }
    case 'dup_x1': {
      if (consumed.length !== 2 || !isValueOfWidth(v1, 1) || !isValueOfWidth(v2, 1)) {
        return false;
      }
      if (!prepare([v1, v2])) {
        return false;
      }
      return pushDup(v1) && pushOrig(v2) && pushOrig(v1);
    }
    case 'dup_x2': {
      if (
        consumed.length === 3 &&
        isValueOfWidth(v1, 1) &&
        isValueOfWidth(v2, 1) &&
        isValueOfWidth(v3, 1)
      ) {
        if (!prepare([v1, v2, v3])) {
          return false;
        }
        return pushDup(v1) && pushOrig(v3) && pushOrig(v2) && pushOrig(v1);
      }
      if (consumed.length === 2 && isValueOfWidth(v1, 1) && isValueOfWidth(v2, 2)) {
        if (!prepare([v1, v2])) {
          return false;
        }
        return pushDup(v1) && pushOrig(v2) && pushOrig(v1);
      }
      return false;
    }
    case 'dup2': {
      if (consumed.length === 1 && isValueOfWidth(v1, 2)) {
        if (!prepare([v1])) {
          return false;
        }
        return pushOrig(v1) && pushDup(v1);
      }
      if (consumed.length === 2 && isValueOfWidth(v1, 1) && isValueOfWidth(v2, 1)) {
        if (!prepare([v1, v2])) {
          return false;
        }
        return pushOrig(v2) && pushOrig(v1) && pushDup(v2) && pushDup(v1);
      }
      return false;
    }
    case 'dup2_x1': {
      if (
        consumed.length === 3 &&
        isValueOfWidth(v1, 1) &&
        isValueOfWidth(v2, 1) &&
        isValueOfWidth(v3, 1)
      ) {
        if (!prepare([v1, v2, v3])) {
          return false;
        }
        return pushOrig(v2) && pushOrig(v1) && pushOrig(v3) && pushDup(v2) && pushDup(v1);
      }
      if (consumed.length === 2 && isValueOfWidth(v1, 2) && isValueOfWidth(v2, 1)) {
        if (!prepare([v1, v2])) {
          return false;
        }
        return pushOrig(v1) && pushOrig(v2) && pushDup(v1);
      }
      return false;
    }
    case 'dup2_x2': {
      if (
        consumed.length === 4 &&
        isValueOfWidth(v1, 1) &&
        isValueOfWidth(v2, 1) &&
        isValueOfWidth(v3, 1) &&
        isValueOfWidth(v4, 1)
      ) {
        if (!prepare([v1, v2, v3, v4])) {
          return false;
        }
        return (
          pushOrig(v2) &&
          pushOrig(v1) &&
          pushOrig(v4) &&
          pushOrig(v3) &&
          pushDup(v2) &&
          pushDup(v1)
        );
      }
      if (
        consumed.length === 3 &&
        isValueOfWidth(v1, 2) &&
        isValueOfWidth(v2, 1) &&
        isValueOfWidth(v3, 1)
      ) {
        if (!prepare([v1, v2, v3])) {
          return false;
        }
        return pushOrig(v1) && pushOrig(v3) && pushOrig(v2) && pushDup(v1);
      }
      if (
        consumed.length === 3 &&
        isValueOfWidth(v1, 1) &&
        isValueOfWidth(v2, 1) &&
        isValueOfWidth(v3, 2)
      ) {
        if (!prepare([v1, v2, v3])) {
          return false;
        }
        return pushOrig(v2) && pushOrig(v1) && pushOrig(v3) && pushDup(v2) && pushDup(v1);
      }
      if (consumed.length === 2 && isValueOfWidth(v1, 2) && isValueOfWidth(v2, 2)) {
        if (!prepare([v1, v2])) {
          return false;
        }
        return pushOrig(v1) && pushOrig(v2) && pushDup(v1);
      }
      return false;
    }
    case 'swap': {
      if (consumed.length !== 2 || !isValueOfWidth(v1, 1) || !isValueOfWidth(v2, 1)) {
        return false;
      }
      if (!prepare([v1, v2])) {
        return false;
      }
      return pushOrig(v1) && pushOrig(v2);
    }
    default:
      return false;
  }
}

module.exports = {
  applyStackManipulation,
};
