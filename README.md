# DSH Robots

**把一个仓库的知识、Skill 和工作流程做成随叫随用的机器人。**

DSH Robots 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件。在 Web 或 macOS 桌面端的「机器人」页面准备好配置，发布后就能在新会话中选择它，主 Agent 也能委派任务给它。每次任务使用固定版本，输出可核对的产物。任务复盘提出改进，人工确认后才进入新版。

## 从哪里开始

| 你想做什么 | 先看这里 |
| --- | --- |
| 1 分钟理解用途 | [看下面的代码审核例子](#一个代码审核例子) |
| 在自己的机器试用 | [从隔离 Web 开始](#开始使用)，或读 [macOS 桌面安装](docs/REPRODUCE.md#安装到-macos-桌面) |
| 已装好插件，只想拿机器人配置 | [导入审核机器人第 1 版](docs/REPRODUCE.md#导入并运行审核机器人) |
| 了解实现、证据和取舍 | [设计与验收](docs/DESIGN.md) |
| 验证兼容性或准备升级 | [验收范围](docs/REPRODUCE.md#已验证范围) · [升级与回退](docs/UPGRADE.md) |

## 一个代码审核例子

假设团队想为自己的 TypeScript 仓库保留一套审核方法。你可以把项目背景、常见问题和审核要求整理为机器人，给它绑定本机的仓库目录。以后只需指定本次要审核的文件。

> 请只读审核 `examples/review-fixtures/temp-cleanup.ts`。比较 `writeA` 和 `writeB` 在写入失败时是否清理临时文件，给出行号和证据。

[这个示例](examples/review-fixtures/temp-cleanup.ts)包含一对正反例。按给定前提，`writeA` 的写入失败发生在 `try` 外，可能遗留临时文件。`writeB` 的写入失败会进入 `finally`，执行清理。

审核机器人按「来源清单 → 证据台账 → 审核报告」完成任务。未完成所需检查就不能推进，流程未覆盖的情形会停下来提问。结论仍需要人按证据核对，复盘候选也需要人确认。仓库提供 [可导入的第 1 版配置](examples/reviewer-v1.dsh-robot.json) 和 [可编辑示例](examples/reviewer.spec.json)。

## 开始使用

**推荐先用隔离 Web。** 准备 Node.js 24 或更新版本，以及 `package.json` 声明的 pnpm 11.7.0。安装器会在独立目录配置 Harness 和插件。下面使用本仓库作为练习项目，默认测试目录 `~/.dsh-robots` 应为空或尚未创建。

```sh
git clone https://github.com/ywfan/dsh-robots.git
cd dsh-robots
pnpm install --frozen-lockfile
pnpm build
node scripts/install-isolated.mjs --workspace "$PWD"
node scripts/launch-isolated.mjs
```

1. 打开终端打印的本机网址，进入侧栏「机器人」。
2. 导入 [审核机器人 JSON](examples/reviewer-v1.dsh-robot.json)，检查并发布草稿。
3. 从机器人详情打开「新会话」，粘贴上面的示例任务。完成后可在运行记录中查看三项产物。

安装、浏览页面和运行本地测试无需模型凭据。**执行示例任务需要可用的模型**。默认配置为 `deepseek-official/deepseek-flash`，可在发布前修改。已有独立安装或需要换项目路径时，请看 [安装说明](docs/INSTALL.md)。

## 当前范围

- **使用方式**包括自己在新会话选择机器人，或由主 Agent 委派。跨同事共享时，可导出可编辑副本。托管调用当前验证到本机回环。
- **已验证宿主**为官方 Web `0.2.2-rc.2`、`0.2.2-rc.3` 和官方 macOS 桌面 `0.2.2-rc.5`。真实模型试点在 Web `rc.3` 完成，更多证据见 [验收表](docs/REPRODUCE.md#已验证范围)。
- **首版聚焦单个机器人**的创建、执行、复盘与分享。监听 PR 自动接单、多机器人调度、跨机器托管和生产发布执行器目前属于后续范围。

## 源码和验证

| 位置 | 负责什么 |
| --- | --- |
| [`packages/robot/src/domain/`](packages/robot/src/domain/) | 配置、发布版本、工作流状态、候选经验和导入导出 |
| [`packages/robot/src/host/`](packages/robot/src/host/) · [`adapters/dsh/`](packages/robot/src/adapters/dsh/) | 接入 Harness 会话、模型、项目访问、受控工具及共享 |
| [`packages/ui-robot/src/client/`](packages/ui-robot/src/client/) | 桌面和 Web 的机器人页、配置、会话入口和产物查看 |
| [`scripts/`](scripts/) · [`tests/`](tests/) | 构建、安装、迁移和宿主集成验证 |

安装依赖并构建后，可执行 `pnpm typecheck` 和 `pnpm test`。如需在两个 Web 版本上复验插件行为，运行 `node scripts/check-service-runtime.mjs`。 [设计与验收细节](docs/DESIGN.md)
