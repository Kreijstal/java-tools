'use strict';

// Reading the parameter list out of a JVM method descriptor.
//
// Two rules live here because the passes genuinely rely on two different ones,
// and merging them would change behaviour at malformed input:
//
//   parameterDescriptors        rejects: returns null when the string is not a
//                               well-formed descriptor, including a truncated
//                               one or an 'L' with no terminating ';'.
//   parameterDescriptorsOrEmpty accepts what it can: returns [] when the string
//                               is not a descriptor and the parameters gathered
//                               so far when one is malformed, and never scans
//                               past the closing ')' for a ';'.
//
// Callers that branch on a null result need the first; callers that iterate the
// result unconditionally use the second. Neither is a general descriptor parser:
// both yield raw descriptor slices ('Ljava/lang/String;'), not the readable type
// names that src/parsing/typeParser.js produces.
//
// Seven further single-use variants remain in individual passes; they have not
// been compared and are deliberately left alone.

function parameterDescriptors(desc) {
  if (typeof desc !== 'string' || desc[0] !== '(') return null;
  const out = [];
  for (let i = 1; i < desc.length && desc[i] !== ')';) {
    const start = i;
    while (desc[i] === '[') i += 1;
    if (desc[i] === 'L') {
      const end = desc.indexOf(';', i);
      if (end < 0) return null;
      out.push(desc.slice(start, end + 1));
      i = end + 1;
    } else {
      if (!desc[i]) return null;
      out.push(desc.slice(start, i + 1));
      i += 1;
    }
  }
  return out;
}

function parameterDescriptorsOrEmpty(descriptor) {
  const close = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || close < 0) return [];
  const params = [];
  for (let i = 1; i < close;) {
    const start = i;
    while (descriptor[i] === '[') i += 1;
    if (descriptor[i] === 'L') {
      const semi = descriptor.indexOf(';', i);
      if (semi < 0 || semi > close) return params;
      params.push(descriptor.slice(start, semi + 1));
      i = semi + 1;
    } else {
      params.push(descriptor.slice(start, i + 1));
      i += 1;
    }
  }
  return params;
}

module.exports = { parameterDescriptors, parameterDescriptorsOrEmpty };
