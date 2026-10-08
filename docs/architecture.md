# Architecture

English | [中文](../docs_zh-CN/architecture.md)

- [Configuration](configuration.md)
- [Extension API](api.md)

## Branch

The branch follows the model protocol's compatibility. *Protocol
support* means the model declares that it takes a mid-conversation
system message.

| Branch | Condition |
| --- | --- |
| `tail` | protocol support, or `role: "user"` |
| `merge` | no support, and `role: "system"` |

`tail` runs at `before_provider_request`: it inserts the block into the
final payload, adjacent to the latest user message. `merge` runs at
`context_with_system`: it appends the block to the top system prompt.

The `merge` branch does not touch the payload; it follows Pi's official
system-prompt modification route.

### Tail placement

| Payload shape | Placement |
| --- | --- |
| `messages` array | before the latest user message |
| `input` array | before the latest user message |
| Anthropic Messages | by `role`, see below |

On the Anthropic Messages shape the anchor follows `role`: a `user`
block goes before the latest user message, a `system` block after the
latest user turn.

When the tail placement does not fit — an unrecognized shape, a missing
payload — the block is merged into the payload's top system content.
The fields are probed in order: `system`, `systemInstruction`,
`messages[0]`, `input[0]`. When none of the four exists, the reporting
channel states that this request cannot carry the block.

## Assembly

The block is assembled once per request, from segments.

The extension's own configured prompts take `position: 0`; the other
segments are registered by extensions, per the contract in [Extension API](api.md).
Segments are ordered by `position` descending, then by `id` ascending,
and their texts are joined by a blank line.

| Situation | Result |
| --- | --- |
| No segment has text | nothing is injected |
| A segment has no content | only that segment is missing |
| Configuration or prompt file missing | nothing is injected, reported |

## Failure and reporting

When the configuration exists but no block can be assembled, the cause
comes from a closed set:

- a parse failure
- an empty list for this session
- a list name with no mapping
- an unreadable prompt

The cause is reported through Pi's UI notification, once per cause;
with no UI the report does not happen.
A missing configuration file is not a failure and is not reported.

## Cache

Configuration reading is keyed by the configuration file's `mtime:size`;
the block is reused under the key formed by joining the configuration
file's stamp with every prompt file's stamp.

Failures are not all remembered under one key: configuration-level
failures — a parse failure, an empty list — are remembered under the
configuration key and short-circuit. Prompt-level failures are remembered
under a key that includes the prompt stamps, so after the missing prompt
file is supplied, the next request reads again and delivers.

## Modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | assembly: hooks, bus listener, branch, reporting |
| `failure.ts` | the closed failure set and its wording |
| `segments.ts` | the segment registry and validation |
| `source.ts` | segment source materialization |
| `payload.ts` | tail placement and the top system fallback |
| `config.ts` | `tail-prompt.yaml` subset parsing |
| `config-file.ts` | configuration reading and stamp cache |
| `session.ts` | the session class and its list |
| `prompts.ts` | prompt path resolution and reading |

## Invariants

- The block exists only for that request and is not written into the
  session record.
- The two branches are mutually exclusive: exactly one placement per
  request.
- A missing link anywhere in assembly keeps the whole block out.
- When one segment has no content, the others are still delivered.
- When the configuration exists and yields no block, it is always
  reported, once per cause.
