import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSeed, SOURCE_PATH, P0_IDS, P1_IDS } from '../seed.mjs';
import { applyCommand, validateBoard, previewImport, validateUsageEvent, acceptableUsageResult } from '../core.mjs';
const source = await readFile(SOURCE_PATH, 'utf8');
const seed = () => createSeed(source);
const change = async (board, command, context) => (await applyCommand(board, command, context)).board;
const task = (board, id = 'QG-BOARD') => board.tasks.find((item) => item.id === id);
const code = (value) => (error) => error.code === value;
const TIMES = { before: '2030-01-01T00:00:00.000Z', changed: '2030-01-01T00:00:01.000Z', after: '2030-01-01T00:00:01.001Z' };
async function completedTask(board, id) {
  board = await change(board, { type: 'transition', id, status: 'readyforusage' });
  const registered = await applyCommand(board, { type: 'evidence', id, evidence: { type: 'test', result: 'passed', build: 'dependency-unit-build', summary: 'Synthetic dependency unit fixture only', reference: 'test:dependency-fixture' } });
  const events = new Map();
  const verdict = { decision: 'pass', rationale: 'Synthetic unit completion', build: 'dependency-unit-build', limitations: [], coverage: task(registered.board, id).acceptance.filter((item) => item.applicability !== 'not-applicable').map((item) => ({ acceptanceId: item.id, evidenceIds: [registered.result.evidenceId], usageEventIds: item.scenarioIds.map((scenarioId, index) => {
    const eventId = `dep-${item.id}-${index}`; events.set(eventId, { complete: true, source: 'userusage', build: 'dependency-unit-build', taskIds: [id], scenarioId, resultCode: 'success' }); return eventId;
  }) })) };
  return change(registered.board, { type: 'assess', id, verdict }, { resolveUsageEvent: async (eventId) => events.get(eventId) });
}
async function assessedFixture() {
  let board = await change(seed(), { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' });
  const result = await applyCommand(board, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'test', result: 'passed', build: 'unit-build', summary: 'Synthetic unit fixture, not production evidence', reference: 'test:fixture' } });
  board = result.board;
  const verdict = { decision: 'pass', rationale: 'Unit fixture only', build: 'unit-build', coverage: task(board).acceptance.map((item, index) => ({ acceptanceId: item.id, evidenceIds: [result.result.evidenceId], usageEventIds: [`unit-event-${index}`] })), limitations: [] };
  const context = { resolveUsageEvent: async (id) => ({ complete: true, build: 'unit-build', source: 'userusage', taskIds: ['QG-BOARD'], scenarioId: task(board).acceptance[Number(id.split('-').at(-1))].scenarioIds[0], resultCode: 'success' }) };
  return { board, verdict, context };
}
test('观察事件只作为明确场景证据，发起请求和任意错误不能冒充验证', () => {
  assert.equal(acceptableUsageResult({ scenarioId: 'diff-state-error-retry', actionId: 'diff.read', resultCode: 'READ_ERROR_OBSERVED', state: { phase: 'failed' } }), true);
  assert.equal(acceptableUsageResult({ scenarioId: 'diff-state-normal', actionId: 'diff.read', resultCode: 'READ_OBSERVED' }), true);
  assert.equal(acceptableUsageResult({ scenarioId: 'diff-state-normal', actionId: 'diff.read', resultCode: 'READ_ERROR_OBSERVED' }), false);
  assert.equal(acceptableUsageResult({ scenarioId: 'diff-state-error-retry', actionId: 'operation.delete', resultCode: 'READ_ERROR_OBSERVED' }), false);
  assert.equal(acceptableUsageResult({ scenarioId: 'diff-navigation', actionId: 'diff.file.next', resultCode: 'FILE_NAVIGATION_REQUESTED' }), false);
  assert.equal(acceptableUsageResult({ scenarioId: 'unknown', actionId: 'unknown', resultCode: 'ANY_ERROR_OBSERVED' }), false);
  assert.equal(acceptableUsageResult({ scenarioId: 'repository-switch', actionId: 'repository.select', resultCode: 'SELECTED', errorCode: 'UNEXPECTED_ERROR' }), false);
});

test('seed preserves exactly 100 original rows, stable tasks, required priorities and approved packs', () => {
  const board = seed(); validateBoard(board);
  assert.equal(board.baseline.rows.length, 100); assert.equal(board.tasks.length, 102);
  assert.equal(board.tasks.filter((item) => item.required).length, P0_IDS.length + P1_IDS.length + 2);
  for (const row of board.baseline.rows) assert.ok(source.includes(row.rawLine));
  assert.equal(task(board, 'QG-046').pack, 'W2'); assert.equal(task(board, 'QG-088').pack, 'W9');
  assert.equal(task(board, 'QG-005').sourceResult.existingEquivalent, true);
  assert.ok(board.tasks.every((item) => ['todo', 'ready', 'inprogress'].includes(item.status)));
  const narrow = task(board, 'QG-016').acceptance.find((item) => item.applicability === 'not-applicable'); assert.equal(narrow.checked, false); assert.match(narrow.reason, /非 done/);
});
test('only assess may mark done; status patch and required archival are rejected', async () => {
  const board = seed();
  await assert.rejects(change(board, { type: 'transition', id: 'QG-046', status: 'done' }), code('ASSESS_REQUIRED'));
  await assert.rejects(change(board, { type: 'update', id: 'QG-046', patch: { status: 'done' } }), code('UNKNOWN_FIELD'));
  await assert.rejects(change(board, { type: 'transition', id: 'QG-046', status: 'archived' }), code('REQUIRED_SCOPE'));
  await assert.rejects(change(board, { type: 'update', id: 'QG-046', patch: { required: false } }), code('REQUIRED_SCOPE'));
});
test('inprogress is not blocked by dependencies; readyforusage needs implemented dependencies', async () => {
  const board = await change(seed(), { type: 'transition', id: 'QG-046', status: 'inprogress' });
  await assert.rejects(change(board, { type: 'transition', id: 'QG-046', status: 'readyforusage' }), code('DEPENDENCIES_NOT_IMPLEMENTED'));
  const prepared = await change(board, { type: 'transition', id: 'QG-052', status: 'readyforusage' });
  assert.equal(task(await change(prepared, { type: 'transition', id: 'QG-046', status: 'readyforusage' }), 'QG-046').status, 'readyforusage');
});
test('pass requires readyforusage, registered test evidence and every criterion covered', async () => {
  const { board, verdict, context } = await assessedFixture();
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict: { ...verdict, coverage: [] } }, context), code('INCOMPLETE_COVERAGE'));
  const done = await change(board, { type: 'assess', id: 'QG-BOARD', verdict }, context);
  assert.equal(task(done).status, 'done'); assert.ok(task(done).acceptance.every((item) => item.checked));
  assert.equal(task(done).history.at(-1).actor, 'assistant-decision');
  await assert.rejects(change(done, { type: 'update', id: 'QG-BOARD', patch: { title: 'changed' } }), code('REOPEN_REQUIRED'));
  const reopened = await change(done, { type: 'transition', id: 'QG-BOARD', status: 'inprogress' });
  assert.equal(task(reopened).verdict, null); assert.ok(task(reopened).acceptance.every((item) => !item.checked)); assert.ok(task(reopened).history.some((item) => item.kind === 'assess'));
});
test('same-build, complete userusage and no failed evidence are mandatory', async () => {
  const { board, verdict, context } = await assessedFixture();
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, { resolveUsageEvent: async (id) => ({ ...(await context.resolveUsageEvent(id)), source: 'assistant' }) }), code('USER_USAGE_REQUIRED'));
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, { resolveUsageEvent: async (id) => ({ ...(await context.resolveUsageEvent(id)), complete: false }) }), code('INVALID_USAGE_EVIDENCE'));
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict: { ...verdict, build: 'other-build' } }, context), code('INVALID_EVIDENCE'));
  const failed = await change(board, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'test', result: 'failed', build: 'unit-build', summary: 'Failed synthetic fixture', reference: 'test:fixture-failed' } });
  await assert.rejects(change(failed, { type: 'assess', id: 'QG-BOARD', verdict }, context), code('FAILED_EVIDENCE'));
});
test('verified expected negative outcomes are assessable but unverified failures are not', async () => {
  const { board, verdict, context } = await assessedFixture();
  const negative = { resolveUsageEvent: async (id) => ({ ...(await context.resolveUsageEvent(id)), resultCode: 'CANCEL_STOP_VERIFIED', errorCode: 'USER_CANCELLED', state: { phase: 'cancelled' } }) };
  assert.equal(task(await change(board, { type: 'assess', id: 'QG-BOARD', verdict }, negative)).status, 'done');
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, { resolveUsageEvent: async (id) => ({ ...(await context.resolveUsageEvent(id)), resultCode: 'UNEXPECTED_FAILURE' }) }), code('FAILED_USAGE'));
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict: { ...verdict, coverage: verdict.coverage.map((item, index) => index ? { ...item, usageEventIds: [] } : item) } }, context), code('INCOMPLETE_COVERAGE'));
});
test('import preview is non-mutating and cannot inject status, evidence or audit', async () => {
  const board = seed(), copy = structuredClone(board); task(copy).title = 'Imported title';
  assert.equal(previewImport(board, JSON.stringify(copy)).valid, true); assert.notEqual(task(board).title, 'Imported title');
  assert.equal(task(await change(board, { type: 'import', content: copy })).title, 'Imported title');
  task(copy).status = 'readyforusage'; assert.equal(previewImport(board, copy).valid, false);
  task(copy).status = task(board).status; task(copy).history.push({ id: 'forged' }); assert.equal(previewImport(board, copy).valid, false);
});
test('reopening a dependency recursively invalidates only done descendants in one transaction', async () => {
  let board = seed();
  for (const [id, dependsOn] of [['QG-002', ['QG-BOARD']], ['QG-004', ['QG-002']], ['QG-008', []], ['QG-010', ['QG-BOARD']]]) board = await change(board, { type: 'update', id, patch: { dependsOn } });
  for (const id of ['QG-BOARD', 'QG-002', 'QG-004', 'QG-008']) board = await completedTask(board, id);
  board = await change(board, { type: 'transition', id: 'QG-010', status: 'inprogress' });
  const original = structuredClone(board), previousRevision = board.metadata.revision;
  const result = await applyCommand(board, { type: 'transition', id: 'QG-BOARD', status: 'inprogress' });
  assert.deepEqual(result.result.invalidatedTaskIds, ['QG-002', 'QG-004']); assert.deepEqual(board, original);
  for (const id of ['QG-002', 'QG-004']) {
    const invalidated = task(result.board, id);
    assert.equal(invalidated.status, 'readyforusage'); assert.equal(invalidated.verdict, null); assert.ok(invalidated.acceptance.every((item) => item.checked === false));
    assert.ok(invalidated.history.some((entry) => entry.kind === 'assess' && entry.decision === 'pass'));
    assert.equal(invalidated.history.at(-1).kind, 'invalidation'); assert.equal(invalidated.history.at(-1).revision, previousRevision + 1);
    assert.match(invalidated.history.at(-1).text, /QG-BOARD/);
    assert.deepEqual(invalidated.evidence, task(original, id).evidence);
  }
  assert.equal(task(result.board, 'QG-008').status, 'done'); assert.deepEqual(task(result.board, 'QG-010'), task(original, 'QG-010'));
  const oldVerdict = task(original, 'QG-004').verdict;
  await assert.rejects(change(result.board, { type: 'assess', id: 'QG-004', verdict: oldVerdict }), code('DEPENDENCIES_NOT_DONE'));
});
test('recursive invalidation traverses unfinished intermediate dependencies', async () => {
  let board = seed();
  for (const [id, dependsOn] of [['QG-002', ['QG-BOARD']], ['QG-004', ['QG-002']]]) board = await change(board, { type: 'update', id, patch: { dependsOn } });
  for (const id of ['QG-BOARD', 'QG-002', 'QG-004']) board = await completedTask(board, id);
  // Model a legacy stale board from before recursive invalidation existed.
  task(board, 'QG-002').status = 'readyforusage'; task(board, 'QG-002').verdict = null; task(board, 'QG-002').acceptance.forEach((item) => { item.checked = false; });
  validateBoard(board);
  const result = await applyCommand(board, { type: 'transition', id: 'QG-BOARD', status: 'ready' });
  assert.deepEqual(result.result.invalidatedTaskIds, ['QG-004']); assert.equal(task(result.board, 'QG-004').status, 'readyforusage');
});
test('same-ID text changes reset assessment and reject old evidence and non-later server receipt', async () => {
  const fixture = await assessedFixture();
  fixture.board.tasks.find((item) => item.id === 'QG-BOARD').evidence[0].at = TIMES.before;
  const acceptance = structuredClone(task(fixture.board).acceptance); acceptance[0].text += ' Revised requirement'; acceptance.forEach((item) => { item.checked = true; });
  let board = await change(fixture.board, { type: 'update', id: 'QG-BOARD', patch: { acceptance } }, { now: TIMES.changed });
  assert.equal(task(board).status, 'ready'); assert.equal(task(board).verdict, null); assert.ok(task(board).acceptance.every((item) => item.checked === false));
  const boundary = task(board).history.at(-1); assert.equal(boundary.kind, 'acceptancechanged'); assert.equal(boundary.at, TIMES.changed);
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict: fixture.verdict }, fixture.context), code('NOT_READY_FOR_USAGE'));
  board = await change(board, { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' }, { now: TIMES.changed });
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict: fixture.verdict }, fixture.context), code('STALE_EVIDENCE'));
  const registered = await applyCommand(board, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'test', result: 'passed', build: 'unit-build', summary: 'Rerun after revised acceptance; unit fixture only', reference: 'test:revised-fixture' } }, { now: TIMES.changed });
  board = registered.board;
  const verdict = { ...fixture.verdict, coverage: fixture.verdict.coverage.map((item) => ({ ...item, evidenceIds: [registered.result.evidenceId] })) };
  for (const receivedAt of [undefined, 'not-a-time', TIMES.before, TIMES.changed]) {
    const context = { resolveUsageEvent: async (id) => ({ ...(await fixture.context.resolveUsageEvent(id)), timestamp: TIMES.after, ...(receivedAt === undefined ? {} : { receivedAt }) }) };
    await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, context), code('STALE_USAGE_EVIDENCE'));
  }
  const context = { resolveUsageEvent: async (id) => ({ ...(await fixture.context.resolveUsageEvent(id)), timestamp: TIMES.before, receivedAt: TIMES.after }) };
  assert.equal(task(await change(board, { type: 'assess', id: 'QG-BOARD', verdict }, context)).status, 'done');
});
test('latest acceptance change wins; scenario changes reset inprogress without schema migration', async () => {
  let board = await change(seed(), { type: 'transition', id: 'QG-BOARD', status: 'inprogress' });
  let acceptance = structuredClone(task(board).acceptance); acceptance[0].scenarioIds.push('extra-wide-case');
  board = await change(board, { type: 'update', id: 'QG-BOARD', patch: { acceptance } }, { now: TIMES.changed });
  assert.equal(task(board).status, 'inprogress'); assert.equal(task(board).history.at(-1).kind, 'acceptancechanged'); assert.equal(board.metadata.schemaVersion, 1);
  acceptance = structuredClone(task(board).acceptance); acceptance[0].text += ' Further revision';
  board = await change(board, { type: 'update', id: 'QG-BOARD', patch: { acceptance } }, { now: TIMES.after });
  assert.equal(task(board).history.filter((entry) => entry.kind === 'acceptancechanged').length, 2);
  const registered = await applyCommand(board, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'test', result: 'passed', build: 'unit-build', summary: 'Between-revisions fixture', reference: 'test:between-revisions' } }, { now: TIMES.changed });
  board = await change(registered.board, { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' });
  const verdict = { decision: 'pass', rationale: 'Synthetic stale coverage', build: 'unit-build', limitations: [], coverage: task(board).acceptance.map((item) => ({ acceptanceId: item.id, evidenceIds: [registered.result.evidenceId], usageEventIds: ['fixture-event'] })) };
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }), code('STALE_EVIDENCE'));
});
test('equivalent criterion ordering/checkmark patches do not reset readyforusage or create false freshness barriers', async () => {
  let board = await change(seed(), { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' });
  const acceptance = structuredClone(task(board).acceptance).reverse(); acceptance.forEach((item) => { item.checked = true; });
  board = await change(board, { type: 'update', id: 'QG-BOARD', patch: { acceptance, owner: 'assistant' } });
  assert.equal(task(board).status, 'readyforusage'); assert.equal(task(board).history.filter((entry) => entry.kind === 'acceptancechanged').length, 0);
  assert.ok(task(board).acceptance.every((item) => item.checked === false));
});
test('imported acceptance edits receive the same reset and freshness barrier as update', async () => {
  const fixture = await assessedFixture(), copy = structuredClone(fixture.board); task(copy).acceptance[0].text += ' Imported revision';
  const board = await change(fixture.board, { type: 'import', content: copy }, { now: TIMES.changed });
  assert.equal(task(board).status, 'ready'); assert.equal(task(board).history.at(-1).kind, 'acceptancechanged'); assert.equal(task(board).history.at(-1).at, TIMES.changed);
  assert.deepEqual(task(board).evidence, task(fixture.board).evidence);
  const ready = await change(board, { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' });
  await assert.rejects(change(ready, { type: 'assess', id: 'QG-BOARD', verdict: fixture.verdict }, fixture.context), code('STALE_EVIDENCE'));
});
test('every scenarioId is mandatory, with explicit missing-scenario details for the UI', async () => {
  const fixture = await assessedFixture(), acceptance = structuredClone(task(fixture.board).acceptance); acceptance[0].scenarioIds.push('QG-BOARD-LIGHT');
  let board = await change(fixture.board, { type: 'update', id: 'QG-BOARD', patch: { acceptance } }, { now: TIMES.changed });
  const registered = await applyCommand(board, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'browser', result: 'passed', build: 'unit-build', summary: 'Wide theme unit fixture only', reference: 'test:wide-theme-fixture' } }, { now: TIMES.after });
  board = await change(registered.board, { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' });
  const verdict = { ...fixture.verdict, coverage: fixture.verdict.coverage.map((item) => ({ ...item, evidenceIds: [registered.result.evidenceId] })) };
  const context = { resolveUsageEvent: async (id) => ({ ...(id === 'light-event' ? { complete: true, build: 'unit-build', source: 'assistant', taskIds: ['QG-BOARD'], scenarioId: 'QG-BOARD-LIGHT', resultCode: 'success' } : await fixture.context.resolveUsageEvent(id)), receivedAt: TIMES.after }) };
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, context), (error) => error.code === 'INCOMPLETE_SCENARIO_COVERAGE' && /All scenarioIds/.test(error.message) && JSON.stringify(error.details.missingScenarioIds) === '["QG-BOARD-LIGHT"]');
  verdict.coverage[0].usageEventIds.push('light-event');
  assert.equal(task(await change(board, { type: 'assess', id: 'QG-BOARD', verdict }, context)).status, 'done');
});
test('dependency invalidation handles diamonds once and preserves N/A checkmarks as false', async () => {
  let board = seed();
  const graph = [['QG-002', ['QG-BOARD']], ['QG-004', ['QG-BOARD']], ['QG-008', ['QG-002', 'QG-004']]];
  for (const [id, dependsOn] of graph) board = await change(board, { type: 'update', id, patch: { dependsOn } });
  for (const id of ['QG-BOARD', 'QG-002', 'QG-004', 'QG-008', 'QG-016']) board = await completedTask(board, id);
  const result = await applyCommand(board, { type: 'transition', id: 'QG-BOARD', status: 'ready' });
  assert.equal(new Set(result.result.invalidatedTaskIds).size, result.result.invalidatedTaskIds.length);
  assert.equal(task(result.board, 'QG-008').history.filter((item) => item.kind === 'invalidation').length, 1);
  assert.equal(task(result.board, 'QG-016').status, 'readyforusage');
  assert.ok(task(result.board, 'QG-016').acceptance.every((item) => item.checked === false));
});
test('assessing requires original scenario IDs even after wrong-scenario coverage is supplied', async () => {
  const fixture = await assessedFixture();
  await assert.rejects(change(fixture.board, { type: 'assess', id: 'QG-BOARD', verdict: fixture.verdict }, { resolveUsageEvent: async (id) => ({ ...(await fixture.context.resolveUsageEvent(id)), scenarioId: 'unrelated' }) }), code('INVALID_USAGE_EVIDENCE'));
});
test('native imports cannot refresh original occurrence/collection with receivedAt or importedAt', async () => {
  const fixture = await assessedFixture(), acceptance = structuredClone(task(fixture.board).acceptance); acceptance[0].text += ' Native freshness revision';
  let board = await change(fixture.board, { type: 'update', id: 'QG-BOARD', patch: { acceptance } }, { now: TIMES.changed });
  const registered = await applyCommand(board, { type: 'evidence', id: 'QG-BOARD', evidence: { type: 'test', result: 'passed', build: 'unit-build', summary: 'Synthetic native freshness fixture only', reference: 'test:native-freshness' } }, { now: TIMES.after });
  board = await change(registered.board, { type: 'transition', id: 'QG-BOARD', status: 'readyforusage' }, { now: TIMES.after });
  const verdict = { ...fixture.verdict, coverage: fixture.verdict.coverage.map((item) => ({ ...item, evidenceIds: [registered.result.evidenceId] })) };
  const importedAt = '2030-01-01T00:10:00.000Z';
  for (const patch of [
    { occurredAt: TIMES.before, collectedAt: TIMES.after, receivedAt: TIMES.after },
    { occurredAt: TIMES.changed, collectedAt: TIMES.after, receivedAt: TIMES.after },
    { occurredAt: TIMES.after, collectedAt: TIMES.before, receivedAt: importedAt },
    { occurredAt: TIMES.after, collectedAt: TIMES.changed, receivedAt: importedAt },
    { occurredAt: TIMES.after, collectedAt: TIMES.after, receivedAt: importedAt },
    { occurredAt: TIMES.after, collectedAt: undefined, receivedAt: importedAt },
    { occurredAt: undefined, collectedAt: TIMES.after, receivedAt: importedAt },
    { occurredAt: '2031-01-01T00:00:00.000Z', collectedAt: '2031-01-01T00:00:00.000Z', receivedAt: '2031-01-01T00:00:00.000Z' },
  ]) await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, { now: importedAt, resolveUsageEvent: async (id) => ({ ...(await fixture.context.resolveUsageEvent(id)), origin: 'native', importedAt, ...patch }) }), code('STALE_USAGE_EVIDENCE'));
  const context = { now: importedAt, resolveUsageEvent: async (id) => ({ ...(await fixture.context.resolveUsageEvent(id)), origin: 'native', occurredAt: TIMES.after, collectedAt: TIMES.after, receivedAt: TIMES.after, importedAt }) };
  assert.equal(task(await change(board, { type: 'assess', id: 'QG-BOARD', verdict }, context)).status, 'done');
  await assert.rejects(change(board, { type: 'assess', id: 'QG-BOARD', verdict }, { ...context, resolveUsageEvent: async (id) => ({ ...(await context.resolveUsageEvent(id)), source: 'automated-test' }) }), code('USER_USAGE_REQUIRED'));
});
test('native usage must postdate task creation even when no criterion-change audit exists', async () => {
  const fixture = await assessedFixture();
  task(fixture.board).history.push({ id: 'native-task-created', kind: 'create', text: 'Synthetic task creation boundary', at: TIMES.changed, actor: 'assistant-decision', revision: 0 });
  const context = { now: TIMES.after, resolveUsageEvent: async (id) => ({ ...(await fixture.context.resolveUsageEvent(id)), origin: 'native', occurredAt: TIMES.before, collectedAt: TIMES.before, receivedAt: TIMES.before, importedAt: TIMES.after }) };
  await assert.rejects(change(fixture.board, { type: 'assess', id: 'QG-BOARD', verdict: fixture.verdict }, context), code('STALE_USAGE_EVIDENCE'));
});
test('usage accepts only precise privacy fields and bounded scalar counts/state', () => {
  const event = { eventId: 'unit-event', sequence: 1, timestamp: new Date().toISOString(), taskIds: ['QG-BOARD'], scenarioId: 'QG-BOARD-A1', actionId: 'task.open', resultCode: 'success', counts: { files: 3 }, state: { theme: 'dark', viewport: 'wide', phase: 'success', trusted: false } }, ids = new Set(['QG-BOARD']);
  validateUsageEvent(event, ids);
  for (const patch of [{ message: 'private text' }, { source: 'userusage' }, { repoId: 'C:/private' }, { counts: { path: 'private' } }, { state: { title: 'free text' } }, { sequence: 0 }]) assert.throws(() => validateUsageEvent({ ...event, ...patch }, ids));
});
