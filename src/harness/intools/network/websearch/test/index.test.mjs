import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchTool } from '../index.mjs';

const rss = items => '<rss><channel>' + items.map(([title, url, snippet = '']) => `<item><title>${title}</title><link>${url.replaceAll('&', '&amp;')}</link><description>${snippet}</description></item>`).join('') + '</channel></rss>';
const html = items => items.length ? items.map(([title, url, snippet = '']) => `<div class="result"><a class="result__a" href="${url.replaceAll('&', '&amp;')}">${title}</a><div class="result__snippet">${snippet}</div></div>`).join('') : '<div class="no-results">No results</div>';
const publicTool = (bing, duck, options = {}) => createWebSearchTool({ providerRetryAttempts: 1, fetch: async url => new Response(new URL(url).hostname.includes('bing') ? bing : duck), ...options });

test('keyless searches start public sources concurrently and merge complementary results', async () => {
  const started = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const tool = publicTool('', '', { fetch: async url => {
    const host = new URL(url).hostname;
    started.push(host.includes('bing') ? 'bing' : host.includes('lite') ? 'lite' : 'duck');
    if (started.length === 3) release();
    await barrier;
    if (host.includes('bing')) return new Response(rss([['Node guide', 'https://nodejs.org/guide']]));
    if (host.includes('lite')) return new Response('<a class="result-link" href="https://nodejs.org/lite">Node lite</a>');
    return new Response(html([['Node reference', 'https://nodejs.org/reference']]));
  } });
  const result = await tool.execute('s', { query: 'node', limit: 3 });
  assert.equal(started.length, 3);
  assert.match(result.details.provider, /bing/);
  assert.ok(result.details.returned >= 2);
  assert.equal(result.details.providers.length, 3);
  assert.ok(result.details.providers.every(p => p.status === 'ok'));
});

test('Chinese natural language and site operators retain relevant results and exclude wrong hosts', async () => {
  const tool = publicTool(rss([
    ['数据库连接池配置指南', 'https://docs.example.com/pool'],
    ['数据库连接池配置指南', 'https://example.com.evil.org/pool'],
    ['数据库连接池配置指南', 'https://old.example.com/pool'],
  ]), html([]));
  const result = await tool.execute('s', { query: '如何配置数据库连接池 site:example.com -site:old.example.com' });
  assert.deepEqual(result.details.results.map(r => r.url), ['https://docs.example.com/pool']);
});

test('search redirect links and tracking duplicates resolve to the best direct result', async () => {
  const direct = 'https://example.com/Guide?q=A';
  const encoded = 'https://www.bing.com/ck/a?u=a1' + Buffer.from(direct + '&utm_source=bing').toString('base64url');
  const redirect = '//duckduckgo.com/l/?uddg=' + encodeURIComponent(direct + '&utm_source=ddg');
  const tool = publicTool(`<ol id="b_results"><li class="b_algo"><h2><a href="${encoded}">Node</a></h2></li></ol>`, html([['Node reference', redirect, 'Node reference guide']]));
  const result = await tool.execute('s', { query: 'node reference' });
  assert.equal(result.details.returned, 1);
  assert.equal(result.details.results[0].url, direct);
  assert.equal(result.details.results[0].title, 'Node reference');
});

test('challenge and unrecognized pages are unavailable, not evidence of absent information', async () => {
  const result = await publicTool('<html><h1>Service temporarily unavailable</h1></html>', '<form id="challenge-form">Verify</form>', {
    fetch: async url => {
      const host = new URL(url).hostname;
      if (host.includes('bing')) return new Response('<html><h1>Service temporarily unavailable</h1></html>');
      if (host.includes('lite')) return new Response('<form id="challenge-form">Verify</form>');
      return new Response('<form id="challenge-form">Verify</form>');
    }
  }).execute('s', { query: 'node' });
  assert.equal(result.details.status, 'unavailable');
  assert.equal(result.details.providers.length, 3);
  assert.ok(result.details.providers.every(p => p.status === 'unavailable'));
  assert.match(result.details.fallback_reason, /human verification|unrecognized|unavailable/i);
  assert.match(result.details.message, /Tavily|browser/i);
  const empty = await publicTool(rss([]), html([]), {
    fetch: async url => new Response(new URL(url).hostname.includes('bing') ? rss([]) : html([]))
  }).execute('s', { query: 'node' });
  assert.equal(empty.details.status, 'no_results');
});

test('one failed source does not discard another source and exact advisory IDs stay mandatory', async () => {
  const result = await publicTool('<html>Error</html>', html([
    ['CVE-2026-12345 details', 'https://example.com/a'],
    ['CVE-2026-99999 details', 'https://example.com/b'],
  ])).execute('s', { query: 'CVE-2026-12345' });
  assert.equal(result.details.provider, 'duckduckgo');
  assert.equal(result.details.returned, 1);
  assert.equal(result.details.providers[0].status, 'unavailable');
});

test('DuckDuckGo lite results and site-only queries remain usable', async () => {
  const tool = publicTool(rss([]), '<table><tr><td><a class="result-link" href="https://example.com/a">Reference</a></td></tr><tr><td class="result-snippet">Usage</td></tr></table>');
  const result = await tool.execute('s', { query: 'site:example.com' });
  assert.equal(result.details.returned, 1);
  assert.equal(result.details.results[0].snippet, 'Usage');
});

test('provider time budget includes retries and preserves faster source results', async () => {
  let calls = 0;
  const tool = publicTool('', '', { timeoutMs: 60, retryBackoffMs: 100, providerRetryAttempts: 3, fetch: async url => {
    if (new URL(url).hostname.includes('bing')) { calls++; return new Response('', { status: 503 }); }
    return new Response(html([['Node guide', 'https://example.com/guide']]));
  } });
  // AbortSignal.timeout is unref'ed; keep the isolated test process alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await tool.execute('s', { query: 'node' });
    assert.ok(calls >= 1 && calls <= 2, String(calls));
    assert.match(result.details.provider, /duckduckgo/);
    assert.equal(result.details.providers[0].status, 'unavailable');
  } finally { clearInterval(keepAlive); }
});

test('cancellation propagates to concurrent providers instead of becoming no_results', async () => {
  const controller = new AbortController(), signals = [];
  const tool = publicTool('', '', { fetch: async (_url, init) => {
    signals.push(init.signal);
    if (signals.length === 3) controller.abort(new Error('user stopped'));
    return new Promise(() => {});
  } });
  await assert.rejects(tool.execute('s', { query: 'node' }, controller.signal), /user stopped/);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
});

test('Tavily disabled avoids authenticated requests and Tavily failure respects fallback configuration', async () => {
  let calls = 0;
  const tool = publicTool(rss([['Node guide', 'https://example.com/guide']]), html([]), { apiKey: 'secret', tavily: { enabled: false }, fetch: async (url, init) => {
    calls++; assert.equal(init.headers.Authorization, undefined);
    assert.ok(!url.includes('tavily'));
    return new Response(new URL(url).hostname.includes('bing') ? rss([['Node guide', 'https://example.com/guide']]) : html([]));
  } });
  assert.equal((await tool.execute('s', { query: 'node' })).details.status, 'ok');
  assert.equal(calls, 3);
  const failed = createWebSearchTool({ apiKey: 'secret', fallbackToPublicProviders: false, fetch: async () => { throw Error('bad secret'); } });
  const result = await failed.execute('s', { query: 'node' });
  assert.equal(result.details.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('non-Latin queries retain relevant provider results', async () => {
  for (const query of ['документация', 'وثائق', '日本語', 'café']) {
    const tool = createWebSearchTool({ apiKey: 'test-key', fallbackToPublicProviders: false,
      fetch: async () => Response.json({ results: [{ url: 'https://example.com/reference', title: query, content: 'reference' }] }) });
    const result = await tool.execute('search', { query });
    assert.equal(result.details.status, 'ok', query);
    assert.equal(result.details.returned, 1, query);
  }
});

test('deduplication preserves case-sensitive paths, queries and trailing slashes', async () => {
  const urls = ['https://example.com/Guide', 'https://example.com/guide', 'https://example.com/guide/',
    'https://example.com/guide?q=A', 'https://example.com/guide?q=a', 'https://EXAMPLE.com/Guide#fragment'];
  const tool = createWebSearchTool({ apiKey: 'test-key', fetch: async () => Response.json({
    results: urls.map(url => ({ url, title: 'Guide reference', content: 'Guide documentation' })),
  }) });
  const result = await tool.execute('search', { query: 'guide', limit: 20 });
  assert.equal(result.details.provider, 'tavily');
  assert.deepEqual(result.details.results.map(item => item.url), urls.slice(0, 5));
});

test('per-call Tavily filters override settings and merge site operators into domain lists', async () => {
  let body;
  const tool = createWebSearchTool({
    apiKey: 'test-key',
    fallbackToPublicProviders: false,
    tavily: { searchDepth: 'basic', topic: 'general', includeAnswer: false },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        answer: 'Short summary',
        results: [{ url: 'https://docs.example.com/a', title: 'Node guide', content: 'Node configuration guide' }]
      });
    }
  });
  const result = await tool.execute('search', {
    query: 'node guide site:docs.example.com -site:old.example.com',
    search_depth: 'advanced',
    topic: 'news',
    time_range: 'week',
    include_domains: ['nodejs.org'],
    include_answer: true,
    limit: 5
  });
  assert.equal(body.search_depth, 'advanced');
  assert.equal(body.topic, 'news');
  assert.equal(body.time_range, 'week');
  assert.equal(body.include_answer, true);
  assert.equal(body.max_results, 5);
  assert.deepEqual(body.include_domains.sort(), ['docs.example.com', 'nodejs.org']);
  assert.deepEqual(body.exclude_domains, ['old.example.com']);
  assert.ok(!/site:/.test(body.query));
  assert.equal(result.details.filters.search_depth, 'advanced');
  assert.equal(result.details.filters.time_range, 'week');
  assert.match(result.details.note, /fetch_web_content/);
  assert.equal(result.details.answer, 'Short summary');
});

test('public fallback applies include/exclude domains via site operators', async () => {
  let query;
  const tool = publicTool(rss([['Allowed', 'https://docs.example.com/a', 'guide']]), html([]), {
    fetch: async url => {
      query = new URL(url).searchParams.get('q');
      return new Response(new URL(url).hostname.includes('bing')
        ? rss([['Allowed', 'https://docs.example.com/a', 'guide'], ['Blocked', 'https://evil.example.org/a', 'guide']])
        : html([]));
    }
  });
  const result = await tool.execute('s', { query: 'guide', include_domains: ['docs.example.com'], exclude_domains: ['evil.example.org'] });
  assert.match(query, /site:docs\.example\.com/);
  assert.match(query, /-site:evil\.example\.org/);
  assert.deepEqual(result.details.results.map(item => item.url), ['https://docs.example.com/a']);
  assert.deepEqual(result.details.filters.include_domains, ['docs.example.com']);
});

test('invalid domain filters and overlapping include/exclude are rejected', async () => {
  const tool = createWebSearchTool({ apiKey: 'test-key', fallbackToPublicProviders: false, fetch: async () => Response.json({ results: [] }) });
  await assert.rejects(tool.execute('s', { query: 'x', include_domains: ['not a host'] }), /hostnames/);
  await assert.rejects(tool.execute('s', { query: 'x', include_domains: ['example.com'], exclude_domains: ['example.com'] }), /overlap/);
  await assert.rejects(tool.execute('s', { query: 'x', time_range: 'hour' }), /time_range/);
});

test('soft ranking keeps provider hits when strict term matching would discard them', async () => {
  const { selectResults } = await import('../index.mjs');
  const selected = selectResults('completely unrelated unique tokens xyzzy', [
    { title: 'Official reference', url: 'https://docs.example.com/ref', snippet: 'documentation overview' }
  ], 5);
  assert.ok(['soft', 'passthrough'].includes(selected.ranking), selected.ranking);
  assert.equal(selected.results[0].url, 'https://docs.example.com/ref');
});

test('Bing HTML fallback is used when RSS parsing fails', async () => {
  let formats = [];
  const tool = createWebSearchTool({
    providerRetryAttempts: 1,
    fetch: async url => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('bing')) {
        formats.push(parsed.searchParams.get('format') || 'html');
        if (parsed.searchParams.get('format') === 'rss') return new Response('<html><h1>not rss</h1></html>');
        return new Response('<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/guide">Node guide</a></h2><p>docs</p></li></ol>');
      }
      return new Response(html([]));
    }
  });
  const result = await tool.execute('s', { query: 'node guide' });
  assert.deepEqual(formats, ['rss', 'html']);
  assert.equal(result.details.status, 'ok');
  assert.equal(result.details.results[0].url, 'https://example.com/guide');
});

test('Tavily retries without include_domains when filtered search is empty', async () => {
  let bodies = [];
  const tool = createWebSearchTool({
    apiKey: 'test-key',
    fallbackToPublicProviders: false,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.include_domains?.length) return Response.json({ results: [] });
      return Response.json({ results: [{ url: 'https://example.com/a', title: 'Node guide', content: 'Node guide docs' }] });
    }
  });
  const result = await tool.execute('s', { query: 'node guide', include_domains: ['missing.example'] });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].include_domains, ['missing.example']);
  assert.equal(bodies[1].include_domains, undefined);
  assert.equal(result.details.status, 'ok');
  assert.equal(result.details.filters.include_domains_relaxed, true);
});
