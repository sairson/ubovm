(() => {
  'use strict';
  const nonce = document.currentScript?.nonce ?? '';
  const tags = new Set(('html head body title style main header footer nav section article aside div span p a h1 h2 h3 h4 h5 h6 br hr pre code blockquote ul ol li dl dt dd strong em b i u s small sub sup mark time address figure figcaption img picture table caption colgroup col thead tbody tfoot tr th td details summary form fieldset legend label input button select option optgroup textarea datalist progress meter output abbr cite q kbd samp var wbr svg g path circle rect line polyline polygon ellipse text tspan defs lineargradient radialgradient stop clippath mask pattern use desc').split(' '));
  const discard = new Set('script iframe frame frameset object embed applet link meta base template noscript portal fencedframe audio video source track foreignobject animate animatemotion animatetransform set'.split(' '));
  const attributes = new Set(('id class title lang dir role alt width height colspan rowspan scope headers abbr span start reversed type value min max step placeholder name checked selected readonly disabled multiple size rows cols wrap for open datetime cite viewbox preserveaspectratio x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity transform offset stop-color stop-opacity gradientunits gradienttransform spreadmethod clippathunits clip-path maskunits maskcontentunits patternunits patterncontentunits patterntransform text-anchor dominant-baseline font-family font-size font-weight letter-spacing textlength lengthadjust').split(' '));
  let current;

  function sourceDocument(source) {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const inline = [];
    for (const element of [...parsed.querySelectorAll('*')]) {
      const tag = element.localName.toLowerCase();
      if (discard.has(tag)) { element.remove(); continue; }
      if (!tags.has(tag)) { element.replaceWith(...element.childNodes); continue; }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name === 'style') {
          // The inherited CSP can suppress DOMParser's attribute CSSOM. Parse
          // the declaration through a detached style object instead.
          const declaration = parsed.createElement('span').style;
          declaration.cssText = attribute.value;
          const css = declaration.cssText;
          element.removeAttribute(attribute.name);
          if (css) {
            const identifier = `inline-${inline.length}`;
            element.setAttribute('data-ubovm-inline', identifier);
            // Preserve inline precedence for ordinary author selectors while
            // retaining !important semantics and the host nonce-only policy.
            inline.push(`[data-ubovm-inline="${identifier}"]${':not(#ubovm-preview-inline-precedence)'.repeat(16)}{${css}}`);
          }
        } else if (!attributes.has(name) && !/^aria-[a-z-]+$/.test(name)) element.removeAttribute(attribute.name);
      }
      if (tag === 'style') { element.setAttribute('nonce', nonce); element.textContent = element.textContent.replaceAll('<', '\\3c '); }
      if (tag === 'a') { element.setAttribute('role', 'link'); element.setAttribute('aria-disabled', 'true'); }
      if (tag === 'img') element.setAttribute('alt', element.getAttribute('alt') || '图片资源未加载');
      if (['input', 'button', 'select', 'textarea', 'fieldset'].includes(tag)) element.setAttribute('disabled', '');
    }
    const policy = parsed.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = `default-src 'none'; script-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'none'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';`;
    parsed.head.prepend(policy);
    const encoding = parsed.createElement('meta'); encoding.setAttribute('charset', 'UTF-8'); parsed.head.prepend(encoding);
    const viewport = parsed.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width,initial-scale=1'; parsed.head.append(viewport);
    const rules = parsed.createElement('style'); rules.setAttribute('nonce', nonce);
    // Baseline first; transformed inline declarations last, as inline styles
    // should win over document styles at the same importance.
    const baseline = parsed.createElement('style'); baseline.setAttribute('nonce', nonce); baseline.textContent = 'html{color-scheme:light}body{margin:16px;font-family:system-ui,sans-serif}img{max-width:100%}';
    parsed.head.insertBefore(baseline, parsed.head.querySelector('style'));
    rules.textContent = inline.join('\n').replaceAll('<', '\\3c '); parsed.body.append(rules);
    return '<!doctype html>\n' + parsed.documentElement.outerHTML;
  }

  function close() {
    if (!current) return;
    const value = current; current = undefined;
    window.removeEventListener('blur', value.onBlur);
    document.removeEventListener('keydown', value.onKeydown, true);
    value.frame.srcdoc = ''; value.dialog.remove();
    for (const [element, inert] of value.background) if (element.isConnected) element.inert = inert;
    if (value.returnFocus?.isConnected) value.returnFocus.focus({ preventScroll: true });
  }

  function open(html, options = {}) {
    if (typeof html !== 'string') throw new TypeError('HTML 源码必须是字符串。');
    if (html.length > 2 * 1024 * 1024) throw new Error('HTML 预览最多支持 2 MiB 源码。');
    const restore = options.returnFocus ?? current?.returnFocus ?? document.activeElement;
    const srcdoc = sourceDocument(html);
    close();
    const dialog = document.createElement('section'); dialog.className = 'html-preview'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'HTML 预览');
    const header = document.createElement('header'); header.className = 'html-preview-header';
    const heading = document.createElement('strong'); heading.textContent = 'HTML 预览'; heading.className = 'html-preview-title';
    const tabs = document.createElement('div'); tabs.className = 'html-preview-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '显示内容');
    const button = (text, name) => { const item = document.createElement('button'); item.type = 'button'; item.textContent = text; item.dataset.previewAction = name; return item; };
    const preview = button('预览', 'preview'), source = button('源码', 'source'), copy = button('复制源码', 'copy'), dismiss = button('关闭', 'close');
    for (const [item, id, panel] of [[preview, 'html-preview-tab', 'html-preview-rendered'], [source, 'html-source-tab', 'html-preview-source']]) { item.id = id; item.setAttribute('role', 'tab'); item.setAttribute('aria-controls', panel); tabs.append(item); }
    dismiss.setAttribute('aria-label', '关闭 HTML 预览（Escape）'); copy.disabled = typeof options.onCopy !== 'function';
    const actions = document.createElement('div'); actions.className = 'html-preview-actions'; actions.append(copy, dismiss); header.append(heading, tabs, actions);
    const body = document.createElement('div'); body.className = 'html-preview-body';
    const rendered = document.createElement('div'); rendered.className = 'html-preview-rendered'; rendered.id = 'html-preview-rendered'; rendered.setAttribute('role', 'tabpanel'); rendered.setAttribute('aria-labelledby', preview.id);
    const frame = document.createElement('iframe'); frame.title = '静态 HTML 预览'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.tabIndex = -1; frame.srcdoc = srcdoc; rendered.append(frame);
    const code = document.createElement('pre'); code.className = 'html-preview-source'; code.id = 'html-preview-source'; code.setAttribute('role', 'tabpanel'); code.setAttribute('aria-labelledby', source.id); code.tabIndex = 0;
    const text = document.createElement('code'); text.textContent = html; code.append(text); body.append(rendered, code);
    const footer = document.createElement('footer'); footer.className = 'html-preview-footer';
    const description = document.createElement('span'); description.textContent = '静态预览 · 脚本、表单和外部资源已停用';
    const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); footer.append(description, status);
    dialog.append(header, body, footer);
    const background = [...document.body.children].filter(element => !['SCRIPT', 'STYLE'].includes(element.tagName)).map(element => [element, element.inert]);
    for (const [element] of background) element.inert = true;
    document.body.append(dialog);
    const select = (kind, focus = false) => {
      const isSource = kind === 'source'; rendered.hidden = isSource; code.hidden = !isSource;
      preview.setAttribute('aria-selected', String(!isSource)); source.setAttribute('aria-selected', String(isSource)); preview.tabIndex = isSource ? -1 : 0; source.tabIndex = isSource ? 0 : -1;
      if (focus) (isSource ? source : preview).focus();
    };
    preview.addEventListener('click', () => select('preview')); source.addEventListener('click', () => select('source')); dismiss.addEventListener('click', close);
    tabs.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); select(event.key === 'Home' ? 'preview' : event.key === 'End' ? 'source' : source.getAttribute('aria-selected') === 'true' ? 'preview' : 'source', true); } });
    copy.addEventListener('click', async () => {
      copy.disabled = true;
      try { await options.onCopy(html); status.textContent = '源码已复制'; }
      catch { status.textContent = '复制失败，请切换源码后手动复制。'; }
      finally { if (dialog.isConnected) copy.disabled = false; }
    });
    const onKeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), [tabindex="0"]')].filter(element => element.tabIndex >= 0 && !element.hidden && !element.closest('[hidden]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    // A sandboxed opaque frame cannot forward Escape. Keep keyboard focus in
    // the host controls after a pointer click; wheel scrolling still works.
    const onBlur = () => setTimeout(() => { if (current?.dialog === dialog && document.activeElement === frame) preview.focus({ preventScroll: true }); }, 0);
    current = { dialog, frame, background, returnFocus: restore, onKeydown, onBlur };
    document.addEventListener('keydown', onKeydown, true); window.addEventListener('blur', onBlur);
    select('preview'); preview.focus({ preventScroll: true });
  }
  window.UBOVMHtmlPreview = Object.freeze({ open, close });
})();
