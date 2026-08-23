/**
 * WORK-027: DefaultExecutionPromptBuilder.
 *
 * Generates the DETERMINISTIC implementation prompt for a Work Order
 * execution from the PERSISTED ImplementationContextContent (built by
 * DefaultImplementationContextBuilder — the context authority).
 *
 * Determinism contract (WORK-027 §12): given identical authoritative inputs
 * (project, Work Item, Work Order, ArchitectureVersion, Requirements,
 * Criteria, Dependencies, Review findings), the generated prompt is
 * byte-identical. Therefore the builder:
 *
 *   - is a PURE function of the content (+ the work item label);
 *   - embeds NO timestamps, NO random values, NO UUIDs (only human-readable
 *     labels/titles/descriptions);
 *   - uses a FIXED section order with FIXED wording.
 *
 * The prompt feeds BOTH execution modes (native benchmark metadata + the
 * external execution package), making native-vs-external benchmarking
 * comparable later. Sections mirror WORK-027 §11: objective, scope,
 * out-of-scope, architecture constraints, requirements, criteria,
 * dependencies, repository, branch, verification requirements, browser
 * testing requirements, prior review findings.
 *
 * This file is private to /work-items (PLAT-AC-02).
 */
import { createHash } from 'node:crypto';
import type { ImplementationContextContent } from './implementation-context.types.js';

export interface ExecutionPrompt {
  /** Deterministic markdown prompt. */
  readonly markdown: string;
  /** SHA-256 hex digest of `markdown` (determinism proof + benchmark key). */
  readonly digest: string;
}

export interface ExecutionPromptBuilder {
  build(content: ImplementationContextContent, label: { workItemLabel: string }): ExecutionPrompt;
}

export class DefaultExecutionPromptBuilder implements ExecutionPromptBuilder {
  build(
    content: ImplementationContextContent,
    label: { workItemLabel: string },
  ): ExecutionPrompt {
    const lines: string[] = [];

    lines.push(`# Implementation Instructions — ${label.workItemLabel}`);
    lines.push('');

    section(lines, 'Objective', content.objective ? [content.objective] : null);
    section(lines, 'Scope', content.scope ? [content.scope] : null);
    section(lines, 'Out of Scope', content.outOfScope ? [content.outOfScope] : null);
    section(
      lines,
      'Architecture Constraints',
      content.architectureConstraints ? [content.architectureConstraints] : null,
    );

    if (content.requirements.length > 0) {
      lines.push('## Requirements');
      lines.push('');
      content.requirements.forEach((req, index) => {
        lines.push(`### ${index + 1}. ${req.title}`);
        if (req.description) {
          lines.push(req.description);
        }
        if (req.criteria.length > 0) {
          lines.push('Acceptance criteria:');
          for (const criterion of req.criteria) {
            lines.push(`- ${criterion.description}`);
          }
        }
        lines.push('');
      });
    }

    if (content.dependencies.length > 0) {
      lines.push('## Dependencies');
      lines.push('');
      for (const dep of content.dependencies) {
        // Title only — the prompt deliberately embeds NO UUIDs so that
        // identical authoritative inputs always produce an identical prompt.
        lines.push(`- ${dep.title}`);
      }
      lines.push('');
    }

    const repoLine =
      content.repository?.owner && content.repository?.repository
        ? `${content.repository.owner}/${content.repository.repository}` +
          (content.repository.defaultBranch
            ? ` (default branch: ${content.repository.defaultBranch})`
            : '')
        : null;
    section(lines, 'Repository', repoLine ? [repoLine] : null);

    section(
      lines,
      'Verification Requirements',
      content.verificationRequirements.length > 0 ? content.verificationRequirements : null,
      '- ',
    );

    section(
      lines,
      'Expected Tests',
      content.expectedTests.length > 0 ? content.expectedTests : null,
      '- ',
    );

    section(
      lines,
      'Browser Testing Requirements',
      content.browserTestRequirements.length > 0 ? content.browserTestRequirements : null,
      '- ',
    );

    if (content.priorReviewFindings.length > 0) {
      lines.push('## Prior Review Findings');
      lines.push('');
      for (const review of content.priorReviewFindings) {
        lines.push(`- [${review.verdict}] ${review.summary}`);
        for (const finding of review.findings) {
          lines.push(`  - ${finding}`);
        }
      }
      lines.push('');
    }

    if (content.instructions.length > 0) {
      lines.push('## Instructions');
      lines.push('');
      content.instructions.forEach((instruction, index) => {
        lines.push(`${index + 1}. ${instruction}`);
      });
      lines.push('');
    }

    const markdown = lines.join('\n').trimEnd() + '\n';
    const digest = createHash('sha256').update(markdown, 'utf8').digest('hex');
    return { markdown, digest };
  }
}

function section(
  lines: string[],
  title: string,
  items: readonly string[] | null,
  prefix = '',
): void {
  if (!items || items.length === 0) return;
  lines.push(`## ${title}`);
  lines.push('');
  for (const item of items) {
    lines.push(`${prefix}${item}`);
  }
  lines.push('');
}
