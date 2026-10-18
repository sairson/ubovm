'use strict';
// Agent-facing installation tools. They run in the extension host because only
// the host owns the writable skills directory and the settings/SecretStorage
// store. Both tools flow through the normal tool-approval gate, and a successful
// install becomes visible on the next turn because the harness re-reads
// configuration and re-scans the skills directory for every turn.
const { installSkill } = require('../../harness/config/skills-install.cjs');
const { defaultDirectory } = require('../../harness/config/skills-catalog.cjs');

const OBJECT = { type: 'object', additionalProperties: false };
const STRING_MAP = { type: 'object', additionalProperties: { type: 'string' } };

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

const INSTALL_SKILL_PARAMETERS = { ...OBJECT, properties: {
  name: { type: 'string', minLength: 1, maxLength: 64, description: 'Kebab-case skill name. Must match the SKILL.md frontmatter name when provided.' },
  content: { type: 'string', description: 'Full SKILL.md text, including YAML frontmatter. Mutually exclusive with url.' },
  files: { type: 'array', maxItems: 256, items: { ...OBJECT, required: ['path', 'content'], properties: {
    path: { type: 'string', description: 'Relative path inside the skill package, for example scripts/run.sh.' },
    content: { type: 'string', description: 'UTF-8 file content.' }
  } } },
  url: { type: 'string', description: 'HTTP(S) URL returning a raw SKILL.md, a ZIP archive, or a tar.gz archive. Mutually exclusive with content.' },
  overwrite: { type: 'boolean', description: 'Replace an existing skill with the same name. Defaults to false.' }
} };

const INSTALL_MCP_PARAMETERS = { ...OBJECT, required: ['name'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 64, description: 'Unique server name; also the tool-name prefix unless toolNamePrefix is set.' },
  transport: { type: 'string', enum: ['stdio', 'sse', 'streamable_http'], description: 'Transport. Defaults to stdio.' },
  command: { type: 'string', description: 'Executable for a stdio server, for example npx or node.' },
  args: { type: 'array', maxItems: 128, items: { type: 'string' }, description: 'Arguments for a stdio server.' },
  cwd: { type: 'string', description: 'Working directory for a stdio server.' },
  url: { type: 'string', description: 'Absolute HTTP(S) endpoint for a remote server.' },
  env: { ...STRING_MAP, description: 'Environment variables for a stdio server. Stored as a credential.' },
  headers: { ...STRING_MAP, description: 'Request headers for a remote server. Stored as a credential.' },
  enabled: { type: 'boolean', description: 'Whether the server is enabled. Defaults to true.' },
  required: { type: 'boolean', description: 'Abort a run when the server cannot connect. Set true only when the server must always be available.' },
  tools: { type: 'array', maxItems: 512, items: { type: 'string' }, description: 'Allowlist of remote tool names. Empty means all tools.' },
  toolNamePrefix: { type: 'string', description: 'Override the exposed tool-name prefix.' },
  overwrite: { type: 'boolean', description: 'Replace an existing server with the same name. Defaults to false.' }
} };

const INSTALL_SKILL_DESCRIPTION = 'Install a skill into the user skills directory so it becomes available on the next turn. Provide either content (the full SKILL.md text with YAML frontmatter, plus optional supporting files) or url (a raw SKILL.md, a ZIP, or a tar.gz package). The skill is validated and written atomically; an existing skill is only replaced when overwrite is true, and replacing a skill already loaded in the current session may require starting a new session. It is discovered only when the next turn starts, and activates through load_skill (it is not a same-named tool); never report a skill as missing without checking the next turn\'s catalog. Use this only when the user explicitly asks to install a skill.';
const INSTALL_MCP_DESCRIPTION = 'Add or replace one MCP server in the user settings so its tools become available on the next turn. Use transport stdio with command/args (and optional cwd) or sse/streamable_http with url. Credentials go in env/headers and are stored in the system credential store, never in the settings file. An existing server is only replaced when overwrite is true. required defaults to false so a server that cannot connect never aborts the run. The server connects only when the next turn starts, so it will not appear in this turn; each turn the harness reports every server as connected or NOT connected, and that status line is the authoritative way to check whether a server actually mounted. Use this only when the user explicitly asks to install or register an MCP server.';

/** Build the agent installation tools for a host that owns settings and skills. */
function createInstallTools({ settings, destination = defaultDirectory, onInstalled = () => {} } = {}) {
  if (!settings || typeof settings !== 'object') throw new TypeError('settings host is required');
  if (typeof destination !== 'string' || !destination.trim()) throw new TypeError('destination must be a directory');
  if (typeof onInstalled !== 'function') throw new TypeError('onInstalled must be a function');

  const notify = event => { try { Promise.resolve(onInstalled(event)).catch(() => {}); } catch { /* observers cannot fail an install */ } };

  const installSkillTool = {
    name: 'install_skill',
    label: '安装 Skill',
    description: INSTALL_SKILL_DESCRIPTION,
    parameters: INSTALL_SKILL_PARAMETERS,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const result = await installSkill(input, { destination, signal });
      const value = { ...result, effective: result.overwritten ? 'next_turn_or_new_session' : 'next_turn' };
      notify({ type: 'skill', ...value });
      return textResult(value);
    }
  };

  const installMcpServerTool = {
    name: 'install_mcp_server',
    label: '安装 MCP 服务',
    description: INSTALL_MCP_DESCRIPTION,
    parameters: INSTALL_MCP_PARAMETERS,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const { env, headers, overwrite, ...server } = input ?? {};
      // Agent installs default to a non-fatal server: a bad endpoint should not
      // abort every later run. The user can flip this in settings.
      if (server.required === undefined) server.required = false;
      // An empty allowlist would expose no tools; treat it as "all tools".
      if (Array.isArray(server.tools) && !server.tools.length) delete server.tools;
      const result = await settings.addMcpServer({ server, credentials: { env, headers }, overwrite: overwrite === true });
      const value = { ...result, effective: 'next_turn' };
      notify({ type: 'mcp', ...value });
      return textResult(value);
    }
  };

  // A host without MCP support simply does not advertise the MCP tool, so a
  // partial or older settings host can never fail extension activation.
  const supported = () => typeof settings.addMcpServer === 'function'
    ? [installSkillTool, installMcpServerTool]
    : [installSkillTool];

  return {
    destination,
    tools: supported
  };
}

module.exports = { createInstallTools, defaultDirectory };
