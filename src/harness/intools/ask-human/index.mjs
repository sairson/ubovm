import { Type } from 'typebox';
import { textResult } from '../shared/common.mjs';
import { checkAbort } from '../shared/store/memory-store.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { ASK_HUMAN_CATALOG } from '../shared/tool-catalogs.mjs';

/** Hard limits shared by the tool and the host question service. */
export const ASK_HUMAN_LIMITS = Object.freeze({ maxQuestion: 2000, maxOptions: 8, maxLabel: 120, maxDescription: 400, maxCustom: 4000 });

const text = (value, name, max) => {
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} must be nonempty text`);
  if (trimmed.length > max) throw new RangeError(`${name} must be at most ${max} characters`);
  return trimmed;
};

/** Validate and normalize ask_human arguments. Shared with host-side tests. */
export function normalizeAskHumanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('ask_human arguments must be an object');
  for (const key of Object.keys(input)) if (!['question', 'options', 'multiple', 'allow_custom', 'help', 'help_topic'].includes(key)) throw new Error(`Unknown ask_human field: ${key}`);
  const question = text(input.question, 'question', ASK_HUMAN_LIMITS.maxQuestion);
  if (!Array.isArray(input.options) || !input.options.length || input.options.length > ASK_HUMAN_LIMITS.maxOptions) {
    throw new RangeError(`ask_human requires 1 to ${ASK_HUMAN_LIMITS.maxOptions} options`);
  }
  const seen = new Set();
  const options = input.options.map((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new TypeError(`option ${index + 1} must be an object`);
    for (const key of Object.keys(option)) if (!['label', 'description'].includes(key)) throw new Error(`Unknown option field: ${key}`);
    const label = text(option.label, `options[${index + 1}].label`, ASK_HUMAN_LIMITS.maxLabel);
    if (seen.has(label)) throw new Error(`Duplicate option label: ${label}`);
    seen.add(label);
    return { label, ...(option.description === undefined || option.description === null || option.description === '' ? {} : { description: text(option.description, `options[${index + 1}].description`, ASK_HUMAN_LIMITS.maxDescription) }) };
  });
  if (input.multiple !== undefined && typeof input.multiple !== 'boolean') throw new TypeError('multiple must be a boolean');
  if (input.allow_custom !== undefined && typeof input.allow_custom !== 'boolean') throw new TypeError('allow_custom must be a boolean');
  return { question, options, multiple: input.multiple === true, allowCustom: input.allow_custom !== false };
}

function answerText(answer) {
  if (answer.cancelled) return '这次提问没有得到回答（用户跳过或已取消）。请据此继续；需要时在澄清歧义后再问一次。';
  const lines = [];
  if (answer.selected?.length) lines.push(`用户选择：${answer.selected.map(value => `「${value}」`).join('、')}`);
  if (answer.custom) lines.push(`用户补充：${answer.custom}`);
  return lines.length ? lines.join('\n') : '用户没有给出可用回答。';
}

/** Ask the human to pick from options (optionally multiple) and/or add a custom answer. */
export function createAskHumanTool({ askHuman, sessionId, workerId = 'worker' } = {}) {
  const tool = {
    name: 'ask_human',
    label: 'Ask the human',
    description: ASK_HUMAN_CATALOG.description,
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: ASK_HUMAN_LIMITS.maxQuestion, description: 'Question shown to the user.' }),
      options: Type.Array(Type.Object({
        label: Type.String({ minLength: 1, maxLength: ASK_HUMAN_LIMITS.maxLabel, description: 'Short option label returned to you.' }),
        description: Type.Optional(Type.String({ maxLength: ASK_HUMAN_LIMITS.maxDescription, description: 'Optional explanation shown under the label.' }))
      }, { additionalProperties: false }), { minItems: 1, maxItems: ASK_HUMAN_LIMITS.maxOptions, description: 'Selectable answers; labels must be unique.' }),
      multiple: Type.Optional(Type.Boolean({ description: 'Allow selecting more than one option (default false).' })),
      allow_custom: Type.Optional(Type.Boolean({ description: 'Allow a free-form answer in addition to the options (default true).' })),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      checkAbort(signal);
      if (typeof askHuman !== 'function') throw new Error('人工问答界面不可用，无法向用户提问。');
      const request = normalizeAskHumanInput(input);
      const answer = await askHuman({ ...request, sessionId, workerId, signal });
      checkAbort(signal);
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('人工问答返回了无效结果。');
      const offered = new Set(request.options.map(option => option.label));
      const chosen = Array.isArray(answer.selected) ? [...new Set(answer.selected.filter(value => typeof value === 'string' && offered.has(value)))] : [];
      const selected = request.multiple ? chosen : chosen.slice(0, 1);
      const custom = typeof answer.custom === 'string' ? answer.custom.trim().slice(0, ASK_HUMAN_LIMITS.maxCustom) : '';
      const cancelled = answer.cancelled === true;
      const details = { question: request.question, selected, custom, cancelled };
      return textResult(answerText(details), details);
    }
  };
  return withProgressiveDisclosure(tool, { ...ASK_HUMAN_CATALOG, mode: 'flag' });
}
