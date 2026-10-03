import { Type } from 'typebox';
import { load } from 'cheerio';
import { boolean, boundedString, compact, httpURL, integer, jsonResult, knownKeys, linkURL, requestBytes, retry, validateHTTPOptions } from '../../shared/http/index.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../../shared/disclosure.mjs';
import { WEB_SEARCH_CATALOG } from '../../shared/tool-catalogs.mjs';

const stopWords = new Set('a an and are for from how in is of on or the to with 漏洞 搜索 查询'.split(' '));
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const SEARCH_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast'];
const TOPICS = ['general', 'news', 'finance'];
const TIME_RANGES = ['day', 'week', 'month', 'year'];
const DOMAIN_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function significantTerms(value, excludeStopWords = false) {
  const segmented = value.replace(/[\p{Script=Han}]+/gu, text => [...segmenter.segment(text)].map(item => item.segment).join(' '));
  return [...new Set((segmented.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}._:+/-]*/gu) ?? [])
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => Array.from(word).length >= 2 && !(excludeStopWords && stopWords.has(word))))];
}

function parseSiteOperators(query) {
  const include = [], exclude = [];
  for (const match of query.matchAll(/(?:^|\s)(-?)site:([^\s]+)/gi)) {
    const host = match[2].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!host) continue;
    (match[1] ? exclude : include).push(host);
  }
  return { include: [...new Set(include)], exclude: [...new Set(exclude)] };
}

function normalizeDomains(values, name) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 10) throw new TypeError(`${name} must be an array of at most 10 domains`);
  const domains = [];
  for (const value of values) {
    const domain = boundedString(value, name, 253, true).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!DOMAIN_RE.test(domain)) throw new TypeError(`${name} entries must be bare hostnames such as docs.example.com`);
    domains.push(domain);
  }
  return [...new Set(domains)];
}

function withDomainOperators(query, includeDomains, excludeDomains) {
  let next = query.replace(/(?:^|\s)-?site:[^\s]+/gi, ' ').replace(/\s+/gu, ' ').trim();
  for (const domain of includeDomains) next += ` site:${domain}`;
  for (const domain of excludeDomains) next += ` -site:${domain}`;
  return next.replace(/\s+/gu, ' ').trim();
}

function isSearchEngineResultPage(host, path) {
  if ((host === 'bing.com' || host.endsWith('.bing.com') || host === 'google.com' || host.endsWith('.google.com')) && path.startsWith('/search')) return true;
  if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && (path === '/' || path.startsWith('/html') || path.startsWith('/lite'))) return true;
  return false;
}

export function rankResults(query, candidates, limit, { requireTerms = true } = {}) {
  const sites = [...query.matchAll(/(?:^|\s)(-?)site:([^\s]+)/gi)].map(match => ({ exclude: !!match[1], host: match[2].toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '') }));
  const terms = significantTerms(query.replace(/(?:^|\s)-?site:[^\s]+/gi, ' '), true);
  const required = [...new Set(query.toLowerCase().match(/\b(?:cve-\d{4}-\d{4,7}|ghsa-[a-z0-9-]{8,})\b/g) ?? [])];
  const phrases = Array.from(query.matchAll(/"([^"]{2,})"/g), (match) => normalize(match[1]));
  const scored = new Map();
  for (const candidate of candidates.slice(0, 100)) {
    const title = compact(candidate.title, 2000), url = resultURL(candidate.url), snippet = compact(candidate.snippet, 8000);
    if (!title || !url) continue;
    // URL already canonicalizes the scheme and host. Paths and queries remain
    // case-sensitive, and a trailing slash may identify a different resource.
    const key = url;
    const parsed = new URL(url), host = parsed.hostname.toLowerCase(), path = parsed.pathname.toLowerCase();
    const matchesSite = site => host === site.host || host.endsWith('.' + site.host);
    if (sites.some(site => site.exclude && matchesSite(site)) || (sites.some(site => !site.exclude) && !sites.some(site => !site.exclude && matchesSite(site)))) continue;
    if (isSearchEngineResultPage(host, path)) continue;
    const values = [title, url, snippet].map(normalize), combined = values.join(' ');
    if (!required.every((term) => combined.includes(term))) continue;
    let score = 0, matched = 0;
    for (const term of terms) {
      if (combined.includes(term)) matched++;
      values.forEach((value, index) => { if (value.includes(term)) score += [7, 4, 2][index]; });
    }
    for (const phrase of phrases) if (combined.includes(phrase)) score += 12;
    if (requireTerms && !required.length && terms.length && matched < (terms.length <= 2 ? 1 : 2)) continue;
    if (!scored.has(key) || score > scored.get(key).score) scored.set(key, { score, result: { title, url, ...(snippet ? { snippet } : {}) } });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ result }) => result);
}

/** Prefer strict relevance; if providers returned hits that ranking discarded, soften then passthrough. */
export function selectResults(query, candidates, limit) {
  const strict = rankResults(query, candidates, limit, { requireTerms: true });
  if (strict.length) return { results: strict, ranking: 'strict' };
  const soft = rankResults(query, candidates, limit, { requireTerms: false });
  if (soft.length) return { results: soft, ranking: 'soft' };
  const seen = new Set(), passthrough = [];
  for (const candidate of candidates.slice(0, 100)) {
    const title = compact(candidate.title, 2000), url = resultURL(candidate.url), snippet = compact(candidate.snippet, 8000);
    if (!title || !url || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (isSearchEngineResultPage(parsed.hostname.toLowerCase(), parsed.pathname.toLowerCase())) continue;
    } catch { continue; }
    seen.add(url);
    passthrough.push({ title, url, ...(snippet ? { snippet } : {}) });
    if (passthrough.length >= limit) break;
  }
  return { results: passthrough, ranking: passthrough.length ? 'passthrough' : 'empty' };
}
const normalize = (text) => compact(text, 100_000).toLowerCase();
function resultURL(raw) {
  let url = linkURL(raw);
  if (!url) return '';
  let parsed = new URL(url);
  if ((parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com')) && parsed.searchParams.has('uddg')) {
    url = linkURL(parsed.searchParams.get('uddg'));
    if (!url) return '';
    parsed = new URL(url);
  }
  if (parsed.hostname === 'bing.com' || parsed.hostname.endsWith('.bing.com')) {
    const target = parsed.searchParams.get('u');
    if (parsed.pathname.startsWith('/ck/') && target) {
      url = linkURL(target.startsWith('a1') ? Buffer.from(target.slice(2), 'base64url').toString('utf8') : target);
      if (!url) return '';
      parsed = new URL(url);
    }
  }
  for (const key of [...parsed.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|msclkid)$/i.test(key)) parsed.searchParams.delete(key);
  return parsed.href;
}
function publicCandidates(text, provider) {
  if (!text.trim().startsWith('<')) throw new Error(`${provider} returned an invalid HTML/XML response format`);
  const rss = provider === 'bing' && /<rss(?:\s|>)/i.test(text);
  const $ = load(text, { xmlMode: rss });
  if ($('#challenge-form, #anomaly-modal, .anomaly-modal, #b_captcha, iframe[src*="captcha"]').length || /verify you are human|unusual traffic|bots use duckduckgo/i.test($('title, h1, h2, .anomaly-modal__title').text())) throw new Error(`${provider} requires human verification`);
  if (rss) {
    if (!$('rss > channel').length) throw new Error('bing returned malformed RSS');
    return $('channel > item').toArray().map((item) => ({ title: $(item).find('title').first().text(), url: $(item).find('link').first().text(), snippet: $(item).find('description').first().text() }));
  }
  if (provider === 'bing' && !$('#b_results, li.b_algo, .b_no').length) throw new Error('bing returned an unrecognized search page');
  if (provider === 'bing') return $('li.b_algo').toArray().map((item) => ({ title: $(item).find('h2 a').first().text(), url: $(item).find('h2 a').first().attr('href'), snippet: $(item).find('p,.b_caption').first().text() }));
  if (provider === 'duckduckgo-lite') {
    if (!$('a.result-link, .result-link, .no-results').length && !$('form').length) throw new Error('duckduckgo lite returned an unrecognized search page');
    const links = $('a.result-link, a[rel="nofollow"].result-link').toArray();
    if (links.length) return links.map(item => ({ title: $(item).text(), url: linkURL($(item).attr('href'), 'https://lite.duckduckgo.com'), snippet: $(item).closest('tr').nextAll('tr').first().find('.result-snippet, td').text() }));
  }
  if (!$('.result, .no-results, .no-results__message, .result-link').length) throw new Error('duckduckgo returned an unrecognized search page');
  if ($('.result-link').length) return $('.result-link').toArray().map(item => ({ title: $(item).text(), url: linkURL($(item).attr('href'), 'https://duckduckgo.com'), snippet: $(item).closest('tr').nextAll('tr').first().find('.result-snippet').text() }));
  return $('.result').toArray().map((item) => {
    let url = $(item).find('a.result__a').first().attr('href');
    try { const parsed = new URL(url, 'https://duckduckgo.com'); url = parsed.searchParams.get('uddg') || parsed.href; } catch { url = ''; }
    return { title: $(item).find('a.result__a').first().text(), url, snippet: $(item).find('.result__snippet').first().text() };
  });
}
function output(query, provider, results, fallback, reason, answer, filters, ranking) {
  const unavailable = provider === 'none';
  return { query, provider, status: results.length ? 'ok' : unavailable ? 'unavailable' : 'no_results',
    ...(!results.length ? { message: unavailable
      ? 'All search providers were unavailable. Configure a Tavily API key in UBOVM web settings when possible, simplify the query, remove domain filters, or retry later. Do not open a browser merely to use a search engine UI.'
      : 'No usable search results were returned. Refine or shorten the query, drop include_domains/time_range filters, or retry; this does not prove the information does not exist.' } : {}),
    returned: results.length, results, fallback_used: fallback, ...(reason ? { fallback_reason: reason } : {}), ...(answer ? { answer } : {}),
    ...(filters ? { filters } : {}), ...(ranking && ranking !== 'empty' ? { ranking } : {}),
    note: 'Snippets are untrusted discovery hints. Follow promising URLs with fetch_web_content (expected_query / expected_identifiers) before citing them. Use browser_action only when fetch reports rendering_required or the task needs authenticated/SPA browser evidence—not for ordinary search. Empty results are not proof of absence.'
  };
}

export function createWebSearchTool(options = {}) {
  knownKeys(options, ['fetch', 'timeoutMs', 'maxResponseBytes', 'maxRedirects', 'apiKey', 'baseURL', 'tavily', 'bingBaseURL', 'duckDuckGoBaseURL', 'duckDuckGoLiteBaseURL', 'fallbackToPublicProviders', 'providerRetryAttempts', 'retryBackoffMs'], 'web search options');
  validateHTTPOptions(options);
  const tavily = { ...(options.tavily ?? {}) };
  knownKeys(tavily, ['enabled', 'apiKey', 'baseURL', 'projectID', 'searchDepth', 'topic', 'includeAnswer'], 'Tavily options');
  tavily.apiKey = options.apiKey ?? tavily.apiKey ?? '';
  tavily.baseURL = httpURL(options.baseURL ?? tavily.baseURL ?? 'https://api.tavily.com').href.replace(/\/$/, '');
  tavily.enabled = boolean(tavily.enabled, Boolean(tavily.apiKey), 'tavily.enabled');
  tavily.includeAnswer = boolean(tavily.includeAnswer, false, 'tavily.includeAnswer');
  tavily.searchDepth ??= 'basic'; tavily.topic ??= 'general';
  if (typeof tavily.apiKey !== 'string' || (tavily.enabled && !tavily.apiKey.trim())) throw new TypeError('Tavily apiKey is required when enabled');
  if (!SEARCH_DEPTHS.includes(tavily.searchDepth)) throw new TypeError('Invalid Tavily searchDepth');
  if (!TOPICS.includes(tavily.topic)) throw new TypeError('Invalid Tavily topic');
  if (tavily.projectID !== undefined && typeof tavily.projectID !== 'string') throw new TypeError('Tavily projectID must be a string');
  const fallback = boolean(options.fallbackToPublicProviders, true, 'fallbackToPublicProviders');
  const attempts = integer(options.providerRetryAttempts, 3, 1, 5, 'providerRetryAttempts');
  const backoffMs = integer(options.retryBackoffMs, 300, 0, 5000, 'retryBackoffMs');
  const bingBase = httpURL(options.bingBaseURL ?? 'https://www.bing.com').href;
  const duckBase = httpURL(options.duckDuckGoBaseURL ?? 'https://html.duckduckgo.com').href;
  const duckLiteBase = httpURL(options.duckDuckGoLiteBaseURL ?? 'https://lite.duckduckgo.com').href;
  return withProgressiveDisclosure({
    name: 'web_search', label: 'Search the public web',
    description: WEB_SEARCH_CATALOG.description,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      search_depth: Type.Optional(Type.Union(SEARCH_DEPTHS.map(value => Type.Literal(value)))),
      topic: Type.Optional(Type.Union(TOPICS.map(value => Type.Literal(value)))),
      time_range: Type.Optional(Type.Union(TIME_RANGES.map(value => Type.Literal(value)))),
      include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      include_answer: Type.Optional(Type.Boolean()),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_id, args, signal) {
      knownKeys(args, ['query', 'limit', 'search_depth', 'topic', 'time_range', 'include_domains', 'exclude_domains', 'include_answer']);
      const query = boundedString(args.query, 'query', 512, true), limit = integer(args.limit === 0 ? undefined : args.limit, 8, 1, 20, 'limit');
      if (args.search_depth !== undefined && !SEARCH_DEPTHS.includes(args.search_depth)) throw new TypeError('search_depth must be basic, advanced, fast, or ultra-fast');
      if (args.topic !== undefined && !TOPICS.includes(args.topic)) throw new TypeError('topic must be general, news, or finance');
      if (args.time_range !== undefined && !TIME_RANGES.includes(args.time_range)) throw new TypeError('time_range must be day, week, month, or year');
      const searchDepth = args.search_depth ?? tavily.searchDepth;
      const topic = args.topic ?? tavily.topic;
      const includeAnswer = boolean(args.include_answer, tavily.includeAnswer, 'include_answer');
      const fromQuery = parseSiteOperators(query);
      const includeDomains = [...new Set([...normalizeDomains(args.include_domains, 'include_domains'), ...fromQuery.include])].slice(0, 10);
      const excludeDomains = [...new Set([...normalizeDomains(args.exclude_domains, 'exclude_domains'), ...fromQuery.exclude])].slice(0, 10);
      if (includeDomains.some(domain => excludeDomains.includes(domain))) throw new TypeError('include_domains and exclude_domains must not overlap');
      const rankingQuery = withDomainOperators(query, includeDomains, excludeDomains);
      const filters = {
        search_depth: searchDepth,
        topic,
        ...(args.time_range ? { time_range: args.time_range } : {}),
        ...(includeDomains.length ? { include_domains: includeDomains } : {}),
        ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
        include_answer: includeAnswer
      };
      const network = { fetch: options.fetch, timeoutMs: options.timeoutMs ?? 15_000, maxResponseBytes: options.maxResponseBytes, maxRedirects: options.maxRedirects, signal };
      const reasons = [];
      const providers = [];
      const providerSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(network.timeoutMs)]) : AbortSignal.timeout(network.timeoutMs);
      async function tavilySearch(domainInclude) {
        const budgetSignal = providerSignal();
        const body = {
          query: query.replace(/(?:^|\s)-?site:[^\s]+/gi, ' ').replace(/\s+/gu, ' ').trim() || query,
          search_depth: searchDepth,
          topic,
          max_results: limit,
          include_answer: includeAnswer,
          include_raw_content: false,
          ...(args.time_range ? { time_range: args.time_range } : {}),
          ...(domainInclude.length ? { include_domains: domainInclude } : {}),
          ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {})
        };
        const response = await retry(() => requestBytes(`${tavily.baseURL}/search`, { ...network, signal: budgetSignal, method: 'POST', headers: { Authorization: `Bearer ${tavily.apiKey.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(tavily.projectID ? { 'X-Project-ID': tavily.projectID } : {}) }, body: JSON.stringify(body) }), { attempts, backoffMs, signal: budgetSignal });
        let decoded;
        try { decoded = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('Tavily returned malformed JSON'); }
        if (!decoded || !Array.isArray(decoded.results) || decoded.results.some((item) => !item || typeof item.title !== 'string' || typeof item.url !== 'string' || (item.content !== undefined && typeof item.content !== 'string')) || (decoded.answer !== undefined && typeof decoded.answer !== 'string')) throw new Error('Tavily returned an invalid response format');
        const selected = selectResults(rankingQuery, decoded.results.map(({ title, url, content }) => ({ title, url, snippet: content })), limit);
        return { selected, answer: compact(decoded.answer, 16_000), body };
      }
      if (tavily.enabled) {
        try {
          let attempt = await tavilySearch(includeDomains);
          if (!attempt.selected.results.length && includeDomains.length) {
            reasons.push('Tavily domain filters returned no hits; retrying without include_domains');
            attempt = await tavilySearch([]);
            if (attempt.selected.results.length) filters.include_domains_relaxed = true;
          }
          if (attempt.selected.results.length) {
            return jsonResult(output(query, 'tavily', attempt.selected.results, false, '', attempt.answer, filters, attempt.selected.ranking));
          }
          providers.push({ provider: 'tavily', status: 'no_results', returned: 0 });
          reasons.push('Tavily returned no query-relevant results');
        } catch (error) { signal?.throwIfAborted(); providers.push({ provider: 'tavily', status: 'unavailable', returned: 0 }); reasons.push(`Tavily: ${compact(String(error.message).replaceAll(tavily.apiKey.trim(), '[REDACTED]'), 240)}`); }
        if (!fallback) return jsonResult({ ...output(query, providers[0].status === 'unavailable' ? 'none' : 'tavily', [], false, reasons.join('; '), '', filters), providers });
      }
      const publicQuery = withDomainOperators(query, includeDomains, excludeDomains);
      const chinese = /\p{Script=Han}/u.test(query);
      const headers = { Accept: 'application/rss+xml,text/html,application/xhtml+xml', 'Accept-Language': chinese ? 'zh-CN,zh;q=0.9,en;q=0.6' : 'en-US,en;q=0.8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36' };
      async function fetchProvider(name, buildUrl, parserName = name) {
        try {
          const endpoint = buildUrl();
          const budgetSignal = providerSignal();
          const response = await retry(() => requestBytes(endpoint, { ...network, signal: budgetSignal, headers }), { attempts, backoffMs, signal: budgetSignal });
          const candidates = publicCandidates(response.body.toString('utf8'), parserName);
          const selected = selectResults(rankingQuery, candidates, limit);
          return { provider: name, status: selected.results.length ? 'ok' : 'no_results', results: selected.results, candidates, ranking: selected.ranking };
        } catch (error) {
          signal?.throwIfAborted();
          return { provider: name, status: 'unavailable', results: [], candidates: [], error: compact(error.message, 240) };
        }
      }
      async function bingSearch() {
        const rss = await fetchProvider('bing', () => {
          const endpoint = new URL(bingBase.replace(/\/$/, '') + '/search');
          endpoint.searchParams.set('q', publicQuery);
          endpoint.searchParams.set('count', String(Math.min(50, Math.max(8, limit * 3))));
          endpoint.searchParams.set('format', 'rss');
          endpoint.searchParams.set('mkt', chinese ? 'zh-CN' : 'en-US');
          endpoint.searchParams.set('setlang', chinese ? 'zh-Hans' : 'en');
          return endpoint;
        });
        if (rss.status === 'ok') return rss;
        const html = await fetchProvider('bing', () => {
          const endpoint = new URL(bingBase.replace(/\/$/, '') + '/search');
          endpoint.searchParams.set('q', publicQuery);
          endpoint.searchParams.set('count', String(Math.min(50, Math.max(8, limit * 3))));
          endpoint.searchParams.set('mkt', chinese ? 'zh-CN' : 'en-US');
          endpoint.searchParams.set('setlang', chinese ? 'zh-Hans' : 'en');
          return endpoint;
        });
        if (html.status === 'ok') {
          if (rss.status !== 'ok') reasons.push(`bing: ${rss.error || 'rss empty'}; used HTML fallback`);
          return { ...html, provider: 'bing' };
        }
        return {
          provider: 'bing',
          status: rss.status === 'unavailable' && html.status === 'unavailable' ? 'unavailable' : 'no_results',
          results: [],
          candidates: [...(rss.candidates ?? []), ...(html.candidates ?? [])],
          error: [rss.error, html.error].filter(Boolean).join('; ') || undefined
        };
      }
      const searches = await Promise.all([
        bingSearch(),
        fetchProvider('duckduckgo', () => {
          const endpoint = new URL(duckBase.replace(/\/$/, '') + '/html/');
          endpoint.searchParams.set('q', publicQuery);
          if (chinese) endpoint.searchParams.set('kl', 'cn-zh');
          return endpoint;
        }),
        fetchProvider('duckduckgo-lite', () => {
          const endpoint = new URL(duckLiteBase.replace(/\/$/, '') + '/lite/');
          endpoint.searchParams.set('q', publicQuery);
          if (chinese) endpoint.searchParams.set('kl', 'cn-zh');
          return endpoint;
        }, 'duckduckgo-lite')
      ]);
      signal?.throwIfAborted();
      for (const source of searches) {
        providers.push({ provider: source.provider, status: source.status, returned: source.results.length, ...(source.error ? { error: source.error } : {}) });
        if (source.status !== 'ok') reasons.push(`${source.provider}: ${source.error || 'no query-relevant results'}`);
      }
      const merged = selectResults(rankingQuery, searches.flatMap(source => source.candidates?.length ? source.candidates : source.results), limit);
      const usable = searches.filter(source => source.status === 'ok');
      const provider = usable.map(source => source.provider).join('+') || searches.find(source => source.status === 'no_results')?.provider || 'none';
      return jsonResult({ ...output(query, provider, merged.results, tavily.enabled || searches.some(source => source.status !== 'ok'), reasons.join('; '), '', filters, merged.ranking), providers });
    },
  }, { ...WEB_SEARCH_CATALOG, mode: 'flag' });
}
