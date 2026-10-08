# 扩展接口

[English](../docs/api.md) | 中文

- [配置](configuration.md)
- [架构](architecture.md)

其他扩展以「段」的形式，向每个请求的 system 内容贡献文本。

## 接入

经 `pi.events` 发出 `tail-prompt:register`，载荷为一个段。
装载时推送一次，并订阅 `tail-prompt:ready`、收到时再推一次——
这样两者谁先装载，注册都能生效。同 id 即同一段，重推无害。

## 段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | 非空字符串 | 你的标识。更新即再次注册同一 id，三件一起替换。 |
| `position` | 整数 | 位置，见下。 |
| `source` | `{ kind: "path", path }` 或 `{ kind: "text", text }` | 内容来源，见下。 |

## 位置

按 `position` 降序排列，同级按 `id` 升序，各段文本以空行连接。

| `position` | 相对用户消息 |
| --- | --- |
| 负值 | 比 `0` 更近 |
| `0` | 最近处由 tail-prompt 自己的提示词占用 |
| 越大 | 越远 |

`0` 不排他：贡献方沿用 `0` 只会与 tail-prompt 自己的段并列，次序由同级 `id` 升序决定。
贡献段默认 `1`。

## 来源

| `kind` | 内容 | 谁保持最新 |
| --- | --- | --- |
| `path` | 绝对路径 | tail-prompt，每个请求重读 |
| `text` | 值即内容 | 你，内容变化时重新注册 |

`path` 读取后去掉首尾空白；`text` 原样使用。

## 校验与失败

下列任一不满足，该注册被丢弃并报一次（不影响其他段与请求）：

- `id` 非空字符串，且不为 `tail-prompt`（tail-prompt 自用）
- `position` 整数
- `source.kind` 恰为 `"path"` 或 `"text"` 之一
- `path` 为绝对路径

某段本次取不到内容、或内容为空时，只该段缺失，其余段照常交付。
