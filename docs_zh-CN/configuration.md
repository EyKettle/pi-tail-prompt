# 配置

[English](../docs/configuration.md) | 中文

- [扩展接口](api.md)
- [架构](architecture.md)

## `tail-prompt.yaml`

| 键 | 值 |
| --- | --- |
| `role` | 注入角色的声明，见下 |
| `imports` | 名称 → 提示词文件 |
| `applyment` | 主会话的提示词清单，按此顺序装配 |
| `profiles.subagent.applyment` | 子会话的提示词清单 |

> `profiles` 下暂时只认 `subagent` 一个资料名。

文件位于 agent 目录，即 `{agentDir}/tail-prompt.yaml`（通常为 `~/.pi/agent/tail-prompt.yaml`）。
文件不存在则不注入，也不通知；文件存在却装配不出块时，整个块不注入，并经 Pi 的通知告知一次。

示例文件内容：

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

| 值 | 效果 |
| --- | --- |
| `system` | 默认 |
| `user` | 提示词以用户角色的轮次落位，模型不支持会话中段 system 时也能留在尾部 |

## `imports`

> [!warning]
> 提示词清单中引用的条目必须在此注册，存在缺漏则整块不注入。

```yaml
imports:
  name: path/to/file
  # ...
```

名称需满足 `[A-Za-z0-9_-]+`，建议使用 `kebab-case`。

相对路径以 agent 目录为根，绝对路径按原样使用。

## 清单与会话类别

| 会话 | 清单 | 缺省行为 |
| --- | --- | --- |
| 主会话 | `applyment` | 清单为空 → 不注入 |
| 子会话 | `profiles.subagent.applyment` | 无 `profiles.subagent` 段 → 不注入 |

会话类别的判据是环境变量 `PI_SUBAGENT_CHILD`：非空即子会话。

## 缓存说明

改动被引用的提示词文件后无需重启，下一个请求即生效。
