/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ExternalExecutionDialog } from '@/components/execution/ExternalExecutionDialog';
import { ExecutionModeDialog } from '@/components/execution/ExecutionModeDialog';
import type { ExecutionSummary } from '@/api/client';

const summary: ExecutionSummary = {
  executionId: 'wf_ext00001',
  mode: 'external',
  provider: 'fake',
  model: null,
  status: 'handoff_ready',
  agentRunId: null,
  externalSessionRef: null,
  repository: 'workflowos/repo',
  branch: 'feat/work-001',
  promptDigest: 'digest',
  benchmarkMetadata: {},
  startedAt: null,
  completedAt: null,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('WORK-028: ExternalExecutionDialog — Open with Companion', () => {
  it('renders the Open with Companion action for handoff-ready executions', () => {
    const { getByTitle } = render(
      <ExternalExecutionDialog
        open
        onOpenChange={() => undefined}
        executionSummary={summary}
      />,
    );
    const button = getByTitle(/Hand this execution to the WorkflowOS Companion/i);
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('disables both handoff actions when the execution is terminal', () => {
    const { getByTitle } = render(
      <ExternalExecutionDialog
        open
        onOpenChange={() => undefined}
        executionSummary={{ ...summary, status: 'expired' }}
      />,
    );
    expect(getByTitle(/Hand this execution to the WorkflowOS Companion/i)).toBeDisabled();
  });
});

describe('WORK-030 (PR #33): ExecutionModeDialog surface capabilities', () => {
  it('renders Conversational + Coding Agent readiness rows for capable providers', async () => {
    const providers = [
      {
        name: 'ChatGPT',
        provider: 'chatgpt',
        model: 'default',
        nativeApi: 'not-configured' as const,
        externalUi: 'available' as const,
        capabilities: {
          conversationalChat: 'ready' as const,
          codingAgent: 'unverified' as const,
          implementationSurface: 'coding-agent' as const,
        },
      },
    ];
    const { getByText } = render(
      <ExecutionModeDialog
        open
        onOpenChange={() => undefined}
        workItemLabel="WORK-1"
        providers={providers}
        busy={false}
        error={null}
        onSubmit={() => undefined}
      />,
    );
    expect(getByText('Conversational: Ready')).toBeInTheDocument();
    expect(getByText('Coding Agent: Unverified')).toBeInTheDocument();
  });
});
