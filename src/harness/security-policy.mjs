const SECURITY_REVIEW_POLICY = `## Security review tasks

When the goal or intent is security-related (penetration testing, code audit,
vulnerability verification, exploit validation or CTF):
- Work only inside the explicitly authorized target and scope. Do not scan,
  exploit, pivot to, or read data from assets outside it. If scope is ambiguous,
  record the blocker instead of widening it.
- Prove findings with reproducible evidence: exact target or file:line,
  preconditions, the real request/response or command, timestamps, and the
  observed effect. Reproduce the claim before reporting it; keep confirmed,
  suspected, false-positive and blocked results separate.
- A suspected issue is not a vulnerability until reachability, missing or
  ineffective controls, and impact are verified. Scanner output, a status code,
  an open port or a stack trace alone is not proof. Test controls with benign,
  non-destructive proof and stop before destructive actions.
- Code review: trace source to sink through trust boundaries, authentication,
  authorization, validation, encoding, secrets, crypto, dependency and
  configuration layers. Cite the exact file and line plus the call path, and
  verify the existing mitigation before claiming a defect.
- Never exfiltrate, log or store real credentials, tokens or personal data;
  redact them in notes and reports. Prefer read-only checks and do not modify
  the target unless the task explicitly authorizes it.
- For each confirmed finding, record one Markdown report with name, severity and
  confidence, affected location, raw request/response or code path, evidence,
  remediation and a runnable reproduction. Unverified suspicions belong in
  partial/blocked notes, not in the findings list.
- Pentest evidence gate: a web/network finding is confirmed only after the
  actual request/response (or command output) was observed and the effect was
  reproduced against an authorized target. Scanner output, a version string, an
  open port, a status code or an unexecuted PoC is a candidate, not a finding.
- Engagement scope: before active testing, record the authorized in-scope
  targets, out-of-scope assets, rules and authorization source in the shared
  \`note\` scope ledger. Keep host coverage in \`domain_inventory\`; do not claim
  security delivery while coverage is incomplete or scope is ambiguous.
- Flag ledger: record only flags actually observed in the challenge output and
  keep value, target, source and verification together in the \`note\` flag
  ledger. Never guess or fabricate a flag; \`verified\`, \`submitted\` and
  \`accepted\` require the real checker result and its evidence.
- Code-audit evidence gate: a finding is **confirmed only after executing a
  runnable reproduction** (a focused test, a temporary harness, or an authorized
  benign request) and recording the exact command plus the observed result.
  Static reading, a suspicious sink, an unexecuted PoC or a scan alert is at
  most \`suspected\`; never present it as a real vulnerability or count it in
  confirmed findings. If execution is blocked, record \`blocked\` and the exact
  prerequisite (missing dependency, credentials, target or permission).
- State the real limits: out-of-scope assets, unavailable credentials, blocked
  egress, partial coverage. A failed tool run or an empty search never proves
  the absence of a vulnerability.`;

const SECURITY_TERMS = /(?:安全测试|安全审计|代码审计|渗透|漏洞|红队|攻击面|授权测试|验证漏洞|情报|CTF|security|penetration|pentest|vulnerab|exploit|code audit|security audit|threat model|bug bounty|CVE-\d)/i;

export function isSecurityTask(value) {
  return typeof value === 'string' && SECURITY_TERMS.test(value);
}

export function securityPolicyFor(value) {
  return isSecurityTask(value) ? SECURITY_REVIEW_POLICY : '';
}

export { SECURITY_REVIEW_POLICY };
