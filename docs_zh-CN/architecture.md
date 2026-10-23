# 架构

[English](../docs/architecture.md) | 中文

- [配置](configuration.md)
- [扩展接口](api.md)

## 分支

按模型协议的兼容性走不同分支。

| 分支 | 条件 | 机制 |
| --- | --- | --- |
| `tail` | 协议支持中段系统提示词 / `role` 为 `user` | `before_provider_request`：把块插入最终载荷，紧贴最新一条用户消息 |
| `merge` | 协议不支持中段系统提示词且 `role` 为 `system` | `before_agent_start`：通过 `systemPromptOptions.appendSystemPrompt` 追加到顶部系统提示词 |

> `merge` 分支不碰载荷，遵循 Pi 官方系统提示词修改途径。

`role` 指 `roleRules` 解析后的最终角色。

### tail 的落位

| 载荷形状 | 落位 |
| --- | --- |
| `messages` 数组 | 最新用户消息之前 |
| `input` 数组 | 最新用户消息之前 |
| Anthropic Messages | 最新用户消息之前 (`role: "user"`) / 最新用户轮次之后 (`role: "system"`) |

> Anthropic 分支在 `role` 不同时表现不同。

尾插放不进去时（形状识别不出、载荷缺失），块并入载荷的顶部 system 内容：依次探测 `system`、`systemInstruction`、`messages[0]`、`input[0]`。
四处都没有时经上报通道说明本次请求无法承载。

### 系统消息身份

匹配 OpenAI 系列协议且模型支持推理时，支持 `developer` 身份的请求会使用 `developer` 身份替代 `system` 身份。

中段 `system` 块采用 Pi 在同一次请求中赋予 system 消息的身份。
声明缺失时读取头领消息的身份；Codex Responses 请求（`instructions`）默认使用 `developer`。
其他协议使用 `system`。

## 装配

每个请求装配一次；块由段装配。

插件自身的配置提示词占 `position: 0`，其余段由扩展注册，契约见[扩展接口](api.md)。
段按 `position` 降序、同级按 `id` 升序排列，各段文本以空行连接。

| 情形 | 结果 |
| --- | --- |
| 无任何段有文本 | 不注入 |
| 某段本次取不到内容 | 只该段缺失 |
| 配置、清单、路径、提示词文件任一缺失 | 不注入，并上报 |

## 失败与上报

配置存在但装配不出块时，起因取自关闭集合：

- 解析失败
- 本会话清单为空
- 清单名称未映射
- 提示词不可读

起因经 Pi 的 UI 通知上报，同一原因只报一次；无 UI 时上报不发生。
配置文件不存在不算失败，不上报。

无效的 `roleRules` 条目不构成失败：该条目被跳过并警告，其余条目与块照常生效。
警告指明该条目在 `roleRules` 中的顺序位置。

## 缓存

配置读取按配置文件的 `mtime:size`；块按「配置文件的 stamp 与全部提示词文件的 stamp 拼接」为键复用。

失败不都按同一个键记：配置级失败（解析、清单）记在配置键下并短路，提示词级失败记在含提示词 stamp 的键下——所以补上缺失的提示词文件之后，下一个请求就重新读取并交付。

## 模块

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 装配：注册钩子与总线监听，选择分支，上报失败与警告 |
| `failure.ts` | 关闭的失败起因集合及其用户文案 |
| `segments.ts` | 段注册表与注册校验 |
| `source.ts` | 段来源物化：读绝对路径，或取文本值 |
| `payload.ts` | 尾插的三种载荷形状落位，与顶部 system 内容的兜底 |
| `config.ts` | `tail-prompt.yaml` 子集解析 |
| `config-file.ts` | 配置文件读取与 stamp 缓存 |
| `session.ts` | 会话类别与其清单选择 |
| `prompts.ts` | 提示词路径解析与读取 |

## 不变量

- 块不成为对话消息：`tail` 分支把它保持在请求载荷中，`merge` 分支把它承载在 Pi 维护的系统提示词区段里。
- 两个分支互斥，每请求恰放置一次。
- 装配的任何一环缺失都使整个块不注入。
- 单个段取不到内容时，其余段照常交付。
- 配置存在而无块时，必定上报，且同一原因只报一次。
