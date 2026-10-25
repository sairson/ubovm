import { Type } from 'typebox';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const alias = description => Type.String({ minLength: 1, maxLength: 32, description });

/**
 * Host-side Worker management tools exposed to the Reason planner during one
 * exploration review. Every call goes through the coordinator's control surface;
 * the tools never touch the Blackboard or another Worker's transcript directly.
 */
export function createReasonWorkerTools({ control, maxActions = 12 } = {}) {
  if (!control || typeof control.list !== 'function' || typeof control.stop !== 'function'
    || typeof control.start !== 'function' || typeof control.prompt !== 'function') {
    throw new TypeError('createReasonWorkerTools requires a worker control surface');
  }
  if (!Number.isSafeInteger(maxActions) || maxActions < 1) throw new TypeError('maxActions must be a positive integer');
  let actions = 0;
  const budget = () => {
    if (++actions > maxActions) throw new Error(`Worker action budget exhausted (${maxActions} per review). Return the JSON decision now; the host applies already executed actions.`);
  };
  return [
    {
      name: 'list_workers', label: 'List exploration Workers',
      description: 'List Workers for this review: node alias (nX), status, task description, attempt history, progress phase and the result alias. Worker aliases from this output are the only addresses stop_worker/start_worker/prompt_worker accept.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return result({ workers: control.list() }); }
    },
    {
      name: 'stop_worker', label: 'Stop an exploration Worker',
      description: 'Stop one Worker now. A running attempt is interrupted after cleanup, its slot is released and the board keeps an interrupted attempt that can be reopened; a queued intent is marked interrupted before it starts. Tool effects are never rolled back. Use start_worker to reopen stopped or failed work.',
      parameters: Type.Object({
        worker: alias('Worker alias from list_workers or the evidence, for example "n4".'),
        reason: Type.Optional(Type.String({ maxLength: 1024, description: 'Short reason recorded on the interrupted attempt.' }))
      }, { additionalProperties: false }),
      async execute(_id, input) {
        budget();
        return result(await control.stop(input.worker, input.reason));
      }
    },
    {
      name: 'start_worker', label: 'Start an exploration Worker',
      description: 'Start or reopen one Worker. A pending Worker is dispatched now when a concurrency slot is available; a failed or interrupted Worker is reopened and resumes from its latest checkpoint. Completed Workers cannot be restarted: create a new intent instead.',
      parameters: Type.Object({
        worker: alias('Worker alias from list_workers or the evidence, for example "n4".')
      }, { additionalProperties: false }),
      async execute(_id, input) {
        budget();
        return result(await control.start(input.worker));
      }
    },
    {
      name: 'prompt_worker', label: 'Send a direction to an exploration Worker',
      description: 'Send a new direction to one Worker. A running Worker restarts from its checkpoint with the direction attached; a pending, failed or interrupted Worker carries it into the next attempt. Earlier tool effects are preserved. Use this to correct course, narrow evidence requirements or stop unproductive recursion, never to replace the goal.',
      parameters: Type.Object({
        worker: alias('Worker alias from list_workers or the evidence, for example "n4".'),
        message: Type.String({ minLength: 1, maxLength: 1024, description: 'Concrete additional direction for this Worker.' })
      }, { additionalProperties: false }),
      async execute(_id, input) {
        budget();
        return result(await control.prompt(input.worker, input.message));
      }
    }
  ];
}
