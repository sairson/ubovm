---
name: attack-surface
description: "Discover and inventory related web assets for authorized security coverage in exploration (goal) and assist modes: seed roots, subdomains, certificate SAN peers, DNS aliases, and HTTP redirects. Always write findings into domain_inventory. Use when expanding attack surface, ensuring no domain is missed, or CTF/web recon."
---

# Attack Surface / Domain Inventory

`domain_inventory` is available in both exploration and assist sessions. In
exploration it is part of the goal pipeline; in assist it is the same shared
ledger, so findings survive turns and can be handed to a later goal. Use it in
both modes instead of free-text host lists.

Maintain complete host coverage with `domain_inventory`. Free-text notes are not a substitute for coverage status.

## Mode adaptation

- **Exploration mode**: run the full workflow below and require
  `coverage` → `complete=true` before security delivery acceptance.
- **Assist mode**: run the same bootstrap/discover/upsert/test/coverage loop. There
  is no goal acceptance gate, but still close coverage before presenting a final
  security summary unless the user explicitly asked for a partial survey.
- **Workers/teammates**: the ledger is shared per session. A spawned Worker may
  discover hosts; the main agent must merge them with `upsert` and verify final
  coverage itself rather than assuming a child Worker completed the ledger.
- **Degraded host**: if `domain_inventory` is unavailable because the host disabled
  internal tools, keep a compact `note` ledger (host, discovery source, relation,
  test status) and use `todo` for pending probes. State clearly that coverage is
  unverified; never claim `complete=true` without the tool.

## Scope rule (low friction)

1. Call `domain_inventory` `bootstrap` once with the user-supplied seed root domain(s) or entry URL hosts.
2. Related assets discovered from those seeds are **in scope by default**. Do **not** re-ask whether each subdomain or same-certificate host is authorized.
3. Ask once only when a host cannot be linked to any seed via subdomain, cert SAN, DNS, or HTTP redirect evidence — then either `upsert` after confirmation or `skip` with `test_status=out_of_scope`.

## Required workflow

1. **Bootstrap** seeds:
   - `domain_inventory` `{ "action": "bootstrap", "seeds": ["example.com"] }`
2. **Record engagement scope** once in the shared `note` scope ledger:
   - `{ "action": "write", "note_type": "scope", "scope": { "targets": ["example.com"], "authorization": "<authorization/challenge reference>", "rules": "<rate/read-only/stop conditions>" } }`
   - Keep the scope note and `domain_inventory` aligned; record explicitly excluded hosts under `out_of_scope`.
3. **Discover related hosts** (prefer `run_linux_ssh_command` when SSH is available; otherwise `fetch_web_content` / `web_search` for passive sources):
   - Certificate transparency / SAN peers for the seed
   - DNS: CNAME, NS, MX, and known subdomain enumeration results
   - HTTP(S) redirect final hosts and Location targets
3. **Upsert every host immediately**:
   - `{ "action": "upsert", "hostnames": ["api.example.com"], "discovery": "cert", "relation_type": "cert_san", "evidence_refs": ["brief source id"] }`
   - Use `discovery`: `enum` | `cert` | `dns` | `redirect` | `manual`
   - Use `relation_type`: `subdomain` | `cert_san` | `dns_cname` | `dns_ns` | `http_redirect` | `manual`
4. **Test and close coverage**:
   - After probing a host: `mark_tested` with evidence refs
   - If intentionally not testing: `skip` with `skip_reason` (use `test_status=out_of_scope` when outside app surface)
5. **Before security delivery accept**: `domain_inventory` `{ "action": "coverage" }` must show `complete=true` (no `pending` / `in_progress`).
6. **Verify findings before reporting**: a web finding is confirmed only after the actual request/response was observed and the effect reproduced against the authorized target. Scanner output, an open port, a version string or an unexecuted PoC is a candidate; record it as a `note` vulnerability candidate and keep it out of confirmed reports until verified.

## Discovery playbook (methodology only)

- Prefer passive sources first; escalate to remote CLI tools on the configured SSH host when needed.
- If a remote tool is missing, report the concrete missing binary and continue with available passive methods — do not invent scan results.
- Deduplicate hostnames (normalize to lowercase ASCII). Wildcards like `*.example.com` expand only to concrete names you observed.
- Record relationship evidence refs short and stable (tool call ids, CT log query labels, dig output digests).
- Keep probing reversible and low-rate on shared environments; mutate only when the task requires it.

## Anti-patterns

- Do not claim domain coverage from notes alone.
- Do not leave discovered hosts unregistered.
- Do not repeatedly request authorization for hosts already in the inventory.
- Do not mark `tested` without an actual probe or verified observation.
