'use strict';

// Small shared helpers for the IDE shell.

function byId(id) {
  return document.getElementById(id);
}

function basename(filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

function parentPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function normalizePath(filePath) {
  let value = String(filePath || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function joinPath(dir, name) {
  return normalizePath(`${dir}/${name}`);
}

function extensionOf(filePath) {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function setStatus(message, kind = 'info') {
  if (typeof window.updateStatus === 'function') {
    window.updateStatus(message, kind);
  } else {
    const status = byId('status');
    if (status) {
      status.textContent = message;
      status.className = `status ${kind}`;
    }
  }
}

function logLine(message, kind = 'info') {
  if (typeof window.log === 'function') {
    window.log(message, kind);
  } else {
    console.log(`[${kind}] ${message}`);
  }
}

/**
 * Modal one-line prompt built on <dialog>. Resolves with the entered string,
 * or null when cancelled.
 */
function promptText({ title, placeholder = '', value = '', hint = '' }) {
  const dialog = byId('promptDialog');
  const input = byId('promptDialogInput');
  byId('promptDialogTitle').textContent = title;
  byId('promptDialogHint').textContent = hint;
  input.placeholder = placeholder;
  input.value = value;

  return new Promise((resolve) => {
    const done = (result) => {
      dialog.close();
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      dialog.removeEventListener('cancel', onDialogCancel);
      resolve(result);
    };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (event) => {
      if (event.key === 'Enter') onOk();
    };
    const onDialogCancel = (event) => {
      event.preventDefault();
      done(null);
    };
    const okBtn = byId('promptDialogOk');
    const cancelBtn = byId('promptDialogCancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    dialog.addEventListener('cancel', onDialogCancel);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

function downloadBytes(fileName, content) {
  const blob = content instanceof Blob ? content : new Blob([content]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

module.exports = {
  byId,
  basename,
  parentPath,
  normalizePath,
  joinPath,
  extensionOf,
  setStatus,
  logLine,
  promptText,
  downloadBytes,
};
