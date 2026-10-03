import { domainToASCII } from 'node:url';

export const DOMAIN_KINDS = Object.freeze(['apex', 'subdomain', 'alias', 'ip_host']);
export const RELATION_TYPES = Object.freeze(['subdomain', 'cert_san', 'dns_cname', 'dns_ns', 'http_redirect', 'manual']);
export const DISCOVERY_SOURCES = Object.freeze(['seed', 'enum', 'cert', 'dns', 'redirect', 'manual']);
export const TEST_STATUSES = Object.freeze(['pending', 'in_progress', 'tested', 'skipped', 'out_of_scope']);

const nonempty = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 4000;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^\[?[0-9a-f:]+\]?$/i;

/** Normalize a hostname or URL host to lowercase ASCII (punycode). */
export function normalizeHostname(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('hostname must be a nonempty string');
  let host = value.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname;
    else if (host.includes('/') || host.includes('?') || host.includes('#')) host = new URL(`https://${host}`).hostname;
  } catch {
    throw new Error(`Invalid hostname: ${value}`);
  }
  host = host.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host.includes(' ') || host.includes(':') && !IPV6.test(host)) throw new Error(`Invalid hostname: ${value}`);
  if (IPV4.test(host) || IPV6.test(host)) return host;
  let ascii;
  try { ascii = domainToASCII(host); } catch { ascii = ''; }
  if (!ascii || ascii === 'invalid' || ascii.includes(' ') || ascii.length > 253) throw new Error(`Invalid hostname: ${value}`);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(ascii) && !IPV4.test(ascii)) {
    throw new Error(`Invalid hostname: ${value}`);
  }
  return ascii.toLowerCase();
}

export function isIpHost(hostname) {
  return IPV4.test(hostname) || IPV6.test(hostname);
}

export function isSubdomainOf(hostname, apex) {
  if (hostname === apex) return true;
  return hostname.endsWith('.' + apex);
}

export function inferKind(hostname, seedRoots = []) {
  if (isIpHost(hostname)) return 'ip_host';
  if (seedRoots.some(root => hostname === root)) return 'apex';
  if (seedRoots.some(root => isSubdomainOf(hostname, root) && hostname !== root)) return 'subdomain';
  return 'alias';
}

export function emptyInventory() {
  return { seedRoots: [], domains: [], revision: 0 };
}

export function coverageSummary(inventory) {
  const domains = inventory?.domains ?? [];
  const counts = { pending: 0, in_progress: 0, tested: 0, skipped: 0, out_of_scope: 0 };
  for (const item of domains) counts[item.test_status] = (counts[item.test_status] ?? 0) + 1;
  const incomplete = domains.filter(item => item.test_status === 'pending' || item.test_status === 'in_progress');
  const complete = domains.length > 0 && incomplete.length === 0;
  const testedOrClosed = counts.tested + counts.skipped + counts.out_of_scope;
  return {
    seedRoots: [...(inventory?.seedRoots ?? [])],
    total: domains.length,
    counts,
    incomplete: incomplete.map(item => item.hostname),
    coverageRate: domains.length ? testedOrClosed / domains.length : 0,
    complete,
    scopeSummary: (inventory?.seedRoots ?? []).length
      ? `Seed roots: ${(inventory.seedRoots).join(', ')}; ${domains.length} inventoried hosts; coverage ${testedOrClosed}/${domains.length}`
      : ''
  };
}

export function assertCoverageComplete(inventory) {
  const summary = coverageSummary(inventory);
  if (!inventory?.seedRoots?.length) throw new Error('Domain inventory has no seed roots; bootstrap seeds before security acceptance');
  if (!summary.total) throw new Error('Domain inventory is empty; register discovered hosts before security acceptance');
  if (!summary.complete) {
    throw new Error(`Domain coverage incomplete: ${summary.incomplete.length} pending/in_progress host(s): ${summary.incomplete.slice(0, 12).join(', ')}`);
  }
  return summary;
}

export function validateDomainInventory(inventory) {
  if (inventory === undefined) return;
  const fail = () => { throw new Error('Invalid domain inventory snapshot'); };
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) fail();
  if (!Array.isArray(inventory.seedRoots) || !Array.isArray(inventory.domains)
    || !Number.isSafeInteger(inventory.revision) || inventory.revision < 0) fail();
  if (inventory.seedRoots.length > 64 || inventory.domains.length > 2000) fail();
  const seeds = new Set();
  for (const root of inventory.seedRoots) {
    if (!nonempty(root) || seeds.has(root)) fail();
    seeds.add(root);
  }
  const seen = new Set();
  for (const item of inventory.domains) {
    if (!item || !nonempty(item.hostname) || seen.has(item.hostname)) fail();
    seen.add(item.hostname);
    if (!DOMAIN_KINDS.includes(item.kind) || !DISCOVERY_SOURCES.includes(item.discovery)
      || !TEST_STATUSES.includes(item.test_status)) fail();
    if (!Array.isArray(item.seed_roots) || item.seed_roots.some(root => !nonempty(root))) fail();
    if (item.parent !== undefined && item.parent !== null && !nonempty(item.parent)) fail();
    if (!Array.isArray(item.relations) || item.relations.length > 64) fail();
    for (const rel of item.relations) {
      if (!rel || !RELATION_TYPES.includes(rel.type) || !Array.isArray(rel.evidence_refs)) fail();
      if (rel.evidence_refs.some(ref => !nonempty(ref)) || rel.evidence_refs.length > 32) fail();
    }
    if (['skipped', 'out_of_scope'].includes(item.test_status) && !nonempty(item.skip_reason)) fail();
    if (item.skip_reason !== undefined && item.skip_reason !== null && !nonempty(item.skip_reason) && item.skip_reason !== '') fail();
    if (!Array.isArray(item.evidence) || item.evidence.some(ref => !nonempty(ref))) fail();
    if (!Array.isArray(item.linked_note_ids) || !Array.isArray(item.finding_ids)) fail();
  }
}
