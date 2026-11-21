# 升级与回退

机器人版本由用户确认后形成，宿主版本由独立安装器管理。换宿主前先在隔离目录验证。当前的验证范围以专题中的适配行为报告和安装运行报告为准。

- `0.2.2-rc.3` 是默认发布基线。
- `0.2.2-rc.2` 是相邻兼容候选，由相同的真实宿主检查验证。模型使用结果以真实试点报告为准。
- 其他确切版本可用 `--experimental` 安装到空的隔离目录做兼容实验。测试通过后更新兼容矩阵及安装器接受范围，再考虑切换现有安装。

## 先用副本验证

先在原启动终端停止 Host，确认 `robots/writer.lock` 已释放，再在源码项目根目录执行：

```bash
node scripts/migrate-data.mjs ~/.dsh-robots/robots
node scripts/migrate-data.mjs ~/.dsh-robots/robots /absolute/path/to/fresh-copy
node scripts/check-dsh-compat.mjs 0.2.2-rc.3
node scripts/check-dsh-compat.mjs 0.2.2-rc.2
```

迁移工具验证当前 schema 1 并逐文件核对复制前后的 SHA-256。新目录必须预先不存在，父目录应存在。验证覆盖机器人 ID、草稿、版本内容及资源哈希、运行关联、产物、已落盘的批准输入、复盘记录和分享邀请。遇到未知格式、损坏数据或进行中的写入，命令会失败并报告具体原因。副本保留原始记录字节，用于同一安装的备份与恢复。

## 切换安装版本

构建拟安装版本并检查本次目标宿主与插件是否兼容。停止 Host 后执行：

```bash
pnpm install --frozen-lockfile
pnpm build
node scripts/install-isolated.mjs --home ~/.dsh-robots --version 0.2.2-rc.3 --workspace /absolute/path/to/repository --stopped --dry-run
node scripts/install-isolated.mjs --home ~/.dsh-robots --version 0.2.2-rc.3 --workspace /absolute/path/to/repository --stopped
node scripts/launch-isolated.mjs --home ~/.dsh-robots
```

升级输出包含用于恢复的 `backup` 路径。CLI 安装和插件快照各自保存在 `robot-toolchains` 与 `robot-releases`。启动后依次检查旧机器人和已确认版本、待确认经验、普通空白会话，以及新任务使用的版本与模型。只读查看目录可以先确认加载，真实任务适合单独运行。

## 恢复已知可用的版本

停止 Host 后，将从升级输出中保存的路径传给 `--restore`：

```bash
node scripts/install-isolated.mjs --home ~/.dsh-robots --restore /absolute/path/to/backup --stopped --dry-run
node scripts/install-isolated.mjs --home ~/.dsh-robots --restore /absolute/path/to/backup --stopped
node scripts/launch-isolated.mjs --home ~/.dsh-robots
```

恢复会先保存当前机器人资料与配置，再切换到备份中的 CLI、插件快照和机器人资料。输出中的 `beforeRestore` 记录恢复前的备份位置。备份之后发生的机器人编辑保存在该副本，可继续检查。Harness 的 Session 由其自身存储管理，本工具只读写机器人资料与安装配置。跨版本 Session 的回放能力查阅对应宿主支持范围。
