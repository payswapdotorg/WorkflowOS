# WORK-072 — Authentication State Synchronization

Status: planned.

Issued by: the 2026-08-30 customer dogfooding experiment's governed follow-up
(the dogfooding evidence artifact
`spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md`,
finding F-3). This Work Order fixes the auth-state synchronization
architectural defect observed in the current frontend. It does NOT implement
the runtime identity layer (WORK-074) — it fixes the frontend
state-ownership problem that exists in the current code and carries forward to
the real auth path. Activation requires the architect's authorization and is
recorded in `spec/development-state/program-state.json` (this change records
none).

Dependencies: none (hard). The defect exists in the current code
(`frontend/src/hooks/useAuth.ts`, `frontend/src/App.tsx`,
`frontend/src/pages/LoginPage.tsx`) and the fix is frontend-only. It does NOT
require the runtime identity layer (WORK-074): the state-ownership
fix is provider-independent (it establishes the canonical auth-state source
that the current demo-key path AND the future OAuth/email path both use). The
fix may be done now; it carries forward.

Downstream: none directly. The fix removes a P2 UX defect that a real
customer would reasonably conclude is a broken login. It also establishes the
auth-state-ownership architecture that WORK-074's new LoginPage will
ALSO use (the two CONFLICT on the shared LoginPage/useAuth/App.tsx surface —
see Parallel-execution metadata).

## Objective

Fix the actual architectural state-ownership problem: the LoginPage changes
authentication state locally, while the App-level auth state is not
synchronously observing the same update, requiring a reload before protected
routes become visible. The fix establishes a single canonical auth-state
source that the App shell and all consumers observe synchronously — so a
successful sign-in transition makes the protected routes visible WITHOUT a
manual reload.

The browser never decides whether a user is authorized (the backend is the
authority — a 401/403 from the backend is the authority, per the existing
WORK-022 invariant). This Work Order fixes the FRONTEND state-ownership
pattern (how the auth-state change is propagated to the App shell), NOT the
backend authority. The backend remains the authority; the frontend just
observes its own auth-state change synchronously across all consumers.

## Why this is a Work Order (the verified defect)

The dogfooding experiment (finding F-3) and the independent code verification
on this branch confirm the defect precisely:

- `frontend/src/hooks/useAuth.ts:11-25` — each `useAuth()` call creates a
  SEPARATE `useState<boolean>(auth.hasApiKey())`. The `setApiKey` callback
  calls `auth.setApiKey(key)` (the shared API client) AND
  `setHasApiKey(true)` — but ONLY on the LOCAL instance. There is no shared
  canonical auth-state source; each `useAuth()` consumer has its own state.
- `frontend/src/App.tsx:26` — `const { hasApiKey } = useAuth();` — the App
  shell has its OWN `useAuth()` instance, with its OWN `useState` initialized
  once at mount from `auth.hasApiKey()`. App's `hasApiKey` is NEVER updated
  by LoginPage's `setHasApiKey` (separate React state).
- `frontend/src/pages/LoginPage.tsx:9,25-27` — `const { setApiKey } =
  useAuth();` ... `setApiKey(key.trim())` ... `navigate('/')`. The LoginPage
  updates ITS OWN local `hasApiKey` to `true` and writes the key to the shared
  auth client, then navigates. App re-renders with `hasApiKey` still `false`
  → renders the LoginPage catch-all route again. Only a full page reload
  re-initializes App's `useState(auth.hasApiKey())` → `true` → protected
  routes become visible.
- The comment at `LoginPage.tsx:23-24` explicitly acknowledges the gap: "Set
  the API key — the backend is the authority. If the key is wrong, the first
  API call will return 401 and the UI will show an error." — i.e., the
  frontend does not synchronously verify or propagate the auth-state change
  to the App shell.

The user experiences a login that "appears to do nothing" until a manual
reload — a P2 UX defect with a non-obvious workaround.

## The fix (the architectural state-ownership pattern)

The fix establishes a single canonical auth-state source observed
synchronously by the App shell and all consumers. The likely shape is an
auth-context provider (or an observable auth client) that holds the
`hasApiKey`/`isAuthenticated` state in ONE place, and `useAuth()` reads from
that single source. When `setApiKey` (or, under WORK-074, the real
login) updates the canonical source, ALL consumers — including the App shell
— re-render synchronously with the new state.

The fix is provider-independent: it does NOT depend on whether the auth
provider is the current API-key path or the future OAuth/email path. The
state-ownership pattern survives WORK-074. In fact, WORK-074's
new LoginPage MUST use the same canonical auth-state source — the two
CONFLICT on the shared surface and must coordinate (or be sequenced).

The implementer MUST NOT create a second auth store. The canonical source is
the ONE auth-state authority on the frontend; the backend remains the ONE
authorization authority (a 401/403 from the backend is still the authority;
the frontend state is a cache of "has a credential been entered," not an
authorization decision).

## Explicit prohibitions

WORK-072 must NEVER become:

- a **second auth store** — the fix establishes ONE canonical auth-state
  source (an auth-context or observable client); it does NOT add a parallel
  state alongside the existing `useAuth` per-instance state (the per-instance
  pattern is REPLACED, not duplicated);
- a **client-side authorization mechanism** — the frontend state caches
  "has a credential been entered," NEVER "is the user authorized to do X";
  the backend remains the authority (a 401/403 is the authority; the
  WORK-022 invariant holds);
- a **re-architecture of the auth provider** — the fix is the STATE-OWNERSHIP
  pattern, not the auth provider (the provider is WORK-074's scope);
- a **silent rewrite of the WORK-022 invariant** — the existing "the browser
  never decides whether a user is authorized" discipline is preserved
  verbatim.

## Required invariants

1. There is exactly ONE canonical auth-state source on the frontend (an
   auth-context provider or an observable auth client); `useAuth()` reads
   from it.
2. When the auth-state source is updated (setApiKey under the current path;
   the real login under WORK-074), ALL consumers — including the App
   shell — re-render synchronously with the new state.
3. A successful sign-in transition makes the protected routes visible WITHOUT
   a manual reload (the empirical proof of finding F-3 resolved).
4. The backend remains the authorization authority; the frontend state is a
   cache of "has a credential been entered," not an authorization decision
   (the WORK-022 invariant holds).
5. No second auth store; the per-instance `useState` pattern in `useAuth` is
   REPLACED by the canonical source (not duplicated).
6. The fix is provider-independent (it works for the current API-key path
   AND carries forward to the OAuth/email path under WORK-074).

## Required proof

The implementation must prove, with objective evidence:

1. **login transition without reload** — after a successful sign-in, the
   protected routes become visible synchronously; NO manual reload is
   required (the empirical proof of F-3 resolved);
2. **logout** — the sign-out transition removes the auth state and returns
   the user to the LoginPage synchronously (no reload required);
3. **refresh persistence** — after a full page reload, the auth state is
   re-read from the persistent auth client (the canonical source initializes
   from `auth.hasApiKey()` at mount) and the protected routes remain visible
   (persistence holds);
4. **unauthenticated route protection** — with no auth state, the App shell
   renders the LoginPage catch-all for ALL routes (no protected route is
   reachable without auth) — discrimination-proven: removing the auth gate
   makes a protected route reachable without auth → the test FAILS;
5. **no second auth store** — the static check confirms exactly one canonical
   auth-state source (no per-instance `useState` in `useAuth` for the
   `hasApiKey`/`isAuthenticated` value);
6. **backend remains the authority** — a 401/403 from the backend still
   clears the auth state and returns the user to the LoginPage (the
   WORK-022 invariant; discrimination-proven: if the backend says 401, the
   frontend MUST NOT continue as if authenticated).

## Scope

Allowed: the auth-context provider (or observable auth client) that holds the
canonical auth-state source; the `useAuth` hook refactored to read from the
single source; the App shell wiring to consume the canonical source; the
LoginPage's `setApiKey`/login transition to update the canonical source; the
required proofs above. Frontend-only changes if that is sufficient.

Forbidden: implementing the runtime identity layer (OAuth/email adapters,
session lifecycle, service accounts — that is WORK-074's scope);
changing the backend authorization authority; introducing a second auth store;
changing the WORK-022 invariant; changing the frozen v1.0 architecture
version.

## Parallel-execution metadata

```yaml
parallelEligibility: conditional
parallelConflicts:
  - surfaces:
      - frontend/src/hooks/useAuth.ts
      - frontend/src/App.tsx
      - frontend/src/pages/LoginPage.tsx
      - frontend/src/main.tsx   # the provider wiring root
      - spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md
    reason: the frontend auth-state surface — concurrent authors must
      coordinate. WORK-074 CONFLICTS on frontend/src/pages/LoginPage.tsx
      and frontend/src/hooks/useAuth.ts and frontend/src/App.tsx (the
      identity-runtime Work Order rewrites the LoginPage and the auth
      boundary). If both WORK-072 and WORK-074 are active, coordinate:
      the natural sequencing is WORK-072 FIRST (to establish the canonical
      auth-state source) then WORK-074 (whose new LoginPage uses the
      canonical source), OR WORK-074 first then WORK-072 (if the
      runtime rewrite subsumes the state-ownership fix). The architect
      chooses the sequencing; the conflict surface is declared here so the
      choice is informed.
  - migrations: []
    # no schema migration in this Work Order — the fix is frontend-only.
  - authorities: []
    # the fix introduces NO new authority; it restructures the frontend
    # auth-state ownership. The backend /auth authority is unchanged.
  - dependencies: []
    # no hard dependencies — the defect exists in the current code and the
    # fix is frontend-only and provider-independent.
    reason: the fix does not require the runtime identity layer
      (WORK-074); the state-ownership pattern is provider-independent
      and carries forward. (WORK-074 is a CONFLICT, not a dependency —
      see the surfaces conflict above.)
protectedSurfaces:
  - frontend/src/hooks/useAuth.ts
  - frontend/src/App.tsx
  - frontend/src/pages/LoginPage.tsx
  - frontend/src/main.tsx
  - spec/work-orders/WORK-072.md
  - spec/architecture/v1.1/dogfooding-evidence/2026-08-30-onboarding-attempt.md
```

An Architect LLM may mechanically determine the state of WORK-072 as: `READY`
(no hard dependencies — the defect exists in the current code and the fix is
frontend-only); `BLOCKED` by nothing; `PARALLEL-SAFE` with WORK-071 (different
protected surfaces: the frontend auth-state vs the backend composition root)
and with WORK-073 (different protected surfaces: the LoginPage/useAuth/App
surface vs the ProjectListPage CreateProjectForm); `CONFLICTING` with
WORK-074 (shared LoginPage/useAuth/App.tsx surface — coordinate or
sequence).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second auth store or a second authorization authority;
- client-side authorization decisions;
- changing the WORK-022 invariant ("the browser never decides whether a user
  is authorized");
- changing the frozen v1.0 architecture version;
- implementing the runtime identity layer (that is WORK-074's scope —
  if the fix cannot be done frontend-only, STOP and reconsider whether the
  defect is actually a runtime-side concern).

## Definition of done

- The canonical auth-state source is established (an auth-context provider or
  an observable auth client); `useAuth()` reads from the single source.
- A successful sign-in transition makes the protected routes visible WITHOUT a
  manual reload (the empirical proof of F-3 resolved).
- Logout, refresh persistence, and unauthenticated route protection all hold
  with objective evidence (the required proofs above, including
  mutation/discrimination tests).
- The backend remains the authorization authority (the WORK-022 invariant
  holds; a 401/403 clears the auth state).
- No second auth store; the per-instance `useState` pattern is REPLACED.
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-072 scope; independent Architect Review approves; the
  implementation PR is merged; WORK-072 is marked VERIFIED.

  (This Work Order does NOT by itself satisfy the dogfooding gate — the gate
  requires WORK-074 complete AND WORK-071 complete. WORK-072 is an
  independent frontend fix that may be done in parallel; it removes a P2 UX
  defect and establishes the auth-state-ownership pattern the runtime login
  will also use.)
