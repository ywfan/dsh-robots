# 机器人页面

本包通过 DSH 公开的 `main` / `sidebar.panellist` / `conversation.hero.options` 扩展点提供独立机器人页面与新会话选择器。保留内置 Agent Preset 控件；机器人会话先由 Host 原子绑定固定修订、模型和权限，再使用 `uiWorkspace.openSession` 导航。

页面覆盖草稿创建与编辑、AI 辅助整理入口、确认发布、运行、经验审批、选择资料导出副本、导入副本及托管邀请。发布携带用户所见 draft ID/editVersion，服务拒绝并发变化。托管邀请只在组件内保留一次性 token，不写浏览器存储；默认地址是本机 loopback，界面不宣称公网可用。

创建、AI 整理或导入时可选项目根目录下的子目录，留空使用根目录。机器人详情显示保存时固定的本地目录。运行记录可以读回已经保存的产物，任务结束后可以提交误报、漏报、纠正等反馈。

复杂知识与流程保留完整 JSON 编辑器，避免丢失 checks、分支和能力配置。模型辅助整理只进入草稿工作流。当前 UI 不承诺外部真实模型的生成质量；实际运行验收采用隔离 profile 和固定输入。

## 构建

先运行根目录 `node scripts/generate-remotes.mjs`，再运行 `node scripts/build-client.mjs`。根 build 包装脚本负责编译空 Host 入口 `lib/index.js`。浏览器产物是官方 lazy-CJS factory 协议，React/Cordis/store/slots/primitives 由宿主 module table 提供，不打包第二个实例。CSS Modules 在 factory 执行时注入，并带有宿主卸载标记。

`clientBundle` 未作为 npm API 发布，因此构建脚本仅实现文档协议，不依赖上游仓的相对路径。`0.2.2-rc.3` 官方 Typert generator 不能直接识别 external protocol 包里的 Remote marker；本项目构建脚本从已安装的公开声明原样提取 marker，生成仅用于编译分析的 ambient facade，并记录版本与源文件 SHA256。运行时始终使用已发布的真实 protocol 包。若 marker 声明改变则构建拒绝继续，应更新 adapter 后重新验收。

## 检查

`pnpm exec vitest run packages/ui-robot/tests` 验证懒加载、共享 React 身份、CSS 注入位置、保存冲突保留数据、固定修订启动和卸载后的迟到请求。实际页面还需要在隔离 Web profile 检查桌面与 390px 宽度、浅色/深色、长名称、错误和审批路径；测试通过不等于实际页面检查完成。
