# Release checklist

English | [简体中文](../zh-CN/release.md)

## Public repository maintenance

- Keep the package repository, homepage, and issue metadata aligned with this repository; do not retain an upstream identity.
- Review dependency and imported-code licenses for compatibility with the intended release.
- Inspect the workspace, index, and complete Git history being pushed. Ignore rules do not remove historical secrets.
- Do not publish `deploy/local/`, `secrets/`, login credentials, databases, personal paths, or runtime logs.
- Enable private vulnerability reporting, branch protection, and CI checks, and verify that the contact process in the [security policy](security.md) works.

## Candidate verification

```sh
npm ci
npm --prefix web ci
npm run build:web
npm run check
npm run test:package
docker build -t codex-agent-bridge:candidate .
BRIDGE_TEST_IMAGE=codex-agent-bridge:candidate node scripts/docker-smoke.mjs
```

Review the Docker smoke script's usage and environment requirements first. It uses test credentials and a fake backend, so it makes no real model calls. Offline CI provides cross-platform verification; a local pass does not prove every platform.

The manual **Validate release candidate** workflow validates and stores a tarball with read-only permissions. It does not create commits or tags, push, or publish. Registry-backed smoke testing is an optional clean dependency-install check, not a release action.

## Before publishing npm or container artifacts

1. Confirm ownership of the package or image namespace, set accurate repository metadata, and choose the version.
2. Audit current dependencies and the production image. Resolve each result without using forced automatic upgrades as a substitute for compatibility testing.
3. Remove `private` only after publication is explicitly approved, then configure repository-specific publishing identity and protected environments.
4. Re-run checks on the final commit and verify the tarball allowlist and checksums.
5. Publish immutable versions and record supported platforms, the Codex version, limitations, and upgrade steps.
6. Never overwrite an existing tag; inspect registry state before recovering from a failed release.

## Upgrade and rollback

Before upgrading, confirm that no requests are active. Stop the service and back up state, the management database and master key, the isolated Codex home, and deployment configuration together. A SQLite backup must be consistent; do not copy only the main database while it is live and omit its WAL.

Keep the prior image or commit with its matching state backup. Rebuild with exactly the same Compose files and environment configuration, then verify readiness and administrator login. In the local profile, verify that an invalid key is rejected; in the agent-service profile, verify that anonymous requests work without key attribution. Restarting interrupts active requests, and an in-flight tool batch is not guaranteed to recover. Do not run `docker compose down -v` without confirming that its volumes may be deleted.
