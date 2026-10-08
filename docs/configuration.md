# Configuration

English | [中文](../docs_zh-CN/configuration.md)

- [Extension API](api.md)
- [Architecture](architecture.md)

## `tail-prompt.yaml`

| Key | Value |
| --- | --- |
| `role` | the injected role, see below |
| `imports` | name → prompt file |
| `applyment` | the main session's prompt list |
| `profiles.subagent.applyment` | the subagent session's list |

> Only `subagent` is recognized under `profiles` for now.

The file lives in the agent directory,
`{agentDir}/tail-prompt.yaml` (usually `~/.pi/agent/tail-prompt.yaml`).
A missing file injects nothing and reports nothing.
A file that exists but yields no block injects nothing, and Pi reports
it once.

Example file contents:

```yaml
role: system
imports:
  contract: system-prompts/working-contract.txt
  decompose: system-prompts/decompose-thinking.txt
applyment:
  - decompose
  - contract
profiles:
  subagent:
    applyment:
      - decompose
```

## `role`

| Value | Effect |
| --- | --- |
| `system` | default |
| `user` | the prompt takes a user-role turn |

A `user` prompt can stay at the tail even on a model that takes no
mid-conversation system message.

## `imports`

> [!warning]
> Every entry the prompt list references must be registered here; a gap
> keeps the whole block out.

```yaml
imports:
  name: path/to/file
  # ...
```

A name matches `[A-Za-z0-9_-]+`; `kebab-case` is recommended.

A relative path is rooted at the agent directory; an absolute path is
used as it is.

## List and session class

| Session | List | When absent |
| --- | --- | --- |
| main | `applyment` | an empty list → nothing |
| subagent | `profiles.subagent.applyment` | no section → nothing |

The session class is decided by the `PI_SUBAGENT_CHILD` environment
variable: non-empty means a subagent session.

## Cache notes

A change to a referenced prompt file needs no restart; it takes effect
on the next request.
