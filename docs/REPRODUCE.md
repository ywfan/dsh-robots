# 部署与复现

先读 [设计与验收](DESIGN.md)，再按需要安装插件或只导入机器人配置。

## 想在 DSH 中用这个机器人

机器人副本位于 [examples/reviewer-v1.dsh-robot.json](../examples/reviewer-v1.dsh-robot.json)。已安装本功能的环境可以从「机器人 → 导入机器人」粘贴该文件中的 JSON，检查草稿并为本机选择项目工作区，然后确认发布。草稿的模型配置是 `deepseek-official/deepseek-flash`，需要在本机配置相应模型。需要兼容其他模型时先编辑草稿，再验证实际表现。

副本是当前正式第 1 版的声明式内容。导入产生独立机器人。配置包含一份项目知识、一份审核 Skill 和三个受控步骤。若用它审核另一个仓库，先把职责、项目知识和适用证据规则改成新仓库的内容。

## 想运行插件

优先用隔离 Web 环境复现。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
node scripts/check-domain-boundary.mjs
node scripts/install-isolated.mjs --home ~/.dsh-robots --workspace /absolute/path/to/repository --dry-run
node scripts/install-isolated.mjs --home ~/.dsh-robots --workspace /absolute/path/to/repository
node scripts/launch-isolated.mjs --home ~/.dsh-robots
```

将 `/absolute/path/to/repository` 换成本机项目路径。首次安装使用空的独立目录并查看 dry-run。源码附运行时锁文件，构建需要相容的 Node.js 和 `package.json` 声明的 pnpm。静态阅读和本地测试不需要模型凭据。真正调用模型时由本机自行配置，项目资料的访问范围由机器人绑定的工作区决定。

原生 macOS 桌面已在官方 `0.2.2-rc.5` 验证。先完全退出桌面并备份 `~/.dsh/profiles/desktop` 中的包清单、锁文件和补丁，从仓库根目录构建并打包，再使用应用内置的 CLI 安装这两份本地包：

```sh
pnpm build
mkdir -p artifacts/release
pnpm --filter @fanbo/dsh-robot pack --pack-destination "$PWD/artifacts/release"
pnpm --filter @fanbo/dsh-ui-robot pack --pack-destination "$PWD/artifacts/release"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  "$PWD/artifacts/release/fanbo-dsh-robot-0.1.0.tgz" \
  "$PWD/artifacts/release/fanbo-dsh-ui-robot-0.1.0.tgz"
```

随后编辑该 profile 的 `cordis.patch.yml`，将 [desktop-patch.example.yml](desktop-patch.example.yml) 中的一个顶层列表项合入现有列表，并换成本机的业务数据目录、项目根目录和实际宿主版本。启动后应出现「机器人」侧栏。恢复时退出桌面、恢复原补丁，用内置 CLI 移除这两个插件并重启，机器人业务目录可独立保存。这个过程使用普通插件加载机制。

## 已验证范围

| 环境 | 验证凭据 |
| --- | --- |
| 官方 Web `rc.2` / `rc.3` | 18 项宿主集成检查，包括目录隔离、主 Agent 委派、分享调用、复制数据、重启、停用和委派服务降级。测试模型在进程内运行。 |
| 官方 Web `rc.3` | 使用真实 DeepSeek 模型做过创建草稿、审核、自动复盘及在隔离副本批准后的复跑。 |
| 官方 macOS 桌面 `rc.5` | 隔离安装、受控 fixture、客户端模块注册回读、卸载回退。日常桌面实测侧栏、普通会话、启动第 1 版及查看迁入的报告与候选。 |
| 共享调用 | 已验证本机回环的双身份权限。跨机器部署仍是独立工作。 |

查看项目内源码附带的 [INSTALL.md](INSTALL.md) 与 [UPGRADE.md](UPGRADE.md) 获取完整命令。对新的宿主版本，应先在独立环境重跑适配和会话检查。
