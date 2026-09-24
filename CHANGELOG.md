# Changelog

Notable changes to Codex Agent Bridge are recorded from version 0.3.0 onward.

## 0.3.0 — September 24, 2026

- Provide a local Chat Completions proxy for `codex app-server`, including streaming, client-defined tools, continuations, and the legacy `codex-openai-proxy` CLI alias and state paths.
- Accept inline images, WAV/MP3 audio, and PDFs in user messages. Convert inline CSV, XLSX, and UTF-8 text files through an `x_codex` extension; reject unsupported file IDs before model work.
- Add a web management console with separate administrator authentication, per-client keys, usage records, model selection, and runtime settings. Scope administrator sessions to the browser origin.
- Add persistent model price tables, optional model-assisted price discovery, and reference USD cost estimates based on measured token usage. Unpriced requests remain visible.
- Support native and Docker deployment, authentication reuse, a dark theme, and explicit native-only local administrator login.
- Add offline regression tests, read-only release candidate validation, source deployment instructions, and security reporting guidance.
