#!/usr/bin/env node
/**
 * Heuristically finds chapter snapshot directories in a source tree.
 *
 * Usage:
 *   node detect-chapter-dirs.mjs [rootDir]
 *   node detect-chapter-dirs.mjs --dirs a,b,c [rootDir]
 *
 * Prints JSON: { ok, root, snapshots[], chapters[], reason? }
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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

/**
 * Scores a directory name as a likely chapter snapshot.
 *
 * @param {string} name
 */
function scoreName(name) {
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
 * @param {string} root
 * @param {string} prefix
 * @param {number} depth
 */
async function listFiles(root, prefix = "", depth = 0) {
  if (depth > 4) {
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
      files.push(...(await listFiles(root, relative, depth + 1)));
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
function similarity(left, right) {
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
function isStartName(name) {
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
 */
async function orderSnapshots(root, parentRel, names) {
  const trees = new Map();
  for (const name of names) {
    trees.set(name, await listFiles(path.join(root, parentRel, name)));
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
 */
async function scoreGroup(root, parentRel, names) {
  const named = names.filter((name) => scoreName(name) > 0);
  if (named.length < 2) {
    return 0;
  }
  let score = named.reduce((sum, name) => sum + scoreName(name), 0);
  score += Math.min(named.length, 8) * 6;

  const ordered = await orderSnapshots(root, parentRel, named);
  /** @type {string[][]} */
  const trees = [];
  for (const name of ordered.slice(0, 5)) {
    trees.push(await listFiles(path.join(root, parentRel, name)));
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
 */
async function detectGroup(root) {
  /** @type {{ parent: string, names: string[], score: number }[]} */
  const candidates = [];

  for (const parent of await candidateParents(root)) {
    const abs = parent === "" ? root : path.join(root, ...parent.split("/"));
    const names = await childDirs(abs);
    const score = await scoreGroup(root, parent, names);
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
  const ordered = await orderSnapshots(root, best.parent, named.length >= 2 ? named : best.names);
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
function buildChapters(snapshots) {
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
 * CLI entry.
 */
async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  /** @type {string[] | undefined} */
  let forcedDirs;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dirs" && args[i + 1]) {
      forcedDirs = args[i + 1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg && !arg.startsWith("-")) {
      root = path.resolve(arg);
    }
  }

  try {
    if (!(await stat(root)).isDirectory()) {
      console.log(JSON.stringify({ ok: false, reason: "root is not a directory", root }));
      process.exitCode = 1;
      return;
    }
  } catch {
    console.log(JSON.stringify({ ok: false, reason: "root not found", root }));
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  let snapshots;
  if (forcedDirs !== undefined && forcedDirs.length >= 2) {
    snapshots = forcedDirs;
  } else if (forcedDirs !== undefined) {
    console.log(
      JSON.stringify({
        ok: false,
        root,
        reason: "need at least two snapshot directories (from → to pairs)",
      }),
    );
    process.exitCode = 1;
    return;
  } else {
    const detected = await detectGroup(root);
    if (detected === undefined) {
      console.log(
        JSON.stringify({
          ok: false,
          root,
          reason:
            "no chapter-like sibling directories found; pass --dirs start,hello,world or choose a source root",
        }),
      );
      process.exitCode = 1;
      return;
    }
    snapshots = detected.snapshots;
  }

  const chapters = buildChapters(snapshots);
  if (chapters.length === 0) {
    console.log(
      JSON.stringify({ ok: false, root, reason: "could not build chapters from snapshots" }),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify({
      ok: true,
      root,
      snapshots,
      chapters,
      courseId:
        path
          .basename(root)
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .toLowerCase() || "course",
    }),
  );
}

await main();
