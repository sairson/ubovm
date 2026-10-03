'use strict';

function normalizeEvidenceLists(observations, toolCallIds, {
  maxObservations = 16,
  maxObservation = 2000,
  maxToolCallIds = 16,
  maxToolCallId = 128
} = {}) {
  const normalizedObservations = [...new Set((Array.isArray(observations) ? observations : [])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim().slice(0, maxObservation)))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxObservations);
  const normalizedToolCallIds = [...new Set((Array.isArray(toolCallIds) ? toolCallIds : [])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim().slice(0, maxToolCallId)))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxToolCallIds);
  return { observations: normalizedObservations, toolCallIds: normalizedToolCallIds };
}

function formatAssistSourceEvidenceSeed(item) {
  if (!item || typeof item.statement !== 'string' || !item.statement.trim()) return '';
  const lists = normalizeEvidenceLists(item.observations, item.toolCallIds);
  const observations = lists.observations.map(value => `- ${value}`).join('\n');
  const toolRefs = lists.toolCallIds.length ? `\nReferenced assist tool calls: ${lists.toolCallIds.join(', ')}` : '';
  return `Assist-mode foundational evidence selected by the user (unverified seed; not completion proof; id=${item.id}):\n${item.statement.trim()}${observations ? `\nObservations:\n${observations}` : ''}${toolRefs}`;
}

module.exports = { normalizeEvidenceLists, formatAssistSourceEvidenceSeed };
