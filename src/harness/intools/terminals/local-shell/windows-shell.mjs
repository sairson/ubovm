import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Windows shell resolution and error normalization for the local shell tool.
 *
 * The DeepSeek Harness PowerShell executor prefers PowerShell 7 (`pwsh.exe`)
 * from well-known install roots, then PATH entries, then falls back to Windows
 * PowerShell 5.1. It also runs `-Command <preamble + command>` rather than
 * `-EncodedCommand`: encoded commands make Windows PowerShell serialize stderr
 * as CLIXML (`#< CLIXML`), which is unreadable in tool output. A fresh
 * non-interactive process per call mirrors the harness pwsh semantics.
 */

const WINDOWS_POWERSHELL = env =>
  join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function safeProbe(probe, path) {
  try { return Boolean(path) && probe(path); } catch { return false; }
}

function pathEntries(env) {
  return String(env.PATH || env.Path || '')
    .split(';')
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/** Candidate pwsh.exe locations in DSH preference order. */
export function pwshCandidates({ env = process.env } = {}) {
  const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter(Boolean)
    .map(root => join(root, 'PowerShell'));
  const candidates = [];
  if (env.UBOVM_PWSH_PATH) candidates.push(env.UBOVM_PWSH_PATH);
  for (const root of programFiles) {
    candidates.push(join(root, '7', 'pwsh.exe'), join(root, '7-preview', 'pwsh.exe'));
  }
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  for (const entry of pathEntries(env)) candidates.push(join(entry, 'pwsh.exe'));
  return [...new Set(candidates)];
}

/**
 * Resolve the shell executable this host should use. Returns `pwsh` when an
 * install is found, otherwise Windows PowerShell 5.1, and `/bin/sh` elsewhere.
 */
export function resolveLocalShell({ platform = process.platform, env = process.env, probe = existsSync } = {}) {
  if (platform !== 'win32') return { executable: '/bin/sh', kind: 'sh' };
  for (const candidate of pwshCandidates({ env })) {
    if (safeProbe(probe, candidate)) return { executable: candidate, kind: 'pwsh' };
  }
  const fallback = WINDOWS_POWERSHELL(env);
  return { executable: fallback, kind: 'powershell' };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the XML entity forms Windows PowerShell uses in CLIXML strings. */
function decodeEntities(value) {
  return value
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (match, name) => ENTITIES[name] || match);
}

/**
 * Windows PowerShell writes redirected error records as a CLIXML document when
 * the command is encoded. Convert that document to readable text; return the
 * input unchanged when it is not CLIXML.
 */
export function decodePowerShellError(text) {
  if (typeof text !== 'string' || !text.includes('#< CLIXML')) return text;
  const start = text.indexOf('#< CLIXML');
  const head = text.slice(0, start).replace(/\s+$/u, '');
  const payload = text.slice(start);
  const errors = [];
  for (const match of payload.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)) {
    const line = decodeEntities(match[1]).replace(/\s+$/u, '');
    if (line) errors.push(line);
  }
  if (!errors.length) {
    // Progress records or malformed serialization: drop the XML wrapper instead
    // of showing the raw document to the model.
    return head || 'PowerShell command failed with serialized error output.';
  }
  return [head, ...errors].filter(Boolean).join('\n');
}

const ACCESS_DENIED = /Access is denied|UnauthorizedAccess|AccessDenied|PermissionDenied|CreateDirectoryUnauthorizedAccessError|对路径.{0,200}的访问被拒绝|拒绝访问/iu;

export function isAccessDenied(text) {
  return typeof text === 'string' && ACCESS_DENIED.test(text);
}

/** Reproduce a failed shell result as a readable tool error. */
export function normalizeShellFailure(error, details = {}) {
  const raw = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const message = decodePowerShellError(raw);
  const denied = isAccessDenied(message);
  const failure = new Error(denied
    ? `${message}\n当前进程对 ${details.cwd || '工作目录'} 没有写权限。常见原因：IDE 继承了 Codex/DSH 等沙箱的低完整性令牌，或目录 ACL 未授予当前用户写权限。请从普通桌面/终端重新启动 IDE，或检查该目录的 Windows 文件权限。`
    : message);
  failure.name = error?.name || 'Error';
  if (denied) failure.code = 'LOCAL_SHELL_ACCESS_DENIED';
  else if (error?.code !== undefined) failure.code = error.code;
  failure.details = { ...(error?.details || {}), ...details, ...(denied ? { denied: true } : {}) };
  failure.cause = error;
  return failure;
}
