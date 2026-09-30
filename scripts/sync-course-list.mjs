#!/usr/bin/env node
/**
 * Discovers Learn by Diff course homes (directories that contain
 * `course.jsonc`) and appends any missing entries to `courses.jsonc`.
 *
 * Usage:
 *   node scripts/sync-course-list.mjs [repoRoot]
 *
 * Exits 0 when the catalog is already complete or after writing updates.
 * Prints added course paths to stderr.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIST_FILE_NAME = "courses.jsonc";
const COURSE_FILE_NAME = "course.jsonc";
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".agents",
  ".githooks",
  ".learn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "scripts",
]);

const LIST_HEADER = `/**
 * Catalog of Learn by Diff courses in this repository.
 * Pre-commit appends any course directory (containing course.jsonc) that is missing.
 */
`;

/**
 * Strips `//` and `/* * /` comments from JSONC so `JSON.parse` can read it.
 *
 * @param {string} text
 */
function stripJsonc(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Parses a JSONC document into a value.
 *
 * @param {string} text
 * @param {string} label
 */
function parseJsonc(text, label) {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${label}: ${message}`);
  }
}

/**
 * True when `name` should not be walked for course homes.
 *
 * @param {string} name
 */
function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name) || name.startsWith(".");
}

/**
 * Normalizes a catalog path to the course home directory (posix).
 *
 * @param {unknown} value
 */
function normalizeCoursePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "";
  }
  const posix = value.split(/[\\/]/).filter(Boolean).join("/");
  return posix.replace(/\/course\.jsonc$/i, "");
}

/**
 * Recursively finds directories that contain `course.jsonc`.
 *
 * @param {string} absRoot
 * @param {string} rel
 */
async function findCourseHomes(absRoot, rel = "") {
  const absDir = rel === "" ? absRoot : path.join(absRoot, ...rel.split("/"));
  /** @type {string[]} */
  const homes = [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return homes;
  }

  const hasCourseFile = entries.some(
    (entry) => entry.isFile() && entry.name === COURSE_FILE_NAME,
  );
  if (hasCourseFile && rel !== "") {
    homes.push(rel);
    return homes;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) {
      continue;
    }
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    homes.push(...(await findCourseHomes(absRoot, childRel)));
  }
  return homes;
}

/**
 * Reads id and title from a course.jsonc, falling back to the directory name.
 *
 * @param {string} absCourseDir
 * @param {string} relPath
 */
async function readCourseEntry(absCourseDir, relPath) {
  const fallbackId = path.posix.basename(relPath);
  try {
    const text = await readFile(path.join(absCourseDir, COURSE_FILE_NAME), "utf8");
    const data = parseJsonc(text, `${relPath}/${COURSE_FILE_NAME}`);
    const id =
      typeof data?.id === "string" && data.id.trim() !== "" ? data.id.trim() : fallbackId;
    const title =
      typeof data?.title === "string" && data.title.trim() !== ""
        ? data.title.trim()
        : id;
    return { id, title, path: relPath };
  } catch {
    return { id: fallbackId, title: fallbackId, path: relPath };
  }
}

/**
 * Loads the existing catalog array from `courses.jsonc`, or `[]` if missing.
 *
 * @param {string} listPath
 */
async function loadListedCourses(listPath) {
  let text;
  try {
    text = await readFile(listPath, "utf8");
  } catch {
    return [];
  }
  const data = parseJsonc(text, LIST_FILE_NAME);
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object" && Array.isArray(data.courses)) {
    return data.courses;
  }
  throw new Error(`${LIST_FILE_NAME} must be an object with a courses array`);
}

/**
 * Writes the catalog JSONC file.
 *
 * @param {string} listPath
 * @param {unknown[]} courses
 */
async function writeCourseList(listPath, courses) {
  await mkdir(path.dirname(listPath), { recursive: true });
  const body = `${LIST_HEADER}${JSON.stringify({ courses }, null, 2)}\n`;
  await writeFile(listPath, body, "utf8");
}

/**
 * Syncs `courses.jsonc` with course homes found under `repoRoot`.
 *
 * @param {string} repoRoot
 * @returns {Promise<string[]>} newly appended course paths
 */
async function syncCourseList(repoRoot) {
  const listPath = path.join(repoRoot, LIST_FILE_NAME);
  const listed = await loadListedCourses(listPath);
  const listedPaths = new Set(
    listed.map((item) =>
      normalizeCoursePath(
        item && typeof item === "object" && "path" in item ? item.path : item,
      ),
    ),
  );

  const homes = (await findCourseHomes(repoRoot)).sort((left, right) =>
    left.localeCompare(right),
  );
  /** @type {string[]} */
  const added = [];
  const next = [...listed];

  for (const relPath of homes) {
    if (listedPaths.has(relPath)) {
      continue;
    }
    const entry = await readCourseEntry(path.join(repoRoot, ...relPath.split("/")), relPath);
    next.push(entry);
    listedPaths.add(relPath);
    added.push(relPath);
  }

  if (listed.length === 0 && next.length > 0) {
    await writeCourseList(listPath, next);
    return added;
  }
  if (added.length > 0) {
    await writeCourseList(listPath, next);
  }
  return added;
}

/**
 * CLI entry: sync the catalog and report added courses.
 */
async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const defaultRoot = path.resolve(here, "..");
  const repoRoot = path.resolve(process.argv[2] ?? defaultRoot);
  const added = await syncCourseList(repoRoot);
  if (added.length === 0) {
    return;
  }
  for (const relPath of added) {
    console.error(`sync-course-list: added ${relPath}`);
  }
}

await main();
