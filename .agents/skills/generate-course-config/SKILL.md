---
name: generate-course-config
description: >-
  Generates Learning Course Protocol (.course-config) JSONC from a source tree of
  chapter snapshot directories. Use when creating course.jsonc / chapters/*.jsonc,
  scaffolding a LearnByDiff course, or when the user asks to generate LCP config
  from existing start/hello/step folders.
---

# Generate course config

Creates `.course-config/course.jsonc` and `.course-config/chapters/*.jsonc` for LearnByDiff.

## Inputs (optional)

User may pass any of:

| Input               | Meaning                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source root         | Directory that contains snapshot folders (default: current workspace / git root)                                                                                |
| Snapshot dirs       | Chapter `fromDir` / `toDir` pairs. Need **not** be consecutive (e.g. `start` → `hello`, then `start` → `world`).                                                |
| File walk depth     | `--depth N` for `detect-chapter-dirs.mjs` (default 6). Raise for deep snapshot trees.                                                                           |
| Course output       | `--out DIR` for the detector (default `./.course-config`). Also where you write `course.jsonc` and basic `chapters/*.jsonc`.                                    |
| `source.repository` | Git URL or relative path written into `course.jsonc` (default: omit / `.` = directory that contains `course.jsonc`; relative paths resolve from that directory) |

## Workflow

Copy and track:

```
- [ ] Resolve source root + chapter fromDir/toDir (user args or exploration)
- [ ] Confirm pairs with the user when ambiguous (need not be consecutive snapshots)
- [ ] Write course.jsonc + basic chapters/*.jsonc (fromDir/toDir; no changedFiles yet)
- [ ] Run detector to fill changedFiles
- [ ] If stdout `ok` is false, read `detect-chapter-dirs.result.json` (failures only)
- [ ] Delete `detect-chapter-dirs.result.json` if it exists
- [ ] Reminder: validate with protocol package / schema.json
```

### 1. Write basic chapter JSONC, then fill `changedFiles`

You invent the chapter sequence. Snapshots are **not** required to be end-to-end (`start` → `hello` then `hello` → `world`). A later chapter may jump back to an earlier snapshot.

Write `.course-config/chapters/001-<id>.jsonc` (and the rest) with at least `fromDir` / `toDir`. Then run this skill’s `scripts/detect-chapter-dirs.mjs` so it **upserts `changedFiles` only**. Do not paste U/M/D lists into the chat.

If there is **no runtime** for that file (no Node, skill folder missing the script, sandbox cannot execute it), **implement the same script yourself** in the workspace (same flags, fill `changedFiles` on existing JSONC, result file, continue-on-chapter-error).

From this monorepo:

```bash
node skills/generate-course-config/scripts/detect-chapter-dirs.mjs --out /path/to/.course-config [sourceRoot]
```

After install (cwd = skill folder):

```bash
node scripts/detect-chapter-dirs.mjs --out /path/to/.course-config [sourceRoot]
```

Default `--out` is `./.course-config` under cwd. Existing chapter files keep extra keys (`docs`, `title`, …); only `changedFiles` is replaced. A failure analyzing or writing **one chapter does not stop the rest**. There is no `--dirs` flag.

```bash
node scripts/detect-chapter-dirs.mjs --out .course-config --depth 8 [sourceRoot]
```

| Flag        | Meaning                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--out DIR` | Course config directory (`DIR/chapters/*.jsonc` must already exist). On failure also writes `DIR/detect-chapter-dirs.result.json`. Default: `./.course-config`. `--out=DIR` is also accepted.             |
| `--depth N` | Subdirectory levels to enter under each snapshot (default **6**; files at that depth still count). Raise it for deep trees (e.g. `examples/playground/src/components/...`). `--depth=N` is also accepted. |
| `--json`    | Print the full fill result to stdout **instead of** writing JSONC / the result file. Do not use this in agent chats (large).                                                                              |
| positional  | Source root (default: cwd)                                                                                                                                                                                |

Stdout is a **short** execution result only: `{ ok, wrote, failed }` plus `result` (absolute path) **when something failed**.

#### `detect-chapter-dirs.result.json` (failures only)

Written **only when the run had errors**. It is a JSON **array of failures** — no successful chapters, no U/M/D lists. Read the whole file; do not grep.

Chapter failure:

```json
[
  {
    "id": "broken",
    "fromDir": "skeleton",
    "toDir": "missing",
    "error": "snapshot not found: missing"
  }
]
```

Fatal (no snapshots / bad root) — one object with `error` only:

```json
[{ "error": "no chapter JSONC in chapters/; write basic chapter files (fromDir/toDir) first" }]
```

- `stdout.ok === true` → no result file. Continue.
- `stdout.ok === false` → Read `stdout.result`. Keep JSONC that was written. Ask the user only about those failed `id`s (or the fatal `error`). Do not invent snapshot dirs.

**Always delete** this file when the skill finishes. Do not commit it.

Nested snapshot paths (`tutorials/hello`, `book/impls/start`) are valid. Chapters need not share one parent.

### 2. Map snapshots → chapters

Each chapter is its own `fromDir` → `toDir` pair (omit either for an empty snapshot). Consecutive snapshots are allowed but **not required**.

- Prefer exploration / the user for `id`, `title`, optional `entryFiles`
- **Always fill `changedFiles`** via the detector script (`path` + `U` / `M` / `D`, or `[]`). Do not recompute diffs in the chat.
- Omit `entryFiles` unless you need a subset; runtime auto-discovers all files under `toDir`
- Do **not** write a `tests` field (not in the protocol yet)

### 3. Write files

Layout (you write `course.jsonc` and basic `chapters/*.jsonc`; the detector fills `changedFiles`):

```text
.course-config/
  course.jsonc
  chapters/
    001-<id>.jsonc
    002-<id>.jsonc
    …
```

`course.jsonc` template (all fields optional; omit what defaults cover):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/RJiazhen/learn-by-diff/refs/heads/main/packages/protocol/schema.json#/$defs/course",
  // id / title default from the `.course-config` parent folder (or `{repo}-learn` at a git root)
  "source": {
    "repository": "<url-or-relative-path>", // omit or `.` = directory that contains this file
    // "root": "<optional prefix under repository>"
  },
  // "chaptersDir": "chapters" // optional; default is `chapters` next to this file
}
```

`source.repository` is a git URL, a local path, or omitted. Relative local paths resolve from the directory that contains `course.jsonc` (for this skill: `.course-config/`). Do not glue a subdirectory onto a git URL — use `source.root` instead.

When `.course-config` sits **inside** the source tree, write `repository: ..` (parent of the config dir). When course output and source are different directories, write the posix relative path from `.course-config` to the source root (e.g. `../../demo-source`). Omit `source.repository` only when snapshots live in the same directory as `course.jsonc`. Do not emit `protocolVersion` or `workspace`.

Minimal chapter file (defaults fill the rest):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/RJiazhen/learn-by-diff/refs/heads/main/packages/protocol/schema.json#/$defs/chapter",
  "fromDir": "<fromDir>",
  "toDir": "<toDir>",
}
```

Or with explicit fields:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/RJiazhen/learn-by-diff/refs/heads/main/packages/protocol/schema.json#/$defs/chapter",
  "id": "<id>",
  "title": "<title>",
  "fromDir": "<fromDir>",
  "toDir": "<toDir>",
  "changedFiles": [{ "path": "src/index.ts", "kind": "M" }],
  // "entryFiles": ["src/index.ts"], // optional; omit to auto-discover
  // "docs": "README.md" // optional http(s) URL or path under toDir/fromDir
}
```

Always include `changedFiles` after the detector runs (the script writes `[]` when the chapter did not change). Number chapter filenames `001-`, `002-`, … (sort order = course order). Empty `fromDir` / `toDir` are allowed (empty trees).

Ask before replacing an existing `course.jsonc`. The detector only upserts `changedFiles` on existing chapter files.

### 4. Done

Summarize generated chapters (`fromDir` → `toDir`). Then give the author a way to **try the course immediately**:

1. Print the **absolute path** of `course.jsonc` (for example `.course-config/course.jsonc`). They can paste it into **Open Course**.
2. Print clickable local deep links (URL-encode the same absolute file path, or a `file:` URL, as `url=`):

```text
vscode://RuanJiazhen.learn-by-diff/open?url=<urlencoded-absolute-course.jsonc>
cursor://RuanJiazhen.learn-by-diff/open?url=<urlencoded-absolute-course.jsonc>
```

Also point authors at:

- Schema: `packages/protocol/schema.json` (or repo README)
- Demo pair: `examples/demo-course` + `examples/demo-source`

## Hard rules

- Write basic `chapters/*.jsonc` (`fromDir` / `toDir`) first, then run `scripts/detect-chapter-dirs.mjs --out` to fill `changedFiles`. Stdout is `{ok,wrote,failed}` plus `result` only on failure. If there is no runtime for the script, implement that same filler locally, then run it. Never dump U/M/D JSON into the chat.
- Do not pass `--dirs`. Chapter snapshots need not be consecutive.
- If stdout `ok` is false, Read `detect-chapter-dirs.result.json` (failures only — no grep). One chapter failure is not a reason to drop the others.
- Delete `detect-chapter-dirs.result.json` when the skill finishes. Do not commit it.
- Raise `--depth` when snapshots nest deeper than the default of 6.
- Never fabricate snapshot directories when detection fails — ask the user.
- One `source.repository` only (no per-chapter remotes).
- `fromDir` / `toDir` must be repo-relative (no `..`, no absolute paths).
- Keep generated JSONC compatible with `schema.json` (additive optional fields only).

## Reference

- Field meanings: [reference.md](reference.md)
