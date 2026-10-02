'use strict';

function goalTools(sessions, conversationId) {
  if (sessions.get(conversationId)?.mode !== 'assist') return [];
  return [{
    name: 'list_linked_goals', label: '查看关联目标',
    description: 'List saved goals created from this chat, including their objective and acceptance criteria. Criteria completion is user-maintained metadata, not proof of successful execution.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_id, _input, signal) {
      signal?.throwIfAborted();
      const goals = sessions.related(conversationId).map(item => {
        const session = sessions.get(item.id);
        return { goal_id: item.id, objective: session.goal.objective, criteria: session.goal.criteria };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ goals }) }], details: { goals } };
    }
  }, {
    name: 'create_linked_goal', label: '创建关联目标',
    description: 'Create a separate saved goal from this conversation when the user asks to establish a goal or delegate a long task. Include a self-contained objective, acceptance criteria and relevant context. This does not start execution or switch the current chat. Reuse request_key only for an identical retry. The user can open the linked goal and start it.',
    parameters: { type: 'object', additionalProperties: false, required: ['request_key', 'objective', 'criteria'], properties: {
      request_key: { type: 'string', minLength: 1, maxLength: 200 }, objective: { type: 'string', minLength: 1, maxLength: 4000 },
      criteria: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } },
      context: { type: 'string', minLength: 1, maxLength: 8000 }
    } },
    async execute(_id, input, signal) {
      const goal = await sessions.createLinkedGoal(conversationId, input, signal);
      const value = { goal_id: goal.id, source_conversation_id: conversationId, objective: goal.goal.objective, status: 'saved', started: false };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    }
  }];
}
module.exports = { goalTools };
