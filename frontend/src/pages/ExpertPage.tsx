import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  organizations,
  workflowRepository,
  type ProductWorkflow,
  type ProductWorkflowVersion,
} from '../api/client';
import OrganizationOnboarding from '../components/onboarding/OrganizationOnboarding';

/**
 * ExpertPage — the intentional entry to the developer/engineering workspace
 * (V2-017 Task 1; T13 — the explicit mode crossing), extended by
 * REALITY-REPAIR-004 Slice B with the bounded expert workflow authoring
 * surface.
 *
 * The existing engineering control surface is re-contextualized as an expert
 * workspace, not deleted (work-order rule 8). This page is the progressive
 * disclosure step from the product shell (INSPECT level) to the existing
 * project-scoped controls: workbench, architecture, requirements, work
 * items, benchmarks, and settings. The expert surface remains a consumer of
 * backend authorities — it introduces no second workflow, execution, or
 * evidence authority.
 *
 * T13: the crossing is EXPLICIT — the page names the mode transition
 * ("you're leaving the consumer workflow UX for the advanced workspace"),
 * and the transition target (/projects) labels the expert mode and carries
 * the return path. Never a silent product-mode switch.
 *
 * REALITY-REPAIR-004 Slice B (F-004b; Architect disposition: composition-only
 * expert authoring, AI generation DEFERRED): the page hosts the bounded
 * expert workflow authoring surface over the EXISTING V2-002 createWorkflow
 * / createVersion commands and the EXISTING V2-003 server-side validation.
 * BOUNDARY RULES (the Work Order's own prohibitions — all honored):
 *   - the expert authors the truthful WorkflowIR document DIRECTLY (a JSON
 *     editor). NO generation: WorkflowOS generates nothing, and the
 *     natural-language capture→WorkflowIR path stays deferred (the Create
 *     page's boundary says so truthfully);
 *   - NO new workflow model, NO compiler, NO node-graph builder, NO
 *     execution authority, NO AI-generation authority — the surface
 *     composes the two existing commands and nothing else;
 *   - the JSON editor is TRANSPORT: the only local check is JSON syntax
 *     (an invalid document is never sent); the semantic validation stays
 *     server-side and typed rejections render VERBATIM with the editor
 *     staying open;
 *   - success renders FROM THE AUTHORITATIVE RESPONSE (the created workflow
 *     identity + the created version facts + the durable library links) —
 *     nothing renders as created before the 201/200 responds, and
 *     create-or-converge is stated honestly (created=false says the
 *     workflow already existed).
 */

const VISIBILITIES = ['private', 'organization', 'public'] as const;

/** The current WorkflowIR compatibility descriptor (V2-003's closed protocol vocabulary). */
const DEFAULT_IR_SCHEMA_VERSION = 'workflowos-workflow-ir-v1';

type OrgsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; orgs: Array<{ id: string; name: string }> };

type CreateState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | {
      kind: 'done';
      workflow: ProductWorkflow;
      initialVersion: ProductWorkflowVersion;
      created: boolean;
    };

type VersionState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; version: ProductWorkflowVersion; created: boolean };

/** Transport-only syntax gate: an unparseable/non-object document is never sent. */
function parseIrDocument(
  text: string,
): { ok: true; content: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: `The WorkflowIR document isn't valid JSON — ${
        err instanceof Error ? err.message : 'invalid syntax'
      }. Nothing was sent.`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      message: 'The WorkflowIR document must be a JSON object. Nothing was sent.',
    };
  }
  return { ok: true, content: parsed as Record<string, unknown> };
}

export default function ExpertPage() {
  // --- the organizations read (the product-shell selection) ------------------
  const [orgsState, setOrgsState] = useState<OrgsState>({ kind: 'loading' });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [orgsNonce, setOrgsNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setOrgsState({ kind: 'loading' });
    organizations
      .listForUser()
      .then((found) => {
        if (cancelled) return;
        const mapped = found.map((o) => ({ id: o.id, name: o.name }));
        setOrgsState({ kind: 'data', orgs: mapped });
        setSelectedOrgId((current) => current ?? mapped[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setOrgsState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [orgsNonce]);

  // --- the create-workflow form (the EXISTING V2-002 command) ---------------
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<string>('private');
  const [irText, setIrText] = useState('');
  const [irSchemaVersion, setIrSchemaVersion] = useState(DEFAULT_IR_SCHEMA_VERSION);
  const [createState, setCreateState] = useState<CreateState>({ kind: 'idle' });

  // --- the create-version form (the EXISTING V2-002 command) ----------------
  const [versionWorkflowId, setVersionWorkflowId] = useState('');
  const [versionIrText, setVersionIrText] = useState('');
  const [versionIrSchemaVersion, setVersionIrSchemaVersion] = useState(DEFAULT_IR_SCHEMA_VERSION);
  const [versionState, setVersionState] = useState<VersionState>({ kind: 'idle' });

  // REALITY-REPAIR-002 composed precondition: a zero-org expert gets the
  // actionable onboarding (the existing POST /organizations authority) —
  // never a silent dead end for the org-scoped create command.
  const onOrganizationCreated = useCallback((created: { id: string; name: string }) => {
    setOrgsState((current) => {
      if (current.kind !== 'data') {
        return { kind: 'data', orgs: [{ id: created.id, name: created.name }] };
      }
      if (current.orgs.some((o) => o.id === created.id)) return current;
      return { kind: 'data', orgs: [...current.orgs, { id: created.id, name: created.name }] };
    });
    setSelectedOrgId(created.id);
    setCreateState({ kind: 'idle' });
  }, []);

  const submitCreate = useCallback(async () => {
    if (!selectedOrgId || createState.kind === 'busy') return;
    // Transport-only: the syntax gate. The semantic validation stays
    // server-side (typed rejections render verbatim below).
    const parsed = parseIrDocument(irText);
    if (!parsed.ok) {
      setCreateState({ kind: 'error', message: parsed.message });
      return;
    }
    setCreateState({ kind: 'busy' });
    try {
      const result = await workflowRepository.createWorkflow(selectedOrgId, {
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
        content: parsed.content,
        protocol: { irSchemaVersion: irSchemaVersion.trim() },
      });
      setCreateState({
        kind: 'done',
        workflow: result.workflow,
        initialVersion: result.initialVersion,
        created: result.created,
      });
      // Carry the created workflow forward as the next command's target
      // (user-owned, editable).
      setVersionWorkflowId(result.workflow.id);
    } catch (err) {
      setCreateState({
        kind: 'error',
        message: err instanceof ApiError ? err.message : 'The workflow could not be created.',
      });
    }
  }, [selectedOrgId, createState.kind, irText, slug, name, description, visibility, irSchemaVersion]);

  const resetCreate = useCallback(() => {
    setCreateState({ kind: 'idle' });
    setName('');
    setSlug('');
    setDescription('');
    setIrText('');
  }, []);

  const submitVersion = useCallback(async () => {
    if (!versionWorkflowId.trim() || versionState.kind === 'busy') return;
    const parsed = parseIrDocument(versionIrText);
    if (!parsed.ok) {
      setVersionState({ kind: 'error', message: parsed.message });
      return;
    }
    setVersionState({ kind: 'busy' });
    try {
      const result = await workflowRepository.createVersion(versionWorkflowId.trim(), {
        content: parsed.content,
        protocol: { irSchemaVersion: versionIrSchemaVersion.trim() },
      });
      setVersionState({ kind: 'done', version: result.version, created: result.created });
    } catch (err) {
      setVersionState({
        kind: 'error',
        message: err instanceof ApiError ? err.message : 'The version could not be created.',
      });
    }
  }, [versionWorkflowId, versionState.kind, versionIrText, versionIrSchemaVersion]);

  const resetVersion = useCallback(() => {
    setVersionState({ kind: 'idle' });
    setVersionIrText('');
  }, []);

  const zeroOrgs = orgsState.kind === 'data' && orgsState.orgs.length === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Expert workspace</h1>
        <p className="mt-2 text-muted-foreground">
          The engineering and architecture controls remain available as a
          deeper workspace — re-contextualized, not deleted.
        </p>
      </div>

      {/* --- REALITY-REPAIR-004 Slice B: the bounded expert authoring surface --- */}
      <section
        aria-label="Expert workflow authoring"
        className="rounded-xl border border-border bg-card p-6"
      >
        <h2 className="text-xl font-semibold">Author a workflow (expert)</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Bounded expert authoring over the existing workflow repository
          commands: you author the WorkflowIR document directly (JSON) —
          WorkflowOS generates nothing. The version is validated
          server-side; typed rejections render verbatim below and the
          editor stays open.
        </p>

        {orgsState.kind === 'loading' && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Loading your organizations…
          </p>
        )}

        {orgsState.kind === 'error' && (
          <div role="alert" className="mt-4 rounded-md bg-destructive/10 p-3">
            <p className="text-sm text-destructive">
              Your organizations are unavailable right now.
            </p>
            <button
              type="button"
              onClick={() => setOrgsNonce((n) => n + 1)}
              className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
            >
              Try again
            </button>
          </div>
        )}

        {zeroOrgs && (
          <div className="mt-4">
            <OrganizationOnboarding onCreated={onOrganizationCreated} />
          </div>
        )}

        {orgsState.kind === 'data' && orgsState.orgs.length > 0 && (
          <>
            {createState.kind === 'done' ? (
              /* The authoritative created facts — rendered FROM THE RESPONSE. */
              <div
                role="status"
                aria-label="Workflow created"
                className="mt-4 rounded-lg border border-border bg-accent/30 p-4"
              >
                <p className="text-sm font-medium">
                  {createState.created
                    ? 'Workflow created — born with immutable Version 1'
                    : 'Workflow already exists — create-or-converge returned its Version 1'}
                </p>
                <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">Name</dt>
                    <dd>{createState.workflow.name}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">Slug</dt>
                    <dd className="font-mono">{createState.workflow.slug}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">Workflow id</dt>
                    <dd className="font-mono">{createState.workflow.id}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">Content digest</dt>
                    <dd className="break-all font-mono">
                      {createState.initialVersion.contentDigest}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-3">
                  <Link
                    to={`/workflows/${createState.workflow.id}`}
                    className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Open in your Workflows library
                  </Link>
                  <Link
                    to="/workflows"
                    className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    Back to the library
                  </Link>
                  <button
                    type="button"
                    onClick={resetCreate}
                    className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    Author another workflow
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="expert-org-select" className="block text-sm text-muted-foreground">
                    For organization
                  </label>
                  <select
                    id="expert-org-select"
                    value={selectedOrgId ?? ''}
                    onChange={(event) => {
                      setSelectedOrgId(event.target.value);
                      // A prior result belongs to the previously selected
                      // organization's command — the state resets honestly.
                      setCreateState({ kind: 'idle' });
                    }}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {orgsState.orgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="expert-name" className="text-sm font-medium">
                    Workflow name
                  </label>
                  <input
                    id="expert-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="expert-slug" className="text-sm font-medium">
                    Workflow slug
                  </label>
                  <input
                    id="expert-slug"
                    type="text"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Lowercase letters, numbers and hyphens — the workflow&rsquo;s
                    durable identity inside the organization.
                  </p>
                </div>

                <div>
                  <label htmlFor="expert-description" className="text-sm font-medium">
                    Description (optional)
                  </label>
                  <input
                    id="expert-description"
                    type="text"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="expert-visibility" className="text-sm font-medium">
                    Visibility
                  </label>
                  <select
                    id="expert-visibility"
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {VISIBILITIES.map((option) => (
                      <option key={option} value={option}>
                        {option === 'private'
                          ? 'Private — only you'
                          : option === 'organization'
                            ? 'Organization — members of your organization'
                            : 'Public — any signed-in user'}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="expert-ir" className="text-sm font-medium">
                    WorkflowIR document (JSON)
                  </label>
                  <textarea
                    id="expert-ir"
                    rows={12}
                    value={irText}
                    onChange={(event) => setIrText(event.target.value)}
                    placeholder="Paste or author the WorkflowIR JSON document here — you own the content; the backend validates it."
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    You author the WorkflowIR yourself — there is no
                    generator. The document is sent verbatim as the
                    version&rsquo;s content.
                  </p>
                </div>

                <div>
                  <label htmlFor="expert-protocol" className="text-sm font-medium">
                    Protocol irSchemaVersion
                  </label>
                  <input
                    id="expert-protocol"
                    type="text"
                    value={irSchemaVersion}
                    onChange={(event) => setIrSchemaVersion(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    The version&rsquo;s truthful WorkflowIR compatibility
                    declaration — the repository&rsquo;s closed protocol
                    descriptor.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={createState.kind === 'busy'}
                  onClick={submitCreate}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {createState.kind === 'busy' ? 'Creating…' : 'Create workflow'}
                </button>

                {createState.kind === 'error' && (
                  <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {createState.message}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* --- the second EXISTING command: a new immutable version ---------- */}
      <section
        aria-label="Create a new version"
        className="rounded-xl border border-border bg-card p-6"
      >
        <h2 className="text-xl font-semibold">Create a new version</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A new immutable version for an EXISTING workflow you own — the
          repository&rsquo;s only &ldquo;edit&rdquo; (no route can ever mutate or delete a
          version). You author the WorkflowIR document directly here too.
        </p>
        {versionState.kind === 'done' ? (
          <div
            role="status"
            aria-label="Version created"
            className="mt-4 rounded-lg border border-border bg-accent/30 p-4"
          >
            <p className="text-sm font-medium">
              {versionState.created
                ? `Version ${versionState.version.versionNumber} created — immutable`
                : `Version ${versionState.version.versionNumber} already existed — create-or-converge`}
            </p>
            <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
              <div className="flex gap-2">
                <dt className="shrink-0 font-medium">Workflow id</dt>
                <dd className="font-mono">{versionState.version.workflowId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 font-medium">Content digest</dt>
                <dd className="break-all font-mono">{versionState.version.contentDigest}</dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link
                to={`/workflows/${versionState.version.workflowId}`}
                className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Open the workflow
              </Link>
              <button
                type="button"
                onClick={resetVersion}
                className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Author another version
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="expert-version-workflow-id" className="text-sm font-medium">
                Workflow id
              </label>
              <input
                id="expert-version-workflow-id"
                type="text"
                value={versionWorkflowId}
                onChange={(event) => setVersionWorkflowId(event.target.value)}
                placeholder="The durable workflow id (carried here after a create)"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label htmlFor="expert-version-ir" className="text-sm font-medium">
                WorkflowIR document (JSON)
              </label>
              <textarea
                id="expert-version-ir"
                rows={12}
                value={versionIrText}
                onChange={(event) => setVersionIrText(event.target.value)}
                placeholder="Paste or author the new version's WorkflowIR JSON document here."
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="expert-version-protocol" className="text-sm font-medium">
                Protocol irSchemaVersion
              </label>
              <input
                id="expert-version-protocol"
                type="text"
                value={versionIrSchemaVersion}
                onChange={(event) => setVersionIrSchemaVersion(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
            </div>
            <button
              type="button"
              disabled={versionState.kind === 'busy'}
              onClick={submitVersion}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {versionState.kind === 'busy' ? 'Creating…' : 'Create version'}
            </button>
            {versionState.kind === 'error' && (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {versionState.message}
              </p>
            )}
          </div>
        )}
      </section>

      {/* --- T13: the developer-workspace bridge (unchanged) ---------------- */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-medium">Developer workspace</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Open the project list to reach the workbench, architecture,
          requirements, work items, benchmarks, and the other engineering
          controls.
        </p>
        {/* V2-017 T13 — the explicit mode crossing: never a silent product
            switch. The landing names the transition and carries the return
            path. */}
        <p className="mt-2 text-sm font-medium text-muted-foreground">
          You're leaving the consumer workflow UX for the advanced workspace —
          the project list opens with the engineering controls and a way back.
        </p>
        <Link
          to="/projects"
          className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Open developer workspace
        </Link>
      </div>

      <p className="text-xs text-muted-foreground">
        The expert surface is a consumer of the existing backend authorities —
        it introduces no second workflow, execution, or evidence authority.
      </p>
    </div>
  );
}
