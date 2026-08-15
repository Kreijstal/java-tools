// Shared line construction for AudioSystem and Mixer. Both are legal ways for
// a client to reach a SourceDataLine, and they must hand back the same shape:
// the format negotiated through DataLine.Info has to survive, because clients
// commonly call Line.open() with no arguments afterwards.

function newJavaObject(jvm, type, fields) {
  return {
    type,
    fields: fields || {},
    hashCode: jvm.nextHashCode++,
    isLocked: false,
    lockOwner: null,
    lockCount: 0,
    waitSet: [],
  };
}

function lineClassName(info) {
  const lineInfo = info && info.fields &&
    info.fields['javax/sound/sampled/Line$Info'];
  const lineClass = lineInfo && lineInfo.lineClass;
  if (!lineClass || !lineClass._classData) return null;
  return lineClass._classData.ast.classes[0].className;
}

function isSourceDataLineInfo(info) {
  return lineClassName(info) === 'javax/sound/sampled/SourceDataLine';
}

function createSourceDataLine(jvm, info) {
  const dataLineInfo = info.fields['javax/sound/sampled/DataLine$Info'];
  const formats = dataLineInfo && dataLineInfo.formats;
  const formatElements = formats && (formats.elements || formats);
  const line = newJavaObject(jvm, 'javax/sound/sampled/SourceDataLine');
  line.isLocked = false;
  line.requestedFormat = formatElements && formatElements[0] || null;
  line.requestedBufferSize = dataLineInfo &&
    Number(dataLineInfo.maxBufferSize) >= 0
    ? Number(dataLineInfo.maxBufferSize)
    : null;
  return line;
}

// Resolve a Line.Info to a concrete line, or throw LineUnavailableException
// exactly as the JRE does for an unsupported line class.
function getLineForInfo(jvm, info) {
  if (isSourceDataLineInfo(info)) {
    return createSourceDataLine(jvm, info);
  }
  const exception = newJavaObject(jvm, 'javax/sound/sampled/LineUnavailableException');
  exception.message = 'Line not supported: ' + lineClassName(info);
  jvm.throwException(exception);
}

module.exports = {
  newJavaObject,
  lineClassName,
  isSourceDataLineInfo,
  createSourceDataLine,
  getLineForInfo,
};
