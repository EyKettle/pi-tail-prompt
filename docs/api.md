# Extension API

English | [中文](../docs_zh-CN/api.md)

- [Configuration](configuration.md)
- [Architecture](architecture.md)

Other extensions contribute text to every request's system content as "segments".

## Registration

Emit `tail-prompt:register` on `pi.events` with one segment as the payload.
Push once at load, then subscribe to `tail-prompt:ready` and push again on
receipt — so registration takes effect whichever side loads first. The same
id is the same segment; pushing again is harmless.

## Segment

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | non-empty string | your identifier |
| `position` | integer | the position, see below |
| `source` | `path` or `text` | the content source, see below |

A `path` source carries `{ kind: "path", path }`; a `text` source carries
`{ kind: "text", text }`. Registering the same `id` again replaces all three
fields together.

## Position

Ordered by `position` descending, then by `id` ascending; the segments'
texts are joined by a blank line.

| `position` | Relative to the user message |
| --- | --- |
| negative | closer than `0` |
| `0` | the nearest slot, taken by tail-prompt's own prompts |
| larger | farther away |

`0` is not exclusive: a contributor that also uses `0` merely sits
alongside tail-prompt's own segment, ordered by `id` ascending within
the level. A contribution defaults to `1`.

## Source

| `kind` | Content | Who keeps it current |
| --- | --- | --- |
| `path` | an absolute path | tail-prompt, every request |
| `text` | the value is the content | you, on change |

A `path` is trimmed after reading; a `text` is used as it is.

## Validation and failure

When any of the following does not hold, that registration is dropped
and reported once, without affecting the other segments or the request:

- `id` is a non-empty string, and is not `tail-prompt` (reserved)
- `position` is an integer
- `source.kind` is exactly `"path"` or `"text"`
- `path` is absolute

When a segment has no content this time, or its content is empty, only
that segment is missing; the rest are still delivered.
