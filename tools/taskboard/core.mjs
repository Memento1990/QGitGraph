import { randomUUID } from 'node:crypto';
import { BUILD, SCHEMA_VERSION } from './seed.mjs';

export const VERSION = BUILD;
export const STATUSES = ['todo', 'ready', 'inprogress', 'readyforusage', 'done', 'blocked', 'archived'];
export const SOURCES = ['userusage', 'assistant', 'automated-test'];
export const SUCCESS_USAGE_RESULTS = ['success', 'passed', 'verified', 'SUCCESS', 'PASSED', 'VERIFIED', 'EXPECTED_FAILURE_OBSERVED', 'EXPECTED_FAILURE_VERIFIED', 'EXPECTED_ERROR_VERIFIED', 'EXPECTED_CANCEL_VERIFIED', 'EXPECTED_BLOCK_VERIFIED', 'EXPECTED_REJECTION_VERIFIED', 'CONFLICT_STOP_VERIFIED', 'CANCEL_STOP_VERIFIED', 'TRUST_REVOKE_STOP_VERIFIED', 'STALE_TARGET_REJECTED_VERIFIED'];
const EXPECTED_NEGATIVE_RESULTS = new Set(SUCCESS_USAGE_RESULTS.filter((value) => value.startsWith('EXPECTED_') || value.endsWith('_VERIFIED') && value !== 'VERIFIED'));
export const OBSERVED_USAGE_RESULTS = ['OBSERVED', 'READ_OBSERVED', 'STATE_OBSERVED', 'SELECTED', 'COMPARED', 'FILTER_RESULT_OBSERVED', 'SEARCH_RESULT_OBSERVED', 'SCOPE_RESULT_OBSERVED', 'QUERY_RESULTS', 'QUERY_EMPTY', 'OPENED', 'BASE_SELECTED'];
const DIFF_OBSERVATIONS = {
  'diff-state-normal': ['READ_OBSERVED', 'NORMAL_OBSERVED'],
  'diff-state-loading': ['LOADING_OBSERVED'],
  'diff-state-error-retry': ['READ_ERROR_OBSERVED', 'RETRY_LOADING_OBSERVED', 'RETRY_READ_OBSERVED'],
  'diff-state-cancel': ['CANCELLED_OBSERVED'],
  'diff-state-binary': ['BINARY_OBSERVED'],
  'diff-state-truncated': ['TRUNCATED_OBSERVED'],
  'diff-state-empty': ['EMPTY_OBSERVED'],
  'diff-navigation': ['FILE_BOUNDARY_OBSERVED', 'CHANGE_UNAVAILABLE_OBSERVED', 'CHANGE_SELECTION_OBSERVED', 'SHORTCUT_BOUNDARY_OBSERVED', 'WORKING_SHORTCUT_IGNORED'],
  'diff-context': ['FULL_CONTEXT_OBSERVED', 'COLLAPSED_CONTEXT_OBSERVED', 'CONTEXT_EXPANSION_OBSERVED'],
  'diff-layout': ['SPLIT_OBSERVED', 'UNIFIED_OBSERVED'],
};
export function acceptableUsageResult(event) {
  // 观察可供助手逐项核对，不代表后端已证明交互正确；REQUESTED 类事件不能完成验收。
  if (event.resultCode === 'REFRESH_FAILED' && event.scenarioId === 'refresh-failure' && event.actionId === 'repository.refresh') return true;
  if (['QUERY_INVALID'].includes(event.resultCode) && ['history-query', 'history-scope'].includes(event.scenarioId) && event.actionId?.startsWith('history.')) return !event.errorCode;
  if (event.actionId?.startsWith('repository.open.') && ['open-repository-failure', 'open-directory-failure', 'open-repository-denied', 'open-directory-denied'].includes(event.scenarioId) && ['DISCOVERY_FAILED', 'ACCESS_DENIED', 'OPENED'].includes(event.resultCode)) return true;
  if (DIFF_OBSERVATIONS[event.scenarioId]?.includes(event.resultCode) && event.actionId?.startsWith('diff.')) return !event.errorCode;
  if (OBSERVED_USAGE_RESULTS.includes(event.resultCode)) return !event.errorCode && !['failed', 'cancelled', 'blocked'].includes(event.state?.phase);
  if (!SUCCESS_USAGE_RESULTS.includes(event.resultCode)) return false;
  // These codes assert that the negative outcome itself was verified; rationale/coverage remains a recorded decision, not identity proof.
  if (EXPECTED_NEGATIVE_RESULTS.has(event.resultCode)) return true;
  return !event.errorCode && !['failed', 'cancelled', 'blocked'].includes(event.state?.phase);
}
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_ID = /^QG-(?:\d{3}|[A-Z][A-Z0-9-]{0,63})$/;
const EVIDENCE_TYPES = ['test', 'browser', 'usage', 'observation'];
const MUTABLE = ['title', 'description', 'priority', 'area', 'pack', 'required', 'acceptance', 'dependsOn', 'owner'];
const TASK_KEYS = ['id', ...MUTABLE, 'status', 'baselineIds', 'evidence', 'history', 'retrospectives', 'verdict', 'sourceResult'];
export class BoardError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = 'BoardError'; this.code = code; this.status = status; if (details !== undefined) this.details = details; }
}
export function assert(condition, code, message, status = 400, details) { if (!condition) throw new BoardError(code, message, status, details); }
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function exactKeys(value, allowed, label) {
  assert(isObject(value), 'INVALID_INPUT', `${label} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), 'UNKNOWN_FIELD', `${label}.${key} is not allowed`);
}
export function text(value, label, max = 20000, allowEmpty = false) {
  assert(typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !value.includes('\0'), 'INVALID_INPUT', `${label} must be ${allowEmpty ? '' : 'nonempty '}text (max ${max})`);
  return value;
}
export function identifier(value, label) { assert(typeof value === 'string' && IDENTIFIER.test(value), 'INVALID_INPUT', `${label} must be an identifier, not a path or free text`); return value; }
function array(value, label, max = 1000) { assert(Array.isArray(value) && value.length <= max, 'INVALID_INPUT', `${label} must be an array (max ${max})`); return value; }
function unique(values, label) { assert(new Set(values).size === values.length, 'INVALID_INPUT', `${label} must not contain duplicates`); }
function taskId(id) { assert(typeof id === 'string' && TASK_ID.test(id), 'INVALID_INPUT', 'Invalid stable task ID'); }
function iso(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19), 'INVALID_INPUT', `${label} must be an ISO UTC timestamp`);
}
export function applicable(acceptance) { return acceptance.applicability !== 'not-applicable'; }
function validateAcceptance(items) {
  array(items, 'acceptance', 100);
  assert(items.some(applicable), 'INVALID_INPUT', 'At least one applicable acceptance criterion is required');
  unique(items.map((item) => item.id), 'acceptance IDs');
  for (const item of items) {
    exactKeys(item, ['id', 'text', 'checked', 'scenarioIds', 'applicability', 'reason'], 'acceptance');
    identifier(item.id, 'acceptance.id'); text(item.text, 'acceptance.text');
    if (item.checked !== undefined) assert(typeof item.checked === 'boolean', 'INVALID_INPUT', 'checked must be boolean');
    array(item.scenarioIds, 'scenarioIds', 50).forEach((id) => identifier(id, 'scenarioId')); unique(item.scenarioIds, 'scenarioIds');
    assert(item.scenarioIds.length > 0, 'INVALID_INPUT', 'Each criterion needs scenario IDs');
    if (item.applicability !== undefined) assert(['applicable', 'not-applicable'].includes(item.applicability), 'INVALID_INPUT', 'Invalid applicability');
    if (!applicable(item)) {
      assert(item.id.endsWith('-NARROW') && item.checked !== true, 'INVALID_INPUT', 'Only explicit narrow-only criteria may be N/A; N/A is not done');
      text(item.reason, 'N/A reason');
    }
  }
}
function validateEvidence(evidence) {
  exactKeys(evidence, ['id', 'type', 'result', 'build', 'summary', 'reference', 'eventIds', 'at'], 'evidence');
  identifier(evidence.id, 'evidence.id');
  assert(EVIDENCE_TYPES.includes(evidence.type), 'INVALID_INPUT', 'Invalid evidence type');
  assert(['passed', 'failed'].includes(evidence.result), 'INVALID_INPUT', 'Invalid evidence result');
  text(evidence.build, 'evidence.build', 200); text(evidence.summary, 'evidence.summary'); text(evidence.reference, 'evidence.reference', 4000); iso(evidence.at, 'evidence.at');
  if (evidence.eventIds !== undefined) array(evidence.eventIds, 'eventIds', 1000).forEach((id) => identifier(id, 'eventId'));
}
function validateVerdict(verdict, task) {
  exactKeys(verdict, ['decision', 'rationale', 'build', 'coverage', 'limitations'], 'verdict');
  assert(['pass', 'fail', 'insufficient'].includes(verdict.decision), 'INVALID_INPUT', 'Invalid verdict decision');
  text(verdict.rationale, 'verdict.rationale'); text(verdict.build, 'verdict.build', 200);
  array(verdict.limitations, 'limitations', 100).forEach((value) => text(value, 'limitation', 4000));
  array(verdict.coverage, 'coverage', 100);
  unique(verdict.coverage.map((item) => item.acceptanceId), 'coverage acceptance IDs');
  for (const item of verdict.coverage) {
    exactKeys(item, ['acceptanceId', 'evidenceIds', 'usageEventIds'], 'coverage');
    assert(task.acceptance.some((criterion) => criterion.id === item.acceptanceId), 'INVALID_INPUT', 'Unknown acceptanceId');
    for (const field of ['evidenceIds', 'usageEventIds']) { array(item[field], field, 1000).forEach((id) => identifier(id, field)); unique(item[field], field); }
  }
}
export function validateBoard(board) {
  exactKeys(board, ['metadata', 'baseline', 'packs', 'tasks'], 'board');
  exactKeys(board.metadata, ['revision', 'schemaVersion', 'build', 'sourceHash', 'createdAt', 'updatedAt'], 'metadata');
  assert(board.metadata.schemaVersion === SCHEMA_VERSION, 'INVALID_SCHEMA', 'Unsupported schemaVersion');
  assert(Number.isSafeInteger(board.metadata.revision) && board.metadata.revision >= 0, 'INVALID_SCHEMA', 'Invalid revision');
  text(board.metadata.build, 'metadata.build', 200);
  assert(typeof board.metadata.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(board.metadata.sourceHash), 'INVALID_SCHEMA', 'Invalid sourceHash');
  iso(board.metadata.createdAt, 'createdAt'); iso(board.metadata.updatedAt, 'updatedAt');
  exactKeys(board.baseline, ['sourcePath', 'rows'], 'baseline');
  assert(board.baseline.sourcePath === 'designs/repository-interactions-vue/FEATURE-COMPARISON.md', 'INVALID_SCHEMA', 'Baseline source path is fixed');
  assert(Array.isArray(board.baseline.rows) && board.baseline.rows.length === 100, 'INVALID_SCHEMA', '100 baseline rows are required');
  board.baseline.rows.forEach((row, index) => {
    exactKeys(row, ['id', 'title', 'area', 'sourceLine', 'rawLine', 'old', 'application', 'sourceStatus', 'gap', 'sourcePriority', 'sourceEvidence'], 'baseline row');
    assert(row.id === index + 1 && Number.isSafeInteger(row.sourceLine) && row.sourceLine > 0, 'INVALID_SCHEMA', 'Invalid baseline row');
    for (const key of ['title', 'area', 'rawLine', 'old', 'application', 'sourceStatus', 'gap', 'sourcePriority', 'sourceEvidence']) text(row[key], `baseline.${key}`);
  });
  array(board.packs, 'packs', 10); unique(board.packs.map((pack) => pack.id), 'pack IDs');
  assert(board.packs.length === 10, 'INVALID_SCHEMA', 'W0..W9 packs are required');
  board.packs.forEach((pack, index) => { exactKeys(pack, ['id', 'title', 'order'], 'pack'); assert(pack.id === `W${index}` && pack.order === index, 'INVALID_SCHEMA', 'Invalid work pack'); text(pack.title, 'pack.title', 200); });
  array(board.tasks, 'tasks', 1000); unique(board.tasks.map((task) => task.id), 'task IDs');
  const ids = new Set(board.tasks.map((task) => task.id));
  for (const id of ['QG-BOARD', 'QG-USAGE', ...Array.from({ length: 100 }, (_, index) => `QG-${String(index + 1).padStart(3, '0')}`)]) assert(ids.has(id), 'INVALID_SCHEMA', `Missing stable task ${id}`);
  for (const task of board.tasks) {
    exactKeys(task, TASK_KEYS, 'task'); taskId(task.id);
    text(task.title, 'title', 1000); text(task.description, 'description', 20000, true); text(task.area, 'area', 1000); text(task.owner, 'owner', 200, true);
    assert(['P0', 'P1', 'P2'].includes(task.priority), 'INVALID_INPUT', 'Invalid priority');
    assert(board.packs.some((pack) => pack.id === task.pack), 'INVALID_INPUT', 'Unknown pack');
    assert(typeof task.required === 'boolean' && STATUSES.includes(task.status), 'INVALID_INPUT', 'Invalid required/status');
    array(task.baselineIds, 'baselineIds', 100).forEach((id) => assert(Number.isSafeInteger(id) && id >= 1 && id <= 100, 'INVALID_SCHEMA', 'Invalid baselineId')); unique(task.baselineIds, 'baselineIds');
    if (/^QG-\d{3}$/.test(task.id) && Number(task.id.slice(3)) <= 100) assert(JSON.stringify(task.baselineIds) === JSON.stringify([Number(task.id.slice(3))]), 'INVALID_SCHEMA', 'Baseline mappings must remain stable');
    validateAcceptance(task.acceptance);
    array(task.dependsOn, 'dependsOn', 1000).forEach((id) => assert(ids.has(id) && id !== task.id, 'INVALID_INPUT', `Invalid dependency ${id}`)); unique(task.dependsOn, 'dependsOn');
    array(task.evidence, 'evidence', 1000).forEach(validateEvidence); unique(task.evidence.map((item) => item.id), 'evidence IDs');
    for (const field of ['history', 'retrospectives']) {
      array(task[field], field, 10000).forEach((entry) => {
        exactKeys(entry, ['id', 'kind', 'text', 'at', 'actor', 'revision', 'from', 'to', 'evidenceId', 'decision'], field);
        identifier(entry.id, `${field}.id`); text(entry.kind, `${field}.kind`, 100); text(entry.text, `${field}.text`, 20000, true); iso(entry.at, `${field}.at`);
        assert(entry.actor === 'assistant-decision' && Number.isSafeInteger(entry.revision) && entry.revision >= 0, 'INVALID_SCHEMA', 'Audit records are decision declarations, not identity authentication');
      });
    }
    if (task.verdict !== null) validateVerdict(task.verdict, task);
    if (task.status === 'done') {
      assert(task.verdict?.decision === 'pass' && task.history.some((entry) => entry.kind === 'assess' && entry.decision === 'pass'), 'INVALID_SCHEMA', 'Done requires a recorded pass assessment');
      assert(task.acceptance.filter(applicable).every((item) => item.checked === true), 'INVALID_SCHEMA', 'Done requires applicable criteria checked by assess');
    }
    if (task.sourceResult !== undefined) {
      exactKeys(task.sourceResult, ['status', 'gap', 'priority', 'existingEquivalent', 'assessment'], 'sourceResult');
      for (const key of ['status', 'gap', 'priority', 'assessment']) text(task.sourceResult[key], `sourceResult.${key}`);
      assert(typeof task.sourceResult.existingEquivalent === 'boolean', 'INVALID_SCHEMA', 'Invalid source result');
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) { if (visited.has(id)) return; assert(!visiting.has(id), 'INVALID_INPUT', 'Dependency cycle'); visiting.add(id); for (const dep of board.tasks.find((task) => task.id === id).dependsOn) visit(dep); visiting.delete(id); visited.add(id); }
  board.tasks.forEach((task) => visit(task.id));
  return board;
}
function getTask(board, id) { taskId(id); const task = board.tasks.find((item) => item.id === id); assert(task, 'NOT_FOUND', `Unknown task ${id}`, 404); return task; }
function history(task, kind, message, now, revision, extra = {}) {
  const entry = { id: `h-${randomUUID()}`, kind, text: message, at: now, actor: 'assistant-decision', revision, ...extra };
  task.history.push(entry); return entry;
}
function acceptanceSignature(items) {
  return JSON.stringify(items.map((item) => ({ id: item.id, text: item.text, scenarioIds: [...item.scenarioIds].sort(), applicability: item.applicability ?? 'applicable', reason: item.reason ?? '' })).sort((a, b) => a.id.localeCompare(b.id)));
}
function clearAssessment(task) {
  task.verdict = null;
  task.acceptance.forEach((item) => { item.checked = false; });
}
function recordAcceptanceChange(task, now, revision) {
  const from = task.status;
  task.status = from === 'inprogress' ? 'inprogress' : 'ready';
  clearAssessment(task);
  history(task, 'acceptancechanged', 'Acceptance criteria changed. Reimplement/review and cover all scenarioIds using evidence registered at or after this change and usage received strictly after it.', now, revision, { from, to: task.status });
}
function latestAcceptanceChange(task) {
  const changes = task.history.filter((entry) => entry.kind === 'acceptancechanged');
  return changes.length ? Math.max(...changes.map((entry) => Date.parse(entry.at))) : null;
}
function invalidateDependants(board, rootId, now, revision) {
  const queue = [rootId], visited = new Set(queue), invalidated = [];
  for (let index = 0; index < queue.length; index++) {
    const dependencyId = queue[index];
    for (const dependant of board.tasks.filter((item) => item.dependsOn.includes(dependencyId))) {
      if (visited.has(dependant.id)) continue;
      visited.add(dependant.id); queue.push(dependant.id);
      if (dependant.status !== 'done') continue;
      dependant.status = 'readyforusage'; clearAssessment(dependant);
      history(dependant, 'invalidation', `Completion invalidated because dependency ${rootId} was reopened (via ${dependencyId}). Previous assessment history is retained; reassess after all dependencies are done.`, now, revision, { from: 'done', to: 'readyforusage' });
      invalidated.push(dependant.id);
    }
  }
  return invalidated;
}
function patchTask(task, patch) {
  exactKeys(patch, MUTABLE, 'patch');
  if (task.required) assert(patch.required !== false, 'REQUIRED_SCOPE', 'Required work cannot be demoted to backlog');
  if (task.sourceResult) assert(patch.priority === undefined || patch.priority === task.priority, 'REQUIRED_SCOPE', 'Baseline priority is fixed');
  const changesAcceptance = Object.hasOwn(patch, 'acceptance');
  if (changesAcceptance) validateAcceptance(patch.acceptance);
  const acceptanceChanged = changesAcceptance && acceptanceSignature(task.acceptance) !== acceptanceSignature(patch.acceptance);
  for (const key of Object.keys(patch)) task[key] = structuredClone(patch[key]);
  if (changesAcceptance) task.acceptance.forEach((item) => { item.checked = false; });
  return acceptanceChanged;
}
export function previewImport(board, content) {
  try {
    const incoming = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
    validateBoard(incoming);
    assert(JSON.stringify(incoming.baseline) === JSON.stringify(board.baseline) && incoming.metadata.sourceHash === board.metadata.sourceHash && JSON.stringify(incoming.packs) === JSON.stringify(board.packs), 'IMPORT_PROTECTED', 'Import cannot replace baseline/source/packs');
    for (const existing of board.tasks) {
      const task = incoming.tasks.find((item) => item.id === existing.id);
      assert(task, 'IMPORT_PROTECTED', `Import cannot remove ${existing.id}`);
      for (const key of ['baselineIds', 'sourceResult', 'evidence', 'history', 'retrospectives', 'verdict']) assert(JSON.stringify(task[key]) === JSON.stringify(existing[key]), 'IMPORT_PROTECTED', `Import cannot replace protected ${existing.id}.${key}`);
      assert(task.status === existing.status, 'IMPORT_PROTECTED', 'Import cannot transition tasks; use transition/assess');
      if (task.status === 'done') assert(JSON.stringify(task) === JSON.stringify(existing), 'IMPORT_PROTECTED', 'Reopen a done task before editing');
      if (existing.required) assert(task.required, 'REQUIRED_SCOPE', 'Import cannot demote required work');
      if (existing.sourceResult) assert(task.priority === existing.priority, 'REQUIRED_SCOPE', 'Baseline priority is fixed');
    }
    for (const task of incoming.tasks.filter((item) => !board.tasks.some((existing) => existing.id === item.id))) assert(['todo', 'ready'].includes(task.status) && task.evidence.length === 0 && task.history.length === 0 && task.retrospectives.length === 0 && task.verdict === null && task.baselineIds.length === 0 && task.sourceResult === undefined, 'IMPORT_PROTECTED', 'New imported tasks must be unassessed and have no imported audit/evidence');
    return { valid: true, errors: [], summary: { tasks: incoming.tasks.length, added: incoming.tasks.filter((task) => !board.tasks.some((item) => item.id === task.id)).length, changed: incoming.tasks.filter((task) => JSON.stringify(task) !== JSON.stringify(board.tasks.find((item) => item.id === task.id))).length }, incoming };
  } catch (error) { return { valid: false, errors: [{ code: error.code ?? 'INVALID_JSON', message: error.message }], summary: null }; }
}
export async function applyCommand(current, command, { now = new Date().toISOString(), resolveUsageEvent = async () => null } = {}) {
  validateBoard(current); iso(now, 'now');
  exactKeys(command, ['type', 'id', 'patch', 'status', 'text', 'evidence', 'verdict', 'content'], 'command');
  assert(['create', 'update', 'transition', 'log', 'evidence', 'retrospective', 'assess', 'import'].includes(command.type), 'UNKNOWN_COMMAND', 'Unknown command type');
  const board = structuredClone(current), revision = current.metadata.revision + 1;
  let result;
  if (command.type === 'import') {
    const preview = previewImport(current, command.content);
    assert(preview.valid, 'INVALID_IMPORT', 'Import validation failed', 400, preview.errors);
    const modified = preview.incoming.tasks.filter((task) => JSON.stringify(task) !== JSON.stringify(current.tasks.find((item) => item.id === task.id)));
    board.tasks = preview.incoming.tasks;
    for (const task of modified) {
      history(task, 'import', 'Validated import; prior evidence and audit retained.', now, revision);
      const existing = current.tasks.find((item) => item.id === task.id);
      if (existing && acceptanceSignature(existing.acceptance) !== acceptanceSignature(task.acceptance)) recordAcceptanceChange(task, now, revision);
      else if (task.status !== 'done') task.acceptance.forEach((item) => { item.checked = false; });
    }
    result = { type: 'import', summary: preview.summary };
  } else if (command.type === 'create') {
    taskId(command.id); assert(!board.tasks.some((item) => item.id === command.id), 'DUPLICATE_ID', 'Task ID already exists');
    const task = { id: command.id, title: '', description: '', priority: 'P2', area: '自定义', pack: 'W0', required: false, status: 'todo', baselineIds: [], acceptance: [], dependsOn: [], owner: '', evidence: [], history: [], retrospectives: [], verdict: null };
    patchTask(task, command.patch); history(task, 'create', command.text ?? 'Created task', now, revision); board.tasks.push(task); result = { id: task.id, type: command.type };
  } else {
    const task = getTask(board, command.id);
    if (command.type === 'update') {
      assert(task.status !== 'done', 'REOPEN_REQUIRED', 'Reopen done task with transition before editing');
      const acceptanceChanged = patchTask(task, command.patch);
      task.verdict = null; history(task, 'update', command.text ?? 'Updated task fields', now, revision);
      if (acceptanceChanged) recordAcceptanceChange(task, now, revision);
    } else if (command.type === 'transition') {
      assert(STATUSES.includes(command.status) && command.status !== 'done', 'ASSESS_REQUIRED', 'Only assess may set done');
      assert(!(task.required && command.status === 'archived'), 'REQUIRED_SCOPE', 'Required work cannot be archived');
      if (command.status === 'readyforusage') {
        const unmet = task.dependsOn.filter((id) => !['readyforusage', 'done'].includes(getTask(board, id).status));
        assert(unmet.length === 0, 'DEPENDENCIES_NOT_IMPLEMENTED', 'Dependencies must be readyforusage/done before usage assessment; ready/inprogress are not blocked', 400, { dependencies: unmet });
      }
      const from = task.status; task.status = command.status; task.verdict = null;
      if (from === 'done') clearAssessment(task);
      history(task, 'transition', command.text ?? `${from} → ${command.status}`, now, revision, { from, to: command.status });
      if (from === 'done') result = { id: task.id, type: command.type, invalidatedTaskIds: invalidateDependants(board, task.id, now, revision) };
    } else if (command.type === 'log' || command.type === 'retrospective') {
      text(command.text, 'text'); const entry = history(task, command.type, command.text, now, revision);
      if (command.type === 'retrospective') task.retrospectives.push(structuredClone(entry));
    } else if (command.type === 'evidence') {
      assert(task.status !== 'done', 'REOPEN_REQUIRED', 'Reopen done task before adding evidence');
      exactKeys(command.evidence, ['type', 'result', 'build', 'summary', 'reference', 'eventIds'], 'evidence');
      const evidence = { ...structuredClone(command.evidence), id: `e-${randomUUID()}`, at: now }; validateEvidence(evidence);
      for (const eventId of evidence.eventIds ?? []) { const event = await resolveUsageEvent(eventId); assert(event?.complete && event.build === evidence.build && event.taskIds.includes(task.id), 'INVALID_USAGE_EVIDENCE', `Missing, incomplete or wrong-build/task event ${eventId}`); }
      task.evidence.push(evidence); task.verdict = null;
      history(task, 'evidence', evidence.summary, now, revision, { evidenceId: evidence.id }); result = { id: task.id, type: 'evidence', evidenceId: evidence.id };
    } else if (command.type === 'assess') {
      assert(task.status === 'readyforusage', 'NOT_READY_FOR_USAGE', 'Assess requires status readyforusage');
      const verdict = structuredClone(command.verdict); validateVerdict(verdict, task);
      if (verdict.decision === 'pass') {
        const unmet = task.dependsOn.filter((id) => getTask(board, id).status !== 'done');
        assert(unmet.length === 0, 'DEPENDENCIES_NOT_DONE', 'Done requires all dependencies done', 400, { dependencies: unmet });
        assert(!task.evidence.some((evidence) => evidence.build === verdict.build && evidence.result === 'failed'), 'FAILED_EVIDENCE', 'Failed evidence for this build prevents pass');
        const selected = new Set(), userEvents = new Set(), acceptanceChangedAt = latestAcceptanceChange(task);
        for (const criterion of task.acceptance.filter(applicable)) {
          const coverage = verdict.coverage.find((item) => item.acceptanceId === criterion.id);
          assert(coverage && coverage.evidenceIds.length > 0 && coverage.usageEventIds.length > 0, 'INCOMPLETE_COVERAGE', `Missing registered evidence/usage coverage for ${criterion.id}`);
          for (const evidenceId of coverage.evidenceIds) {
            const evidence = task.evidence.find((item) => item.id === evidenceId);
            assert(evidence && evidence.build === verdict.build && evidence.result === 'passed', 'INVALID_EVIDENCE', `Evidence ${evidenceId} must be registered, passed and same-build`);
            assert(acceptanceChangedAt === null || Date.parse(evidence.at) >= acceptanceChangedAt, 'STALE_EVIDENCE', `Evidence ${evidenceId} predates the latest acceptance change; register new evidence for the revised criteria`, 400, { evidenceId, acceptanceChangedAt: new Date(acceptanceChangedAt).toISOString() });
            selected.add(evidence.id);
          }
          const coveredScenarios = new Set();
          for (const eventId of coverage.usageEventIds) {
            const event = await resolveUsageEvent(eventId);
            assert(event?.complete && event.build === verdict.build && event.taskIds.includes(task.id) && criterion.scenarioIds.includes(event.scenarioId), 'INVALID_USAGE_EVIDENCE', `Event ${eventId} must be complete, same-build and task/scenario-matched`);
            // Legacy prototype receivedAt is the trusted collection boundary; timestamp was supplied by its client.
            // Native imports must use BOTH original occurrence and collection, never the later import/receipt time.
            const native = event.origin === 'native';
            const createdAt = native ? Math.max(0, ...task.history.filter((entry) => entry.kind === 'create').map((entry) => Date.parse(entry.at))) : 0;
            const freshnessBoundary = Math.max(acceptanceChangedAt ?? 0, createdAt);
            const fresh = native
              ? [event.occurredAt, event.collectedAt].every((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) > freshnessBoundary && Date.parse(value) <= Date.parse(now)) && event.receivedAt === event.collectedAt && Date.parse(event.occurredAt) <= Date.parse(event.collectedAt)
              : acceptanceChangedAt === null || Number.isFinite(Date.parse(event.receivedAt)) && Date.parse(event.receivedAt) > acceptanceChangedAt;
            assert(fresh, 'STALE_USAGE_EVIDENCE', `Event ${eventId} must have original collection (and native occurrence) strictly after the latest criteria boundary; importing cannot refresh old usage`, 400, { eventId, ...(freshnessBoundary ? { acceptanceChangedAt: new Date(freshnessBoundary).toISOString() } : {}) });
            assert(acceptableUsageResult(event), 'FAILED_USAGE', `Event ${eventId} must record a verified success or explicitly verified expected negative outcome`);
            coveredScenarios.add(event.scenarioId);
            if (event.source === 'userusage') userEvents.add(eventId);
          }
          const missingScenarioIds = criterion.scenarioIds.filter((id) => !coveredScenarios.has(id));
          assert(missingScenarioIds.length === 0, 'INCOMPLETE_SCENARIO_COVERAGE', `All scenarioIds are required for ${criterion.id}; missing: ${missingScenarioIds.join(', ')}`, 400, { acceptanceId: criterion.id, missingScenarioIds });
        }
        assert(userEvents.size > 0, 'USER_USAGE_REQUIRED', 'At least one complete userusage session event for this task/build is required; source is a declaration, not authenticated identity');
        assert(task.evidence.some((evidence) => selected.has(evidence.id) && ['test', 'browser'].includes(evidence.type)), 'TEST_EVIDENCE_REQUIRED', 'A registered passed test/browser execution record is required');
        task.acceptance.forEach((criterion) => { if (applicable(criterion)) criterion.checked = true; }); task.status = 'done';
      }
      task.verdict = verdict; history(task, 'assess', verdict.rationale, now, revision, { decision: verdict.decision, from: 'readyforusage', to: task.status });
    }
    result ??= { id: task.id, type: command.type };
  }
  board.metadata.revision = revision; board.metadata.updatedAt = now; validateBoard(board);
  return { board, result };
}

export const USAGE_EVENT_FIELDS = ['eventId', 'sequence', 'timestamp', 'taskIds', 'scenarioId', 'actionId', 'resultCode', 'durationMs', 'repoId', 'counts', 'state', 'errorCode'];
export const COUNT_FIELDS = ['selected', 'files', 'staged', 'unstaged', 'untracked', 'commits', 'conflicts', 'changed', 'total'];
export const STATE_FIELDS = ['theme', 'viewport', 'status', 'phase', 'trusted', 'busy', 'cancelled'];
export const NATIVE_ERROR_CODES = ['CANCELLED', 'USER_CANCELLED', 'GIT_FAILED', 'IO', 'ACCESS_DENIED', 'NOT_TRUSTED', 'TRUST_REQUIRED', 'TRUST_REVOKED', 'STALE_TARGET', 'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'TIMEOUT', 'UNAVAILABLE', 'DESKTOP_REQUIRED', 'USAGE_FULL', 'USAGE_WRITE_FAILED', 'UNKNOWN_ERROR'];
export const NATIVE_HEADER_FIELDS = ['kind', 'schemaVersion', 'sessionId', 'source', 'build', 'runtime', 'taskIds', 'createdAt'];
export const NATIVE_RECORD_FIELDS = ['kind', 'boundary', 'eventId', 'sequence', 'sessionId', 'source', 'build', 'occurredAt', 'collectedAt', 'taskIds', 'scenarioId', 'actionId', 'resultCode', 'durationMs', 'repoId', 'counts', 'state', 'errorCode'];

// This is a declared, local provenance category, not authenticated human identity.
// Require a stopped, fully valid session. No salvage of a bad/partial tail can become completion evidence.
export function parseNativeUsage(content, knownTaskIds, now = new Date().toISOString()) {
  assert(typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= 10 * 1024 * 1024 && !content.includes('\u0000') && !content.includes('\ufffd'), 'INVALID_NATIVE_USAGE', 'Expected bounded UTF-8 native JSONL content');
  assert(content.endsWith('\n'), 'INCOMPLETE_NATIVE_USAGE', 'Partial JSONL tail; no records were imported. Stop recording and review the original log.');
  const lines = content.slice(0, -1).split('\n');
  assert(lines.length >= 3 && lines.every((line) => line.length > 0 && Buffer.byteLength(line) <= 64 * 1024), 'INVALID_NATIVE_USAGE', 'Native JSONL requires a session header and bounded complete records');
  // Never return JSON parser messages: they can quote private content from a rejected input.
  let values; try { values = lines.map((line) => JSON.parse(line)); } catch { throw new BoardError('INVALID_NATIVE_USAGE', 'Malformed native JSONL record; nothing imported'); }
  const [header, ...records] = values;
  exactKeys(header, NATIVE_HEADER_FIELDS, 'native session');
  assert(header.kind === 'native-session' && header.schemaVersion === 1 && /^s-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(header.sessionId), 'INVALID_NATIVE_USAGE', 'Invalid native session identity/schema');
  validateUsageSession({ source: header.source, build: header.build, taskIds: header.taskIds }, knownTaskIds);
  assert(Array.isArray(header.taskIds), 'INVALID_NATIVE_USAGE', 'Native session taskIds are required');
  exactKeys(header.runtime, ['appVersion', 'sourceBuild', 'sourceBuildReliable', 'exeSha256'], 'native runtime');
  identifier(header.runtime.appVersion, 'appVersion'); identifier(header.runtime.sourceBuild, 'sourceBuild');
  assert(/^[a-f0-9]{64}$/.test(header.runtime.exeSha256) && header.build === `native-${header.runtime.exeSha256}`, 'INVALID_NATIVE_USAGE', 'Native build must be bound to its measured executable digest');
  assert(typeof header.runtime.sourceBuildReliable === 'boolean' && header.runtime.sourceBuildReliable === !['development', 'unknown', 'unavailable'].includes(header.runtime.sourceBuild), 'INVALID_NATIVE_USAGE', 'Native source build reliability is inconsistent');
  iso(header.createdAt, 'createdAt'); iso(now, 'now');
  assert(Date.parse(header.createdAt) <= Date.parse(now), 'INVALID_NATIVE_USAGE', 'Native session is future-dated');
  let phase = 'idle', previousOccurred = Date.parse(header.createdAt), previousCollected = previousOccurred;
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    exactKeys(record, NATIVE_RECORD_FIELDS, 'native record');
    assert(record.sessionId === header.sessionId && record.source === header.source && record.build === header.build, 'NATIVE_PROVENANCE_CONFLICT', 'Native session source/build/ID cannot be rewritten');
    assert(record.sequence === index + 1 && !ids.has(record.eventId), 'INVALID_NATIVE_USAGE', 'Native record sequence or event ID is duplicated/skipped'); ids.add(record.eventId);
    iso(record.occurredAt, 'occurredAt'); iso(record.collectedAt, 'collectedAt');
    const occurred = Date.parse(record.occurredAt), collected = Date.parse(record.collectedAt);
    assert(occurred >= previousOccurred && collected >= previousCollected && occurred <= collected && collected <= Date.parse(now), 'INVALID_NATIVE_USAGE', 'Native occurrence/collection ordering is invalid or future-dated'); previousOccurred = occurred; previousCollected = collected;
    const input = Object.fromEntries(USAGE_EVENT_FIELDS.filter((key) => key !== 'timestamp' && Object.hasOwn(record, key)).map((key) => [key, record[key]]));
    validateUsageEvent({ ...input, timestamp: record.occurredAt }, knownTaskIds);
    if (record.repoId !== undefined) assert(/^r-[a-f0-9]{32}$/.test(record.repoId), 'INVALID_NATIVE_USAGE', 'Native repoId must be a session-anonymous identifier');
    if (record.errorCode !== undefined) assert(NATIVE_ERROR_CODES.includes(record.errorCode), 'INVALID_NATIVE_USAGE', 'Native errorCode must be an allowlisted category');
    if (header.taskIds.length) assert(record.taskIds.every((id) => header.taskIds.includes(id)), 'INVALID_NATIVE_USAGE', 'Native record is outside session task scope');
    if (record.kind === 'boundary') {
      const next = ({ idle: { start: 'recording' }, recording: { pause: 'paused', stop: 'stopped' }, paused: { resume: 'recording', stop: 'stopped' } })[phase]?.[record.boundary];
      assert(next && record.scenarioId === `native-usage-${record.boundary}` && record.actionId === `usage.${record.boundary}` && record.resultCode === 'OBSERVED' && ['durationMs', 'repoId', 'counts', 'state', 'errorCode'].every((key) => record[key] === undefined), 'INVALID_NATIVE_USAGE', 'Invalid native recording boundary'); phase = next;
    } else assert(record.kind === 'event' && record.boundary === undefined && phase === 'recording', 'INVALID_NATIVE_USAGE', 'Events must occur inside an explicitly started/resumed recording');
  }
  assert(phase === 'stopped', 'INCOMPLETE_NATIVE_USAGE', 'Native session is not explicitly stopped; nothing imported');
  return { header, records };
}
export function validateUsageSession(input, knownTaskIds) {
  exactKeys(input, ['source', 'build', 'taskIds'], 'session');
  assert(SOURCES.includes(input.source), 'INVALID_INPUT', 'Invalid usage source'); text(input.build, 'build', 200);
  if (input.taskIds !== undefined) { array(input.taskIds, 'taskIds', 100).forEach((id) => { taskId(id); assert(knownTaskIds.has(id), 'INVALID_INPUT', 'Unknown taskId'); }); unique(input.taskIds, 'taskIds'); }
}
export function validateUsageEvent(event, knownTaskIds) {
  exactKeys(event, USAGE_EVENT_FIELDS, 'event');
  for (const field of ['eventId', 'scenarioId', 'actionId', 'resultCode']) identifier(event[field], field);
  assert(Number.isSafeInteger(event.sequence) && event.sequence > 0, 'INVALID_INPUT', 'sequence must be a positive integer'); iso(event.timestamp, 'timestamp');
  array(event.taskIds, 'taskIds', 100).forEach((id) => { taskId(id); assert(knownTaskIds.has(id), 'INVALID_INPUT', 'Unknown taskId'); }); unique(event.taskIds, 'taskIds');
  if (event.durationMs !== undefined) assert(Number.isFinite(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 86400000, 'INVALID_INPUT', 'Invalid durationMs');
  for (const field of ['repoId', 'errorCode']) if (event[field] !== undefined) identifier(event[field], field);
  if (event.counts !== undefined) { exactKeys(event.counts, COUNT_FIELDS, 'counts'); for (const value of Object.values(event.counts)) assert(Number.isSafeInteger(value) && value >= 0 && value <= 1e9, 'INVALID_INPUT', 'counts values must be nonnegative integers <= 1e9'); }
  if (event.state !== undefined) {
    exactKeys(event.state, STATE_FIELDS, 'state');
    for (const [key, value] of Object.entries(event.state)) {
      if (['trusted', 'busy', 'cancelled'].includes(key)) assert(typeof value === 'boolean', 'INVALID_INPUT', `${key} must be boolean`);
      else assert(({ theme: ['dark', 'light'], viewport: ['wide', 'narrow'], status: STATUSES, phase: ['idle', 'preview', 'running', 'success', 'failed', 'cancelled', 'blocked'] })[key].includes(value), 'INVALID_INPUT', `Invalid state.${key}`);
    }
  }
}
