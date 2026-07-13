/**
 * Git history reader: the provenance signal behind KIT_BOILERPLATE (§4.7).
 *
 * F7 is the first rule to consult git history. It fires on a file inherited from
 * the workspace's fork or import point and never adapted since. This module is
 * the seam that turns a directory into the per-path git facts the rule reads:
 * whether a path is tracked, whether it existed at a fork-point commit, and how
 * many commits after that point touched it.
 *
 * It mirrors `tokens.ts`: a single pure-ish entry point (`readGitInfo`) behind
 * which the implementation detail (shelling out to `git`) is hidden, so the
 * audit runner reasons about plain fields on `WorkspaceFile`, never about git.
 *
 * Safe degradation is the contract (SPEC §4.7): a workspace not under git, a git
 * binary that is missing or errors, or a shallow clone lacking the fork-point
 * commit all yield an empty map (every file reads as untracked), so F7 simply
 * under-reports rather than firing spuriously. A wrong or unresolvable
 * `--fork-point` likewise degrades to silence, never to a false positive.
 */

import { execFileSync } from 'node:child_process';

/** Per-path git facts F7 reads (SPEC §4.7). */
export interface GitInfo {
  /** True when the path is tracked in the repository. */
  readonly tracked: boolean;
  /**
   * Commits after the fork-point commit that touched this path; `null` when the
   * path is not tracked or the workspace is off-repo. `0` means inherited and
   * never adapted, the F7 fire condition (with `existedAtForkPoint`).
   */
  readonly postForkCommits: number | null;
  /** True when the path existed at the fork-point commit. */
  readonly existedAtForkPoint: boolean;
}

/**
 * Per-path git facts for the workspace rooted at `root`, keyed by POSIX-relative
 * path (the same keys `readWorkspace` uses). `forkPoint` overrides the boundary
 * commit; it defaults to the repository's root commit.
 *
 * Returns an empty map (every file untracked) when the workspace is not under
 * git, when git is unavailable or errors, when the repository is a shallow clone
 * whose default fork point cannot be trusted, or when an explicit `forkPoint`
 * does not resolve to a present commit. This is the SPEC §4.7 safe degradation:
 * silence, never a spurious finding.
 */
export function readGitInfo(
  root: string,
  forkPoint?: string,
): Map<string, GitInfo> {
  const empty = new Map<string, GitInfo>();
  if (run(root, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
    return empty;
  }

  const fork = resolveForkPoint(root, forkPoint);
  if (fork === undefined) return empty;

  // `ls-files` lists paths relative to the cwd (the workspace root); `ls-tree`
  // with `--full-tree` lists them relative to the repository root, so map a
  // workspace-relative path `p` to its repo-relative form via `--show-prefix`.
  const prefix = (run(root, ['rev-parse', '--show-prefix']) ?? '').trim();
  const tracked = nullSeparated(run(root, ['ls-files', '-z']));
  const existed = existedAtFork(root, fork, prefix);

  const info = new Map<string, GitInfo>();
  for (const path of tracked) {
    info.set(path, {
      tracked: true,
      existedAtForkPoint: existed.has(path),
      postForkCommits: countCommitsSince(root, fork, path),
    });
  }
  return info;
}

/**
 * The fork-point commit SHA, or `undefined` when none can be trusted. An
 * explicit `forkPoint` must resolve to a present commit; otherwise the default
 * is the repository's root commit, which a shallow clone cannot be trusted to
 * hold (its grafted boundary is not the true root), so a shallow repository
 * yields `undefined` for the default.
 */
function resolveForkPoint(
  root: string,
  forkPoint?: string,
): string | undefined {
  if (forkPoint !== undefined) {
    return run(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${forkPoint}^{commit}`,
    ])?.trim() || undefined;
  }
  if (run(root, ['rev-parse', '--is-shallow-repository'])?.trim() === 'true') {
    return undefined;
  }
  // The root commit: the (typically sole) commit with no parents, reachable
  // from HEAD. `--max-parents=0` lists parentless commits oldest-last.
  const roots = nullSeparated(
    run(root, ['rev-list', '--max-parents=0', '-z', 'HEAD']),
  );
  return roots.length === 0 ? undefined : roots[roots.length - 1];
}

/**
 * The set of workspace-relative paths that existed at `fork`. `ls-tree
 * --full-tree` lists repo-relative paths; keep those under `prefix` (the
 * workspace within the repo) and strip it back to workspace-relative.
 */
function existedAtFork(
  root: string,
  fork: string,
  prefix: string,
): Set<string> {
  const all = nullSeparated(
    run(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', fork]),
  );
  if (prefix === '') return new Set(all);
  const scoped = new Set<string>();
  for (const path of all) {
    if (path.startsWith(prefix)) scoped.add(path.slice(prefix.length));
  }
  return scoped;
}

/**
 * Commits after `fork` that touched `path` (a workspace-relative pathspec, which
 * `git` resolves relative to the cwd). `null` if the count cannot be read.
 */
function countCommitsSince(
  root: string,
  fork: string,
  path: string,
): number | null {
  const out = run(root, [
    'rev-list',
    '--count',
    `${fork}..HEAD`,
    '--',
    path,
  ]);
  if (out === undefined) return null;
  const n = Number.parseInt(out.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/** Split a `-z` (NUL-separated) git output into a list, dropping empties. */
function nullSeparated(out: string | undefined): string[] {
  if (!out) return [];
  return out.split('\0').filter((s) => s !== '');
}

/**
 * Run `git` with the given args in `root`, returning stdout, or `undefined` on
 * any failure (git missing, non-zero exit, not a repo). stderr is discarded so a
 * non-repo probe stays quiet.
 */
function run(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}
