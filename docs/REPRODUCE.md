# 安装与复现

只想了解功能可以先看 [README 中的审核例子](../README.md#一个代码审核例子)。第一次安装请从 [隔离 Web 快速开始](../README.md#开始使用) 进入。已有插件可直接导入配置。使用 macOS 原生桌面的同事可按下方步骤安装。

## 导入并运行审核机器人

1. 在已装好插件的环境打开「机器人 → 导入机器人」，复制 [审核机器人第 1 版 JSON](../examples/reviewer-v1.dsh-robot.json) 的内容并导入。
2. 为副本选择本机的项目目录并检查草稿。运行仓库自带例子时，选择本仓库作为工作区。用于其他仓库时，先调整职责、项目知识和证据要求。
3. 检查模型路由，默认是 `deepseek-official/deepseek-flash`。配置本机可用的模型后发布。
4. 点「新会话」，复制 [README 的试用提示](../README.md#一个代码审核例子)。任务结束后进入运行记录查看来源清单、证据台账和审核报告。

导入得到一台独立机器人。副本保存一份项目知识、一份审核 Skill 和三个流程步骤。机器人后续发布的版本、任务记录和复盘候选由各自环境维护。

## 安装到 macOS 桌面

下面的方式在官方 **macOS 桌面 `0.2.2-rc.5`** 验证。需要 Node.js 24 或更新版本及仓库声明的 pnpm。准备好源码后，从仓库根目录执行构建及打包。

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p artifacts/release
pnpm --filter @fanbo/dsh-robot pack --pack-destination "$PWD/artifacts/release"
pnpm --filter @fanbo/dsh-ui-robot pack --pack-destination "$PWD/artifacts/release"
```

完全退出桌面。备份 `~/.dsh/profiles/desktop` 的包清单、锁文件和补丁，并用应用内置 CLI 安装两份本地包。

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  "$PWD/artifacts/release/fanbo-dsh-robot-0.1.0.tgz" \
  "$PWD/artifacts/release/fanbo-dsh-ui-robot-0.1.0.tgz"
```

将 [桌面补丁示例](desktop-patch.example.yml) 中的顶层条目合入 `desktop/cordis.patch.yml` 现有列表，替换路径和实际宿主版本。项目根目录应当是机器人可访问的资料范围。数据目录用于保存版本、历史运行和复盘候选。启动桌面后点侧栏「机器人」，再按 [导入步骤](#导入并运行审核机器人) 操作。

如需停用，退出桌面，恢复原补丁，用内置 CLI 移除这两个插件后重启。把机器人业务目录作为独立数据保留。Web 环境的设置、升级和回退见 [INSTALL.md](INSTALL.md) 与 [UPGRADE.md](UPGRADE.md)。

## 已验证范围

| 场景 | 实际验证 |
| --- | --- |
| 官方 Web `rc.2` / `rc.3` | 18 项宿主集成检查，包含项目隔离、委派、分享、资料迁移及重启。使用本地脚本模型。 |
| 官方 Web `rc.3` | 真实 DeepSeek 模型执行草稿创建、项目审核、自动复盘及批准副本后的复跑。 |
| 官方 macOS 桌面 `rc.5` | 独立安装、插件激活、卸载回退和受控任务。日常桌面核对入口、普通会话、第 1 版启动和迁入产物。 |
| 托管调用 | 本机回环双身份测试。跨机器接入需要另行部署与验证。 |

未来版本先在独立环境检查插件能否加载、机器人和普通会话能否继续使用，再考虑升级日常安装。
