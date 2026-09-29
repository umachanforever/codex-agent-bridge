# Security policy

English | [简体中文](../zh-CN/security.md)

The `main` branch is currently maintained. No long-term support or security response-time commitment is offered. See the [security model](../reference/security.md) for design boundaries.

## Report a vulnerability

Do not submit usable credentials, login links, production transcripts, or unredacted logs publicly.

Prefer GitHub Security's **Report a vulnerability** feature when private vulnerability reporting is enabled. Otherwise, open a contact-only issue without vulnerability details and wait for the maintainer to establish a private channel. This project does not claim an unconfigured security email address.

Include the affected commit, deployment method, attack prerequisites, expected and actual behavior, and a minimal reproduction using synthetic data. Revoke or rotate exposed credentials immediately instead of waiting for a code fix.

## Supported security boundaries

- The service binds only to host loopback addresses by default; documented deployments are not intended for direct Internet exposure.
- Administrator credentials, client keys, and upstream login credentials are separate.
- Multiple client keys do not provide multi-tenant isolation between filesystems or Codex sessions.
- Password-free native local login is only for trusted direct access and must not sit behind a proxy or tunnel.
- Full execution access can read credentials available to the process. Containers should not mount the Docker socket or broad host directories.
- Treat logs as sensitive plaintext and never upload raw diagnostics to an issue.
