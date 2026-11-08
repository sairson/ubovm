---
id: VULN-001
title: "Short finding title"
severity: high            # critical / high / medium / low / info
confidence: confirmed      # confirmed / likely / suspected
status: confirmed          # confirmed requires verification: executed + reproduction: passed
verification: executed     # executed / static-only / blocked
reproduction: passed       # passed / failed / not-run
cwe: CWE-XXX
component: "path/to/component"
---

# Short finding title

## Verification

- `verification: executed` — state the command/script/test and target.
- `reproduction: passed` — quote the observed output, not the expected output.
- If this is `static-only` or `blocked`, use a `CAND-` id under
  `security-reports/candidates/`, set status `suspected` or `blocked`, and never
  describe it as a confirmed vulnerability.

## Affected locations

- `path/to/file.ext:123-145` — entrypoint or affected function
- `path/to/other.ext:67` — missing control / sink

Call path: `route -> controller -> service -> sink`.

## Root cause

Explain the missing or ineffective control in one or two paragraphs. Include a
short code excerpt (remove secrets and personal data):

```ts
// exact excerpt with the vulnerable condition
```

## Reachability and preconditions

- Who can reach it (anonymous, authenticated, role, tenant)?
- Feature flags, configuration, deployment assumptions, required parameters.
- Any prerequisites or constraints that limit or amplify impact.

## Impact

Describe the concrete security consequence: data read/write, privilege gained,
integrity/availability loss, affected users or tenants, and why it matters in
this deployment.

## Evidence

- Observed code path with path and line references.
- Focused test output or benign request/response (redact credentials):

```http
POST /example HTTP/1.1
Host: authorized-target.example
Content-Type: application/json

{"field":"benign proof"}
```

```http
HTTP/1.1 200 OK
{"result":"observed effect"}
```

- Tool call IDs, command, version and timestamp when applicable.
- Coverage limits: what was not tested or remains suspected.

## Remediation

Concrete fix at the root cause (parameterized query, authorization check,
allowlist, safe API, config change), plus defense-in-depth and a regression test
that would catch the issue returning.

## Reproduction

A runnable command or test; include the exact invocation, environment
prerequisites and the **observed** result. This is the confirmation gate: if it
was not executed, do not use `status: confirmed` or a `VULN-` id.

```bash
# exact command that was executed
```

Observed result:

```text
# actual output from the run (redact secrets)
```

## References

- CWE/OWASP category or relevant documentation.
- Related report ids or prior fixes when this extends earlier work.
