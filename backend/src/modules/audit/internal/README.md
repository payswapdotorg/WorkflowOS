# `internal/` — private to the /audit module

Files in this directory are implementation details of the **/audit** module.
Other modules MUST NOT import from here. Cross-module imports of
`src/modules/audit/internal/**` are rejected by the static architecture
check in `tests/architecture/static-architecture.test.ts` (PLAT-AC-02).

Public capabilities are exported from `../index.ts`.
