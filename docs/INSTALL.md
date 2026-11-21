# 安装与启动

DSH Robots 通过插件挂到 DeepSeek Harness Web 的侧边栏。安装器保存独立的 CLI 和插件快照，机器人目录使用独立的 `DSH_HOME`。首轮基线是 `0.2.2-rc.3`。相邻版本验证和升级步骤见 [升级与回退](UPGRADE.md)。

在项目根目录执行。当前仓库的锁文件随源码交付，建议使用 Node.js 24 或更新版本和 package.json 中声明的 pnpm 版本。

```bash
pnpm install --frozen-lockfile
pnpm build
node scripts/install-isolated.mjs --home ~/.dsh-robots --workspace /absolute/path/to/repository --dry-run
node scripts/install-isolated.mjs --home ~/.dsh-robots --workspace /absolute/path/to/repository
node scripts/launch-isolated.mjs --home ~/.dsh-robots
```

`--workspace` 绑定机器人可读取的项目绝对路径，默认是本仓库。首次安装要求目标目录为空，安装器拒绝日常的 `~/.dsh` 和指向它的链接。启动器在回环地址绑定可用端口，在终端输出带本次登录令牌的本机网址。需要固定端口时传 `--port 38080`。在浏览器打开该地址，侧边栏点击 **机器人**。

真实模型任务使用当前进程继承的 provider 凭据，请通过本机已有的安全方式设置 `DEEPSEEK_API_KEY`。插件安装与无模型的目录及启动检查不需要密钥。安装器只打包本项目的插件构建文件和所选 CLI，凭据由用户自己的环境提供。

## 日常操作

- 新建机器人或打开 AI 辅助创建，选择该机器人的项目子目录。检查草稿的职责、资源、流程和模型后，在机器人详情里确认激活版本。
- 用 **新会话** 从机器人发起任务，或者在已有主 Agent 中用 `robot_catalog` 与 `robot_invoke`。主 Agent 可以用 `robot_task_status` 查询状态和产物名，再用 `robot_task_result` 读取产物。
- 机器人详情显示运行状态、产物入口与候选经验。任务完成后可以提交误报、漏报或纠正。确认经验前先核对来源与差异。
- **导出副本** 只包含勾选的声明式资源及必要配置。接收方导入后检查草稿，重新选择适合自己的工作区和模型。
- **托管共享** 用限时邀请授予指定机器人的调用权限。邀请令牌仅创建时显示一次。邀请可让调用者发起任务并读取自己的产物。创建邀请前请核对机器人可读取的项目目录和资源。当前服务监听本机回环地址，跨机器调用需另行配置部署和认证。

## 暂停与恢复

在启动终端按 Ctrl+C 关闭。以 `--without-robots` 重启即可使用同一环境的普通 Harness 会话。机器人管理、共享和浏览器模块一起停用，已保存的机器人资料可在正常重启后继续使用。用原命令重启即可恢复。

```bash
node scripts/launch-isolated.mjs --home ~/.dsh-robots --without-robots
```

如启动失败，先检查端口、工作区目录和终端错误。如果错误指出 `robots/writer.lock`，核实锁里的 PID、原启动终端和进程列表。仅在确认该进程已退出后将残留锁移到单独的诊断备份，再重启。
