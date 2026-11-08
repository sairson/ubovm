const moduleName = value => value?.trim().replace(/^['"]|['"]$/g, '').split('.')[0] || '';

/** Turn common Python process failures into actionable, non-executing advice. */
export function diagnosePythonFailure(text = '') {
  const source = String(text);
  let match = /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/.exec(source);
  if (match) {
    const module = moduleName(match[1]);
    return {
      kind: 'missing-module', module,
      summary: `缺少 Python 模块：${match[1]}`,
      recovery: `使用 manage_python_environment 的 sync 操作安装对应依赖（packages 中填写包名），然后重试。模块名与 PyPI 包名可能不同，请先核对项目依赖文件。`
    };
  }
  match = /(?:ImportError|ModuleNotFoundError):\s*(?!No module named)([^\r\n]+)/.exec(source);
  if (match) return { kind: 'import-error', summary: 'Python 导入依赖失败', recovery: `检查当前托管环境、解释器版本和项目依赖；必要时用 manage_python_environment 执行 list/check 或 sync。原始信息：${match[1].trim()}` };
  match = /(?:the following arguments are required:|required positional argument[s]?:)\s*([^\r\n]+)/i.exec(source);
  if (match) return { kind: 'missing-arguments', arguments: match[1].trim(), summary: 'Python 脚本缺少必需参数', recovery: `在 run_python.arguments 中按脚本定义补齐参数：${match[1].trim()}` };
  match = /TypeError:\s*[^\r\n]*missing\s+(?:\d+\s+)?required positional argument[s]?:?\s*([^\r\n]*)/i.exec(source);
  if (match) return { kind: 'missing-arguments', arguments: match[1].trim(), summary: 'Python 调用缺少必需参数', recovery: '检查函数调用或在 run_python.arguments 中补齐脚本参数。' };
  match = /FileNotFoundError:\s*\[Errno 2\][^\r\n]*:\s*([^\r\n]+)/.exec(source);
  if (match) return { kind: 'missing-file', path: match[1].trim(), summary: 'Python 访问的文件或目录不存在', recovery: '确认 cwd、脚本相对路径和 arguments 中的输入路径；相对路径以 Python 的实际 cwd 为准。' };
  if (/PYTHON_TIMEOUT|Python execution timed out after/i.test(source))
    return { kind: 'timeout', summary: 'Python 执行超时被终止', recovery: '调大 timeout_seconds（受 IDE 最大超时限制），检查死循环、阻塞的网络或交互式等待；先用更小的输入缩小脚本范围再重试。已生成的文件仍保存在 output_directory。' };
  if (/PYTHON_SANDBOX_UNAVAILABLE|not provisioned|sandbox is unavailable|is unsupported on this platform|未就绪|初始化 Python 沙箱/i.test(source))
    return { kind: 'sandbox-unavailable', summary: 'Python 沙箱尚未就绪，本次未执行任何代码', recovery: '请用户在 IDE 中运行命令“UBOVM: 初始化 Python 沙箱”（初始化 Python 沙箱），完成后重试；若初始化失败，请按提示修复沙箱账户或系统依赖。' };
  if (/PermissionError|Errno 13|WinError 5|Operation not permitted|Read-only file system/i.test(source))
    return { kind: 'write-denied', summary: 'Python 无法读取或写入目标路径（沙箱或文件权限限制）', recovery: 'IDE 设置中可能未启用工作区写入，或目标路径属于受保护目录。请把产物写入 UBOVM_PYTHON_OUTPUT（结果中的 output_directory）后重试；若确实需要写入工作区，请让用户在 IDE 设置中开启“允许写入工作区”。' };
  return undefined;
}
