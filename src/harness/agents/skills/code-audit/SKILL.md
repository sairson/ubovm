---
name: code-audit
description: "Perform an authorized source-code security audit: map entrypoints and trust boundaries, trace source-to-sink data flows, verify authentication/authorization/validation/secrets/dependency controls, and record each finding as one self-contained Markdown report. A finding is confirmed only after an executed runnable reproduction with its observed result; static-only observations stay suspected or blocked and must never be presented as real vulnerabilities."
---

# Code Security Audit

Audit source code for real security defects, then record verified findings as
deliverable reports. **One confirmed vulnerability per Markdown file.** Write
reports with the IDE workspace tools (`edit_workspace_files` and friends) so
changes appear in Code Changes and can be reviewed or undone.

## When to use

- The user asks for a code audit, secure-code review, threat-model review, or
  verification/retest of a reported vulnerability.
- You have workspace read access to the files under review.
- Not for: unverified scanner output, style/quality-only review, or systems
  outside the explicitly authorized scope. Record suspicions and blocked checks
  separately instead of inflating the findings list.

## Scope and authorization

1. Confirm the authorized target: repository/workspace, branches, deployed
   environment and any excluded paths or assets. The user's request is the scope;
   do not expand it on your own.
2. Work read-only by default. Do not modify production code or data to prove a
   finding unless the task explicitly asks for a fix or a test change.
3. Never copy real credentials, tokens, cookies or personal data into notes,
   reports, commands or test fixtures. Redact them even when they are the finding.

## Workflow

1. **Map the attack surface.** Identify languages/frameworks, entrypoints (HTTP
   routes, gRPC/GraphQL, CLI, IPC, jobs, file watchers), trust boundaries,
   authentication/authorization layers, data stores, outbound integrations and
   deployment/config files. Use `search_workspace`, `read_workspace_code`,
   `navigate_workspace_code` and `inspect_workspace_project`.
2. **Build a focused checklist** from `references/audit-checklist.md`, prioritized
   by exposure and impact. Do not blindly tick every category; combine static
   reading with evidence about how the application is deployed and invoked.
3. **Trace source to sink.** For each candidate issue identify: controllable
   input → transforms/validation → dangerous sink, plus the missing or ineffective
   control. Confirm reachability through real callers; a helper that is never
   called is not a vulnerability.
4. **Verify the mitigation.** Search for framework protections, middleware,
   sanitizers, parameterization, allowlists, authorization decorators and tests.
   A filter that exists but does not cover the reachable path is still a finding;
   a real control means do not report it.
5. **Reproduce safely** with the smallest proof: a focused unit/integration test,
   a temporary isolated harness, a benign request to an authorized test target, or
   a local `run_python` script. Prefer read-only proof and stop before destructive
   actions. Record the command, version and observed result. **A finding cannot
   be confirmed until this step actually runs and shows the claimed effect.**
6. **Assess severity and confidence.** Use exploitability, required privileges,
   reachability, data/impact and existing compensating controls. Keep confidence
   separate: suspected findings stay partial until proven.
7. **Record and index** the finding using the report layout below.
8. **Retest after fixes** and update status, evidence and the index rather than
   creating a duplicate report.

## Verification gate (mandatory)

A code-audit finding is **confirmed only when a runnable reproduction was
actually executed** against the authorized target/code and its observed result
was recorded. Reading code, spotting a suspicious sink, writing a PoC that was
never executed, or citing a scanner alert is **not** confirmation.

- `confirmed` requires: `verification: executed`, a runnable command/script or
  test, and `reproduction: passed` with the real observed output (evidence).
- Static analysis alone is `suspected` (`verification: static-only`). An
  execution attempt blocked by environment, credentials or scope is `blocked`
  (`verification: blocked`) with the exact prerequisite.
- Only executed-and-passed findings may use a `VULN-xxx` id under
  `security-reports/vulns/` and appear in the confirmed findings list/statistics.
  Suspected or blocked observations use a `CAND-xxx` id under
  `security-reports/candidates/` and are never counted as vulnerabilities.
- If the reproduction fails to show the claimed effect, do not keep the finding
  as confirmed: downgrade it to suspected/blocked and record what was actually
  observed.
- Before the final answer, re-read the report and verify the reproduction
  command, observed output and status agree. The final answer must state which
  findings were executed and which remain static-only or blocked; never use the
  word "vulnerability" for an unexecuted suspicion.

For large repositories, split independent areas with `spawn_worker` and give each
worker a disjoint path scope. Pass the same report layout and require an evidence
file or report path in each finish.

## Report layout

```
security-reports/
  README.md                      # index and statistics only
  vulns/
    VULN-001-idor-profile.md     # confirmed: reproduction executed and passed
  candidates/
    CAND-001-possible-ssrf.md    # suspected or blocked: not a confirmed finding
  evidence/                      # optional: redacted requests, logs, screenshots
```

- IDs are `VULN-<3 digits>` only for confirmed, executed findings; `CAND-<3 digits>`
  for suspected/blocked candidates. Allocate from the highest existing id + 1.
- File name: `<id>-<slug>.md` with a lowercase ASCII slug.
- Keep one finding per file. Reuse `pentest-report` conventions when both runtime
  and source evidence exist; do not duplicate the same root cause twice.
- `README.md` is an index: separate **Confirmed findings** from **Unverified
  candidates**, sort by severity, maintain total counts and status. Statistics
  count only `VULN-` entries.
- Re-read and verify each report after writing; a successful write is not proof
  that all required sections are present.

## Required finding sections

Use `references/finding-template.md` and keep every section:

1. Title, id, severity, confidence and status.
2. **Verification**: `executed` / `static-only` / `blocked`; do not use
   `status: confirmed` unless `verification: executed` and `reproduction: passed`.
3. Affected component and exact `file:line` locations (plus call path).
4. Root cause: the missing/ineffective control, with a concise code excerpt.
5. Reachability and preconditions (roles, feature flags, configuration).
6. Impact: what an attacker gains or what data/integrity/availability is lost.
7. Evidence: observed code path and the actual execution output (or, for
   candidates, explicitly why execution was impossible).
8. Remediation: concrete code/config guidance, plus defense-in-depth where useful.
9. Reproduction: a deterministic command/script/test and `reproduction: passed`
   with the observed result. An unexecuted PoC does not satisfy the gate.
10. References: CWE/OWASP category or project documentation when applicable.

## Evidence and truthfulness

- Quote exact code with path and line numbers; do not paraphrase load-bearing
  conditions from memory. Re-read after edits and record the hash/version used.
- A confirmed report must contain the actual reproduction command and its actual
  output. Never write an expected result as if it was observed; never label a
  static-only observation as confirmed.
- Distinguish confirmed from suspected and blocked. A failed tool run, empty
  search or unavailable dependency never proves the absence of a defect.
- Do not claim a fix works without retesting the affected path. Report the actual
  command/result and its limits.
- Reports are deliverables in the workspace, not chat-only summaries. The final
  answer should link the executed finding paths and list unverified candidates
  separately, so the user can immediately see what is real.

## Tool recipes

- `search_workspace` with `mode=files|matchingFiles|matchingLines|count` to find
  routes, sinks, auth middleware and dependency manifests.
- `read_workspace_code` with `startLine`/`lineCount` and `expectedHash` to page
  large files without mixing versions.
- `navigate_workspace_code` for definitions/references; provider results may be
  incomplete, so fall back to text search.
- `run_local_shell_command` / `run_python` for the focused test or reproduction
  that proves the finding, decoding and safe local proof; never use them to
  attack out-of-scope hosts. Capture the exact command and observed output.
- `edit_workspace_files` for reports; one report per file and no shell redirection.
