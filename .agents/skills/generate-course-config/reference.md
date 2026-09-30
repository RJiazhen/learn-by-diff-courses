# LCP field reference (for generators)

## `course.jsonc`

No field is required in the JSONC file.

| Field               | Default                                                                           | Notes                                                       |
| ------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `id`                | Parent dir of `.course-config`; `{repoName}-learn` when that parent is a git root | Also used as the default learning folder name               |
| `title`             | same as `id`                                                                      | Display name                                                |
| `source.repository` | `.` (directory that contains `course.jsonc`)                                      | Git URL or path; relative paths resolve from that directory |
| `source.root`       | _(none)_                                                                          | Prefix joined in front of every chapter `fromDir` / `toDir` |
| `chaptersDir`       | `chapters` (next to `course.jsonc`)                                               | Nested paths allowed; no `..` or absolutes                  |

There is no `protocolVersion` or `workspace` block yet — the protocol only adds optional fields over time.

## `chapters/*.jsonc`

No field is required in the JSONC file.

| Field          | Default                                                       | Notes                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | filename without numeric prefix (`001-hello.jsonc` → `hello`) | Unique within the course                                                                                                                                                                  |
| `title`        | same as `id`                                                  | Display name                                                                                                                                                                              |
| `fromDir`      | `""` (empty tree)                                             | Start snapshot under source (or `source.root`)                                                                                                                                            |
| `toDir`        | `""` (empty tree)                                             | Goal snapshot; empty = no implementation target                                                                                                                                           |
| `entryFiles`   | auto (all files under `toDir`)                                | Optional explicit list relative to the chapter tree root                                                                                                                                  |
| `changedFiles` | classify from/to at runtime; `[]` means unchanged             | Optional path + `U`/`M`/`D`; write basic chapter JSONC first, then `detect-chapter-dirs.mjs --out` fills this. Failures go to `detect-chapter-dirs.result.json` (delete after the skill). |
| `docs`         | _(none)_                                                      | `http(s)` URL or relative file under chapter snapshot (`toDir` / `fromDir`)                                                                                                               |

Load order = chapter **file name** sort order. There is no `tests` field yet.

## Schema

JSON Schema: `https://raw.githubusercontent.com/RJiazhen/learn-by-diff/refs/heads/main/packages/protocol/schema.json` (`$defs/course`, `$defs/chapter`).

Set `$schema` on each JSONC file:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/RJiazhen/learn-by-diff/refs/heads/main/packages/protocol/schema.json#/$defs/course",
}
```

Use `#/$defs/chapter` on chapter files.
