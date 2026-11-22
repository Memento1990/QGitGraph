export function percentile(values, probability) {
  if (!values.length) return null;
  if (probability < 0 || probability > 1) throw new Error('Percentile probability must be in [0,1].');
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index); const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
export function sizeComparison({ executableBytes, installerBytes, referenceExecutableBytes, referenceInstallerBytes }) {
  const compare = (actual, reference) => Number.isFinite(reference) && reference > 0 ? { actualBytes: actual, referenceBytes: reference, ratio: actual / reference, differenceBytes: actual - reference } : null;
  return {
    executableBytes, installerBytes: installerBytes ?? null,
    installerNineMiB: installerBytes === undefined ? { status: 'blocked', reason: 'No installer supplied.' } : { status: installerBytes <= 9 * 1024 * 1024 ? 'within-comparison-budget' : 'above-comparison-budget', comparisonBudgetBytes: 9 * 1024 * 1024 },
    executableComparison: compare(executableBytes, referenceExecutableBytes), installerComparison: compare(installerBytes, referenceInstallerBytes),
    interpretation: 'Byte sizes and an explicit 9 MiB comparison budget, not a performance claim or an imported upstream executable.',
  };
}
