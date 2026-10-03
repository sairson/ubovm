'use strict';
// SDKs may throw arbitrary values, including proxies, getters and functions.
// Error reporting must neither execute conversions nor send uncloneable fields.
function serializeError(error) {
  const read = key => { try { return error?.[key]; } catch { return undefined; } };
  const message = read('message'), name = read('name'), code = read('code'), status = read('status');
  return {
    name: typeof name === 'string' ? name.slice(0, 128) : 'Error',
    message: (typeof message === 'string' ? message : typeof error === 'string' ? error : 'Agent operation failed').slice(0, 16000),
    ...(typeof code === 'string' ? { code: code.slice(0, 128) } : {}),
    ...(Number.isSafeInteger(status) ? { status } : {})
  };
}
module.exports = { serializeError };
