'use strict';

function browserNavigator() {
  return typeof globalThis !== 'undefined' && globalThis.navigator
    ? globalThis.navigator
    : {};
}

function platformText() {
  const navigator = browserNavigator();
  return String(
    navigator.userAgentData && navigator.userAgentData.platform ||
    navigator.platform ||
    navigator.userAgent ||
    '',
  );
}

function type() {
  const platform = platformText();
  if (/mac|iphone|ipad|ipod/i.test(platform)) return 'Darwin';
  if (/win/i.test(platform)) return 'Windows_NT';
  return 'Linux';
}

function arch() {
  const platform = platformText();
  if (/arm64|aarch64|iphone|ipad/i.test(platform)) return 'arm64';
  if (/arm/i.test(platform)) return 'arm';
  if (/x86_64|x64|win64|amd64|intel/i.test(platform)) return 'x64';
  return 'unknown';
}

function cpus() {
  const count = Math.max(
    1,
    Number(browserNavigator().hardwareConcurrency) || 1,
  );
  return Array.from({length: count}, () => ({
    model: 'browser',
    speed: 0,
    times: {user: 0, nice: 0, sys: 0, idle: 0, irq: 0},
  }));
}

module.exports = {
  type,
  arch,
  cpus,
  platform: () => type() === 'Windows_NT'
    ? 'win32'
    : (type() === 'Darwin' ? 'darwin' : 'linux'),
  release: () => '',
  tmpdir: () => '/tmp',
  homedir: () => '/',
  hostname: () => 'browser',
};
