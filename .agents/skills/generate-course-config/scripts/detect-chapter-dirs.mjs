#!/usr/bin/env node
/**
 * Fills `changedFiles` on existing chapter JSONC under `--out`.
 *
 * Usage:
 *   node detect-chapter-dirs.mjs [--out .course-config] [--depth N] [rootDir]
 *   node detect-chapter-dirs.mjs --json [--out .course-config] [--depth N] [rootDir]
 *
 * Write basic chapter files (`fromDir` / `toDir`) first. `--depth` is how many
 * subdirectory levels to enter under each snapshot (default 6; files at that
 * depth still count). On failure only, writes `detect-chapter-dirs.result.json`
 * listing failed chapters. One chapter failure does not stop the rest. `--json`
 * prints the full fill result instead of writing files.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatJsonc, parseJsonc, upsertChangedFilesJsonc } from "./chapter-jsonc.mjs";

export { formatJsonc, parseJsonc, upsertChangedFilesJsonc };

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".learn",
  ".course-config",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
]);

/** Top-level monorepo folders that are almost never chapter snapshots. */
const NOISE_DIR_NAMES = new Set([
  "apps",
  "packages",
  "skills",
  "scripts",
  "sandbox",
  "docs",
  "test",
  "tests",
  "src",
  "lib",
  "bin",
  "tools",
  "fixtures",
  "assets",
  "public",
  "examples",
]);

const NAME_SCORE = [
  [/^start$/i, 50],
  [/^baseline$/i, 45],
  [/^init$/i, 40],
  [/^initial$/i, 40],
  [/^step[-_]?(\d+)$/i, 35],
  [/^chapter[-_]?(\d+)$/i, 35],
  [/^ch[-_]?(\d+)$/i, 30],
  [/^(\d{2,3})([-_.].+)?$/i, 30],
  [/^v?\d+(\.\d+)*$/i, 20],
  // Common lesson folder tokens (including the local demo-source names)
  [/^(hello|world|bang|done|goal|final|reactive|effect|skeleton|particles|follow|glow)$/i, 25],
];

/** Subdirectory levels to enter under each snapshot when `--depth` is omitted. */
export const DEFAULT_MAX_DEPTH = 6;

/** Per-chapter run report written next to course JSONC (agent deletes after the skill). */
export const RESULT_FILE_NAME = "detect-chapter-dirs.result.json";

/**
 * Parses a `--depth` CLI value into a non-negative integer.
 *
 * @param {string} raw - Agent/CLI argument
 * @returns {number | undefined} Parsed depth, or undefined when invalid
 */
export function parseMaxDepth(raw) {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * Scores a directory name as a likely chapter snapshot.
 *
 * @param {string} name
 */
export function scoreName(name) {
  if (NOISE_DIR_NAMES.has(name.toLowerCase()) || SKIP_DIR_NAMES.has(name)) {
    return 0;
  }
  let score = 0;
  for (const [pattern, points] of NAME_SCORE) {
    if (pattern.test(name)) {
      score += points;
    }
  }
  return score;
}

/**
 * Lists immediate child directories of `dir`.
 *
 * @param {string} dir
 */
async function childDirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP_DIR_NAMES.has(entry.name))
    .map((entry) => entry.name);
}

/**
 * Collects relative file paths under `root` (depth-limited).
 *
 * `maxDepth` is how many subdirectory levels to enter. Depth 0 is the snapshot
 * root; files in a directory at `maxDepth` are included, deeper dirs are not.
 *
 * @param {string} root
 * @param {string} prefix
 * @param {number} depth - Current nesting under `root`
 * @param {number} maxDepth - Inclusive subdirectory limit
 */
async function listFiles(root, prefix = "", depth = 0, maxDepth = DEFAULT_MAX_DEPTH) {
  if (depth > maxDepth) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative, depth + 1, maxDepth)));
    } else if (entry.isFile()) {
      files.push(relative.split(/[/\\]/).join("/"));
    }
  }
  return files;
}

/**
 * Jaccard similarity of two path sets.
 *
 * @param {string[]} left
 * @param {string[]} right
 */
export function similarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) {
      inter += 1;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * True when name is an explicit "start of course" snapshot.
 *
 * @param {string} name
 */
export function isStartName(name) {
  return /^(start|baseline|init|initial)$/i.test(name);
}

/**
 * Orders snapshots: start-like (or smallest tree) first, then choose the
 * permutation that maximizes path Jaccard similarity and, on ties, minimizes
 * adjacent content drift (incremental tutorials).
 *
 * @param {string} root
 * @param {string} parentRel - Parent path relative to root ("" at root)
 * @param {string[]} names - Basename list under parent
 * @param {number} maxDepth - Inclusive subdirectory limit for file listing
 */
async function orderSnapshots(root, parentRel, names, maxDepth = DEFAULT_MAX_DEPTH) {
  const trees = new Map();
  for (const name of names) {
    trees.set(name, await listFiles(path.join(root, parentRel, name), "", 0, maxDepth));
  }

  let start = names.find((name) => isStartName(name));
  if (start === undefined) {
    start = names.reduce((best, name) => {
      const bestCount = (trees.get(best) ?? []).length;
      const count = (trees.get(name) ?? []).length;
      return count < bestCount ? name : best;
    }, names[0]);
  }
  if (start === undefined) {
    return names;
  }

  const rest = names.filter((name) => name !== start);
  if (rest.length <= 1) {
    return [start, ...rest];
  }

  if (rest.length > 7) {
    return orderSnapshotsGreedy(start, rest, trees);
  }

  /** @type {string[]} */
  let bestOrder = rest;
  let bestSim = -1;
  let bestDrift = Number.POSITIVE_INFINITY;
  let bestSizePenalty = Number.POSITIVE_INFINITY;
  for (const perm of permutations(rest)) {
    const seq = [start, ...perm];
    let simScore = 0;
    let drift = 0;
    let sizePenalty = 0;
    /** @type {number[]} */
    const sizes = [];
    for (let i = 0; i < seq.length; i += 1) {
      const name = seq[i];
      if (name === undefined) {
        continue;
      }
      sizes.push(await treeByteSize(path.join(root, parentRel, name), trees.get(name) ?? []));
    }
    for (let i = 0; i < seq.length - 1; i += 1) {
      const left = seq[i];
      const right = seq[i + 1];
      if (left === undefined || right === undefined) {
        continue;
      }
      const leftFiles = trees.get(left) ?? [];
      const rightFiles = trees.get(right) ?? [];
      simScore += similarity(leftFiles, rightFiles);
      drift += await contentDrift(
        path.join(root, parentRel, left),
        path.join(root, parentRel, right),
        leftFiles,
        rightFiles,
      );
      const leftSize = sizes[i] ?? 0;
      const rightSize = sizes[i + 1] ?? 0;
      if (rightSize < leftSize) {
        sizePenalty += leftSize - rightSize;
      }
    }
    const better =
      simScore > bestSim ||
      (simScore === bestSim && drift < bestDrift) ||
      (simScore === bestSim && drift === bestDrift && sizePenalty < bestSizePenalty);
    if (better) {
      bestSim = simScore;
      bestDrift = drift;
      bestSizePenalty = sizePenalty;
      bestOrder = perm;
    }
  }
  return [start, ...bestOrder];
}

/**
 * Sums UTF-8 byte lengths of files in a snapshot (proxy for lesson progress).
 *
 * @param {string} absRoot
 * @param {string[]} files
 */
async function treeByteSize(absRoot, files) {
  let total = 0;
  for (const relative of files) {
    try {
      total += Buffer.byteLength(
        await readFile(path.join(absRoot, ...relative.split("/")), "utf8"),
        "utf8",
      );
    } catch {
      // ignore missing
    }
  }
  return total;
}

/**
 * Counts path/content differences between two snapshot trees.
 *
 * @param {string} leftRoot
 * @param {string} rightRoot
 * @param {string[]} leftFiles
 * @param {string[]} rightFiles
 */
async function contentDrift(leftRoot, rightRoot, leftFiles, rightFiles) {
  const all = new Set([...leftFiles, ...rightFiles]);
  let drift = 0;
  for (const relative of all) {
    let leftText;
    let rightText;
    try {
      leftText = await readFile(path.join(leftRoot, ...relative.split("/")), "utf8");
    } catch {
      leftText = undefined;
    }
    try {
      rightText = await readFile(path.join(rightRoot, ...relative.split("/")), "utf8");
    } catch {
      rightText = undefined;
    }
    if (leftText !== rightText) {
      drift += 1;
    }
  }
  return drift;
}

/**
 * Yields all permutations of `items`.
 *
 * @template T
 * @param {T[]} items
 * @returns {Generator<T[]>}
 */
function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    if (head === undefined) {
      continue;
    }
    const tail = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(tail)) {
      yield [head, ...perm];
    }
  }
}

/**
 * Greedy fallback when there are too many snapshots to permute.
 *
 * @param {string} start
 * @param {string[]} rest
 * @param {Map<string, string[]>} trees
 */
function orderSnapshotsGreedy(start, rest, trees) {
  /** @type {string[]} */
  const ordered = [start];
  const remaining = new Set(rest);
  while (remaining.size > 0) {
    const prev = ordered[ordered.length - 1] ?? start;
    const prevFiles = trees.get(prev) ?? [];
    let next;
    let nextScore = -1;
    for (const name of remaining) {
      const files = trees.get(name) ?? [];
      const growth = files.length >= prevFiles.length ? 1 : 0;
      const score = growth * 10 + similarity(prevFiles, files);
      if (score > nextScore) {
        nextScore = score;
        next = name;
      }
    }
    if (next === undefined) {
      break;
    }
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered;
}

/**
 * Scores a sibling directory group as possible chapter snapshots.
 *
 * @param {string} root
 * @param {string} parentRel
 * @param {string[]} names
 * @param {number} maxDepth - Inclusive subdirectory limit for file listing
 */
async function scoreGroup(root, parentRel, names, maxDepth = DEFAULT_MAX_DEPTH) {
  const named = names.filter((name) => scoreName(name) > 0);
  if (named.length < 2) {
    return 0;
  }
  let score = named.reduce((sum, name) => sum + scoreName(name), 0);
  score += Math.min(named.length, 8) * 6;

  const ordered = await orderSnapshots(root, parentRel, named, maxDepth);
  /** @type {string[][]} */
  const trees = [];
  for (const name of ordered.slice(0, 5)) {
    trees.push(await listFiles(path.join(root, parentRel, name), "", 0, maxDepth));
  }
  let simSum = 0;
  let pairs = 0;
  for (let i = 0; i < trees.length - 1; i += 1) {
    simSum += similarity(trees[i] ?? [], trees[i + 1] ?? []);
    pairs += 1;
  }
  if (pairs === 0) {
    return 0;
  }
  const avg = simSum / pairs;
  if (avg < 0.2) {
    return 0;
  }
  score += Math.round(avg * 80);
  if (named.some((name) => isStartName(name))) {
    score += 20;
  }
  return score;
}

/**
 * Collects candidate parent paths to search for sibling snapshot groups.
 *
 * @param {string} root
 */
async function candidateParents(root) {
  /** @type {string[]} */
  const parents = [""];
  const top = await childDirs(root);
  for (const child of top) {
    parents.push(child);
    // One more level (e.g. examples/demo-source)
    if (
      NOISE_DIR_NAMES.has(child.toLowerCase()) ||
      /^(examples?|tutorials?|lessons?|impls?|demos?)$/i.test(child)
    ) {
      const nested = await childDirs(path.join(root, child));
      for (const grand of nested) {
        parents.push(`${child}/${grand}`);
      }
    }
  }
  return parents;
}

/**
 * Picks the best sibling group that looks like ordered chapter snapshots.
 *
 * @param {string} root
 * @param {number} maxDepth - Inclusive subdirectory limit for file listing
 */
async function detectGroup(root, maxDepth = DEFAULT_MAX_DEPTH) {
  /** @type {{ parent: string, names: string[], score: number }[]} */
  const candidates = [];

  for (const parent of await candidateParents(root)) {
    const abs = parent === "" ? root : path.join(root, ...parent.split("/"));
    const names = await childDirs(abs);
    const score = await scoreGroup(root, parent, names, maxDepth);
    if (score > 0) {
      candidates.push({ parent, names, score });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (best === undefined || best.score < 80) {
    return undefined;
  }

  const named = best.names.filter((name) => scoreName(name) > 0);
  const ordered = await orderSnapshots(
    root,
    best.parent,
    named.length >= 2 ? named : best.names,
    maxDepth,
  );
  if (ordered.length < 2) {
    return undefined;
  }
  const snapshots = ordered.map((name) => (best.parent === "" ? name : `${best.parent}/${name}`));
  return { parent: best.parent, snapshots, score: best.score };
}

/**
 * Builds chapter descriptors from ordered snapshot paths.
 *
 * @param {string[]} snapshots
 */
export function buildChapters(snapshots) {
  /** @type {{ id: string, title: string, fromDir: string, toDir: string }[]} */
  const chapters = [];
  for (let i = 0; i < snapshots.length - 1; i += 1) {
    const fromDir = snapshots[i];
    const toDir = snapshots[i + 1];
    if (fromDir === undefined || toDir === undefined) {
      continue;
    }
    const rawId =
      path.posix.basename(toDir).replace(/^\d+[-_.]?/, "") || `chapter-${String(i + 1)}`;
    const id =
      rawId
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-|-$/g, "") || `chapter-${String(i + 1)}`;
    const title =
      id
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ") || `Chapter ${String(i + 1)}`;
    chapters.push({
      id,
      title,
      fromDir,
      toDir,
    });
  }
  return chapters;
}

/**
 * Returns whether `value` is a plain object.
 *
 * @param {unknown} value
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Formats `changedFiles` as a JSON array (no trailing newline).
 *
 * @param {{ path: string, kind: "U" | "M" | "D" }[]} files
 */
export function formatChangedFilesJsonc(files) {
  return JSON.stringify(files, null, 2);
}

/**
 * Derives a chapter id from `001-hello.jsonc` (strip extension and numeric prefix).
 *
 * @param {string} fileName
 */
export function chapterIdFromFileName(fileName) {
  const base = fileName.replace(/\.jsonc$/i, "");
  const stripped = base.replace(/^\d+[-_.]?/, "");
  return stripped || base;
}

/**
 * Reads `id` / `fromDir` / `toDir` from chapter JSONC (empty from/to = empty trees).
 *
 * @param {string} text - Chapter JSONC
 * @param {string} fileName - File basename used when `id` is omitted
 */
export function readChapterSnapshotFields(text, fileName) {
  const value = parseJsonc(text);
  if (!isRecord(value)) {
    throw new Error("chapter config must be a JSON object");
  }
  const idRaw = typeof value.id === "string" ? value.id : undefined;
  const fromRaw = typeof value.fromDir === "string" ? value.fromDir : undefined;
  const toRaw = typeof value.toDir === "string" ? value.toDir : undefined;
  return {
    id: idRaw !== undefined && idRaw !== "" ? idRaw : chapterIdFromFileName(fileName),
    fromDir: fromRaw ?? "",
    toDir: toRaw ?? "",
    file: fileName,
  };
}

/**
 * Rejects `fromDir` / `toDir` values that are absolute or contain `..`.
 *
 * @param {string} relative
 */
export function assertRepoRelativeSnapshot(relative) {
  if (relative === "") {
    return;
  }
  const parts = relative.split(/[/\\]/);
  if (path.isAbsolute(relative) || parts.includes("..")) {
    throw new Error(`fromDir/toDir must be repo-relative (no .. or absolute): ${relative}`);
  }
}

/**
 * Lists `chapters/*.jsonc` under the course config directory, sorted by file name.
 *
 * @param {string} configDir
 * @returns {Promise<Array<{ file: string, filePath: string }>>}
 */
export async function listChapterConfigFiles(configDir) {
  const chaptersDir = path.join(configDir, "chapters");
  let entries;
  try {
    entries = await readdir(chaptersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.jsonc$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ file, filePath: path.join(chaptersDir, file) }));
}

/**
 * Fills `changedFiles` on each existing chapter JSONC file; continues after a failure.
 *
 * @param {string} root - Source root
 * @param {string} configDir - Course config directory (`--out`)
 * @param {number} [maxDepth]
 * @param {{ write?: boolean }} [options] - `write: false` computes diffs without saving
 */
export async function fillExistingChapterConfigs(
  root,
  configDir,
  maxDepth = DEFAULT_MAX_DEPTH,
  options = {},
) {
  const write = options.write !== false;
  const listed = await listChapterConfigFiles(configDir);
  if (listed.length === 0) {
    return {
      ok: false,
      wrote: 0,
      failed: 0,
      reason: "no chapter JSONC in chapters/; write basic chapter files (fromDir/toDir) first",
      chapters: [],
    };
  }
  /** @type {Array<{
   *   ok: boolean,
   *   id: string,
   *   fromDir: string,
   *   toDir: string,
   *   file: string,
   *   changes?: number,
   *   changedFiles?: { path: string, kind: "U" | "M" | "D" }[],
   *   error?: string,
   * }>} */
  const chapters = [];
  for (const { file, filePath } of listed) {
    let id = chapterIdFromFileName(file);
    let fromDir = "";
    let toDir = "";
    try {
      const text = await readFile(filePath, "utf8");
      const fields = readChapterSnapshotFields(text, file);
      id = fields.id;
      fromDir = fields.fromDir;
      toDir = fields.toDir;
      assertRepoRelativeSnapshot(fromDir);
      assertRepoRelativeSnapshot(toDir);
      await ensureSnapshotDir(root, fromDir);
      await ensureSnapshotDir(root, toDir);
      const changedFiles = await changedFilesBetween(root, fromDir, toDir, maxDepth);
      if (write) {
        await writeFile(filePath, upsertChangedFilesJsonc(text, changedFiles), "utf8");
      }
      chapters.push({
        ok: true,
        id,
        fromDir,
        toDir,
        file,
        changes: changedFiles.length,
        changedFiles,
      });
    } catch (error) {
      chapters.push({
        ok: false,
        id,
        fromDir,
        toDir,
        file,
        error: formatError(error),
      });
    }
  }
  /** Counts chapter JSONC files updated successfully. */
  const wrote = chapters.filter((chapter) => chapter.ok).length;
  /** Counts chapters that failed analyze or write. */
  const failed = chapters.filter((chapter) => !chapter.ok).length;
  return {
    ok: failed === 0,
    wrote,
    failed,
    chapters,
  };
}

/**
 * Formats a new chapter JSONC document (id, title, from/to, changedFiles).
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   fromDir: string,
 *   toDir: string,
 *   changedFiles?: { path: string, kind: "U" | "M" | "D" }[],
 * }} chapter
 */
export function formatNewChapterJsonc(chapter) {
  return formatJsonc({
    id: chapter.id,
    title: chapter.title,
    fromDir: chapter.fromDir,
    toDir: chapter.toDir,
    changedFiles: chapter.changedFiles ?? [],
  });
}

/**
 * Turns a thrown value into a one-line message for the run report.
 *
 * @param {unknown} error
 */
export function formatError(error) {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return String(error);
}

/**
 * Rejects a non-empty snapshot path that is missing or not a directory.
 *
 * @param {string} root - Source root
 * @param {string} relative - Snapshot path relative to `root` (empty = empty tree)
 */
export async function ensureSnapshotDir(root, relative) {
  if (relative === "") {
    return;
  }
  const abs = path.join(root, relative);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`snapshot not found: ${relative}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`snapshot is not a directory: ${relative}`);
  }
}

/**
 * Fills `changedFiles` on each chapter; records `error` and continues on failure.
 *
 * @param {string} root - Source root
 * @param {Array<{
 *   id: string,
 *   title: string,
 *   fromDir: string,
 *   toDir: string,
 *   changedFiles?: { path: string, kind: "U" | "M" | "D" }[],
 *   error?: string,
 * }>} chapters
 * @param {number} [maxDepth]
 * @param {(
 *   root: string,
 *   fromDir: string,
 *   toDir: string,
 *   maxDepth?: number,
 * ) => Promise<{ path: string, kind: "U" | "M" | "D" }[]>} [compare]
 */
export async function fillChangedFiles(
  root,
  chapters,
  maxDepth = DEFAULT_MAX_DEPTH,
  compare = changedFilesBetween,
) {
  for (const chapter of chapters) {
    try {
      await ensureSnapshotDir(root, chapter.fromDir);
      await ensureSnapshotDir(root, chapter.toDir);
      chapter.changedFiles = await compare(root, chapter.fromDir, chapter.toDir, maxDepth);
      delete chapter.error;
    } catch (error) {
      chapter.error = formatError(error);
      delete chapter.changedFiles;
    }
  }
  return chapters;
}

/**
 * Collects failed chapter (or fatal) records for `detect-chapter-dirs.result.json`.
 *
 * @param {{
 *   reason?: string,
 *   chapters?: Array<{
 *     ok: boolean,
 *     id: string,
 *     fromDir: string,
 *     toDir: string,
 *     error?: string,
 *   }>,
 * }} report
 * @returns {Array<{ id?: string, fromDir?: string, toDir?: string, error: string }>}
 */
export function failedResultsFromReport(report) {
  /** @type {Array<{ id?: string, fromDir?: string, toDir?: string, error: string }>} */
  const failed = [];
  for (const chapter of report.chapters ?? []) {
    if (chapter.ok) {
      continue;
    }
    failed.push({
      id: chapter.id,
      fromDir: chapter.fromDir,
      toDir: chapter.toDir,
      error: chapter.error ?? "unknown error",
    });
  }
  if (failed.length === 0 && typeof report.reason === "string") {
    failed.push({ error: report.reason });
  }
  return failed;
}

/**
 * Formats failed-only JSON for the result file (pretty-printed array).
 *
 * @param {{
 *   reason?: string,
 *   chapters?: Array<{
 *     ok: boolean,
 *     id: string,
 *     fromDir: string,
 *     toDir: string,
 *     error?: string,
 *   }>,
 * }} report
 */
export function formatFailedResults(report) {
  return `${JSON.stringify(failedResultsFromReport(report), null, 2)}\n`;
}

/**
 * Writes `detect-chapter-dirs.result.json` when there are failures; removes it on success.
 *
 * @param {string} configDir - Course config directory (`--out`)
 * @param {object} report - Run summary
 * @returns {Promise<string | undefined>} Result file path, or undefined when nothing failed
 */
export async function writeRunReport(configDir, report) {
  const filePath = path.join(configDir, RESULT_FILE_NAME);
  const failed = failedResultsFromReport(report);
  if (failed.length === 0) {
    await rm(filePath, { force: true });
    return undefined;
  }
  await mkdir(configDir, { recursive: true });
  await writeFile(filePath, formatFailedResults(report), "utf8");
  return filePath;
}

/**
 * Writes or updates numbered chapter JSONC files under `configDir/chapters`.
 *
 * Existing files keep extra keys (`docs`, `entryFiles`, …); only `changedFiles`
 * is replaced. New files get id/title/fromDir/toDir/changedFiles. A chapter
 * with `error` is skipped. A write failure is recorded; later chapters still run.
 *
 * @param {string} configDir - Course config directory (contains `chapters/`)
 * @param {Array<{
 *   id: string,
 *   title: string,
 *   fromDir: string,
 *   toDir: string,
 *   changedFiles?: { path: string, kind: "U" | "M" | "D" }[],
 *   error?: string,
 * }>} chapters
 * @returns {Promise<Array<{
 *   ok: boolean,
 *   id: string,
 *   fromDir: string,
 *   toDir: string,
 *   file?: string,
 *   changes?: number,
 *   error?: string,
 * }>>}
 */
export async function writeChapterConfigs(configDir, chapters) {
  const chaptersDir = path.join(configDir, "chapters");
  /** @type {Array<{
   *   ok: boolean,
   *   id: string,
   *   fromDir: string,
   *   toDir: string,
   *   file?: string,
   *   changes?: number,
   *   error?: string,
   * }>} */
  const results = [];
  try {
    await mkdir(chaptersDir, { recursive: true });
  } catch (error) {
    const message = formatError(error);
    for (const chapter of chapters) {
      results.push({
        ok: false,
        id: chapter.id,
        fromDir: chapter.fromDir,
        toDir: chapter.toDir,
        error: message,
      });
    }
    return results;
  }
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    if (chapter === undefined) {
      continue;
    }
    if (chapter.error !== undefined) {
      results.push({
        ok: false,
        id: chapter.id,
        fromDir: chapter.fromDir,
        toDir: chapter.toDir,
        error: chapter.error,
      });
      continue;
    }
    const ordinal = String(i + 1).padStart(3, "0");
    const fileName = `${ordinal}-${chapter.id}.jsonc`;
    const filePath = path.join(chaptersDir, fileName);
    try {
      let existing;
      try {
        existing = await readFile(filePath, "utf8");
      } catch {
        existing = undefined;
      }
      const files = chapter.changedFiles ?? [];
      const next =
        existing === undefined
          ? formatNewChapterJsonc(chapter)
          : upsertChangedFilesJsonc(existing, files);
      await writeFile(filePath, next, "utf8");
      results.push({
        ok: true,
        id: chapter.id,
        fromDir: chapter.fromDir,
        toDir: chapter.toDir,
        file: fileName,
        changes: files.length,
      });
    } catch (error) {
      results.push({
        ok: false,
        id: chapter.id,
        fromDir: chapter.fromDir,
        toDir: chapter.toDir,
        error: formatError(error),
      });
    }
  }
  return results;
}

/**
 * Classifies U/M/D file differences between two snapshot directories under `root`.
 *
 * @param {string} root - Source root
 * @param {string} fromDir - Start snapshot (empty string = empty tree)
 * @param {string} toDir - Goal snapshot (empty string = empty tree)
 * @param {number} [maxDepth] - Inclusive subdirectory limit (default {@link DEFAULT_MAX_DEPTH})
 */
export async function changedFilesBetween(root, fromDir, toDir, maxDepth = DEFAULT_MAX_DEPTH) {
  const fromAbs = fromDir === "" ? "" : path.join(root, fromDir);
  const toAbs = toDir === "" ? "" : path.join(root, toDir);
  const fromFiles = fromDir === "" ? [] : await listFiles(fromAbs, "", 0, maxDepth);
  const toFiles = toDir === "" ? [] : await listFiles(toAbs, "", 0, maxDepth);
  const fromSet = new Set(fromFiles);
  const toSet = new Set(toFiles);
  const all = [...new Set([...fromFiles, ...toFiles])].sort();
  /** @type {{ path: string, kind: "U" | "M" | "D" }[]} */
  const files = [];
  for (const relative of all) {
    const inFrom = fromSet.has(relative);
    const inTo = toSet.has(relative);
    if (!inFrom && inTo) {
      files.push({ path: relative, kind: "U" });
      continue;
    }
    if (inFrom && !inTo) {
      files.push({ path: relative, kind: "D" });
      continue;
    }
    let leftText;
    let rightText;
    try {
      leftText = await readFile(path.join(fromAbs, ...relative.split("/")), "utf8");
    } catch {
      leftText = undefined;
    }
    try {
      rightText = await readFile(path.join(toAbs, ...relative.split("/")), "utf8");
    } catch {
      rightText = undefined;
    }
    if (leftText !== rightText) {
      files.push({ path: relative, kind: "M" });
    }
  }
  return files;
}

/**
 * Detects ordered snapshots and per-chapter U/M/D lists under a source root.
 *
 * @param {string} root - Source tree
 * @param {string[] | undefined} forcedDirs - Explicit snapshot dirs; omit to run heuristics
 * @param {number} [maxDepth] - Inclusive subdirectory limit (default {@link DEFAULT_MAX_DEPTH})
 * @returns {Promise<
 *   | { ok: true; root: string; snapshots: string[]; chapters: object[]; courseId: string }
 *   | { ok: false; root: string; reason: string }
 * >}
 */
export async function detectCourse(root, forcedDirs, maxDepth = DEFAULT_MAX_DEPTH) {
  /** @type {string[]} */
  let snapshots;
  if (forcedDirs !== undefined && forcedDirs.length >= 2) {
    snapshots = forcedDirs;
  } else if (forcedDirs !== undefined) {
    return {
      ok: false,
      root,
      reason: "need at least two snapshot directories (from → to pairs)",
    };
  } else {
    const detected = await detectGroup(root, maxDepth);
    if (detected === undefined) {
      return {
        ok: false,
        root,
        reason:
          "no chapter-like sibling directories found; write chapter JSONC with fromDir/toDir instead",
      };
    }
    snapshots = detected.snapshots;
  }

  const chapters = buildChapters(snapshots);
  if (chapters.length === 0) {
    return { ok: false, root, reason: "could not build chapters from snapshots" };
  }

  await fillChangedFiles(root, chapters, maxDepth);

  return {
    ok: true,
    root,
    snapshots,
    chapters,
    courseId:
      path
        .basename(root)
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .toLowerCase() || "course",
  };
}

/**
 * Prints a one-line CLI result and sets a non-zero exit code on failure.
 *
 * @param {object} summary
 * @param {boolean} ok
 */
function printSummary(summary, ok) {
  console.log(JSON.stringify(summary));
  if (!ok) {
    process.exitCode = 1;
  }
}

/**
 * Writes the failure result file when needed, then prints `{ok,wrote,failed,result?}`.
 *
 * @param {string} outDir
 * @param {object} report
 */
async function finishRun(outDir, report) {
  const wrote = report.wrote ?? 0;
  const failed = report.failed ?? 0;
  const ok = report.ok === true;
  let resultPath;
  try {
    resultPath = await writeRunReport(outDir, report);
  } catch (error) {
    printSummary(
      {
        ok: false,
        wrote,
        failed,
        reason: formatError(error),
      },
      false,
    );
    return;
  }
  printSummary(
    {
      ok,
      wrote,
      failed,
      ...(resultPath === undefined ? {} : { result: resultPath }),
    },
    ok,
  );
}

/**
 * Parses CLI args, writes chapter JSONC by default, or prints JSON with `--json`.
 */
async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let maxDepth = DEFAULT_MAX_DEPTH;
  let outDir = path.resolve(process.cwd(), ".course-config");
  let printJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      printJson = true;
      continue;
    }
    if (arg === "--dirs" || arg.startsWith("--dirs=")) {
      printSummary(
        {
          ok: false,
          wrote: 0,
          failed: 0,
          reason: "--dirs was removed; write chapter JSONC with fromDir/toDir, then rerun",
        },
        false,
      );
      return;
    }
    /** @type {string | undefined} */
    let depthRaw;
    if (arg.startsWith("--depth=")) {
      depthRaw = arg.slice("--depth=".length);
    } else if (arg === "--depth") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        printSummary(
          {
            ok: false,
            wrote: 0,
            failed: 0,
            reason: "invalid --depth (need a non-negative integer)",
          },
          false,
        );
        return;
      }
      depthRaw = next;
      i += 1;
    }
    if (depthRaw !== undefined) {
      const parsed = parseMaxDepth(depthRaw);
      if (parsed === undefined) {
        printSummary(
          {
            ok: false,
            wrote: 0,
            failed: 0,
            reason: "invalid --depth (need a non-negative integer)",
          },
          false,
        );
        return;
      }
      maxDepth = parsed;
      continue;
    }
    /** @type {string | undefined} */
    let outRaw;
    if (arg.startsWith("--out=")) {
      outRaw = arg.slice("--out=".length);
    } else if (arg === "--out") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        printSummary(
          { ok: false, wrote: 0, failed: 0, reason: "invalid --out (need a directory)" },
          false,
        );
        return;
      }
      outRaw = next;
      i += 1;
    }
    if (outRaw !== undefined) {
      outDir = path.resolve(outRaw);
      continue;
    }
    if (arg && !arg.startsWith("-")) {
      root = path.resolve(arg);
    }
  }

  try {
    if (!(await stat(root)).isDirectory()) {
      await finishRun(outDir, {
        ok: false,
        root,
        configDir: outDir,
        wrote: 0,
        failed: 0,
        reason: "root is not a directory",
        chapters: [],
      });
      return;
    }
  } catch {
    await finishRun(outDir, {
      ok: false,
      root,
      configDir: outDir,
      wrote: 0,
      failed: 0,
      reason: "root not found",
      chapters: [],
    });
    return;
  }

  let result;
  try {
    result = await fillExistingChapterConfigs(root, outDir, maxDepth, { write: !printJson });
  } catch (error) {
    await finishRun(outDir, {
      ok: false,
      root,
      configDir: outDir,
      wrote: 0,
      failed: 0,
      reason: formatError(error),
      chapters: [],
    });
    return;
  }
  if (printJson) {
    console.log(JSON.stringify(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  await finishRun(outDir, {
    ok: result.ok,
    root,
    configDir: outDir,
    wrote: result.wrote,
    failed: result.failed,
    reason: result.reason,
    chapters: result.chapters,
  });
}

/**
 * Returns whether this file is the Node CLI entry (not imported by tests).
 */
function isMainModule() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    printSummary({ ok: false, wrote: 0, failed: 0, reason: formatError(error) }, false);
  }
}
