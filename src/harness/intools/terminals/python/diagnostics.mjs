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
  return undefined;
}
