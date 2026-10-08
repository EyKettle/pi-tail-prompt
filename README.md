# tail-prompt extension

[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white)](https://conventionalcommits.org) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

English | [中文](README.zh-CN.md)

> [!note]
> AI-generated artifacts. May include low-quality code.

A [Pi](https://github.com/earendil-works/pi) extension that delivers a
configured prompt to every request.

## Features

- A prompt that is always injected at the tail
- Compatibility with protocols that do not support mid-conversation
  system messages
- Compatibility with subagents (`npm:pi-subagents`)
- Extension interface support

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Extension API](docs/api.md)

## Installation

Clone into Pi's user extension path (e.g. `~/.pi/agent/extensions`).

```bash
git clone https://github.com/EyKettle/pi-tail-prompt.git \
  ~/.pi/agent/extensions/tail-prompt
cd ~/.pi/agent/extensions/tail-prompt
pnpm install
```

Pi automatically loads `index.ts` under `~/.pi/agent/extensions/` as a
user extension.
Restart Pi after installing.

Developed against Pi 1.0.4.

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
```

`private: true` is intentional. The extension is not ready for
publication.
