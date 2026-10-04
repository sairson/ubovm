// Shared by the extension host and its webviews; no platform dependencies.
(function (root) {
  'use strict';
  function redact(value) {
    return String(value).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[私钥已隐藏]')
      .replace(/((?:api[_-]?key|password|passphrase|token|secret|authorization)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*?\2/gi, '$1"[已隐藏]"')
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[认证信息已隐藏]')
      .replace(/((?:api[_-]?key|password|passphrase|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[已隐藏]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[已隐藏]');
  }
  function tr(message, ...args) {
    let text = message;
    try { text = globalThis.UBOVMi18n?.t(message, ...args) ?? message; }
    catch { text = message; }
    if (!globalThis.UBOVMi18n && args.length) text = String(text).replace(/\{(\d+)\}/g, (match, index) => args[index] == null ? match : String(args[index]));
    return text;
  }
  const actions = Object.freeze({ prompt: '发送消息', setMode: '切换模式', newChat: '新建会话', saveGoal: '保存目标', runGoal: '开始执行', cancelRun: '停止执行', interruptCommand: '中断命令', backgroundCommand: '放在一边', resumeRun: '恢复执行', addGoalNote: '保存笔记', toggleGoalCriterion: '更新验收项', attachFile: '添加附件', clearFileContext: '移除附件', selectWorkspace: '选择工作空间', openExploration: '打开探索记录', copyText: '复制内容', openMessageLink: '打开链接', reviewCodeChanges: '查看代码更改', validateCodeChanges: '验证代码更改', setTheme: '切换主题', settingsRead: '读取配置', settingsSave: '保存配置', settingsTestSSH: '测试 SSH 连接', settingsInstallBrowser: '安装浏览器' });
  function title(error) { const value = normalize(error); return tr(actions[value.action] || '操作') + tr(value.cancelled ? '已取消' : '未完成'); }
  function normalize(error, action = '') {
    try { return normalizeValue(error, action); }
    catch {
      // SDKs and extensions can reject with arbitrary objects. A throwing
      // accessor or conversion must not break the error recovery surface.
      return { code: 'OPERATION_FAILED', message: tr('操作未能完成，请稍后重试。'), hint: '', detail: '',
        action: typeof action === 'string' ? action : '', cancelled: false };
    }
  }
  function normalizeValue(error, action = '') {
    const source = error && typeof error === 'object' ? error : {};
    action = action || (typeof source.action === 'string' ? source.action : '');
    if (typeof source.message === 'string' && typeof source.hint === 'string' && typeof source.detail === 'string') {
      return { code: redact(source.code || 'OPERATION_FAILED').slice(0, 80), message: tr(redact(source.message).trim().slice(0, 800) || '操作未能完成，请稍后重试。'), hint: tr(redact(source.hint).slice(0, 800)), detail: redact(source.detail).slice(0, 4000), action, cancelled: source.cancelled === true };
    }
    const chain = [], seen = new Set();
    let current = error;
    while (current && chain.length < 6 && !seen.has(current)) {
      seen.add(current); chain.push(current);
      current = typeof current === 'object' ? current.cause || current.error : undefined;
    }
    const messages = chain.map(item => typeof item === 'string' ? item : typeof item.message === 'string' ? item.message : '').filter(Boolean);
    const raw = [...new Set(messages)].join('\n');
    const detail = redact(raw).trim().slice(0, 4000);
    const code = redact(chain.find(item => typeof item?.code === 'string')?.code || '').slice(0, 80);
    const status = chain.map(item => Number(item?.status || item?.statusCode || item?.response?.status)).find(value => value >= 400 && value <= 599)
      || Number(/(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[\s:=]+)([45]\d{2})\b/i.exec(raw)?.[1]);
    const match = [code, ...chain.map(item => item?.name), raw].join(' ');
    let message = detail.split(/\n\s*at /)[0].slice(0, 800) || tr('操作未能完成，请稍后重试。');
    let hint = '', category = 'OPERATION_FAILED';
    if (/AbortError|ABORT_ERR|^CANCELLED\b|^(?:Error )?(?:cancelled|canceled)(?:$|[.:])/i.test(match.trim())) { category = 'CANCELLED'; message = tr('操作已取消。'); }
    else if (/AGENT_HEARTBEAT_TIMEOUT|AGENT_THREAD_EXIT/i.test(match)) { category = code || (/AGENT_HEARTBEAT_TIMEOUT/i.test(match) ? 'AGENT_HEARTBEAT_TIMEOUT' : 'AGENT_THREAD_EXIT'); message = tr('Agent 后端连接已中断。'); hint = tr('运行中的任务已停止；若出现“继续执行”，可从检查点恢复，请勿重复提交。'); }
    else if (/SERVICE_CLOSED/i.test(match)) { category = 'SERVICE_CLOSED'; message = tr('Agent 服务已关闭。'); hint = tr('请重新打开面板或重启应用后再试。'); }
    else if (/RPC_BUSY/i.test(match)) { category = 'RPC_BUSY'; message = tr('Agent 正在处理其他请求。'); hint = tr('请稍候再试，或先停止当前执行。'); }
    else if (status === 401 || /unauthorized|invalid.api.key|authentication failed|all configured authentication methods failed/i.test(match)) { category = 'AUTHENTICATION_FAILED'; message = tr('身份验证失败。'); hint = tr('请检查对应服务的密钥或登录凭据。'); }
    else if (status === 403 || /forbidden|EACCES|EPERM|permission denied/i.test(match)) { category = 'PERMISSION_DENIED'; message = tr('没有执行此操作的权限。'); hint = tr('请检查文件权限或服务账号的访问权限。'); }
    else if (status === 429 || /rate.limit|quota.exceeded|insufficient.quota/i.test(match)) { category = 'RATE_LIMITED'; message = tr('服务请求受限或额度不足。'); hint = tr('请稍后重试，并检查服务额度。'); }
    else if (/SSH command timed out|Shell command timed out|Shell queue wait timed out/i.test(match)) {
      category = 'TIMEOUT';
      const seconds = Number(/timed out after (\d+) seconds/i.exec(raw)?.[1]);
      message = Number.isFinite(seconds) ? tr('远程命令已超时（{0} 秒）。', seconds) : tr('远程命令已超时。');
      hint = tr('请提高 timeout_seconds，或对长期运行的服务使用 retain=true。远程进程已按超时结束，请勿当作界面等待超时重试。');
    }
    else if (/ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError|timed?\s*out/i.test(match)) { category = 'TIMEOUT'; message = tr('等待操作结果超时。'); hint = tr('操作可能仍在执行，请先确认当前状态，再决定是否重试。'); }
    else if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network error|Failed to fetch/i.test(match)) { category = 'NETWORK_ERROR'; message = tr('无法连接到服务。'); hint = tr('请检查网络、服务地址和代理设置。'); }
    else if (/ENOENT|FileNotFound/i.test(match)) { category = 'NOT_FOUND'; message = tr('所需文件或程序不存在。'); hint = tr('请检查路径，以及所需组件是否已安装。'); }
    else if (/ENOSPC/i.test(match)) { category = 'STORAGE_FULL'; message = tr('存储空间不足，无法完成写入。'); hint = tr('请释放磁盘空间后重试。'); }
    else if ([500, 502, 503, 504].includes(status)) { category = 'SERVICE_UNAVAILABLE'; message = tr('服务暂时不可用。'); hint = tr('请稍后重试，或检查服务运行状态。'); }
    return { code: code || category, message, hint, detail, action, cancelled: category === 'CANCELLED' };
  }
  function text(error) { const value = normalize(error); return value.message + (value.hint ? ' ' + value.hint : ''); }
  const api = { normalize, text, redact, title };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UBOVMErrors = api;
})(globalThis);
