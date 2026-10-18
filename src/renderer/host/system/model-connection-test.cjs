'use strict';

function isByteString(value) {
  if (typeof value !== 'string' || !value) return false;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 255) return false;
  }
  return true;
}

function describeError(error) {
  const message = String(error?.message || error?.errorMessage || '').trim();
  // Preserve intentional, user-facing Chinese errors thrown by this module.
  if (/^请填写 API Key|^API Key 含有非英文字符|^模型配置无效。$/.test(message)) return message;
  const text = String(error?.status || error?.statusCode || '') + ' ' + String(error?.code || '') + ' ' + String(error?.name || '') + ' ' + message;
  if (/ByteString|greater than 255|ISO-8859-1|Latin.?1/i.test(text)) {
    return 'API Key 或请求头含有非英文字符（例如中文）。请清空 API Key 输入框以使用已保存密钥，或重新粘贴纯英文/数字密钥。';
  }
  if (/timed? ?out|ETIMEDOUT|TimeoutError|AbortError/i.test(text)) return '连接超时，请检查地址、网络或防火墙。';
  if (/401|403|unauthorized|forbidden|invalid.?api.?key|incorrect.?api.?key|authentication/i.test(text)) return '认证失败，请检查 API Key 是否正确且适用于该服务地址。';
  if (/404|not.?found|unknown.?model|model.?not.?exist|model.?not.?found/i.test(text)) return '模型或接口不存在，请检查模型 ID、协议与服务地址。';
  if (/402|insufficient.?balance|insufficient.?quota|insufficient.?funds|payment.?required|billing|quota.?exceeded|余额不足|欠费/i.test(text)) return '账户余额或额度不足，请充值或检查服务商的配额。';
  if (/context.?length|maximum.?context|context.?window.{0,40}(exceed|too|limit)|too many tokens|token.?limit|prompt.{0,20}too.?long/i.test(text)) return '请求超出模型上下文窗口，请缩短上下文或换用更大窗口的模型。';
  if (/reasoning_effort|reasoning.?effort|thinking.{0,24}(not.?support|unsupported|invalid)|不支持.{0,8}(思考|推理)/i.test(text)) return '模型不支持所选推理/思考参数，请调整思考级别后重试。';
  if (/429|rate.?limit|too many requests/i.test(text)) return '请求过于频繁，请稍后重试。';
  if (/50[0234]|overloaded|server.?busy|temporarily.?unavailable|服务繁忙|服务暂时不可用/i.test(text)) return '服务暂时不可用或繁忙，请稍后重试。';
  if (/400|422|invalid.?request|invalid.?parameter|bad.?request/i.test(text)) return '请求参数无效，请检查模型 ID、协议、思考级别与最大输出 Token。';
  if (/ECONNREFUSED/i.test(text)) return '连接被拒绝，请检查服务地址与端口。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '无法解析服务地址，请检查 URL 和 DNS。';
  if (/certificate|SSL|TLS/i.test(text)) return 'TLS/证书校验失败，请检查 HTTPS 地址或代理。';
  if (/429|rate.?limit/i.test(text)) return '请求过于频繁，请稍后重试。';
  if (/TypeError|must be|Invalid |Unknown |requires api|nonempty string/i.test(text)) {
    const detail = String(error?.message || '').trim();
    return detail ? `模型配置无效：${detail}` : '模型配置无效，请检查服务商、模型 ID、协议与服务地址。';
  }
  return '模型连接失败，请检查服务商、地址、协议与 API Key。';
}

function createModelConnectionTest({ loadModelClient }) {
  let active, disposed = false;
  return {
    async test(draft) {
      if (disposed) return { ok: false, message: '连接测试已关闭。' };
      if (active) return { ok: false, message: '已有连接正在测试，请稍后重试。' };
      const operation = { controller: new AbortController() };
      active = operation;
      const start = Date.now();
      const timer = setTimeout(() => operation.controller.abort(new Error('Model connection timeout')), 20000);
      try {
        const { createModelClient } = await loadModelClient();
        operation.controller.signal.throwIfAborted();
        if (!draft || typeof draft !== 'object') throw new Error('模型配置无效。');
        const apiKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : '';
        if (!apiKey) throw new Error('请填写 API Key 后再测试连接。');
        // fetch Headers only accept ByteString values. A Chinese character in the
        // key becomes Authorization: Bearer <key> and fails at the first non-Latin1
        // code unit (often index 7, right after "Bearer ").
        if (!isByteString(apiKey)) {
          throw new Error('API Key 含有非英文字符（例如中文）。请清空输入框以使用已保存密钥，或重新粘贴纯英文/数字密钥。');
        }
        // Keep the probe independent of advanced draft knobs (reasoning level,
        // custom maxTokens, compat). Those can break a connectivity check even
        // when the endpoint and key are fine.
        const client = createModelClient({
          provider: draft.provider,
          modelId: draft.modelId,
          api: draft.api,
          baseUrl: draft.baseUrl,
          apiKey,
          streamOptions: { maxTokens: 16, maxRetries: 0, timeoutMs: 20000 },
        });
        operation.controller.signal.throwIfAborted();
        const aborted = new Promise((_, reject) => {
          if (operation.controller.signal.aborted) {
            reject(operation.controller.signal.reason || new Error('Model connection timeout'));
            return;
          }
          operation.controller.signal.addEventListener('abort', () => {
            reject(operation.controller.signal.reason || new Error('Model connection timeout'));
          }, { once: true });
        });
        const stream = await Promise.race([
          client.streamFn(client.model, {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
          }, { signal: operation.controller.signal, maxTokens: 16, maxRetries: 0, timeoutMs: 20000 }),
          aborted,
        ]);
        const result = await Promise.race([stream.result(), aborted]);
        operation.controller.signal.throwIfAborted();
        if (result?.stopReason === 'error' || result?.errorMessage) {
          throw Object.assign(new Error(result.errorMessage || '模型返回错误'), { code: result.stopReason });
        }
        return { ok: true, durationMs: Date.now() - start, message: '连接成功，服务地址与凭据可用。' };
      } catch (error) {
        if (operation.controller.signal.aborted && /timeout/i.test(String(operation.controller.signal.reason?.message || error?.message || ''))) {
          return { ok: false, message: '连接超时，请检查地址、网络或防火墙。' };
        }
        return { ok: false, message: describeError(error) };
      } finally {
        clearTimeout(timer);
        if (active === operation) active = undefined;
      }
    },
    dispose() {
      disposed = true;
      if (active) active.controller.abort(new Error('Model test closed'));
    }
  };
}

module.exports = { createModelConnectionTest, describeError, isByteString };
