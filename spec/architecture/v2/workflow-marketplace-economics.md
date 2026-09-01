# WorkflowOS 2.0 — Workflow Marketplace Economics

**Status:** PROPOSED / normative V2 design

## Purpose

Define the commercial boundary around installable WorkflowVersions without allowing payment or publisher relationships to change execution authority.

## Commercial models

First-class models:

- `free`
- `one_time_purchase`
- `maintenance_subscription`

Additional licensing models require a governed V2 architecture change.

## Objects

- **Listing** — public metadata describing a WorkflowVersion, publisher, requirements and commercial terms.
- **Offer** — immutable pricing/terms for a Listing revision.
- **Entitlement** — customer's right to access one or more versions/updates under an accepted Offer.
- **Installation** — customer's explicit binding to a WorkflowVersion.
- **Deployment** — customer's execution binding for an installed version.

A Listing is not the WorkflowVersion. An Entitlement is not an Installation. An Installation is not an authorization grant beyond the customer's existing policy.

## Purchase flow

```text
Listing
  ↓
Offer accepted
  ↓
Entitlement
  ↓
Customer chooses WorkflowVersion
  ↓
Installation pins exact version
  ↓
Customer deployment policy controls execution
```

## One-time purchase

A one-time purchase grants the rights explicitly specified by the Offer. The purchased WorkflowVersion remains immutable. Update rights, if any, are represented by entitlement rules and require an explicit customer installation/deployment transition.

## Maintenance subscription

A maintenance subscription may grant access to publisher-provided compatible versions, support, fixes, or maintenance releases according to the accepted terms. The publisher cannot silently replace an installed version. The customer or a customer-configured update policy selects whether a new compatible version becomes active.

Cancellation stops future maintenance rights according to the Offer; it does not rewrite historical versions or retroactively alter an already executed run.

## Publisher boundary

Publishers may manage their own WorkflowRepository, versions, listings, offers and publisher-side maintenance artifacts. They do not receive automatic access to:

- customer secrets;
- customer private workflow data;
- customer deployments;
- customer execution inputs/outputs;
- customer run evidence.

Any explicit support or diagnostic access must be separately authorized and scoped.

## Entitlement boundary

Entitlement answers **may this customer access/install this content/version?** It does not answer **may this workflow execute this capability?**

Execution remains governed by:

```text
workflow policy
AND user/org authorization
AND node capability
AND placement/locality
AND consent/security policy
```

## Payment isolation

Payment processors are external adapters. Provider-specific payment identifiers, webhooks, cards, bank credentials and processor state do not belong in WorkflowIR or execution authority contracts. The workflow domain deals only with normalized entitlement facts.

## Version and compatibility rules

An installed WorkflowVersion remains addressable by immutable identity/digest even when a newer version is published. A maintenance update may be accepted only when compatibility rules pass. A breaking change must result in a distinct version and explicit customer transition.

## Trust presentation

Marketplace metadata may expose:

- publisher identity;
- WorkflowVersion digest;
- required capabilities;
- data scopes;
- placement requirements;
- security/effect profile;
- dependency graph;
- available tests/evidence;
- price and maintenance terms.

Publication, sales volume, ranking, reviews, or marketplace badges must never be interpreted as authorization or execution proof.

## Safety requirements

Paid status cannot bypass policy. A marketplace workflow may request dangerous capabilities, but installation must disclose those requirements and execution must still pass the customer's authorization and consent boundary.

## Required regressions

- private listing cannot leak to unauthorized tenant;
- purchase does not grant a capability permission;
- publisher cannot mutate installed version;
- maintenance update requires explicit adoption;
- canceled maintenance stops eligible updates but preserves pinned installation;
- payment processor failure cannot create a false entitlement;
- entitlement for version A cannot silently authorize version B;
- publisher cannot read customer secrets or execution data without explicit authorization.
