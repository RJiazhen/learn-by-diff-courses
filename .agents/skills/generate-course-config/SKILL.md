---
name: generate-course-config
description: >-
  Generates Learning Course Protocol (.course-config) YAML from a source tree of
  chapter snapshot directories. Use when creating course.yml / chapters/*.yml,
  scaffolding a LearnByDiff course, or when the user asks to generate LCP config
  from existing start/hello/step folders.
---

# Generate course config

Creates `.course-config/course.yml` and `.course-config/chapters/*.yml` for LearnByDiff.

## Inputs (optional)

User may pass any of:

| Input               | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Source root         | Directory that contains snapshot folders (default: current workspace / git root)                        |
| Snapshot dirs       | Explicit ordered list, e.g. `start,hello,world` or `intro/start,intro/hello`                            |
| Course output       | Where to write `.course-config` (default: cwd, or ask if cwd is clearly the source-only tree)           |
| `source.repository` | Git URL or relative path written into `course.yml` (default: `.` or relative path from course → source) |

## Workflow

Copy and track:

```
- [ ] Resolve source root + snapshot dirs (user args or detect)
- [ ] Confirm chapter sequence with the user when detection is ambiguous
- [ ] Write course.yml + chapters/*.yml
- [ ] Reminder: validate with protocol package / schema.json
```

### 1. Resolve snapshots

**If the user listed directories** (comma-separated or bullets): use that order as snapshot sequence. Need ≥ 2 dirs.

**If not specified**, detect chapter-like snapshot folders under the source root:

1. **Prefer the agent’s built-in project tools** whenever the runtime provides them (e.g. Cursor `Glob` / directory listing / `Shell` `ls`, or equivalent file-tree APIs). Use them to:
   - List immediate children and one nested level (e.g. `examples/*/`, `tutorials/*/`)
   - Spot sibling dirs named like chapters: `start`, `baseline`, `init`, `step-N`, `chapter-N`, `001-*`, short lesson tokens (`hello`, `world`, …)
   - Skip noise: `node_modules`, `.git`, `apps`, `packages`, `src`, `dist`, …
   - Order candidates: `start`-like first; then prefer growing tree size / content; confirm with the user if several orders look equally plausible
2. **Fallback only** if those tools are unavailable or you need a packaged heuristic: run the detector script from this skill directory:

```bash
node skills/generate-course-config/scripts/detect-chapter-dirs.mjs [sourceRoot]
# or after install, from the skill folder:
node scripts/detect-chapter-dirs.mjs [sourceRoot]
```

Forced dirs (script or user args):

```bash
node scripts/detect-chapter-dirs.mjs --dirs start,hello,world [sourceRoot]
```

Script JSON stdout (when used):

- `ok: true` → use `snapshots` / `chapters` / `courseId`
- `ok: false` → treat like a failed built-in detection

**If detection fails** (built-in or script): **stop**. Do not invent directories. Ask the user for concrete snapshot dirs (and optional source root).

Nested parents like `tutorials/*` or `examples/demo-source/*` are valid; chapters need not share one parent.

### 2. Map snapshots → chapters

For ordered snapshots `D0, D1, … Dn` create **n** chapters:

- Chapter `k`: `fromDir: Dk-1`, `toDir: Dk` (omit either for an empty snapshot)
- Prefer detector / exploration results for `id`, `title`, optional `entryFiles`
- Omit `entryFiles` unless you need a subset; runtime auto-discovers all files under `toDir`
- Do **not** write a `tests` field (not in the protocol yet)

Chapters need **not** share one parent; nested paths are valid (`advanced/start`).

### 3. Write files

Layout:

```text
.course-config/
  course.yml
  chapters/
    001-<id>.yml
    002-<id>.yml
    …
```

`course.yml` template (all fields optional; omit what defaults cover):

```yaml
# yaml-language-server: $schema=<relative-path-to>/packages/protocol/schema.json#/$defs/course
# id / title default from the `.course-config` parent folder (or `{repo}-learn` at a git root)
source:
  repository: <url-or-relative-path> # default: .
  # root: <optional prefix under repository>
# chaptersDir: chapters   # optional; default is `chapters` next to this file
```

Only set `source.repository` when it is not the course home (`.`). Do not emit `protocolVersion` or `workspace`.

Minimal chapter file (defaults fill the rest):

```yaml
# yaml-language-server: $schema=<relative-path-to>/packages/protocol/schema.json#/$defs/chapter
fromDir: <fromDir>
toDir: <toDir>
```

Or with explicit fields:

```yaml
# yaml-language-server: $schema=<relative-path-to>/packages/protocol/schema.json#/$defs/chapter
id: <id>
title: <title>
fromDir: <fromDir>
toDir: <toDir>
# entryFiles:   # optional; omit to auto-discover
#   - src/index.ts
# docs: README.md   # optional http(s) URL or path under toDir/fromDir
```

Number chapter filenames `001-`, `002-`, … (sort order = course order). Empty `fromDir` / `toDir` are allowed (empty trees).

Do **not** overwrite existing `.course-config` without asking.

### 4. Done

Summarize generated chapters (`fromDir` → `toDir`). Then give the author a way to **try the course immediately**:

1. Print the **absolute path** of `course.yml` (for example `.course-config/course.yml`). They can paste it into **Open Course**.
2. Print clickable local deep links (URL-encode the same absolute file path, or a `file:` URL, as `url=`):

```text
vscode://RuanJiazhen.learn-by-diff/open?url=<urlencoded-absolute-course.yml>
cursor://RuanJiazhen.learn-by-diff/open?url=<urlencoded-absolute-course.yml>
```

Also point authors at:

- Schema: `packages/protocol/schema.json` (or repo README)
- Demo pair: `examples/demo-course` + `examples/demo-source`

## Hard rules

- Prefer built-in project/directory tools over `scripts/detect-chapter-dirs.mjs` when the agent runtime provides them.
- Never fabricate snapshot directories when detection fails — ask the user.
- One `source.repository` only (no per-chapter remotes).
- `fromDir` / `toDir` must be repo-relative (no `..`, no absolute paths).
- Keep generated YAML compatible with `schema.json` (additive optional fields only).

## Reference

- Field meanings: [reference.md](reference.md)
