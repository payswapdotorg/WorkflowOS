# Architecture Change Requests

Architecture Change Requests are the durable proposal mechanism for changes that cannot be made within a frozen ArchitectureVersion.

A request records motivation, current architecture, proposed evolution, alternatives, invariants preserved, impact, migration/rollback strategy, required evidence, and approval status. An ACR does not itself change the governing architecture; approved changes produce a new immutable ArchitectureVersion through the existing `/architecture` authority.
