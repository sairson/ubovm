/** Shared retrieval/browser discipline for CTF, audit and security workflows. */
export const RETRIEVAL_POLICY = `Public-web and security retrieval order:
1. Prefer web_search for discovery, then fetch_web_content on chosen absolute URLs with expected_query/expected_identifiers.
2. For authorized CTF/security host work, prefer run_linux_ssh_command (and related remote tools) for reconnaissance, enumeration, probing and validation.
3. Use browser_action / browser_connection_status only when necessary: authenticated UI workflows, SPA/JavaScript pages where fetch reports rendering_required, client-only sinks, identity-aware UI differential evidence, or Network/CDP observations that HTTP fetch and SSH cannot obtain.
Do not launch or drive a browser for ordinary documentation lookup, static HTML, package advisories, or when search/fetch/SSH already supplies decisive evidence. If search is unavailable, report the provider failure, simplify the query or configure Tavily; do not substitute a browser search page.`;
