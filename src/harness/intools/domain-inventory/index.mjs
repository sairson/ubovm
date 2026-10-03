import { Type } from 'typebox';
import { assertSession, checkAbort, required, toolResult } from '../shared/store/memory-store.mjs';
import {
  DISCOVERY_SOURCES, DOMAIN_KINDS, RELATION_TYPES, TEST_STATUSES,
  assertCoverageComplete, coverageSummary, emptyInventory, inferKind, isSubdomainOf,
  normalizeHostname, validateDomainInventory
} from './record.mjs';

export {
  DISCOVERY_SOURCES, DOMAIN_KINDS, RELATION_TYPES, TEST_STATUSES,
  assertCoverageComplete, coverageSummary, emptyInventory, normalizeHostname, validateDomainInventory
} from './record.mjs';

const string = Type.String();
const optionalString = Type.Optional(string);
const strings = Type.Array(string);
const optionalStrings = Type.Optional(strings);
const relationSchema = Type.Object({
  type: Type.Union(RELATION_TYPES.map(Type.Literal)),
  evidence_refs: Type.Optional(strings)
}, { additionalProperties: false });

function textList(values, label, max = 32) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > max) throw new Error(`${label} must be an array of at most ${max} strings`);
  return [...new Set(values.map(value => required(value, label)).filter(Boolean))];
}

function ensureInventory(state) {
  if (!state.domainInventory) state.domainInventory = emptyInventory();
  return state.domainInventory;
}

function publicDomain(item) {
  return structuredClone(item);
}

function findDomain(inventory, hostname) {
  return inventory.domains.find(item => item.hostname === hostname);
}

function mergeRelations(existing, incoming) {
  const map = new Map();
  for (const rel of [...existing, ...incoming]) {
    const key = rel.type;
    const prior = map.get(key);
    map.set(key, {
      type: rel.type,
      evidence_refs: [...new Set([...(prior?.evidence_refs ?? []), ...(rel.evidence_refs ?? [])])].slice(0, 32)
    });
  }
  return [...map.values()].slice(0, 64);
}

function makeDomain({ hostname, kind, parent, seed_roots, discovery, relations, test_status, skip_reason, evidence, linked_note_ids, finding_ids, now }) {
  return {
    hostname,
    kind: kind ?? 'alias',
    parent: parent ?? null,
    seed_roots: seed_roots ?? [],
    discovery: discovery ?? 'manual',
    relations: relations ?? [],
    test_status: test_status ?? 'pending',
    skip_reason: skip_reason ?? null,
    last_tested_at: null,
    evidence: evidence ?? [],
    linked_note_ids: linked_note_ids ?? [],
    finding_ids: finding_ids ?? [],
    updated_at: now,
    created_at: now
  };
}

function parseRelations(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 64) throw new Error('relations must be an array of at most 64 items');
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('relation must be an object');
    for (const key of Object.keys(item)) if (!['type', 'evidence_refs'].includes(key)) throw new Error(`Unknown relation field: ${key}`);
    const type = required(item.type, 'relation.type').toLowerCase();
    if (!RELATION_TYPES.includes(type)) throw new Error(`Unknown relation type: ${type}`);
    return { type, evidence_refs: textList(item.evidence_refs, 'relation.evidence_refs') };
  });
}

export function createDomainInventoryTool({ store, sessionId, workerId = 'worker' } = {}) {
  assertSession(store, sessionId);
  workerId = required(workerId, 'workerId');

  return {
    name: 'domain_inventory',
    label: '域名攻击面台账',
    description: 'Session domain inventory for security coverage. Bootstrap seed root domains once, upsert related hosts (subdomains, cert SAN, DNS aliases, redirects) without re-asking authorization for related assets, mark tested/skipped, and read coverage. Security delivery acceptance requires complete coverage (no pending/in_progress). Inventory is the coverage authority; do not track domain coverage only in free-text notes.',
    parameters: Type.Object({
      action: Type.Union(['bootstrap', 'upsert', 'relate', 'mark_tested', 'skip', 'list', 'coverage'].map(Type.Literal)),
      seeds: optionalStrings,
      hostname: optionalString,
      hostnames: optionalStrings,
      kind: Type.Optional(Type.Union(DOMAIN_KINDS.map(Type.Literal))),
      parent: optionalString,
      discovery: Type.Optional(Type.Union(DISCOVERY_SOURCES.map(Type.Literal))),
      relations: Type.Optional(Type.Array(relationSchema, { maxItems: 64 })),
      relation_type: Type.Optional(Type.Union(RELATION_TYPES.map(Type.Literal))),
      evidence_refs: optionalStrings,
      skip_reason: optionalString,
      test_status: Type.Optional(Type.Union(TEST_STATUSES.map(Type.Literal))),
      linked_note_ids: optionalStrings,
      finding_ids: optionalStrings,
      query: optionalString,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 }))
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      checkAbort(signal);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('domain_inventory arguments must be an object');
      const allowed = ['action', 'seeds', 'hostname', 'hostnames', 'kind', 'parent', 'discovery', 'relations', 'relation_type', 'evidence_refs', 'skip_reason', 'test_status', 'linked_note_ids', 'finding_ids', 'query', 'limit', 'offset'];
      for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown domain_inventory field: ${key}`);
      const action = required(input.action, 'action').toLowerCase();

      if (action === 'list' || action === 'coverage') {
        await store.flush();
        checkAbort(signal);
        const inventory = store.snapshot(['domainInventory']).domainInventory ?? emptyInventory();
        if (action === 'coverage') return toolResult({ ...coverageSummary(inventory), revision: inventory.revision });
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        const statusFilter = input.test_status ? required(input.test_status, 'test_status').toLowerCase() : '';
        if (statusFilter && !TEST_STATUSES.includes(statusFilter)) throw new Error('Invalid test_status filter');
        const limit = input.limit ?? 50;
        const offset = input.offset ?? 0;
        let items = inventory.domains;
        if (statusFilter) items = items.filter(item => item.test_status === statusFilter);
        if (query) items = items.filter(item => item.hostname.includes(query) || (item.parent ?? '').includes(query));
        const page = items.slice(offset, offset + limit);
        return toolResult({
          revision: inventory.revision,
          seedRoots: inventory.seedRoots,
          total: items.length,
          offset,
          next_offset: offset + limit < items.length ? offset + limit : null,
          domains: page.map(publicDomain),
          coverage: coverageSummary(inventory)
        });
      }

      const result = await store.commit(state => {
        checkAbort(signal);
        const inventory = ensureInventory(state);
        const now = new Date().toISOString();

        if (action === 'bootstrap') {
          const seeds = textList(input.seeds ?? (input.hostname ? [input.hostname] : input.hostnames), 'seeds', 64)
            .map(normalizeHostname);
          if (!seeds.length) throw new Error('bootstrap requires one or more seed hostnames');
          const merged = [...new Set([...inventory.seedRoots, ...seeds])];
          if (merged.length > 64) throw new Error('At most 64 seed roots are allowed');
          inventory.seedRoots = merged;
          for (const seed of seeds) {
            let item = findDomain(inventory, seed);
            if (!item) {
              item = makeDomain({
                hostname: seed, kind: 'apex', parent: null, seed_roots: [seed],
                discovery: 'seed', relations: [{ type: 'manual', evidence_refs: textList(input.evidence_refs, 'evidence_refs') }],
                now
              });
              inventory.domains.push(item);
            } else {
              item.kind = 'apex';
              item.discovery = item.discovery === 'manual' ? 'seed' : item.discovery;
              item.seed_roots = [...new Set([...item.seed_roots, seed])];
              item.updated_at = now;
            }
          }
          inventory.revision++;
          validateDomainInventory(inventory);
          return { status: 'bootstrapped', seedRoots: [...inventory.seedRoots], coverage: coverageSummary(inventory), revision: inventory.revision };
        }

        if (action === 'upsert') {
          if (!inventory.seedRoots.length) throw new Error('Bootstrap seed roots before upserting related hosts');
          const names = textList(input.hostnames ?? (input.hostname ? [input.hostname] : []), 'hostnames', 100).map(normalizeHostname);
          if (!names.length) throw new Error('upsert requires hostname or hostnames');
          const discovery = input.discovery ? required(input.discovery, 'discovery').toLowerCase() : 'enum';
          if (!DISCOVERY_SOURCES.includes(discovery)) throw new Error('Invalid discovery source');
          const relations = parseRelations(input.relations);
          if (input.relation_type) {
            const type = required(input.relation_type, 'relation_type').toLowerCase();
            if (!RELATION_TYPES.includes(type)) throw new Error('Invalid relation_type');
            relations.push({ type, evidence_refs: textList(input.evidence_refs, 'evidence_refs') });
          }
          const parent = input.parent ? normalizeHostname(input.parent) : null;
          const created = [], updated = [];
          for (const hostname of names) {
            const seed_roots = inventory.seedRoots.filter(root => isSubdomainOf(hostname, root) || hostname === root);
            const attached = seed_roots.length ? seed_roots : [...inventory.seedRoots];
            let kind = input.kind ? required(input.kind, 'kind').toLowerCase() : inferKind(hostname, inventory.seedRoots);
            if (!DOMAIN_KINDS.includes(kind)) throw new Error('Invalid kind');
            let item = findDomain(inventory, hostname);
            if (!item) {
              item = makeDomain({
                hostname, kind, parent: parent ?? (attached.length === 1 && hostname !== attached[0] ? attached[0] : null),
                seed_roots: attached, discovery, relations: mergeRelations([], relations), now
              });
              inventory.domains.push(item);
              created.push(hostname);
            } else {
              item.kind = kind === 'alias' ? item.kind : kind;
              item.parent = parent ?? item.parent;
              item.seed_roots = [...new Set([...item.seed_roots, ...attached])];
              item.discovery = item.discovery === 'seed' ? 'seed' : discovery;
              item.relations = mergeRelations(item.relations, relations);
              item.linked_note_ids = [...new Set([...item.linked_note_ids, ...textList(input.linked_note_ids, 'linked_note_ids')])];
              item.finding_ids = [...new Set([...item.finding_ids, ...textList(input.finding_ids, 'finding_ids')])];
              item.updated_at = now;
              updated.push(hostname);
            }
          }
          if (inventory.domains.length > 2000) throw new Error('Domain inventory capacity reached (2000)');
          inventory.revision++;
          validateDomainInventory(inventory);
          return { status: 'upserted', created, updated, coverage: coverageSummary(inventory), revision: inventory.revision };
        }

        if (action === 'relate') {
          const hostname = normalizeHostname(required(input.hostname, 'hostname'));
          const item = findDomain(inventory, hostname);
          if (!item) throw new Error(`Domain ${hostname} was not found; upsert it first`);
          const relations = parseRelations(input.relations);
          if (input.relation_type) {
            relations.push({
              type: required(input.relation_type, 'relation_type').toLowerCase(),
              evidence_refs: textList(input.evidence_refs, 'evidence_refs')
            });
          }
          if (!relations.length) throw new Error('relate requires relations or relation_type');
          for (const rel of relations) if (!RELATION_TYPES.includes(rel.type)) throw new Error(`Invalid relation type: ${rel.type}`);
          item.relations = mergeRelations(item.relations, relations);
          item.updated_at = now;
          inventory.revision++;
          validateDomainInventory(inventory);
          return { status: 'related', domain: publicDomain(item), coverage: coverageSummary(inventory), revision: inventory.revision };
        }

        if (action === 'mark_tested' || action === 'skip') {
          const hostname = normalizeHostname(required(input.hostname, 'hostname'));
          const item = findDomain(inventory, hostname);
          if (!item) throw new Error(`Domain ${hostname} was not found`);
          const refs = textList(input.evidence_refs, 'evidence_refs');
          if (action === 'mark_tested') {
            item.test_status = 'tested';
            item.skip_reason = null;
            item.last_tested_at = now;
            item.evidence = [...new Set([...item.evidence, ...refs])].slice(0, 64);
          } else {
            const reason = required(input.skip_reason, 'skip_reason');
            if (reason.length > 4000) throw new Error('skip_reason exceeds 4000 characters');
            const status = input.test_status === 'out_of_scope' ? 'out_of_scope' : 'skipped';
            item.test_status = status;
            item.skip_reason = reason;
            item.last_tested_at = now;
            item.evidence = [...new Set([...item.evidence, ...refs])].slice(0, 64);
          }
          item.updated_at = now;
          inventory.revision++;
          validateDomainInventory(inventory);
          return { status: action === 'mark_tested' ? 'tested' : item.test_status, domain: publicDomain(item), coverage: coverageSummary(inventory), revision: inventory.revision };
        }

        throw new Error(`Unknown domain_inventory action: ${action}`);
      });
      return toolResult(result);
    },
    summary() {
      const inventory = store.snapshot(['domainInventory']).domainInventory;
      if (!inventory?.seedRoots?.length) return '';
      const coverage = coverageSummary(inventory);
      return '# Domain attack-surface inventory\n' + JSON.stringify({
        revision: inventory.revision,
        seedRoots: coverage.seedRoots.slice(0, 16),
        total: coverage.total,
        counts: coverage.counts,
        incomplete: coverage.incomplete.slice(0, 20),
        complete: coverage.complete,
        coverageRate: coverage.coverageRate
      });
    },
    coverage() {
      const inventory = store.snapshot(['domainInventory']).domainInventory ?? emptyInventory();
      return coverageSummary(inventory);
    },
    assertComplete() {
      const inventory = store.snapshot(['domainInventory']).domainInventory;
      return assertCoverageComplete(inventory);
    }
  };
}
