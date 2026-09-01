import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateWorkflowIrDocument,
  WORKFLOW_IR_OBJECT_TYPE,
  WORKFLOW_IR_REGISTRY_VOCABULARY,
} from '../../../src/workflow-ir/index.js';
import { buildMinimalDocument, withNode } from './helpers.js';

/**
 * V2-003 — platform-semantic exclusion and registry conformance.
 *
 * The IR is platform-neutral: capability references are canonical registry
 * names (V2-CTRL-003), NEVER browser/desktop/mobile/cloud SDK names and
 * never non-canonical aliases of canonical operations.
 */

const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
);

function withCapability(capability: string) {
  return withNode(buildMinimalDocument(), 'observe', {
    spec: { class: 'deterministic_api', capability },
    capabilityRequirements: [capability],
  });
}

function withCapabilityRequirements(requirements: string[]) {
  return withNode(buildMinimalDocument(), 'observe', {
    capabilityRequirements: requirements,
  });
}

describe('V2-003 — canonical capability names are accepted', () => {
  for (const capability of [
    'browser.observe',
    'filesystem.write',
    'github.repository.read',
    'messaging.send',
    'workflow.execute',
    'phone.call.answer',
    'contacts.read',
    'spreadsheet.edit',
    'speech.synthesis',
    'social.post.publish',
  ]) {
    it(`accepts the canonical capability ${capability}`, () => {
      expect(validateWorkflowIrDocument(withCapability(capability)).ok).toBe(true);
    });
  }
});

describe('V2-003 — non-canonical aliases are rejected (registry rule: aliasesForbidden)', () => {
  // the registry's own examples of forbidden aliases, plus near-misses
  for (const alias of [
    'phone.answer_call',
    'messages.send',
    'calls.answer',
    'github.read_repo',
    'Messaging.Send',
    'browser.observe ',
    ' browser.observe',
    'browser..observe',
    '.browser.observe',
    'browser.observe.v2',
  ]) {
    it(`rejects the non-canonical alias ${JSON.stringify(alias)}`, () => {
      const result = validateWorkflowIrDocument(withCapability(alias));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.code === 'IR_CAPABILITY_NON_CANONICAL')).toBe(true);
      }
    });
  }

  it('rejects non-canonical names inside capabilityRequirements too', () => {
    const result = validateWorkflowIrDocument(
      withCapabilityRequirements(['browser.observe', 'phone.answer_call']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_CAPABILITY_REQUIREMENT_NON_CANONICAL')).toBe(true);
    }
  });
});

describe('V2-003 — platform SDK concepts are rejected', () => {
  // browser SDK calls, iOS intents / app handles, desktop app handles,
  // cloud-provider SDK calls — none of these are workflow semantics
  for (const sdkConcept of [
    'chrome.tabs.create',
    'safari.webView.navigate',
    'webkit.messageHandlers.post',
    'ios.appintent.openurl',
    'uiapplication.open',
    'android.intent.action.VIEW',
    'electron.app.quit',
    'nsworkspace.openFile',
    'aws.s3.putObject',
    'navigator.geolocation.getCurrentPosition',
  ]) {
    it(`rejects the platform SDK concept ${sdkConcept}`, () => {
      const result = validateWorkflowIrDocument(withCapability(sdkConcept));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.code === 'IR_CAPABILITY_NON_CANONICAL')).toBe(true);
      }
    });
  }

  it('rejects an SDK concept smuggled into capabilityRequirements', () => {
    const result = validateWorkflowIrDocument(
      withCapabilityRequirements(['browser.observe', 'chrome.tabs.create']),
    );
    expect(result.ok).toBe(false);
  });
});

describe('V2-003 — the frozen registry vocabulary snapshot matches the registry file (no drift)', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as {
    capabilities: Record<string, string[]>;
    executionClasses: string[];
    placement: string[];
    evidence: string[];
    attestationObjectTypes: string[];
  };

  it('the embedded capability set equals the registry capability set exactly', () => {
    const registryCapabilities = new Set(
      Object.values(registry.capabilities).flatMap((group) => group),
    );
    const embedded = new Set(WORKFLOW_IR_REGISTRY_VOCABULARY.capabilities);
    expect(embedded).toEqual(registryCapabilities);
  });

  it('the embedded execution classes equal the registry execution classes exactly', () => {
    expect(new Set(WORKFLOW_IR_REGISTRY_VOCABULARY.executionClasses)).toEqual(new Set(registry.executionClasses));
  });

  it('the embedded placement identifiers equal the registry placement identifiers exactly', () => {
    expect(new Set(WORKFLOW_IR_REGISTRY_VOCABULARY.placement)).toEqual(new Set(registry.placement));
  });

  it('the embedded evidence classes equal the registry evidence classes exactly', () => {
    expect(new Set(WORKFLOW_IR_REGISTRY_VOCABULARY.evidence)).toEqual(new Set(registry.evidence));
  });

  it('the IR domain is NOT one of the registry attestation object types (domain discrimination)', () => {
    expect(registry.attestationObjectTypes).not.toContain(WORKFLOW_IR_OBJECT_TYPE);
    expect(WORKFLOW_IR_OBJECT_TYPE).toBe('workflowos/workflow-ir/v1');
  });
});
