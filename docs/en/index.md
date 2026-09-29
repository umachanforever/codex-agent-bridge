# Documentation

English | [简体中文](../zh-CN/index.md)

The [root README](../../README.md) introduces installation and agent-client setup. Start with [web management](admin.md) or [troubleshooting](troubleshooting.md). The detailed [client API reference](client-api.md) covers Chat Completions and nonstandard `x_codex` extensions; [Codex compatibility](compatibility.md) describes the pinned app-server contract.

## User documentation

| Topic                               | Read it for                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Project README](../../README.md)    | Installation, features, client setup, and operational boundaries                                  |
| [Client API](client-api.md)          | Requests, streaming, tools, continuation, media, and `x_codex` extensions                         |
| [Web management](admin.md)           | Administrator login, client keys, usage accounting, and reference pricing                         |
| [Docker deployment](docker.md)       | Compose profiles, resource limits, upgrades, and backups                                         |
| [Troubleshooting](troubleshooting.md) | Authentication, rate limits, media, and streaming                                                 |
| [Compatibility](compatibility.md)    | Pinned Codex contract, startup catalog workaround, persistence decisions, and verification limits |
| [Security policy](security.md)       | Reporting vulnerabilities and supported security boundaries                                      |
| [Release checklist](release.md)      | Evidence gates and publication procedure                                                          |
| [Changelog](changelog.md)            | Notable changes by release                                                                         |

Update the topic that owns a changed decision and its compatibility consequence. Update the root README when clients can observe the change.
