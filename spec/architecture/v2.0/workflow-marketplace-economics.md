# WorkflowOS 2.0 — Marketplace & Creator Economics

This document makes the commercial model normative enough that implementation agents do not invent incompatible entitlement, update, or creator-payment semantics later.

## 1. Marketplace is a distribution layer

The Marketplace distributes Workflow Repositories and immutable Workflow Versions.

It does NOT become:

- an execution authority;
- a capability authority;
- a policy authority;
- a workflow mutation authority.

The execution runtime remains authoritative for whether an installed workflow may actually run.

## 2. Entitlements

An entitlement grants a user permission to obtain/use a workflow according to explicit commercial terms.

Minimum identity:

```text
EntitlementId
buyer
workflowId
purchasedVersion or releaseChannel
seller/publisher
commercialPlan
status
startedAt
expiresAt
createdAt
```

Entitlement status should be explicit:

```text
active
expired
revoked
cancelled
refunded
```

## 3. One-time purchase

A one-time purchase creates a perpetual or term-limited execution entitlement according to the listing terms.

A perpetual purchase does NOT imply automatic adoption of future versions.

The default safe model is:

```text
purchase version N
      ↓
install version N
      ↓
version N remains reproducible
      ↓
creator publishes N+1
      ↓
user chooses whether to update
```

A creator may define a compatibility/update policy, but immutable historical versions remain installable when the entitlement permits them.

## 4. Maintenance subscription

A maintenance subscription is a continuing entitlement to compatible releases rather than a perpetual right to every future release regardless of compatibility.

A subscription may cover:

```text
bug fixes
connector changes
platform adaptation
security updates
performance improvements
workflow corrections
creator support
```

Subscription terms must identify the version/release channels covered.

## 5. Compatibility-aware updates

A maintenance update may be classified:

```text
compatible patch
compatible minor
major/incompatible
security-critical
platform-required
```

The runtime does not install updates merely because the subscription is active.

The update service evaluates:

```text
compatibility
policy changes
required capabilities
required permissions
input/output contract changes
locality requirements
side-effect changes
```

A material capability or side-effect expansion requires explicit user acceptance.

## 6. Creator economics

The creator model should support:

```text
one-time purchases
subscriptions
free workflows
free trials
organization licensing
volume licensing
```

The first implementation may begin with one-time and subscription purchases, but the artifact model should not hard-code a single pricing mechanism.

## 7. Revenue and payment boundary

Payment processing is an integration boundary.

No payment provider SDK belongs in workflow execution/domain modules.

The commercial subsystem should expose a provider-neutral contract such as:

```text
PricingService
EntitlementService
BillingService
PublisherSettlementService
```

Provider adapters remain outside the core workflow model.

## 8. Publisher settlement

Marketplace sales produce accounting records separate from Workflow Runs.

A settlement record should preserve:

```text
transaction
workflow/release
publisher
buyer
amount
currency
platformFee
creatorShare
status
timestamps
```

Financial accounting is authoritative for money. Workflow execution state is authoritative only for execution.

## 9. Refund/revocation semantics

Commercial revocation must not rewrite execution history.

After a refund/revocation:

- historical runs remain attributable;
- prior evidence remains attributable;
- future execution may be blocked according to entitlement policy;
- already-installed local versions are governed by the explicit license/entitlement policy.

## 10. Marketplace ranking

Search ranking, ratings, downloads, revenue and popularity are advisory discovery signals.

They must never affect:

```text
capability grants
policy ceilings
permission checks
node selection
security decisions
```

## 11. Paid workflow trust metadata

Listings should display a capability summary generated from the immutable Workflow Version:

```text
data accessed
apps/services touched
side-effect classes
required permissions
required devices
execution locality
human approvals
network use
external services
```

The marketplace should not allow a creator to advertise weaker access requirements than the workflow actually declares.

## 12. Creator maintenance authority

The creator owns the workflow repository/version lineage they publish.

The creator does NOT own a buyer's deployment.

Therefore a creator may:

```text
publish a new version
mark a version deprecated
publish security guidance
publish a compatible update
```

but may not remotely:

```text
change an installed immutable version
expand its permissions
extract buyer secrets
reassign buyer data
execute against buyer resources
```

without explicit runtime authorization.

## 13. Commercial provenance

Every marketplace installation should be able to answer:

```text
who published it?
which repository?
which Workflow Version?
which commercial entitlement?
under what license?
which deployment installed it?
```

This provenance is independent from the Workflow Run's operational provenance.

## 14. Marketplace and open-source workflow repositories

Public workflows can remain open-source while supporting optional paid services around them.

Examples:

```text
FREE workflow source
PAID maintenance
PAID support
PAID hosted execution
```

The architecture must not assume source access and execution entitlement are the same permission.

## 15. Creator quality loop

Creators should receive aggregate, privacy-respecting operational signals about published workflows:

```text
successful runs
failure classes
platform compatibility
common blocked capabilities
update adoption
teaching completion
```

Raw customer data must not leak merely because a workflow is published or monetized.

## 16. Economic invariants

1. Money does not grant execution authority.
2. Payment provider choice does not leak into workflow domain contracts.
3. Entitlement does not mutate an immutable Workflow Version.
4. Subscription maintenance cannot silently broaden permissions.
5. Refund/revocation does not erase historical execution evidence.
6. Creator ownership does not imply control over buyer resources.
7. Marketplace ranking never influences security or capability authorization.
8. Every commercial installation is attributable to an exact workflow release/version.
