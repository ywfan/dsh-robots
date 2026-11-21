# DSH Robots

在 DeepSeek Harness 的侧栏中创建和管理预先准备的机器人。每个机器人绑定自己的项目目录、模型、知识、Skill 和工作流。发布后可在新会话中选择，也可由主 Agent 调用。运行固定一个已发布版本，任务结果和复盘候选保存在独立目录。用户确认候选后，后续任务才能使用新版。

- [设计与验收](docs/DESIGN.md)
- [安装与复现](docs/REPRODUCE.md)
- [隔离 Web 安装](docs/INSTALL.md)
- [升级、停用和回退](docs/UPGRADE.md)
- [可导入的审核机器人第 1 版](examples/reviewer-v1.dsh-robot.json)
- [可编辑的审核机器人示例](examples/reviewer.spec.json)

首轮以官方 DSH `0.2.2-rc.3` 为基线。管理插件也通过了官方 `0.2.2-rc.2` 的隔离宿主检查。业务数据与宿主版本独立，升级前可在副本中重跑同一套检查。真实模型试点使用 `deepseek-official/deepseek-flash`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
node scripts/check-domain-boundary.mjs
node scripts/check-service-runtime.mjs
```

此仓库以首轮实现提交 4465681 为基础，包括共享所需源码、测试、锁文件和可移植配置。导入后的机器人由接收者选择项目目录和模型。
