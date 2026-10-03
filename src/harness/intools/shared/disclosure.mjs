import { Type } from 'typebox';
import { jsonResult } from './common.mjs';

/**
 * Shared progressive-disclosure helpers for Agent tools.
 * Multi-action tools: action=help (+ topic).
 * Single-purpose tools: help=true (+ help_topic) so existing fields like web_search.topic stay free.
 */

export function buildHelpCatalog({
  docs = [],
  tiers = [],
  tierBlurbs = {},
  topic,
  source,
  tool,
  available,
  defaultTopic = 'core',
} = {}) {
  const allowed = available ? new Set(available) : null;
  const filtered = docs.filter(doc => !allowed || allowed.has(doc.action) || doc.action === 'help');
  const tierOrder = (tiers.length ? tiers : unique(filtered.map(doc => doc.tier))).filter(tier =>
    filtered.some(doc => doc.tier === tier));
  const normalized = typeof topic === 'string' ? topic.trim().toLowerCase() : '';
  const src = source || tool || 'tool';

  const summarize = (doc, detail = false) => {
    const item = { action: doc.action, tier: doc.tier, summary: doc.summary };
    if (detail) {
      if (doc.params?.length) item.params = doc.params;
      if (doc.notes) item.notes = doc.notes;
      if (doc.fields?.length) item.fields = doc.fields;
    }
    return item;
  };

  if (!normalized || normalized === defaultTopic) {
    const actions = filtered.filter(doc => doc.tier === defaultTopic).map(doc => summarize(doc, true));
    const next = tierOrder.find(tier => tier !== defaultTopic);
    return {
      mode: 'help', source: src, tool, topic: defaultTopic || 'core',
      guidance: 'Start with core. Expand only when needed via topic=<tier|action|field>|all.',
      tiers: tierOrder.map(tier => ({
        tier, summary: tierBlurbs[tier] || tier,
        count: filtered.filter(doc => doc.tier === tier).length
      })),
      actions: actions.length ? actions : filtered.slice(0, 12).map(doc => summarize(doc, true)),
      next: next ? { topic: next, reason: tierBlurbs[next] || next } : undefined,
    };
  }

  if (normalized === 'all') {
    return {
      mode: 'help', source: src, tool, topic: 'all',
      guidance: 'Summaries only. Call help again with topic=<action|field> for params.',
      tiers: tierOrder.map(tier => ({ tier, summary: tierBlurbs[tier] || tier })),
      actions: filtered.map(doc => summarize(doc)),
    };
  }

  if (tierOrder.includes(normalized)) {
    const actions = filtered.filter(doc => doc.tier === normalized).map(doc => summarize(doc, true));
    const index = tierOrder.indexOf(normalized);
    const next = tierOrder[index + 1];
    return {
      mode: 'help', source: src, tool, topic: normalized,
      guidance: tierBlurbs[normalized] || normalized,
      tiers: tierOrder.map(tier => ({ tier, summary: tierBlurbs[tier] || tier })),
      actions,
      next: next ? { topic: next, reason: tierBlurbs[next] || next } : undefined,
    };
  }

  const doc = filtered.find(item => item.action === normalized || item.field === normalized);
  if (doc) {
    return {
      mode: 'help', source: src, tool, topic: doc.action || doc.field,
      guidance: 'Single-item detail for the next call.',
      action: summarize(doc, true),
      related: filtered
        .filter(item => item.tier === doc.tier && item.action !== doc.action && item.field !== doc.field)
        .map(item => item.action || item.field),
    };
  }

  return {
    mode: 'help', source: src, tool, topic: normalized, ok: false,
    error: `Unknown help topic "${topic}". Use a tier (${tierOrder.join(', ') || 'all'}), an action/field name, or all.`,
    tiers: tierOrder.map(tier => ({ tier, summary: tierBlurbs[tier] || tier })),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function isHelpRequest(input, mode = 'action') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (mode === 'flag') return input.help === true;
  return typeof input.action === 'string' && input.action.trim().toLowerCase() === 'help';
}

export function helpTopicOf(input, mode = 'action') {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.help_topic === 'string') return input.help_topic;
  if (mode === 'action' && typeof input.topic === 'string') return input.topic;
  if (mode === 'flag' && typeof input.query === 'string' && input.help === true) return input.query;
  return '';
}

export function stripHelpFields(input, mode = 'action') {
  if (!input || typeof input !== 'object') return input;
  const next = { ...input };
  delete next.help;
  delete next.help_topic;
  if (mode === 'action') delete next.topic;
  return next;
}

export function flagHelpProperties() {
  return {
    help: Type.Optional(Type.Boolean({ description: 'Return progressive guidance without executing.' })),
    help_topic: Type.Optional(Type.String({ description: 'With help=true: core|params|limits|workflow|all or a field name' })),
  };
}

export function withActionHelp(properties) {
  return {
    ...properties,
    action: Type.String({ minLength: 1, maxLength: 64, description: 'Tool verb. Call help first when unsure; use topic for tiers/actions.' }),
    topic: Type.Optional(Type.String({ description: 'With action=help: tier, action name, or all' })),
  };
}

/** Wrap a tool so help is answered from a catalog before the original execute runs. */
export function withProgressiveDisclosure(tool, {
  description,
  docs,
  tiers,
  tierBlurbs,
  source,
  mode = 'action',
  parameters,
  defaultTopic = 'core',
} = {}) {
  if (!tool || typeof tool.execute !== 'function') throw new TypeError('withProgressiveDisclosure requires a tool with execute');
  return {
    ...tool,
    description: description || tool.description,
    ...(parameters ? { parameters } : {}),
    async execute(id, input, signal, ...rest) {
      if (isHelpRequest(input, mode)) {
        return jsonResult(buildHelpCatalog({
          docs, tiers, tierBlurbs,
          topic: helpTopicOf(input, mode),
          source: source || tool.name,
          tool: tool.name,
          defaultTopic,
        }));
      }
      return tool.execute(id, stripHelpFields(input, mode), signal, ...rest);
    }
  };
}
