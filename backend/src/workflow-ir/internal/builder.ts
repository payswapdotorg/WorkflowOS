/**
 * V2-003 — the deterministic authoring builder (client A of the IR).
 *
 * Pure construction, zero defaults beyond the documented schema defaults:
 * the builder only assembles a typed document. Validation is a separate
 * explicit step (fail-closed; the builder never "fixes" an invalid graph).
 * Combined with canonical set semantics, independently built documents are
 * byte-identical under canonical serialization (cross-client equivalence).
 */
import type {
  ControlEdge,
  PlacementId,
  PortDeclaration,
  PresentationMetadata,
  VersionAffectingCompatibility,
  WorkflowIrDocument,
  WorkflowNode,
  WorkflowOutputBinding,
  WorkflowProvenance,
} from '../types.js';
import { IR_SCHEMA_VERSION, WORKFLOW_IR_OBJECT_TYPE } from '../types.js';

export interface WorkflowIrBuilder {
  withCompatibility(compatibility: VersionAffectingCompatibility): WorkflowIrBuilder;
  withProvenance(provenance: WorkflowProvenance): WorkflowIrBuilder;
  withDefaultPlacement(placement: PlacementId): WorkflowIrBuilder;
  withStart(start: string): WorkflowIrBuilder;
  withPresentation(presentation: PresentationMetadata): WorkflowIrBuilder;
  addWorkflowInput(input: PortDeclaration): WorkflowIrBuilder;
  addWorkflowOutput(output: WorkflowOutputBinding): WorkflowIrBuilder;
  addNode(node: WorkflowNode): WorkflowIrBuilder;
  addEdge(edge: ControlEdge): WorkflowIrBuilder;
  build(): WorkflowIrDocument;
}

export function createWorkflowIrBuilder(): WorkflowIrBuilder {
  return new Builder();
}

class Builder implements WorkflowIrBuilder {
  private compatibility: VersionAffectingCompatibility = {
    compatibilityLevel: 'equivalent',
    inputSurfaceChange: 'none',
    outputSurfaceChange: 'none',
  };
  private provenance: WorkflowProvenance = { origin: 'authored' };
  private defaultPlacement: PlacementId = 'any_supported_node';
  private start = '';
  private presentation: PresentationMetadata | undefined = undefined;
  private readonly inputs: PortDeclaration[] = [];
  private readonly outputs: WorkflowOutputBinding[] = [];
  private readonly nodes: WorkflowNode[] = [];
  private readonly edges: ControlEdge[] = [];

  withCompatibility(compatibility: VersionAffectingCompatibility): WorkflowIrBuilder {
    this.compatibility = { ...compatibility };
    return this;
  }

  withProvenance(provenance: WorkflowProvenance): WorkflowIrBuilder {
    this.provenance = {
      origin: provenance.origin,
      ...(provenance.sourceRefs !== undefined ? { sourceRefs: [...provenance.sourceRefs] } : {}),
    };
    return this;
  }

  withDefaultPlacement(placement: PlacementId): WorkflowIrBuilder {
    this.defaultPlacement = placement;
    return this;
  }

  withStart(start: string): WorkflowIrBuilder {
    this.start = start;
    return this;
  }

  withPresentation(presentation: PresentationMetadata): WorkflowIrBuilder {
    this.presentation = {
      ...(presentation.title !== undefined ? { title: presentation.title } : {}),
      ...(presentation.nodeLabels !== undefined
        ? { nodeLabels: { ...presentation.nodeLabels } }
        : {}),
      ...(presentation.nodePositions !== undefined
        ? { nodePositions: { ...presentation.nodePositions } }
        : {}),
      ...(presentation.notes !== undefined ? { notes: presentation.notes } : {}),
    };
    return this;
  }

  addWorkflowInput(input: PortDeclaration): WorkflowIrBuilder {
    this.inputs.push({ ...input });
    return this;
  }

  addWorkflowOutput(output: WorkflowOutputBinding): WorkflowIrBuilder {
    this.outputs.push({ ...output });
    return this;
  }

  addNode(node: WorkflowNode): WorkflowIrBuilder {
    this.nodes.push({
      ...node,
      inputs: node.inputs.map((input) => ({ ...input })),
      outputs: node.outputs.map((output) => ({ ...output })),
      capabilityRequirements: [...node.capabilityRequirements],
    });
    return this;
  }

  addEdge(edge: ControlEdge): WorkflowIrBuilder {
    this.edges.push({ ...edge });
    return this;
  }

  build(): WorkflowIrDocument {
    const document: WorkflowIrDocument = {
      objectType: WORKFLOW_IR_OBJECT_TYPE,
      irSchemaVersion: IR_SCHEMA_VERSION,
      compatibility: { ...this.compatibility },
      ir: {
        start: this.start,
        inputs: [...this.inputs],
        outputs: [...this.outputs],
        nodes: [...this.nodes],
        edges: [...this.edges],
        defaultPlacement: this.defaultPlacement,
        provenance: { ...this.provenance },
      },
      ...(this.presentation !== undefined ? { presentation: { ...this.presentation } } : {}),
    };
    return document;
  }
}
