# LCP field reference (for generators)

## `course.yml`

No field is required in the YAML file.

| Field               | Default                                                                           | Notes                                                        |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `id`                | Parent dir of `.course-config`; `{repoName}-learn` when that parent is a git root | Also used as the default learning folder name                |
| `title`             | same as `id`                                                                      | Display name                                                 |
| `source.repository` | `.` (course home)                                                                 | Git URL or path; relative paths resolve from the course home |
| `source.root`       | _(none)_                                                                          | Prefix joined in front of every chapter `fromDir` / `toDir`  |
| `chaptersDir`       | `chapters` (next to `course.yml`)                                                 | Nested paths allowed; no `..` or absolutes                   |

There is no `protocolVersion` or `workspace` block yet — the protocol only adds optional fields over time.

## `chapters/*.yml`

No field is required in the YAML file.

| Field        | Default                                                     | Notes                                                                       |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`         | filename without numeric prefix (`001-hello.yml` → `hello`) | Unique within the course                                                    |
| `title`      | same as `id`                                                | Display name                                                                |
| `fromDir`    | `""` (empty tree)                                           | Start snapshot under source (or `source.root`)                              |
| `toDir`      | `""` (empty tree)                                           | Goal snapshot; empty = no implementation target                             |
| `entryFiles` | auto (all files under `toDir`)                              | Optional explicit list relative to the chapter tree root                    |
| `docs`       | _(none)_                                                    | `http(s)` URL or relative file under chapter snapshot (`toDir` / `fromDir`) |

Load order = chapter **file name** sort order. There is no `tests` field yet.

## Schema

JSON Schema: `packages/protocol/schema.json` (`$defs/course`, `$defs/chapter`).

Wire each YAML file with a relative path comment (do not rely on workspace `yaml.schemas`):

```yaml
# yaml-language-server: $schema=../../../packages/protocol/schema.json#/$defs/course
```

Adjust `../` depth to reach the schema from that file.
