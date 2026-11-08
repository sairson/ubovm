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
  transport: { type: 'string', enum: ['stdio', 'sse', 'streamable_http', 'streamable-http'], description: 'Transport. Defaults to stdio.' },
  command: { type: 'string', description: 'Executable for a stdio server, for example npx or node.' },
  args: { type: 'array', maxItems: 128, items: { type: 'string' }, description: 'Arguments for a stdio server.' },
  cwd: { type: 'string', description: 'Working directory for a stdio server.' },
  url: { type: 'string', description: 'Absolute HTTP(S) endpoint for a remote server.' },
  env: { ...STRING_MAP, description: 'Environment variables for a stdio server. Stored as a credential.' },
  headers: { ...STRING_MAP, description: 'Request headers for a remote server. Stored as a credential.' },
  insecureTls: { type: 'boolean', description: 'Accept a self-signed or otherwise untrusted HTTPS certificate for this server. Only for endpoints the user controls.' },
  tlsCa: { type: 'string', description: 'PEM certificate(s) to trust for this HTTPS server instead of skipping verification.' },
  enabled: { type: 'boolean', description: 'Whether the server is enabled. Defaults to true.' },
  required: { type: 'boolean', description: 'Abort a run when the server cannot connect. Set true only when the server must always be available.' },
  tools: { type: 'array', maxItems: 512, items: { type: 'string' }, description: 'Allowlist of remote tool names. Empty means all tools.' },
  toolNamePrefix: { type: 'string', description: 'Override the exposed tool-name prefix.' },
  overwrite: { type: 'boolean', description: 'Replace an existing server with the same name. Defaults to false.' }
} };

const INSTALL_SKILL_DESCRIPTION = 'Install a skill into the user skills directory so it becomes available on the next turn. Provide either content (the full SKILL.md text with YAML frontmatter, plus optional supporting files) or url (a raw SKILL.md, a ZIP, or a tar.gz package). The skill is validated and written atomically; an existing skill is only replaced when overwrite is true, and replacing a skill already loaded in the current session may require starting a new session. It is discovered only when the next turn starts, and activates through load_skill (it is not a same-named tool); never report a skill as missing without checking the next turn\'s catalog. Use this only when the user explicitly asks to install a skill.';
const INSTALL_MCP_DESCRIPTION = 'Add or replace one MCP server in the user settings, then immediately test the real connection. Use transport stdio with command/args (and optional cwd) or sse/streamable_http with url. Credentials go in env/headers and are stored in the system credential store, never in the settings file. An existing server is only replaced when overwrite is true. required defaults to false so a server that cannot connect never aborts the run. The result carries a `connection` object: connected, the exposed tool names, or the actual failure reason (HTTP status, untrusted certificate, missing executable, timeout). Report that status to the user verbatim instead of claiming the server works; a server that failed to connect stays installed but its tools are unusable until the cause is fixed. HTTPS certificate validation is off by default for MCP (the global "ignore HTTPS certificate" MCP setting); pass insecureTls=true or tlsCa (PEM) only to pin per-server trust, and never tell the user a self-signed certificate must be fixed before the server can work. Exposed tools are named mcp__<server>__<tool>. Use this only when the user explicitly asks to install or register an MCP server.';

/** Build the agent installation tools for a host that owns settings and skills. */
function createInstallTools({ settings, destination = defaultDirectory, onInstalled = () => {}, verifyMcpServer } = {}) {
  if (!settings || typeof settings !== 'object') throw new TypeError('settings host is required');
  if (typeof destination !== 'string' || !destination.trim()) throw new TypeError('destination must be a directory');
  if (typeof onInstalled !== 'function') throw new TypeError('onInstalled must be a function');
  if (verifyMcpServer !== undefined && typeof verifyMcpServer !== 'function') throw new TypeError('verifyMcpServer must be a function');

  const notify = event => { try { Promise.resolve(onInstalled(event)).catch(() => {}); } catch { /* observers cannot fail an install */ } };

  // Saving a server only proves the settings write. Verify the real connection
  // so the chat/notification reports "installed + N tools" or the actual reason
  // instead of an unconditional success that leaves the user with no tools.
  async function probe(server, credentials) {
    if (typeof verifyMcpServer !== 'function' || server.enabled === false) return undefined;
    const candidate = { ...server };
    if (credentials.env !== undefined) candidate.env = credentials.env;
    if (credentials.headers !== undefined) candidate.headers = credentials.headers;
    try {
      const connection = await verifyMcpServer(candidate);
      return {
        connected: connection?.connected === true,
        tools: Array.isArray(connection?.tools) ? connection.tools : [],
        ...(connection?.connected === true ? {} : { error: String(connection?.error ?? 'connection failed') })
      };
    } catch (error) {
      return { connected: false, tools: [], error: String(error?.message ?? error) };
    }
  }

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
      const connection = await probe(server, { env, headers });
      const value = { ...result, effective: 'next_turn', ...(connection ? { connection } : {}) };
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
