# `internal/` — private to the /llm module

Files in this directory are implementation details of the **/llm** module.
Other modules MUST NOT import from here. Cross-module imports of
`src/modules/llm/internal/**` are rejected by the static architecture
check in `tests/architecture/static-architecture.test.ts` (PLAT-AC-02).

Public capabilities are exported from `../index.ts`.
