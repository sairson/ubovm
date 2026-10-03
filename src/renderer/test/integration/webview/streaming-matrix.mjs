import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

// Each scenario compares every intermediate stream with a newly rendered
// reference, including edits and the final non-streaming commit.
const scenarios = [
  ['plain prose', 'A simple answer grows one word at a time.'],
  ['Chinese punctuation', '这是流式输出。中文标点、换行和长段落都应当正确。'],
  ['Unicode and emoji', '👩🏽‍💻 UTF-16 边界 e\u0301 🚀 𠮷'],
  ['emphasis boundaries', 'Some **bold** and *italic* and ~~deleted~~ words.'],
  ['inline code', 'Use `const x = 1` and ``a ` b`` safely.'],
  ['escaped punctuation', '\\*literal\\* \\_word\\_ \\`code\\`'],
  ['entities', '&amp; &lt; &gt; &#39; &#x1f680;'],
  ['soft and hard breaks', 'first\nsecond  \nthird\\\nfourth'],
  ['setext heading', 'Title\n=====\n\nContent\n-----\n'],
  ['ATX headings', '# Heading\n\n## Next\n\nBody'],
  ['horizontal rules', 'Before\n\n---\n\n***\n\nAfter'],
  ['unordered lists', '- one\n- two\n  - nested\n\nAfter'],
  ['ordered lists', '1. one\n2. two\n   1. nested\n\nAfter'],
  ['loose lists', '- one\n\n  second paragraph\n\n- two'],
  ['task lists', '- [ ] pending\n- [x] complete'],
  ['block quotes', '> quote\n>\n> **nested**\n\nAfter'],
  ['GFM tables', 'Name | Value\n:--- | ---:\na | 1\nb | 2\n'],
  ['escaped table pipes', 'Name | Value\n--- | ---\na\\|b | `x`\n'],
  ['backtick fence', '```js\nconst x = 1;\nconsole.log(x);\n```\n\nAfter'],
  ['tilde fence', '~~~python\nprint("hello")\n~~~\n\nAfter'],
  ['nested fence', '- example\n\n  ```js\n  const x = 1;\n  ```'],
  ['indented code', '    const x = 1;\n    const y = 2;\n\nAfter'],
  ['direct and automatic links', '[link](https://example.com) <https://example.org> https://example.net'],
  ['reference definitions', '[ref] and [label][ref]\n\n[ref]: https://example.com "title"'],
  ['definitions before use', '[ref]: https://example.com\n\nText [ref] later.'],
  ['HTML sanitization', '<div><b>safe</b><script>alert(1)</script><img src=x onerror=alert(1)></div>'],
  ['HTML details', '<details><summary>More</summary><p>Body</p></details>'],
  ['CRLF and tabs', 'First\r\n\r\n```js\r\n\tconst x = 1;\r\n```\r\n'],
  ['rewrites and deletion', 'Original **answer**\n\nSecond paragraph', ['Replacement *text*', '', 'Restored **answer**']],
  ['long paragraph and code', 'text '.repeat(300) + '\n\n```js\n' + 'const x = 1;\n'.repeat(100) + '```', undefined, 43],
  ['empty fence and blank lines', '```\n\n\ntext\n\n```\n', undefined, 1],
  ['split closing fence with spaces', '```js\nx\n  ```\t\n\nAfter', undefined, 1],
  ['short and mixed fence markers', '````js\nx\n```\n~~~\n`~`\n`````\nAfter', undefined, 1],
  ['indented fence body', '  ```js\n  one\n two\n    three\n  ```\nAfter', undefined, 1],
  ['four space non-closing marker', '```\nx\n    ```\nmore\n```\nAfter', undefined, 1],
  ['carriage return inside growing fence', '```js\none\r\ntwo\rthree\r\n```\r\nAfter', undefined, 1],
  ['closing tilde with trailing text', '~~~\none\n~~~text\nmore\n~~~~\nAfter', undefined, 1]
];
let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
test.after(async () => { await browser?.close(); });

for (const [index, [name, body, rewrites = [], stride = 3]] of scenarios.entries()) {
  test(`round ${String(index + 1).padStart(2, '0')}: ${name}`, async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} });
      });
      await page.route('http://stream-matrix.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
      await page.goto('http://stream-matrix.test/');
      const result = await page.evaluate(({ body, rewrites, stride }) => {
        const target = document.createElement('div'), reference = document.createElement('div');
        document.body.append(target, reference);
        const prefix = Array.from({ length: 24 }, (_, i) => `Completed paragraph ${i}.\n\n`).join('');
        let steps = 0;
        const check = (text, streaming) => {
          UBOVMMarkdown.update(target, text, { streaming });
          UBOVMMarkdown.release(reference); reference.replaceChildren();
          UBOVMMarkdown.update(reference, text, { streaming });
          steps++;
          if (target.innerHTML !== reference.innerHTML) return { steps, mismatch: text.slice(-250), actual: target.lastChild?.outerHTML, expected: reference.lastChild?.outerHTML };
        };
        try {
          for (let i = 1; i < body.length; i += stride) {
            const mismatch = check(prefix + body.slice(0, i), true);
            if (mismatch) return mismatch;
          }
          for (const text of [prefix + body, ...rewrites]) {
            const mismatch = check(text, true) || check(text, false);
            if (mismatch) return mismatch;
          }
          return { steps, safe: !target.querySelector('script,iframe,img,[onerror]') };
        } finally { UBOVMMarkdown.release(target); UBOVMMarkdown.release(reference); target.remove(); reference.remove(); }
      }, { body, rewrites, stride });
      assert.equal(result.mismatch, undefined, JSON.stringify(result));
      assert.equal(result.safe, true);
    } finally { await page.close(); }
  });
}
