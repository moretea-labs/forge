import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autopilotPlanTree } from '../../src/runtime/autopilot/runner';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import {
  createPlanSemanticContext,
  listPlanContracts,
} from '../../src/runtime/control-plane/facade/plan-contract-store';

test('projects thin semantic Plan items into the Autopilot model context', () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-autopilot-plan-context-'));
  try {
    createRequirement(
      { controllerHome },
      {
        requirementId: 'REQ-SEMANTIC',
        title: 'Semantic plan context',
        outcomeStatement: 'Expose thin Plan items to the autonomous loop.',
        acceptanceCriteria: ['Autopilot receives the current Plan semantic items.'],
      },
    );
    createPlanSemanticContext(
      { controllerHome, repoId: 'repo-plan-context' },
      {
        planId: 'PLAN-SEMANTIC',
        repoId: 'repo-plan-context',
        requirementId: 'REQ-SEMANTIC',
        scopeKey: 'semantic-plan',
        sourceBasisRevision: 'source-revision',
        goal: 'Drive the independent implementation loop.',
        items: [
          {
            id: 'semantic-slice',
            objective: 'Implement the semantic Plan slice.',
            dependencies: [],
          },
        ],
      },
    );

    const tree = autopilotPlanTree('REQ-SEMANTIC', listPlanContracts({ controllerHome, repoId: 'repo-plan-context' }));
    expect(tree).toEqual([
      {
        planId: 'PLAN-SEMANTIC',
        parentPlanId: undefined,
        goal: 'Drive the independent implementation loop.',
        items: [
          {
            id: 'semantic-slice',
            objective: 'Implement the semantic Plan slice.',
            dependencies: [],
          },
        ],
        itemsTruncated: false,
      },
    ]);
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
});
