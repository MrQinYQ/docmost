# Git 文档发布

## 配置及持久化

一个 MCP 连接配置一个 `DOCMOST_GIT_ROOT`（仓库绝对路径），`DOCMOST_KNOWLEDGE_STATE_DIR` 指向仓库外私有目录；原 MD/页面记录已存在时沿用其同一个状态目录，不能创建第二本账接管同页。状态目录 0700、记录及快照 0600，由 MCP 管理；不提交 Git、不同用户不共用。凭据仍用已有 session/key 文件，Skill 不读凭据。部署、默认空间/父页及知识库选择沿用 Docmost 安装引导，Git 配置不改变目标权限。

无知识库时显式 `DOCMOST_KNOWLEDGE_PROVIDER=none`；OpenViking 支持现有个人/共享与远程 URL 配置，无本地服务不阻止 Docmost。首次外发仍须授权，既有目的地和模型处理授权可沿用。详细安装见仓库 `docs/git-delivery.md` 和 `docs/local-mcp.md`。

更新构建后重启该 MCP 连接并重新发现实际 schema。只读连接只提供状态，旧部署缺少条件更新接口时停止发布，不能用普通更新代替。无工具时先说明缺连接；只在用户授权配置时安装或改配置。

## 首次关联与来源转换

先固定完整提交及完整分支 ref，确认已提交 Markdown 与 Docmost 已保存完整原文一致。调用：

```json
{"filePath":"docs/design.md","pageId":"真实 UUID","commit":"完整提交对象 ID","branch":"refs/heads/feature/example"}
```

以上传给 `bind_git_document`。此操作只登记基线，不初次覆盖正文。不一致时报告冲突，由用户决定先合并到哪个版本；不静默改页或建副本。新文档只有用户明确授权创建时才先创建目标页面，再核对保存的 Markdown 与提交，建立关联。

已有 Markdown/页面入库记录时，先从其状态工具取得 bindingId，并在同一账本调用 `bind_git_document` 加 `replaceBindingId`。保留原记录身份、页面和知识库归属，改为 `source=git`；原 MD 保存监听随之停止。待确认写入/任务先对账，不能另建记录绕过。转换是行为改变，需用户已有切换授权。

## 状态与冲突

- `publish_git_documents` 可省 bindingIds 处理该连接所有 Git 关联；其他来源不受影响。传入的 commit 必须仍是该完整 branch ref 的 HEAD，否则 `GIT_REF_CHANGED`，重新检查实际提交，不猜分支。
- 每条结果独立检查 `state`、`error`、`git.published`、`git.intent`、`knowledgeBase`。Docmost 已确认后知识库才处理；处理失败可用 `retry_knowledge_sync`，只补知识库，不重复发布 Docmost。
- 同正文也核对网页版本。同正文旧提交不会倒退 published。正文变化/改名须包含上次发布提交；缺历史则补齐用户允许的历史后重查，不能当作可覆盖。
- `GIT_BRANCH_CONFLICT`：先将上次 published 提交合并到当前分支，人工解决真实内容冲突，再提交并重新发布。仍共用原页面。
- `CONFLICT`：用 `get_git_document_status({bindingId})` 读取 currentRevision，并阅读网页和提交原文；用户明确选择的合并结果须形成新提交。再用 `resolve_git_document_conflict({bindingId,commit,branch,expectedRevision})`，expectedRevision 是本次观察值。网页再次变动则重新暂停。
- `unconfirmed`/pending：先查询和等候只读对账，不循环重发写入。不能从网络错误推断未写入。
- `set_git_document_sync` 支持 pause/resume/unbind/rebind。resume 不授权覆盖冲突，rebind 只明确改本地路径，解绑保留两端内容。
- 唯一同 blob 改名可跟随原关联；有歧义时用户指定路径。删除源文件返回 `GIT_SOURCE_DELETED`，保留 Docmost 和知识库；真正删页须另有明确授权。

MCP 重启只恢复未确认请求和已登记任务，不扫描工作区上传。每次 Skill 调用的提交/仅 push 阶段是发布触发点；关闭 Skill/MCP 后无后台推送。
