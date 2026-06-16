/**
 * Shared path and routing-frame helpers (SPEC §2.1, §2.2).
 *
 * Workspace trees are flat lists of POSIX-relative paths. These helpers locate
 * workspace roots (the directories holding a `CLAUDE.md`) and compute a file's
 * routing depth and nearest enclosing root in the audit frame. The classifier
 * (§2.5) and the audit runner (§3, §4) share this one implementation so the two
 * cannot drift.
 */

import { ROOT_IDENTITY_FILE } from './model.js';

/** Directory of a path; '' for a path at the workspace root. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Final path segment. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** True for a Markdown path (case-insensitive `.md`). */
export function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/** The directory of every `CLAUDE.md` in the tree: one per workspace root. */
export function workspaceRootDirs(tree: readonly string[]): string[] {
  return tree
    .filter((path) => baseName(path) === ROOT_IDENTITY_FILE)
    .map(dirOf);
}

/** True when workspace root `root` ('' is the audit root) contains `fileDir`. */
export function rootContains(root: string, fileDir: string): boolean {
  if (root === '') return true;
  return fileDir === root || fileDir.startsWith(`${root}/`);
}

/** Every workspace root whose workspace contains `filePath` (§2.2). */
export function containingRoots(
  filePath: string,
  tree: readonly string[],
): string[] {
  const fileDir = dirOf(filePath);
  return workspaceRootDirs(tree).filter((root) => rootContains(root, fileDir));
}

/**
 * Routing depth (§2.2): the count of `CLAUDE.md` files whose workspace contains
 * `filePath`. The audit root counts as depth 1; a file one workspace deep is
 * depth 2. Depth above the W6 maximum triggers OVER_ROUTING (§4.4).
 */
export function routingDepth(
  filePath: string,
  tree: readonly string[],
): number {
  return containingRoots(filePath, tree).length;
}

/** The nearest enclosing workspace root: the deepest containing root dir. */
export function nearestRoot(
  filePath: string,
  tree: readonly string[],
): string {
  return containingRoots(filePath, tree).reduce(
    (deepest, root) => (root.length > deepest.length ? root : deepest),
    '',
  );
}

/** `filePath` relative to its nearest enclosing workspace root. */
export function pathWithinWorkspace(
  filePath: string,
  tree: readonly string[],
): string {
  const root = nearestRoot(filePath, tree);
  return root === '' ? filePath : filePath.slice(root.length + 1);
}
