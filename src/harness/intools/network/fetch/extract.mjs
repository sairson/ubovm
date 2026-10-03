import { load, loadBuffer } from 'cheerio';
import { compact, linkURL } from '../../shared/http/index.mjs';

const ignored = new Set(['script', 'style', 'template', 'svg', 'canvas', 'form', 'nav', 'footer']);
const blocks = new Set(['p', 'div', 'main', 'article', 'section', 'header', 'aside', 'blockquote', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const normalizePlain = (text) => text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();
const normalizeHTML = (text) => text.replace(/\r/g, '').split('\n').map((line) => line.replace(/[\t \f\v\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
function render(root, $) {
  const chunks = [], stack = [{ node: root }];
  while (stack.length) {
    const { node, end } = stack.pop();
    if (end) { chunks.push('\n'); continue; }
    if (node.type === 'text') { chunks.push(node.data); continue; }
    const tag = node.name;
    if (ignored.has(tag)) continue;
    if (tag === 'pre') { chunks.push({ code: $(node).text() }); continue; }
    if (blocks.has(tag) || tag === 'br') chunks.push('\n');
    if (tag === 'li') chunks.push('\n- ');
    if (/^h[1-6]$/.test(tag ?? '')) chunks.push(`${'#'.repeat(Number(tag[1]))} `);
    if (tag === 'td' || tag === 'th') chunks.push(' | ');
    if (blocks.has(tag)) stack.push({ node, end: true });
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) stack.push({ node: node.children[i] });
  }
  const sections = []; let plain = [];
  const flush = () => { const text = normalizeHTML(plain.join('')); if (text) sections.push(text); plain = []; };
  for (const chunk of chunks) {
    if (typeof chunk === 'string') plain.push(chunk);
    else {
      flush();
      const code = chunk.code.replace(/\r\n?/g, '\n');
      let fenceLength = 3;
      for (const match of code.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
      const fence = '`'.repeat(fenceLength);
      sections.push(`${fence}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}`);
    }
  }
  flush();
  return sections.join('\n\n');
}
function collectMetadata($) {
  const values = [], seen = new Set();
  const add = (value, limit) => {
    if (typeof value !== 'string' || values.length >= 24) return;
    const text = compact(value, limit), key = text.toLowerCase();
    if (text && !seen.has(key)) { values.push(text); seen.add(key); }
  };
  $('meta').each((_index, node) => {
    const name = ($(node).attr('name') ?? '').toLowerCase(), property = ($(node).attr('property') ?? '').toLowerCase();
    if (name === 'description' || ['og:description', 'twitter:description', 'og:title', 'twitter:title'].includes(property)) add($(node).attr('content'), 1000);
  });
  const names = new Set(['headline', 'name', 'description', 'articlebody', 'text', 'datepublished', 'dateupdated']);
  $('script[type="application/ld+json"]').each((_index, node) => {
    let data;
    try { data = JSON.parse($(node).text()); } catch { return; }
    const stack = [{ data, depth: 0 }];
    while (stack.length && values.length < 24) {
      const { data: item, depth } = stack.pop();
      if (!item || typeof item !== 'object' || depth > 8) continue;
      for (const [key, value] of Object.entries(item)) {
        if (names.has(key.toLowerCase())) add(value, 4000);
        if (value && typeof value === 'object') stack.push({ data: value, depth: depth + 1 });
      }
    }
  });
  return values.join('\n');
}
function collectLinks($, base) {
  const links = [], seen = new Set();
  let truncated = false;
  $('a[href]').each((_index, node) => {
    const url = linkURL($(node).attr('href'), base);
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (links.length >= 100) { truncated = true; return false; }
    links.push({ url, text: compact($(node).text(), 200) });
  });
  return { links, linksTruncated: truncated };
}
function feed(text, base) {
  const $ = load(text, { xmlMode: true });
  const root = $.root().children().first(), tag = root.get(0)?.name;
  if (!['rss', 'RDF', 'rdf:RDF', 'feed'].includes(tag)) return null;
  const atom = tag === 'feed', channel = atom ? root : root.children('channel').first();
  const title = compact(channel.children('title').first().text(), 300);
  const subtitle = compact(load(channel.children(atom ? 'subtitle' : 'description').first().text()).text(), 500);
  let entries = atom ? root.children('entry') : channel.children('item');
  if (!entries.length && !atom) entries = root.children('item');
  const lines = [`${subtitle ? `${subtitle}\n\n` : ''}Feed with ${entries.length} entries${entries.length > 100 ? ' (showing first 100)' : ''}:`], links = [];
  const seen = new Set();
  for (const node of entries.toArray().slice(0, 100)) {
    const item = $(node), entryTitle = compact(item.children('title').first().text(), 300) || '(untitled)';
    const date = compact(item.children(atom ? 'published,updated' : 'pubDate').first().text(), 100);
    const link = atom ? item.children('link').filter((_index, candidate) => !$(candidate).attr('rel') || $(candidate).attr('rel') === 'alternate').first().attr('href') || item.children('link').first().attr('href') : item.children('link').first().text();
    const url = link ? linkURL(link, base) : '';
    const summary = compact(load(item.children(atom ? 'summary,content' : 'description').first().text()).text(), 400);
    lines.push(`\n- **${entryTitle}**${date ? ` — ${date}` : ''}${url ? `\n  ${url}` : ''}${summary ? `\n  ${summary}` : ''}`);
    if (url && !seen.has(url)) { links.push({ url, text: entryTitle }); seen.add(url); }
  }
  return { title, text: lines.join('\n'), links, linksTruncated: entries.length > 100, extractionTruncated: entries.length > 100, renderingRequired: false };
}

export function extract(body, header, base) {
  let contentType = (header ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType) contentType = /^\s*(?:<!doctype\s+html|<html)/i.test(body.subarray(0, 1024).toString('utf8')) ? 'text/html' : body.subarray(0, 1024).includes(0) ? 'application/octet-stream' : 'text/plain';
  const textual = contentType.startsWith('text/') || /^(?:application\/(?:json|xml|xhtml\+xml|javascript|ecmascript)|image\/svg\+xml)$/.test(contentType) || /\+(?:json|xml)$/.test(contentType) || (contentType === 'application/octet-stream' && !body.subarray(0, 1024).includes(0));
  if (!textual) throw Object.assign(new Error(`Unsupported binary content type: ${contentType}`), { code: 'UNSUPPORTED_CONTENT' });
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(header ?? '')?.[1];
  const html = contentType === 'text/html' || contentType === 'application/xhtml+xml' || (contentType === 'text/plain' && /<html/i.test(body.subarray(0, 1024).toString('utf8')));
  // loadBuffer applies HTML charset sniffing (BOM, HTTP header, and meta tags).
  const text = html ? '' : new TextDecoder(charset || 'utf-8').decode(body);
  let document;
  if (html) {
    const $ = loadBuffer(body, { encoding: { transportLayerEncodingLabel: charset, defaultEncoding: 'utf-8' } });
    let root = $('body').get(0) ?? $.root().get(0), largest = 0;
    $('main,article').each((_index, node) => {
      const size = $(node).text().length;
      if (size > largest) { largest = size; root = node; }
    });
    let rendered = render(root, $);
    const metadata = collectMetadata($);
    if (metadata && !rendered.includes(metadata)) rendered += `\n\n# Page metadata\n${normalizeHTML(metadata)}`;
    document = { title: compact($('title').first().text(), 300), text: rendered, ...collectLinks($, base), renderingRequired: Array.from(rendered).length < 200 && Boolean($('#root,#app,#__next,[ng-version],script#__NEXT_DATA__').length) && $('script').length >= 2 };
  } else {
    document = /(?:xml|rss|atom)/.test(contentType) || /<(?:rss|feed)(?:\s|>)/i.test(text.slice(0, 512)) ? feed(text, base) : null;
    if (!document) {
      let plain = text;
      if (contentType === 'application/json' || contentType.endsWith('+json')) { try { plain = JSON.stringify(JSON.parse(text), null, 2); } catch { /* A bounded prefix may legitimately end inside JSON. */ } }
      document = { title: '', text: normalizePlain(plain), links: [], linksTruncated: false, renderingRequired: false };
    }
  }
  const runes = Array.from(document.text), extractionTruncated = Boolean(document.extractionTruncated) || runes.length > 500_000;
  return { ...document, contentType, text: extractionTruncated ? runes.slice(0, 500_000).join('') : document.text, extractionTruncated };
}
