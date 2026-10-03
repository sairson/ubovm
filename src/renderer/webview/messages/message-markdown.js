/* Local Marked lexer + static DOM renderer. All model HTML is untrusted. */
(() => {
  'use strict';
  const views = new WeakMap(), largeViews = new WeakMap();
  const richTextLimit = 256 * 1024;
  const safeTags = new Set(['A', 'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'U', 'SMALL', 'MARK', 'SUB', 'SUP', 'CODE', 'PRE', 'KBD', 'SAMP', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SPAN', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD', 'ABBR', 'TIME']);
  const excludedTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'FORM', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'CANVAS', 'TEMPLATE', 'NOSCRIPT']);
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const sourceText = value => typeof value === 'string' ? value : '';
  const languageName = value => /^[\w.+#-]+/.exec(sourceText(value).trim())?.[0].toLowerCase() || 'text';
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };

  function linkTarget(value) {
    const href = sourceText(value).trim();
    if (!href || /[\u0000-\u001f\u007f]/.test(href) || /^[\\/]{2}/.test(href)) return undefined;
    if (/^https?:|^mailto:/i.test(href)) {
      try {
        const parsed = new URL(href);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
        return { value: parsed.href, external: true };
      } catch { return undefined; }
    }
    // Local paths are callback-only buttons. The host owns path confinement and
    // file validation; the webview never navigates or fetches a model file path.
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return undefined;
    if (href.startsWith('#')) return undefined;
    return { value: href, external: false };
  }

  function sanitize(html) {
    // Template contents are inert: parsing cannot execute scripts or fetch image
    // URLs. Only newly constructed allowlisted nodes leave this detached tree.
    const template = document.createElement('template');
    template.innerHTML = html;
    let count = 0;
    const clean = (source, depth = 0) => {
      if (++count > 12000 || depth > 60) return document.createTextNode('');
      if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.data);
      if (source.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
      const tag = source.tagName;
      if (excludedTags.has(tag)) return document.createTextNode('');
      if (tag === 'IMG') {
        const alt = source.getAttribute('alt') || '图片';
        return node('span', 'md-image-placeholder', '[' + alt + ']');
      }
      if (tag === 'INPUT') {
        if (source.getAttribute('type')?.toLowerCase() !== 'checkbox') return document.createTextNode('');
        const checkbox = node('input', 'md-task-checkbox');
        checkbox.type = 'checkbox'; checkbox.disabled = true;
        checkbox.checked = source.hasAttribute('checked');
        if (checkbox.checked) checkbox.setAttribute('checked', '');
        checkbox.setAttribute('aria-label', checkbox.checked ? '已完成' : '未完成');
        return checkbox;
      }
      let target;
      if (tag === 'A') {
        const link = linkTarget(source.getAttribute('href'));
        target = node(link?.external ? 'a' : link ? 'button' : 'span', link ? 'md-link' : 'md-invalid-link');
        if (link) {
          target.dataset.mdLink = link.value;
          if (link.external) { target.setAttribute('href', link.value); target.setAttribute('rel', 'noopener noreferrer'); }
          else { target.type = 'button'; target.classList.add('md-file-link'); }
        }
      } else target = safeTags.has(tag) ? node(tag.toLowerCase()) : document.createDocumentFragment();
      if (target.nodeType === Node.ELEMENT_NODE) {
        const title = source.getAttribute('title');
        if (title) target.setAttribute('title', title.slice(0, 1000));
        if (tag === 'OL' && /^-?\d{1,6}$/.test(source.getAttribute('start') || '')) target.setAttribute('start', source.getAttribute('start'));
        if (tag === 'DETAILS' && source.hasAttribute('open')) target.setAttribute('open', '');
        if (tag === 'CODE') {
          const language = /(?:^|\s)language-([\w.+#-]+)(?:\s|$)/.exec(source.getAttribute('class') || '');
          if (language) target.dataset.mdLanguage = language[1].toLowerCase();
        }
        if (['TD', 'TH'].includes(tag)) {
          for (const attribute of ['colspan', 'rowspan']) {
            const value = Number(source.getAttribute(attribute));
            if (Number.isInteger(value) && value >= 1 && value <= 40) target.setAttribute(attribute, String(value));
          }
          const alignment = source.getAttribute('align');
          if (['left', 'right', 'center'].includes(alignment)) target.classList.add('md-align-' + alignment);
        }
      }
      for (const child of source.childNodes) target.appendChild(clean(child, depth + 1));
      return target;
    };
    const result = document.createDocumentFragment();
    for (const child of template.content.childNodes) result.appendChild(clean(child));
    return result;
  }

  function patchChildren(parent, incoming) {
    const desired = [...incoming.childNodes];
    for (let index = 0; index < desired.length; index++) {
      const next = desired[index], current = parent.childNodes[index];
      if (!current) { parent.appendChild(next); continue; }
      if (current.nodeType !== next.nodeType || (current.nodeType === Node.ELEMENT_NODE && current.tagName !== next.tagName)) {
        parent.replaceChild(next, current); continue;
      }
      if (current.nodeType === Node.TEXT_NODE) {
        if (current.data !== next.data) {
          if (next.data.startsWith(current.data)) current.appendData(next.data.slice(current.data.length));
          else current.replaceData(0, current.length, next.data);
        }
        continue;
      }
      const stateAttribute = name => current.tagName === 'DETAILS' && name === 'open' || current.classList.contains('md-code-card') && name === 'data-expanded' || current.hasAttribute('data-md-toggle') && name === 'aria-expanded' || current.hasAttribute('data-md-copy') && ['disabled', 'title'].includes(name);
      // A user's expansion of static HTML details belongs to the view, not the
      // next partial model token. Every other attribute came from the allowlist.
      for (const attribute of [...current.attributes]) {
        if (stateAttribute(attribute.name)) continue;
        if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      }
      for (const attribute of next.attributes) {
        if (stateAttribute(attribute.name)) continue;
        if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      }
      if (current.tagName === 'INPUT') { current.disabled = true; current.checked = next.checked; }
      if (current.hasAttribute('data-md-copy') || current.hasAttribute('data-md-toggle')) continue;
      patchChildren(current, next);
    }
    while (parent.childNodes.length > desired.length) parent.lastChild.remove();
  }

  const aliases = { js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml' };
  const keywords = {
      javascript: /^(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield|interface|type|public|private|readonly|as)\b/,
      python: /^(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/,
      json: /^(?:true|false|null)\b/,
      shell: /^(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|then|until|while)\b/,
      sql: /^(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ORDER|BY|GROUP|HAVING|LIMIT|DISTINCT)\b/i
  };

  function highlightLine(text, language) {
    const fragment = document.createDocumentFragment();
    const kind = aliases[language] || language;
    // Minified payloads and generated data can contain megabyte-long lines.
    // Keep the complete text copyable without tokenizing it on every chunk.
    if (!Object.hasOwn(keywords, kind) || text.length > 8192) { fragment.appendChild(document.createTextNode(text)); return fragment; }
    let offset = 0, plain = '', spans = 0;
    const flush = () => { if (plain) { fragment.appendChild(document.createTextNode(plain)); plain = ''; } };
    while (offset < text.length) {
      if (spans >= 512) { plain += text.slice(offset); break; }
      const rest = text.slice(offset);
      const comment = ['python', 'shell'].includes(kind) ? /^#.*/.exec(rest) : kind === 'sql' ? /^--.*/.exec(rest) : /^(?:\/\/.*|\/\*.*)/.exec(rest);
      const string = /^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)/.exec(rest);
      const number = /^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/i.exec(rest);
      const keyword = (offset === 0 || !/[\w$]/.test(text[offset - 1])) ? keywords[kind].exec(rest) : null;
      const match = comment || string || number || keyword;
      if (match) {
        flush(); fragment.appendChild(node('span', comment ? 'md-token-comment' : string ? 'md-token-string' : number ? 'md-token-number' : 'md-token-keyword', match[0]));
        offset += match[0].length;
        spans++;
      } else {
        // Consume identifiers in one pass. Retrying a numeric regex at every
        // digit of an invalid numeric identifier otherwise becomes quadratic.
        const value = /^[\w$]+/.exec(rest)?.[0] || text[offset];
        plain += value; offset += value.length;
      }
    }
    flush(); return fragment;
  }

  function codeClosed(token) {
    const raw = token.raw || '';
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(raw);
    if (!opening) return true;
    const end = raw.trimEnd(), start = end.lastIndexOf('\n') + 1;
    if (start < opening[0].length) return false;
    const ending = /^ {0,3}(`+|~+)[ \t]*$/.exec(end.slice(start));
    return Boolean(ending && ending[1].length >= opening[1].length && ending[1][0] === opening[1][0]);
  }

  function appendOpenFence(token, appended) {
    // Only unindented, normalized fences have a verbatim body. Indentation,
    // CR normalization and possible closing fences stay with the real lexer.
    const opening = /^(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
    if (!opening || appended.includes('\r')) return;
    const body = token.raw.slice(opening[0].length);
    if (body.replace(/\n$/, '') !== token.text) return;
    const changedLines = token.raw.slice(token.raw.lastIndexOf('\n') + 1) + appended;
    const closing = new RegExp('^ {0,3}' + opening[1][0] + '{' + opening[1].length + ',}[ \\t]*(?:\\n|$)', 'm');
    if (closing.test(changedLines)) return;
    const raw = token.raw + appended;
    return { ...token, raw, text: raw.slice(opening[0].length).replace(/\n$/, '') };
  }

  function createCodeBlock(block, view) {
    const card = node('figure', 'md-code-card'); card.dataset.expanded = 'false';
    const toolbar = node('figcaption', 'md-code-toolbar');
    const language = node('span', 'md-code-language');
    const status = node('span', 'md-code-status'); status.setAttribute('aria-live', 'off');
    const actions = node('span', 'md-code-actions');
    const toggle = node('button', 'md-code-button', '展开代码'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
    const preview = node('button', 'md-code-button', '预览 HTML'); preview.type = 'button';
    const copy = node('button', 'md-code-button', '复制代码'); copy.type = 'button';
    const pre = node('pre'); const code = node('code'); pre.appendChild(code);
    const entry = { card, language, status, toggle, preview, copy, pre, code, lines: [], text: '', lang: '' };
    toggle.dataset.mdToggle = ''; copy.dataset.mdCopy = ''; preview.dataset.mdCodePreview = '';
    actions.append(toggle, preview, copy); toolbar.append(language, status, actions); card.append(toolbar, pre); block.element.appendChild(card);
    block.code = entry;
    return entry;
  }

  function renderCode(block, token, view, streaming) {
    const code = block.code || createCodeBlock(block, view);
    const language = languageName(token.lang), text = sourceText(token.text);
    setText(code.language, language);
    const active = streaming && !codeClosed(token);
    setText(code.status, active ? '生成中' : '');
    if (code.card.dataset.streaming !== String(active)) code.card.dataset.streaming = String(active);
    const previewHidden = !['html', 'htm', 'xhtml'].includes(language);
    const previewDisabled = typeof view.options.onPreviewHtml !== 'function';
    if (code.preview.hidden !== previewHidden) code.preview.hidden = previewHidden;
    if (code.preview.disabled !== previewDisabled) code.preview.disabled = previewDisabled;
    const append = code.lang === language && typeof code.text === 'string' && text.startsWith(code.text) && code.lines.length;
    const start = append ? code.lines.length - 1 : 0;
    const offset = append ? code.text.lastIndexOf('\n') + 1 : 0;
    const lines = text.slice(offset).split('\n'), count = start + lines.length;
    if (code.toggle.hidden !== (count <= 18)) code.toggle.hidden = count <= 18;
    const added = [], fragment = document.createDocumentFragment();
    for (const [localIndex, value] of lines.entries()) {
      const index = start + localIndex;
      const withNewline = value + (localIndex < lines.length - 1 ? '\n' : '');
      let line = code.lines[index];
      if (!line) {
        line = { element: node('span', 'md-code-line'), text: undefined, language: undefined };
        added.push(line); fragment.appendChild(line.element);
      }
      if (line.text !== withNewline || line.language !== language) {
        patchChildren(line.element, highlightLine(withNewline, language));
        line.text = withNewline; line.language = language;
      }
    }
    // Commit new lines together. Until highlighting succeeds, detached lines
    // never enter the cache, so a failed render can retry the same text safely.
    if (added.length) {
      code.code.appendChild(fragment);
      for (const line of added) code.lines.push(line);
    }
    while (code.lines.length > count) code.lines.pop().element.remove();
    code.text = text; code.lang = language;
  }

  function renderBlock(block, token, view, streaming) {
    if (token.type === 'code') { renderCode(block, token, view, streaming); return; }
    const fragment = sanitize(globalThis.marked.parser([token], { gfm: true, breaks: false }));
    // Marked also emits fences nested inside lists and block quotes. Decorate
    // those static nodes before reconciliation; the container delegates their
    // actions, so their existing DOM remains valid as the enclosing block grows.
    for (const code of [...fragment.querySelectorAll('pre > code')]) {
      const pre = code.parentElement, language = code.dataset.mdLanguage || 'text';
      const text = code.textContent.replace(/\n$/, '');
      const lines = text.split('\n');
      const card = node('figure', 'md-code-card'); card.dataset.expanded = 'false';
      const toolbar = node('figcaption', 'md-code-toolbar');
      const actions = node('span', 'md-code-actions');
      const toggle = node('button', 'md-code-button', '展开代码'); toggle.type = 'button'; toggle.dataset.mdToggle = ''; toggle.setAttribute('aria-expanded', 'false'); toggle.hidden = lines.length <= 18;
      const preview = node('button', 'md-code-button', '预览 HTML'); preview.type = 'button'; preview.dataset.mdCodePreview = ''; preview.hidden = !['html', 'htm', 'xhtml'].includes(language); preview.disabled = typeof view.options.onPreviewHtml !== 'function';
      const copy = node('button', 'md-code-button', '复制代码'); copy.type = 'button'; copy.dataset.mdCopy = '';
      actions.append(toggle, preview, copy); toolbar.append(node('span', 'md-code-language', language), actions);
      code.replaceChildren();
      for (const [index, value] of lines.entries()) {
        const line = node('span', 'md-code-line');
        line.appendChild(highlightLine(value + (index < lines.length - 1 ? '\n' : ''), language)); code.appendChild(line);
      }
      pre.replaceWith(card); card.append(toolbar, pre);
    }
    // Tables scroll within the message instead of widening the entire webview.
    for (const table of [...fragment.querySelectorAll('table')]) {
      const wrap = node('div', 'md-table-scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '表格');
      table.replaceWith(wrap); wrap.appendChild(table);
    }
    if (token.type === 'html' && /<!doctype\s+html\b|<html[\s>]/i.test(token.raw || '')) {
      const preview = node('button', 'md-html-preview', '预览 HTML'); preview.type = 'button'; preview.dataset.mdHtmlPreview = '';
      preview.disabled = typeof view.options.onPreviewHtml !== 'function';
      fragment.prepend(preview);
    }
    patchChildren(block.element, fragment);
    block.html = token.type === 'html' ? token.raw : undefined;
  }

  /** Update one assistant text part; HTML preview isolation and file opening belong to the host callbacks. */
  function update(element, text, options = {}) {
    if (!(element instanceof Element)) throw new TypeError('Markdown container must be a DOM element');
    text = sourceText(text);
    // Large or adversarial replies must not allocate an unbounded Markdown
    // token tree and thousands of DOM nodes on every streamed update. Preserve
    // the complete source as plain text, including HTML-looking content.
    if (text.length > richTextLimit) {
      let large = largeViews.get(element);
      if (!large || large.body.parentNode !== element || large.notice.parentNode !== element) {
        release(element);
        const notice = node('p', 'md-large-notice', '内容较长，已切换为纯文本显示以保持页面稳定。');
        const body = node('pre', 'md-large-body', '');
        element.replaceChildren(notice, body);
        element.classList.add('md-content');
        large = { body, notice, text: '', dirty: false };
        large.integrity = new MutationObserver(() => { large.dirty = true; });
        large.integrity.observe(element, { childList: true, characterData: true, subtree: true });
        largeViews.set(element, large);
      }
      const dirty = large.integrity.takeRecords().length > 0 || large.dirty;
      if (large.text === text && !dirty) return false;
      if (!dirty && large.body.firstChild?.nodeType === Node.TEXT_NODE && text.startsWith(large.text)) large.body.firstChild.appendData(text.slice(large.text.length));
      else large.body.textContent = text;
      large.text = text;
      large.integrity.takeRecords(); large.dirty = false;
      return true;
    }
    if (largeViews.has(element)) { release(element); element.replaceChildren(); }
    let view = views.get(element);
    if (!view) {
      view = { blocks: [], text: undefined, streaming: undefined, options, resets: new Map() };
      views.set(element, view); element.classList.add('md-content');
      element.replaceChildren();
      // Watch only the block roots. Streaming text changes inside a block do
      // not invalidate their identity; external fallback replacement does.
      view.integrity = new MutationObserver(() => { view.integrityDirty = true; });
      view.integrity.observe(element, { childList: true });
      view.click = event => {
        const action = event.target.closest?.('[data-md-toggle], [data-md-copy], [data-md-code-preview]');
        if (action && element.contains(action)) {
          const card = action.closest('.md-code-card');
          if (!card) return;
          if (action.hasAttribute('data-md-toggle')) {
            const expanded = card.dataset.expanded !== 'true'; card.dataset.expanded = String(expanded);
            action.setAttribute('aria-expanded', String(expanded)); setText(action, expanded ? '收起代码' : '展开代码');
          } else if (action.hasAttribute('data-md-code-preview')) view.options.onPreviewHtml?.(card.querySelector('code').textContent, action);
          else if (!action.disabled) {
            clearTimeout(view.resets.get(action)); view.resets.delete(action);
            const onCopy = view.options.onCopy, copiedText = card.querySelector('code').textContent;
            const current = () => views.get(element) === view && element.contains(action);
            action.disabled = true; setText(action, '复制中…');
            Promise.resolve().then(async () => {
              if (!current()) return;
              if (typeof onCopy !== 'function' || await onCopy(copiedText) === false) throw new Error('复制未完成，请重试');
              if (current()) { setText(action, '已复制'); action.title = '代码已复制'; }
            }).catch(error => { if (current()) { setText(action, '复制失败'); action.title = sourceText(error?.message) || '复制失败，请重试'; } })
              .finally(() => {
                if (!current()) return;
                action.disabled = false;
                view.resets.set(action, setTimeout(() => {
                  view.resets.delete(action);
                  if (current()) setText(action, '复制代码');
                }, 1600));
              });
          }
          return;
        }
        const link = event.target.closest?.('[data-md-link]');
        if (link && element.contains(link)) { event.preventDefault(); view.options.onOpenLink?.(link.dataset.mdLink); return; }
        const preview = event.target.closest?.('[data-md-html-preview]');
        if (preview && element.contains(preview)) {
          const block = view.blocks.find(block => block.element.contains(preview));
          if (block?.html) view.options.onPreviewHtml?.(block.html, preview);
        }
      };
      element.addEventListener('click', view.click);
    }
    view.options = options || {};
    // A component fallback may replace the container's children while keeping
    // the container alive. Rebuild instead of accepting an offscreen cache hit.
    // takeRecords also catches synchronous replacements before observer delivery.
    // Unchanged completed parts no longer walk every Markdown block per token.
    if (view.integrity.takeRecords().length || view.integrityDirty) {
      view.integrityDirty = true;
      if (view.blocks.length !== element.childNodes.length || view.blocks.some((block, index) => element.childNodes[index] !== block.element)) {
        element.replaceChildren(); view.blocks = []; view.text = undefined; view.tokens = undefined; view.streaming = undefined;
      }
      view.integrityDirty = false;
    }
    const streaming = view.options.streaming === true;
    const previewEnabled = typeof view.options.onPreviewHtml === 'function';
    const capabilitiesChanged = view.previewEnabled !== previewEnabled;
    if (view.text === text && view.streaming === streaming && !capabilitiesChanged && !view.parseFailed && !view.renderDirty) return false;
    let tokens, referenceFree = false, renderFrom = 0, parseFailed = false;
    try {
      // A growing top-level open fence cannot change earlier Markdown. Append
      // a verbatim body directly, otherwise re-lex only that fence. Closing or
      // rewriting content takes the full path,
      // so reference definitions and block boundaries remain correct.
      const tail = view.tokens?.at(-1);
      if (!view.parseFailed && !view.renderDirty && streaming && view.streaming && tail?.type === 'code' && !codeClosed(tail) && text.startsWith(view.text) && view.text.endsWith(tail.raw)) {
        const appended = text.slice(view.text.length);
        const extended = appendOpenFence(tail, appended);
        const next = extended ? [extended] : globalThis.marked.lexer(tail.raw + appended, { gfm: true, breaks: false }).filter(token => token.type !== 'space');
        if (next.length === 1 && next[0].type === 'code' && !codeClosed(next[0])) {
          tokens = [...view.tokens.slice(0, -1), next[0]];
          renderFrom = view.tokens.length - 1;
        }
      }
      // A standalone paragraph may grow into a table, heading or list. Keep
      // that entire tail in the lexer, but reuse earlier completed blocks.
      // Reference syntax can change earlier inline tokens, so exclude it.
      const appended = streaming && view.streaming && text.startsWith(view.text) ? text.slice(view.text.length) : undefined;
      referenceFree = appended !== undefined ? view.referenceFree && !appended.includes('[') : !text.includes('[');
      if (!tokens && !view.parseFailed && !view.renderDirty && referenceFree && appended !== undefined && tail?.type === 'paragraph' && view.text.endsWith(tail.raw)) {
        const next = globalThis.marked.lexer(tail.raw + appended, { gfm: true, breaks: false }).filter(token => token.type !== 'space');
        tokens = [...view.tokens.slice(0, -1), ...next];
        renderFrom = view.tokens.length - 1;
      }
      tokens ??= globalThis.marked.lexer(text, { gfm: true, breaks: false }).filter(token => token.type !== 'space');
    } catch {
      // Preserve the complete response if a parser unexpectedly rejects input.
      // This fallback is literal text, never an alternate HTML execution path.
      tokens = [{ type: 'code', text, raw: text, lang: 'text' }];
      parseFailed = true; referenceFree = false; renderFrom = 0;
    }
    // Only a completely committed render may reuse its historical prefix.
    // If DOM rendering throws halfway through, the next call repairs all blocks.
    view.renderDirty = true;
    if (capabilitiesChanged) renderFrom = 0;
    for (let index = renderFrom; index < tokens.length; index++) {
      const token = tokens[index];
      let block = view.blocks[index];
      if (!block || block.type !== token.type) {
        const replacement = { element: node('div', 'md-block'), type: token.type, signature: undefined };
        if (block) block.element.replaceWith(replacement.element); else element.appendChild(replacement.element);
        view.blocks[index] = block = replacement;
      }
      // Code tokens have no inline subtree: compare their source fields without
      // allocating a JSON copy of the entire growing fence on every chunk.
      const signature = token.type === 'code'
        ? (block.token?.raw === token.raw && block.token?.text === token.text && block.token?.lang === token.lang ? block.signature : token)
        : token === block.token ? block.signature : JSON.stringify(token);
      const active = streaming && index === tokens.length - 1;
      if (signature !== block.signature || active !== block.streaming || capabilitiesChanged) {
        renderBlock(block, token, view, active);
        block.signature = signature; block.streaming = active;
      }
      block.token = token;
    }
    while (view.blocks.length > tokens.length) view.blocks.pop().element.remove();
    view.text = text; view.streaming = streaming; view.tokens = tokens; view.referenceFree = referenceFree;
    view.parseFailed = parseFailed; view.renderDirty = false;
    view.previewEnabled = previewEnabled;
    view.integrity.takeRecords(); view.integrityDirty = false;
    return true;
  }

  function release(element) {
    largeViews.get(element)?.integrity.disconnect();
    largeViews.delete(element);
    const view = views.get(element);
    if (!view) return;
    view.integrity.disconnect();
    views.delete(element);
    element.removeEventListener('click', view.click);
    for (const timer of view.resets.values()) clearTimeout(timer);
    view.resets.clear();
  }

  globalThis.UBOVMMarkdown = Object.freeze({ update, release });
})();
