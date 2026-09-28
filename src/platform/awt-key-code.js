// DOM virtual-key values usually match AWT, but Enter is CR in the browser
// and VK_ENTER (LF) in Java. Preserve the fallback used by older DOM events.
function javaKeyCode(event) {
  const code = event.keyCode || event.which || 0;
  return event.key === 'Enter' || code === 13 ? 10 : code;
}

module.exports = {javaKeyCode};
