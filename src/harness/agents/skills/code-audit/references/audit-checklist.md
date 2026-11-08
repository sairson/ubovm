# Code Audit Checklist

Use this as a starting point, not a checklist to tick mechanically. Prioritize
entrypoints that are reachable by lower-privileged users and handle sensitive
data or privileged side effects.

## Authentication and session

- Login, session, token and API-key verification on every protected route.
- Password reset, MFA, account recovery and invitation flows.
- Session fixation, rotation after privilege change, logout invalidation.
- JWT: algorithm confusion, `alg:none`, key confusion, missing expiry/audience/
  issuer validation, weak secret handling.
- OAuth/OIDC: redirect_uri allowlists, state/PKCE, implicit-flow leakage,
  token audience and scope validation.
- Cookie flags, SameSite behavior, CSRF protection for state-changing requests.

## Authorization

- Missing authorization on new routes, admin-only actions and bulk endpoints.
- IDOR/BOLA: object lookups from user-controlled ids without ownership checks.
- Function-level authorization (role/tenant checks) at controllers and services.
- Multi-tenant isolation in queries, caches, jobs and file storage.
- Mass assignment / over-posting of privileged fields.
- GraphQL: field-level authorization, introspection policy, query depth/cost.

## Input handling and injection

- SQL/NoSQL/LDAP/XPath/ORM injection; parameterization vs string concatenation.
- Command and argument injection; shell wrappers, `exec`, template interpolation.
- Template injection (SSTI), expression languages, deserialization (JSON/Java/
  Python/PHP/YAML), prototype pollution.
- Path traversal and archive extraction; `..`, symlinks, absolute paths.
- SSRF: user-controlled URLs, redirects, DNS rebinding, internal metadata/LB,
  file reads through URL handlers, allowlists vs blocklists.
- XXE, unsafe XML/SVG/media parsing, spreadsheet formula injection.
- Header injection, CRLF, open redirects, host-header trust.
- File upload: extension/content validation, storage path, execution, size,
  image parser attack surface; download authorization.

## Data protection

- Secrets in source, logs, errors, telemetry, client bundles and build artifacts.
- Credential exposure in URLs, referrers, shell history, process args.
- Sensitive data in caches, queues, backups and temporary files.
- Encryption choices, key management, random number generation, hashing
  parameters, TLS verification disabled.
- Logging of tokens/passwords/PII; error responses leaking internals.
- PII/retention requirements and access control over exports.

## Business logic and races

- Price/quantity/currency manipulation and server-side recalculation.
- Coupon, refund, balance and withdrawal flows; replay and idempotency.
- TOCTOU races, concurrent state transitions, double-spend protection.
- Workflow bypasses through direct API calls or alternate state transitions.

## Dependencies, configuration and deployment

- Dependency versions against known advisories; lockfile integrity.
- CI/CD secrets, pull-request workflows, artifact signing and deployment perms.
- Debug endpoints, default credentials, permissive CORS, missing security headers.
- Cloud storage/IAM policies, metadata endpoints, network exposure.
- Container images, capability flags, mounted secrets, Kubernetes RBAC.
- Feature flags and test hooks that are enabled in production.

## Evidence checks before reporting

- **Reproduction gate:** has a runnable test/script/request actually executed
  and shown the claimed effect? If not, this is a `CAND-` candidate, not a
  confirmed vulnerability. Static reading or an unexecuted PoC is not proof.
- Is the path reachable from a realistic attacker starting point?
- Is the apparent missing control actually enforced elsewhere (framework,
  gateway, middleware, database, deployment)?
- Can you reproduce the effect with a benign, non-destructive proof?
- Is the root cause distinct from findings already reported?
- Would the remediation close this exact path without breaking legitimate use?
