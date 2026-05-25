const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function stringValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return String(value.value);
  }
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  if (value && typeof value.toString === 'function') {
    const text = value.toString();
    if (text && text.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(text, 'value')) return String(text.value);
    return String(text);
  }
  return String(value);
}

function numericValue(value) {
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  return value;
}

function formatHex(value, width = 0) {
  const raw = numericValue(value);
  const hex = (typeof raw === 'bigint' ? raw : Number(raw || 0)).toString(16);
  return width > 0 ? hex.padStart(width, '0') : hex;
}

function format(formatString, args) {
  let argIndex = 0;
  let result = '';

  for (let i = 0; i < formatString.length; i++) {
    if (formatString[i] === '%') {
      i++;
      let width = 0;
      let zeroPad = false;
      if (formatString[i] === '0') {
        zeroPad = true;
        i++;
      }
      while (/[0-9]/.test(formatString[i] || '')) {
        width = width * 10 + Number(formatString[i]);
        i++;
      }
      const specifier = formatString[i];
      let nextArg = args[argIndex];

      switch (specifier) {
        case 's':
          result += stringValue(nextArg);
          argIndex++;
          break;
        case 'd':
          result += parseInt(numericValue(nextArg), 10);
          argIndex++;
          break;
        case 'x':
          result += formatHex(nextArg, zeroPad ? width : 0);
          argIndex++;
          break;
        case 'n':
          result += '\n';
          break;
        case 't':
          i++;
          const dateSpecifier = formatString[i];
          const date = nextArg._date; // get the underlying JS Date object
          switch (dateSpecifier) {
            case 'B':
              result += months[date.getMonth()];
              break;
            case 'e':
              result += date.getDate();
              break;
            case 'Y':
              result += date.getFullYear();
              break;
            default:
              result += `%t${dateSpecifier}`; // unsupported
          }
          argIndex++;
          break;
        case '<':
          // re-use last argument
          i++;
          const prevSpecifier = formatString[i];
          let prevArg = args[argIndex - 1];
          switch (prevSpecifier) {
            case 't':
              i++;
              const prevDateSpecifier = formatString[i];
              const prevDate = prevArg._date;
               switch (prevDateSpecifier) {
                case 'e':
                  result += prevDate.getDate();
                  break;
                case 'Y':
                  result += prevDate.getFullYear();
                  break;
                default:
                  result += `%<t${prevDateSpecifier}`;
              }
              break;
            default:
              result += `%<${prevSpecifier}`;
          }
          break;
        default:
          result += `%${specifier}`;
      }
    } else {
      result += formatString[i];
    }
  }
  return result;
}

module.exports = { format };
