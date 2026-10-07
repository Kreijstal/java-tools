/*
 * Windows executable for the shim boot JDK's bin/<tool>.exe. The JDK build
 * treats a Windows executable differently from a script (it runs it through
 * fixpath, which also rewrites paths inside @argfiles), so the shim has to be
 * one. It runs `node launcher.js <tool> <args>` with the original argument
 * text passed through untouched and returns node's exit code.
 *
 * Built by make-shim.js with:
 *   gcc -O2 -municode -DSHIM_HOME=L"..." -DSHIM_LAUNCHER=L"..." -DSHIM_TOOL=L"java"
 */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

/* skip argv[0] in a command line, following the CommandLineToArgvW rules */
static const wchar_t *skip_program_name(const wchar_t *p) {
  if (*p == L'"') {
    p++;
    while (*p && *p != L'"') p++;
    if (*p) p++;
  } else {
    while (*p && *p != L' ' && *p != L'\t') p++;
  }
  while (*p == L' ' || *p == L'\t') p++;
  return p;
}

int wmain(void) {
  const wchar_t *args = skip_program_name(GetCommandLineW());
  size_t n = wcslen(args) + wcslen(SHIM_LAUNCHER) + 64;
  wchar_t *cmd = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, n * sizeof(wchar_t));
  if (!cmd) return 1;
  _snwprintf(cmd, n, L"node \"%ls\" %ls %ls", SHIM_LAUNCHER, SHIM_TOOL, args);
  cmd[n - 1] = 0;
  SetEnvironmentVariableW(L"BOOTJDK_SHIM_HOME", SHIM_HOME);

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fwprintf(stderr, L"shim %ls: cannot run node (error %lu)\n", SHIM_TOOL, GetLastError());
    return 1;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return (int)code;
}
