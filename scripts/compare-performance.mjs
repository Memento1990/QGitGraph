#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'artifacts/performance-0.2.1');
const beforeBytes = await readFile(join(directory, 'native-baseline-02/performance-report.json'));
const optimizedRun = process.argv[3] ?? 'optimized-final-02';
assert(/^[a-z0-9-]+$/.test(optimizedRun), 'Select a single local performance run directory.');
const afterBytes = await readFile(join(directory, `${optimizedRun}/performance-report.json`));
const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes);
for (const report of [before, after]) {
  assert.equal(report.measurementStatus, 'completed', 'Incomplete measurements cannot be compared.');
  assert.equal(report.repositoryIntegrity.status, 'unchanged-within-stated-coverage', 'Repository/config changes invalidate the comparison.');
  assert.equal(report.performanceKind, 'native');
  assert.equal(report.requestedSamples, 20);
  assert.equal(report.cleanup.remaining.length, 0);
  assert.equal(report.cleanup.errors.length, 0);
}
assert.equal(before.samplePlan.sha256, after.samplePlan.sha256, 'Different private immutable sample plans cannot be compared.');
assert.equal(before.repository.effectiveConfigSha256, after.repository.effectiveConfigSha256, 'Git configuration differs.');
assert.equal(before.environmentPolicy.homeIdentitySha256, after.environmentPolicy.homeIdentitySha256, 'User Git environment differs.');
const pairs = [
  ['usable-history', 'repository-open-warm.injectedObservation.firstHistory.paintOpportunityMs'],
  ['full-open', 'repository-open-warm.native.paint-opportunity.fromOperationStartMs'],
  ['cold-file-list', 'commit-first-selection.native.file-list-paint-opportunity.fromOperationStartMs'],
  ['cold-commit-diff', 'commit-first-selection.native.paint-opportunity.fromOperationStartMs'],
  ['file-change', 'file-change.native.paint-opportunity.fromOperationStartMs'],
  ['warm-commit-revisit', 'commit-revisit.native.paint-opportunity.fromOperationStartMs'],
  ['warm-file-revisit', 'file-revisit.native.paint-opportunity.fromOperationStartMs'],
  ['refresh', 'repository-refresh.native.paint-opportunity.fromOperationStartMs'],
  ['history-search', 'search-history.native.paint-opportunity.fromOperationStartMs'],
];
const comparisons = pairs.map(([scenario, metric]) => {
  const a = before.metrics[metric], b = after.metrics[metric];
  assert(a && b && a.count === b.count && a.count > 0, `Matching actual samples required: ${scenario}`);
  return { scenario, metric, sampleCount: a.count, baseline: a, optimized: b,
    p50ReductionPercent: (1 - b.medianMs / a.medianMs) * 100,
    p95ReductionPercent: (1 - b.p95Ms / a.p95Ms) * 100 };
});
const standalone = Object.fromEntries(Object.entries(after.metrics).filter(([metric]) => /selection-feedback|history-paint-opportunity|file-content-|diff-scroll|repository-menu|window-resize/.test(metric)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { schemaVersion: 1, kind: 'performance-comparison', status: 'valid-core-comparison-with-explicit-coverage-blocks',
  nativeBaselineVersion: '0.2.0-instrumented-only', optimizedVersion: '0.2.1',
  baselineReportSha256: hash(beforeBytes), optimizedReportSha256: hash(afterBytes),
  baselineBinarySha256: before.binary.sha256, optimizedBinarySha256: after.binary.sha256,
  samplePlan: after.samplePlan, comparisons, optimizedOnly: standalone,
  baselineCoverageBlockers: before.coverageBlockers, optimizedCoverageBlockers: after.coverageBlockers,
  limitations: [
    'Observed on one Windows/WSL UNC machine. OS filesystem/cache/load cannot be held constant and are not claimed cold or randomized.',
    'Baseline/optimized use the exact same validated immutable commit/parent/file sample plan, user Git configuration, native clocks and readiness semantics.',
    'First-history observation is trusted input to actual rows plus double-rAF opportunity; full-open is native handler to all metadata/history completion plus opportunity. Neither is physical GPU presentation.',
    'Only major scenarios have 20 samples; refresh/search and supplemental UI checks have 3, not a statistically stable tail latency benchmark.',
    'Warm cache was already responsive; negative percentages are honestly retained as relative regressions at very small absolute durations.',
    'Overall suites may be blocked by optional native cancellation acknowledgement. This report does not relabel those suites passed.',
    'No repository restoration, trust grant, index/ref/config mutation, fetch/pull or production credential use occurred. Integrity covers the explicitly sampled paths, not all unsampled concurrency.',
  ] };
await writeFile(join(directory, `performance-comparison-${optimizedRun}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, comparisons: comparisons.map(({ scenario, sampleCount, baseline, optimized, p50ReductionPercent }) => ({ scenario, sampleCount, baselineP50: baseline.medianMs, optimizedP50: optimized.medianMs, optimizedP95: optimized.p95Ms, p50ReductionPercent })) }, null, 2));
