import { SSHCommands } from './commands.mjs';
import { requireText } from '../../shared/common.mjs';

export class SSHCommandsPool {
  #profiles = new Map();
  constructor({ profiles = [], defaultId } = {}) {
    for (const profile of profiles) {
      if (!profile.host?.trim() && !profile.username?.trim()) continue;
      const id = requireText(profile.id ?? (profiles.length === 1 ? 'default' : ''), 'SSH profile id');
      if (this.#profiles.has(id)) throw new Error(`Duplicate SSH profile: ${id}`);
      this.#profiles.set(id, new SSHCommands({ ...profile, id }));
    }
    this.defaultId = defaultId ?? this.#profiles.keys().next().value;
    if (this.defaultId && !this.#profiles.has(this.defaultId)) throw new Error('Default SSH profile does not exist');
  }
  get(id = this.defaultId) { return this.#profiles.get(id); }
  require(id = this.defaultId) { const profile = this.get(id); if (!profile) throw new Error(`SSH profile is not configured: ${id ?? '(default)'}`); return profile; }
  summaries() { return [...this.#profiles.entries()].map(([id, profile]) => profile.summary(id === this.defaultId)); }
  async close() { await Promise.all([...this.#profiles.values()].map(profile => profile.close())); }
}
