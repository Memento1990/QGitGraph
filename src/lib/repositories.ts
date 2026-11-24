import type { RepositoryCandidate } from '../shared/protocol';

export const MAX_REPOSITORY_CANDIDATES = 256;
/** The native scanner is bounded; keep an independent UI bound for malformed DTOs. */
export const MAX_REPOSITORY_COMPONENTS = 6;
export const MAX_REPOSITORY_TREE_NODES = 1 + MAX_REPOSITORY_CANDIDATES * MAX_REPOSITORY_COMPONENTS;
export const MAX_REPOSITORY_NODE_KEY_LENGTH = 32_768;

/** A disclosure key, not a filesystem path. Never split, case-fold, or resolve native paths here. */
export function repositoryNodeKey(components: readonly string[]): string {
  return components.map(component => encodeURIComponent(component)).join('/');
}

/**
 * Display-only basename with an explicit native-path syntax check. This never
 * participates in hierarchy, identity, or path reconstruction; components from
 * the native scanner remain authoritative even for UNC and POSIX backslash names.
 */
export function repositoryScopeName(rootPath: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(rootPath) || rootPath.startsWith('\\\\');
  let end = rootPath.length;
  const separator = (character: string): boolean => character === '/' || windowsPath && character === '\\';
  while (end > 0 && separator(rootPath[end - 1])) end--;
  if (!end) return rootPath;
  const prefix = rootPath.slice(0, end);
  const at = Math.max(prefix.lastIndexOf('/'), windowsPath ? prefix.lastIndexOf('\\') : -1);
  return prefix.slice(at + 1) || rootPath;
}

export function clampRepositoryDepth(depth: number): number {
  return Number.isFinite(depth) ? Math.max(0, Math.min(5, Math.floor(depth))) : 0;
}

export interface RepositoryTreeNode {
  readonly key: string;
  readonly name: string;
  readonly components: readonly string[];
  readonly parentKey: string | null;
  /** A repository and its descendants are independent: a node may have both. */
  readonly candidate: RepositoryCandidate | null;
  readonly children: readonly RepositoryTreeNode[];
}

export interface RepositoryTreeData {
  /** Exact native scope identity; relative keys are scoped by this value. */
  readonly rootPath: string;
  readonly root: RepositoryTreeNode;
  readonly nodes: ReadonlyMap<string, RepositoryTreeNode>;
  readonly candidateCount: number;
  /** Invalid or over-budget records must not silently look like a complete scan. */
  readonly omittedCount: number;
}

interface MutableTreeNode {
  key: string;
  name: string;
  components: string[];
  parentKey: string | null;
  candidate: RepositoryCandidate | null;
  children: MutableTreeNode[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareCandidates(left: RepositoryCandidate, right: RepositoryCandidate): number {
  for (let index = 0; index < Math.min(left.components.length, right.components.length); index++) {
    const compared = compareText(left.components[index], right.components[index]);
    if (compared) return compared;
  }
  return left.components.length - right.components.length || compareText(left.path, right.path) || compareText(left.marker, right.marker);
}
function validCandidate(candidate: RepositoryCandidate): boolean {
  return Boolean(candidate && typeof candidate.path === 'string' && candidate.path.length && !candidate.path.includes('\0')
    && ['git-directory', 'git-file', 'bare'].includes(candidate.marker)
    && Array.isArray(candidate.components) && candidate.components.length <= MAX_REPOSITORY_COMPONENTS
    && candidate.components.every(component => typeof component === 'string' && component.length > 0
      && component.length <= MAX_REPOSITORY_NODE_KEY_LENGTH && component !== '.' && component !== '..' && !component.includes('\0')));
}

/**
 * Build only the root and ancestors of native candidate components. No path parsing,
 * Git calls, locale-sensitive sorting, or inferred repositories. Work and mounting
 * remain bounded even if a caller supplies more records than the scanner permits.
 */
export function buildRepositoryTree(rootPath: string, candidates: readonly RepositoryCandidate[]): RepositoryTreeData {
  const root: MutableTreeNode = { key: '', name: rootPath, components: [], parentKey: null, candidate: null, children: [] };
  const nodes = new Map<string, MutableTreeNode>([['', root]]);
  const accepted: RepositoryCandidate[] = [];
  let omittedCount = Math.max(0, candidates.length - MAX_REPOSITORY_CANDIDATES);
  for (let index = 0; index < Math.min(candidates.length, MAX_REPOSITORY_CANDIDATES); index++) {
    const candidate = candidates[index];
    if (!validCandidate(candidate)) { omittedCount++; continue; }
    try {
      if (repositoryNodeKey(candidate.components).length > MAX_REPOSITORY_NODE_KEY_LENGTH) { omittedCount++; continue; }
    } catch {
      // Invalid Unicode cannot be encoded losslessly into a persisted disclosure key.
      omittedCount++; continue;
    }
    accepted.push({ path: candidate.path, components: [...candidate.components], marker: candidate.marker });
  }
  accepted.sort(compareCandidates);
  let candidateCount = 0;
  for (const candidate of accepted) {
    let node = root;
    for (let length = 1; length <= candidate.components.length; length++) {
      const components = candidate.components.slice(0, length);
      const key = repositoryNodeKey(components);
      let child = nodes.get(key);
      if (!child) {
        child = { key, name: components[length - 1], components, parentKey: node.key, candidate: null, children: [] };
        node.children.push(child); nodes.set(key, child);
      }
      node = child;
    }
    if (!node.candidate) { node.candidate = candidate; candidateCount++; }
    else if (node.candidate.path !== candidate.path || node.candidate.marker !== candidate.marker) omittedCount++;
  }
  // Native code-unit order is deliberately stable across locale changes.
  for (const node of nodes.values()) node.children.sort((left, right) => compareText(left.name, right.name));
  return { rootPath, root, nodes, candidateCount, omittedCount };
}

export interface RepositoryTreeRow {
  readonly node: RepositoryTreeNode;
  readonly level: number;
  readonly position: number;
  readonly setSize: number;
}

/** Bounded preorder suitable for a flat ARIA tree with explicit hierarchy metadata. */
export function visibleRepositoryRows(tree: RepositoryTreeData, collapsed: ReadonlySet<string>): RepositoryTreeRow[] {
  const rows: RepositoryTreeRow[] = [];
  const visit = (node: RepositoryTreeNode, level: number, position: number, setSize: number): void => {
    rows.push({ node, level, position, setSize });
    if (collapsed.has(node.key)) return;
    node.children.forEach((child, index) => visit(child, level + 1, index + 1, node.children.length));
  };
  visit(tree.root, 1, 1, 1);
  return rows;
}

export type RepositoryTreeKeyAction =
  | { readonly type: 'focus'; readonly key: string }
  | { readonly type: 'toggle'; readonly key: string; readonly collapsed: boolean }
  | { readonly type: 'activate'; readonly key: string }
  | { readonly type: 'none' };

/** Pure single-selection tree keyboard behavior. A handled no-op still prevents page scrolling. */
export function repositoryTreeKeyAction(rows: readonly RepositoryTreeRow[], focusedKey: string, collapsed: ReadonlySet<string>, key: string): RepositoryTreeKeyAction | null {
  const index = rows.findIndex(row => row.node.key === focusedKey);
  if (index < 0) return null;
  const node = rows[index].node;
  const focus = (at: number): RepositoryTreeKeyAction => ({ type: 'focus', key: rows[Math.max(0, Math.min(rows.length - 1, at))].node.key });
  switch (key) {
    case 'ArrowDown': return focus(index + 1);
    case 'ArrowUp': return focus(index - 1);
    case 'Home': return focus(0);
    case 'End': return focus(rows.length - 1);
    case 'ArrowRight':
      return node.children.length ? collapsed.has(node.key)
        ? { type: 'toggle', key: node.key, collapsed: false }
        : { type: 'focus', key: node.children[0].key } : { type: 'none' };
    case 'ArrowLeft':
      if (node.children.length && !collapsed.has(node.key)) return { type: 'toggle', key: node.key, collapsed: true };
      return node.parentKey === null ? { type: 'none' } : { type: 'focus', key: node.parentKey };
    case 'Enter': return node.candidate ? { type: 'activate', key: node.key } : { type: 'none' };
    case ' ':
    case 'Spacebar':
      return node.children.length ? { type: 'toggle', key: node.key, collapsed: !collapsed.has(node.key) } : { type: 'none' };
    default: return null;
  }
}

/** Restore hidden/removed focus to the closest surviving visible native ancestor. */
export function repositoryTreeFocusKey(rows: readonly RepositoryTreeRow[], preferredComponents: readonly string[] | null): string | null {
  if (!rows.length) return null;
  const visible = new Set(rows.map(row => row.node.key));
  if (preferredComponents) {
    for (let length = preferredComponents.length; length >= 0; length--) {
      const key = repositoryNodeKey(preferredComponents.slice(0, length));
      if (visible.has(key)) return key;
    }
  }
  return rows[0].node.key;
}
