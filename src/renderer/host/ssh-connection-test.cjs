'use strict';

function describeError(error) {
  const text = String(error?.code || '') + ' ' + String(error?.message || '');
  if (/timed? ?out|ETIMEDOUT|timeout/i.test(text)) return '连接超时，请检查主机、端口、网络或防火墙。';
  if (/authentication|authenticate|auth fail/i.test(text)) return '认证失败，请检查用户名、密码、私钥及私钥口令。';
  if (/host.*(verify|verification|key)|known.host/i.test(text)) return '主机身份校验失败，请检查 known_hosts 或主机指纹。';
  if (/ECONNREFUSED/i.test(text)) return '连接被拒绝，请检查端口及 SSH 服务是否启动。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '无法解析主机地址，请检查地址和 DNS。';
  if (/ENOENT|EACCES|private.*key|passphrase/i.test(text)) return '无法读取认证文件或解析私钥，请检查路径、权限和私钥口令。';
  return 'SSH 连接失败，请检查网络、认证方式和主机配置。';
}

function createSSHConnectionTest({ loadSSH }) {
  let active, disposed = false;
  return {
    async test(profile) {
      if (disposed) return { ok: false, message: '连接测试已关闭。' };
      if (active) return { ok: false, message: '已有连接正在测试，请稍后重试。' };
      const operation = { controller: new AbortController(), connection: null };
      active = operation;
      const start = Date.now();
      const seconds = Math.min(profile.connect_timeout_seconds ?? 10, 30);
      const timer = setTimeout(() => operation.controller.abort(new Error('SSH timeout')), seconds * 1000);
      try {
        const { SSHCommands } = await loadSSH();
        operation.controller.signal.throwIfAborted();
        operation.connection = new SSHCommands({ ...profile, connect_timeout_seconds: seconds });
        await operation.connection.waitForConnection(operation.controller.signal);
        return { ok: true, durationMs: Date.now() - start, message: profile.known_hosts_file || profile.host_key_sha256 ? '连接成功，主机身份校验与登录认证通过。' : '连接成功，登录认证通过（未校验主机身份）。' };
      } catch (error) {
        return { ok: false, message: describeError(error) };
      } finally {
        clearTimeout(timer);
        try { await operation.connection?.close(); } catch { /* Always release the test slot. */ }
        if (active === operation) active = undefined;
      }
    },
    dispose() { disposed = true; active?.controller.abort(); void active?.connection?.close().catch(() => {}); }
  };
}
module.exports = { createSSHConnectionTest };
