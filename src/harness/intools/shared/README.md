# shared 公共基础

跨工具复用的基础设施。按职责分子目录；`common.mjs` 为最底层校验与结果辅助，无目录依赖。

| 路径 | 职责 |
| --- | --- |
| `common.mjs` | 文本/整数校验、路径包含判断、`textResult` / `jsonResult`、中止错误 |
| `http/` | 联网工具共用的 HTTP 客户端、重试与 URL/字节校验（供 `network/fetch`、`network/websearch`） |
| `store/` | `MemoryStore` 会话持久化及工具侧 `assertSession` / `toolResult` 等辅助 |
| `process/` | 进程输出合并、本机 spawn、进程树终止、持久 shell、命令队列、中断控制 |

公开 SDK 仍通过 `../index.mjs` 导出 `MemoryStore`；其他模块路径属内部实现。

运行本目录测试：

```sh
node --test "src/harness/intools/shared/**/test/*.test.mjs"
```
