/** Shared public-web and environment retrieval discipline for all agent roles. */
export const RETRIEVAL_POLICY = `Public-web and environment retrieval:
1. Use web_search for discovery, then fetch_web_content on absolute URLs with expected_query / expected_identifiers when source association matters.
2. Use local workspace tools for local files and code. Use run_linux_ssh_command or related remote tools only when the task targets the configured remote host; never assume local and remote files, services or paths are shared.
3. Use browser_action / browser_connection_status only when HTTP fetch and the configured shell cannot supply evidence: authenticated UI, SPA/JavaScript rendering (fetch reports rendering_required), client-only sinks, or browser network inspection. Load the browser-bridge skill before the first browser call when it is listed.
Do not launch a browser for ordinary documentation, static HTML, package advisories or when search/fetch/shell already supplies decisive evidence. If search is unavailable, report the provider failure, simplify the query or configure Tavily; do not substitute a browser search page.`;
