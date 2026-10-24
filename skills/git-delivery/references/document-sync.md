# Git 文档发布

## 配置及持久化

同一个 MCP 服务连接支持多个项目，用户无需配置 Git 地址或路径。Skill 从当前项目自动检测根目录，并在每次查询、绑定、发布、显式解决时传 `repositoryRoot`。不要把用户项目写成 MCP 的固定环境变量；切项目不改配置、不重启。

安装向导自动选择一次仓库外的私有 `DOCMOST_KNOWLEDGE_STATE_DIR`（0700）；记录及快照由 MCP 以 0600 管理。已有 MD/页面/Git 记录沿用原状态目录及 bindingId，不能复制账本接管同页。移除旧 `DOCMOST_GIT_ROOT` 不要求迁移记录；若保留，它仅作为旧调用省略 repositoryRoot 时的默认值，新 Skill 仍显式传当前上下文。`DOCMOST_SYNC_STATE_DIR` 可兼容作为同一私有状态目录的别名，未配置 MD 源目录时不会启用保存监听。凭据继续使用既有文件，Skill 不读取。

仓库实例指纹固定 commonDir 的 dev/ino/birthtime；新 clone 或目录替换不能自动接管，磁盘迁移后也需保留现场处理。路径读取固定使用关联登记的 Git 前缀，不随调用 cwd 改变。早期无指纹记录会保留原 ID/page/pending，以 `GIT_IDENTITY_UNCONFIRMED` 暂停：先向用户说明对应页面、原路径、待处理操作，取得可信原仓库的明确确认，再调用 `set_git_document_sync({bindingId,action:"confirm-repository",repositoryRoot})`。工具核对原路径的已确认 blob/hash、保存实例和前缀、对账旧写入，不上传新正文。普通 resume/retry 不授权首次信任；原路径或历史缺失继续暂停，不手改 JSON、不创建副本、不用 update_page 覆盖。

稳定仓库身份来自受校验的 Git commonDir 和对象格式，同仓库链接工作树可共用关联；相同远程 URL 的独立 clone 仍是不同本地仓库，不能自动接管。状态响应的 repository.id 标识仓库，root 为原关联位置。缺少或更换某个仓库只暂停该项目，不改投其他项目。

无知识库时显式 `DOCMOST_KNOWLEDGE_PROVIDER=none`；OpenViking 支持现有个人/共享与远程 URL 配置，无本地服务不阻止 Docmost。首次外发仍须授权，既有目的地和模型处理授权可沿用。详细安装见仓库 `docs/git-delivery.md` 和 `docs/local-mcp.md`。

更新构建后重启该 MCP 连接并重新发现实际 schema。只读连接只提供状态，旧部署缺少条件更新接口时停止发布，不能用普通更新代替。无工具时先说明缺连接；只在用户授权配置时安装或改配置。

## 首次关联与来源转换

先固定完整提交及完整分支 ref，确认已提交 Markdown 与 Docmost 已保存完整原文一致。调用：

```json
{"repositoryRoot":"Skill 检测的规范绝对根目录","filePath":"docs/design.md","pageId":"真实 UUID","commit":"完整提交对象 ID","branch":"refs/heads/feature/example"}
```

以上传给 `bind_git_document`。此操作只登记基线，不初次覆盖正文。不一致时报告冲突，由用户决定先合并到哪个版本；不静默改页或建副本。新文档只有用户明确授权创建时才先创建目标页面，再核对保存的 Markdown 与提交，建立关联。

已有 Markdown/页面入库记录时，先从其状态工具取得 bindingId，并在同一账本调用 `bind_git_document` 加 `replaceBindingId`。保留原记录身份、页面和知识库归属，改为 `source=git`；原 MD 保存监听随之停止。待确认写入/任务先对账，不能另建记录绕过。转换是行为改变，需用户已有切换授权。

## 状态与冲突

- `publish_git_documents` 可省 bindingIds 处理当前 repositoryRoot 的 Git 关联；不会发布其他项目。混入另一仓库 bindingId 时整批拒绝且不写入。传入 commit 必须仍是该完整 branch ref 的 HEAD，否则 `GIT_REF_CHANGED`，重新检查实际提交，不猜分支。缺少上下文且无旧默认值时停止，不能从 MCP cwd 猜测。
- 每条结果独立检查 `state`、`error`、`git.published`、`git.intent`、`knowledgeBase`。Docmost 已确认后知识库才处理；处理失败可用 `retry_knowledge_sync`，只补知识库，不重复发布 Docmost。
- 同正文也核对网页版本。同正文旧提交不会倒退 published。正文变化/改名须包含上次发布提交；缺历史则补齐用户允许的历史后重查，不能当作可覆盖。
- `GIT_BRANCH_CONFLICT`：先将上次 published 提交合并到当前分支，人工解决真实内容冲突，再提交并重新发布。仍共用原页面。
- `CONFLICT`：用 `get_git_document_status({repositoryRoot,bindingId})` 读取 currentRevision，并阅读网页和提交原文；用户明确选择的合并结果须形成新提交。再用 `resolve_git_document_conflict({repositoryRoot,bindingId,commit,branch,expectedRevision})`，expectedRevision 是本次观察值。网页再次变动则重新暂停。
- `unconfirmed`/pending：先查询和等候只读对账，不循环重发写入。不能从网络错误推断未写入。
- `set_git_document_sync` 支持 pause/resume/unbind/rebind。resume 不授权覆盖冲突，rebind 只明确改本地路径，解绑保留两端内容。
- 唯一同 blob 改名可跟随原关联；有歧义时用户指定路径。删除源文件返回 `GIT_SOURCE_DELETED`，保留 Docmost 和知识库；真正删页须另有明确授权。

MCP 重启只恢复未确认请求和已登记任务，不扫描工作区上传。每次 Skill 调用的提交/仅 push 阶段是发布触发点；关闭 Skill/MCP 后无后台推送。

同步锁仅覆盖一次有限工作及账本更新，完成、失败或取消即释放，MCP 空闲不占页；不新增常驻服务。多个实例共享原账本，获锁后刷新记录。遇到 LEASE_BUSY 先等待正在执行的操作；旧版连接可正常重连，不删活锁、不清账本、不擅自结束其他会话。远端知识库任务继续按原记录对账，不重放正文。
