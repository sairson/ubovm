'use strict';

function goalTools(sessions, conversationId) {
  if (sessions.get(conversationId)?.mode !== 'assist') return [];
  return [{
    name: 'list_assist_evidence', label: '查看协助证据',
    description: 'List evidence the user previously asked to record in this assist chat. Returns ids, summaries and attached_goal_ids so the user can choose which items to attach to a linked exploration goal. Does not invent or auto-record evidence.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_id, _input, signal) {
      signal?.throwIfAborted();
      const evidence = sessions.listAssistEvidence(conversationId).map(item => ({
        evidence_id: item.id,
        statement: item.statement,
        observations: item.observations,
        ...(item.toolCallIds?.length ? { tool_call_ids: item.toolCallIds } : {}),
        attached_goal_ids: item.attachedGoalIds || [],
        created_at: item.createdAt
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ evidence }) }], details: { evidence } };
    }
  }, {
    name: 'record_assist_evidence', label: '记录协助证据',
    description: 'Record durable assist-mode evidence only when the user explicitly asks to record evidence for later exploration. Never call silently after ordinary tool work, notes, or speculation. Include a concise statement and concrete observations; optional tool_call_ids may cite prior tool calls in this chat. Identical content is reused instead of duplicated.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['statement', 'observations'],
      properties: {
        statement: { type: 'string', minLength: 1, maxLength: 2000 },
        observations: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        tool_call_ids: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 128 } }
      }
    },
    async execute(_id, input, signal) {
      const entry = await sessions.recordAssistEvidence(conversationId, input, signal);
      const value = {
        evidence_id: entry.id,
        statement: entry.statement,
        observations: entry.observations,
        ...(entry.toolCallIds?.length ? { tool_call_ids: entry.toolCallIds } : {}),
        reused: entry.reused === true
      };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    }
  }, {
    name: 'attach_assist_evidence', label: '附加协助证据到探索',
    description: 'Attach previously recorded assist evidence to an existing linked exploration goal only when the user explicitly names which evidence_ids and which goal_id to use. Never attach the full ledger by default. Idempotent for already-attached ids.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['goal_id', 'evidence_ids'],
      properties: {
        goal_id: { type: 'string', minLength: 1, maxLength: 200 },
        evidence_ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } }
      }
    },
    async execute(_id, input, signal) {
      const result = await sessions.attachAssistEvidenceToGoal(conversationId, input.goal_id, input.evidence_ids, signal);
      const value = {
        goal_id: result.id,
        attached_count: result.attachedCount ?? 0,
        added_evidence_ids: result.addedEvidenceIds || [],
        already_attached_ids: result.alreadyAttachedIds || [],
        source_evidence_count: result.goal?.sourceEvidence?.length || 0
      };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    }
  }, {
    name: 'list_linked_goals', label: '查看关联目标',
    description: 'List saved goals created from this chat, including their objective, acceptance criteria and how many assist evidence seeds are already attached. Criteria completion is user-maintained metadata, not proof of successful execution.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_id, _input, signal) {
      signal?.throwIfAborted();
      const goals = sessions.related(conversationId).map(item => {
        const session = sessions.get(item.id);
        return {
          goal_id: item.id,
          objective: session.goal.objective,
          criteria: session.goal.criteria,
          source_evidence_count: item.sourceEvidenceCount || session.goal?.sourceEvidence?.length || 0,
          source_evidence_ids: item.sourceEvidenceIds || (session.goal?.sourceEvidence || []).map(entry => entry.id)
        };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ goals }) }], details: { goals } };
    }
  }, {
    name: 'create_linked_goal', label: '创建关联目标',
    description: 'Create a separate saved goal from this conversation when the user asks to establish a goal or delegate a long task. Include a self-contained objective, acceptance criteria and relevant context. Optional evidence_ids may attach assist evidence only when the user explicitly names which recorded evidence_ids to feed into exploration—never attach all evidence by default and never invent ids. Reusing request_key for an identical goal merges newly named evidence_ids into the existing goal without rewriting objective/criteria. This does not start execution or switch the current chat. The user can open the linked goal and start it.',
    parameters: { type: 'object', additionalProperties: false, required: ['request_key', 'objective', 'criteria'], properties: {
      request_key: { type: 'string', minLength: 1, maxLength: 200 }, objective: { type: 'string', minLength: 1, maxLength: 4000 },
      criteria: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } },
      context: { type: 'string', minLength: 1, maxLength: 8000 },
      evidence_ids: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } }
    } },
    async execute(_id, input, signal) {
      const goal = await sessions.createLinkedGoal(conversationId, input, signal);
      const value = {
        goal_id: goal.id,
        source_conversation_id: conversationId,
        objective: goal.goal.objective,
        status: 'saved',
        started: false,
        source_evidence_count: goal.goal?.sourceEvidence?.length || 0,
        source_evidence_ids: (goal.goal?.sourceEvidence || []).map(item => item.id)
      };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    }
  }];
}
module.exports = { goalTools };
