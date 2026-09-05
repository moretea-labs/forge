import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { calculateMetrics } from './metrics.ts';
import { CANDIDATE_INTERNAL_DIAGNOSTIC_AUTHORITY } from './protocol.ts';
import { REPORT_SCHEMA, type EvaluationReport, type EvaluationScenario, type EvaluationTrace } from './types.ts';

function percent(value: number | null): string {
  return value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function diagnose(trace: EvaluationTrace, report: Pick<EvaluationReport, 'metrics'>): EvaluationReport['diagnosis'] {
  const diagnosis: EvaluationReport['diagnosis'] = [];
  const isolation = trace.validation.find((result) => result.kind === 'isolation' && result.status === 'failed');
  if (isolation) diagnosis.push({ category: 'isolation_failure', detail: isolation.summary });
  if (report.metrics.impactCoverage !== null && report.metrics.impactCoverage < 1) {
    diagnosis.push({ category: 'missed_context', detail: 'Not every affected domain had retrieved or inspected evidence in the trace.' });
  }
  for (const result of trace.validation.filter((entry) => entry.status === 'failed')) {
    if (result.kind === 'regression') diagnosis.push({ category: 'regression_reintroduced', detail: `${result.id}: ${result.summary}` });
    else if (result.kind === 'behavior' || result.kind === 'invariant') diagnosis.push({ category: 'implementation_error', detail: `${result.id}: ${result.summary}` });
    else if (result.kind !== 'isolation') diagnosis.push({ category: 'verification_failure', detail: `${result.id}: ${result.summary}` });
  }
  if (trace.commands.some((command) => command.kind === 'forge' && command.exitCode !== 0)) {
    diagnosis.push({ category: 'verification_failure', detail: 'Forge invocation did not complete successfully.' });
  }
  return diagnosis;
}

export function buildReport(scenario: EvaluationScenario, trace: EvaluationTrace): EvaluationReport {
  const metrics = calculateMetrics(scenario, trace);
  return {
    schemaVersion: REPORT_SCHEMA,
    authority: CANDIDATE_INTERNAL_DIAGNOSTIC_AUTHORITY,
    generatedAt: new Date().toISOString(),
    scenario: {
      id: scenario.id,
      title: scenario.title,
      userIntent: scenario.userIntent,
      groundTruth: scenario.groundTruth,
      provenance: scenario.provenance,
    },
    trace,
    metrics,
    diagnosis: diagnose(trace, { metrics }),
  };
}

export function renderMarkdownReport(report: EvaluationReport): string {
  const rows = report.trace.validation.map((result) => `| ${escapeCell(result.id)} | ${result.kind} | ${result.status} | ${escapeCell(result.summary)} |`);
  const diagnosis = report.diagnosis.length === 0
    ? '- No failure diagnosis was produced.'
    : report.diagnosis.map((entry) => `- **${entry.category}**: ${entry.detail}`).join('\n');
  return [
    `# Forge Evaluation: ${report.scenario.title}`,
    '',
    `- Scenario: \`${report.scenario.id}\``,
    `- Authority: \`${report.authority}\``,
    `- Result: **${report.trace.finalResult.status}**`,
    `- Snapshot: \`${report.trace.snapshot.commit}\``,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Task success rate | ${percent(report.metrics.taskSuccessRate)} |`,
    `| Impact coverage | ${percent(report.metrics.impactCoverage)} |`,
    `| Behavioral invariant success | ${percent(report.metrics.behavioralInvariantSuccess)} |`,
    `| Regression reintroduction rate | ${percent(report.metrics.regressionReintroductionRate)} |`,
    `| Change precision | ${percent(report.metrics.changePrecision)} |`,
    `| Execution latency | ${report.metrics.executionLatencyMs === null ? 'not measured' : `${report.metrics.executionLatencyMs} ms`} |`,
    `| Tool interaction count | ${report.metrics.toolInteractionCount} |`,
    '',
    '## Validation',
    '',
    '| Validator | Kind | Status | Detail |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Diagnosis',
    '',
    diagnosis,
    '',
    '## Trace Summary',
    '',
    `- Changed files: ${report.trace.changedFiles.length === 0 ? 'none' : report.trace.changedFiles.join(', ')}`,
    `- Commands recorded: ${report.trace.commands.length}`,
    `- Checks recorded: ${report.trace.checks.length}`,
    `- Sandbox retained: ${report.trace.sandbox.retained ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

export function writeReport(outputDirectory: string, report: EvaluationReport): void {
  const output = resolve(outputDirectory);
  if (existsSync(output)) throw new Error(`Evaluation output directory already exists: ${output}`);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(output, 'report.md'), renderMarkdownReport(report));
}
