# tail-prompt 插件

[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white)](https://conventionalcommits.org) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | 中文

> [!note]
> AI 生成产物，可能包含低质量代码。

一个把配置好的提示词送达每个请求的 [Pi](https://github.com/earendil-works/pi) 拓展插件。

## 功能

- 一段始终保持在末尾的提示词注入
- 兼容不支持中段系统消息的协议
- 兼容子代理功能 (`npm:pi-subagents`)
- 扩展接口支持

## 文档

- [架构](docs_zh-CN/architecture.md)
- [配置](docs_zh-CN/configuration.md)
- [扩展接口](docs_zh-CN/api.md)

## 安装

克隆到 Pi 的用户扩展路径 (如 `~/.pi/agent/extensions`)。

```bash
git clone https://github.com/EyKettle/pi-tail-prompt.git ~/.pi/agent/extensions/tail-prompt
cd ~/.pi/agent/extensions/tail-prompt
pnpm install
```

Pi 会自动加载 `~/.pi/agent/extensions/` 下的 `index.ts` 作为用户插件。
安装后重启 Pi 即可。

开发基线为 Pi 1.0.4。

## 开发

```bash
pnpm install
pnpm test
pnpm run typecheck
```

`private: true` 是有意为之。该插件尚未做好发布准备。
