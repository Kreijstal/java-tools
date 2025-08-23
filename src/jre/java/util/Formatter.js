const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function format(formatString, args) {
  let argIndex = 0;
  let result = '';

  for (let i = 0; i < formatString.length; i++) {
    if (formatString[i] === '%') {
      i++;
      const specifier = formatString[i];
      let nextArg = args[argIndex];

      switch (specifier) {
        case 's':
          result += nextArg.toString();
          argIndex++;
          break;
        case 'd':
          result += parseInt(nextArg, 10);
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
