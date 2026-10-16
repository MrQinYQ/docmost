# git-delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户尚未选择执行方式；计划审阅后再进入实现。

**Goal:** 交付通用 Git Skill，使任意分支成功提交后，将已关联文档的准确提交版本发布到同一 Docmost 页面和原知识库目标，冲突时暂停。

**Architecture:** Skill 执行用户指定的暂存、提交信息生成、提交、推送及目标分支合并。MCP 增加 Git 来源，复用原有私有账本、页面租约、条件更新与知识库任务；工作区保存监听只处理 Markdown 来源。Git 读取和发布协调分别放在独立模块，避免继续把全部逻辑放进 `sync.mjs`。

**Tech Stack:** Node.js >=22、现有 Git CLI、现有 MCP SDK/zod、Node 内置 test/fs/crypto/child_process；不发布 npm 包，不新增运行时依赖。

**Spec:** [2026-10-16-git-delivery-design.md](../specs/2026-10-16-git-delivery-design.md)。执行者先读取规格，再按本计划推进。

## Global Constraints

- 任意分支成功提交后发布，不以 push 成功或 main 分支作为前提。
- 不同分支共用同一页面；分支内容冲突时暂停，不创建分支副本。
- 只处理明确关联的普通 UTF-8 `.md` blob，最多 1,000,000 字节，非空；正文来自固定 Git 提交。
- Git 根使用 `DOCMOST_GIT_ROOT`；Git、MD、页面来源复用同一仓库外私有账本，目录 0700、文件 0600。
- 同页一个正文来源；保存自动同步和提交发布互斥，不丢弃旧任务、不直接编辑私有 JSON 完成迁移。
- 通过现有条件同步协议写入；部署不支持时暂停，不退回普通更新。
- 知识库可关闭；目标选择、个人/共享范围、完整原文和 Docmost 目录结构保持现有约定。
- 网络结果未知时先对账；知识库重试不重放 Docmost 写入；不安装或调用 `ov`。
- 验收仅使用独立 Git 仓库/bare 远端、合成文档及专用页面；不提交或推送本项目的开发改动，不清空既有资源。
- 相关修改集中完成后批量验证；保留必要的失败复现和受影响检查，稳定后运行完整 MCP 测试。

## Review Focus

1. 文件名含中文、空格、换行或 Git 选项样式：保持正确路径身份，拒绝注入和树外读取。Task 1 固定测试。
2. 两个链接工作树指向同一仓库，但工作区正文不同：同页关联和提交快照不受工作区内容影响。Task 1、2 固定测试。
3. 分支 ref 在发布调用前或调用中移动：调用前拒绝不匹配；调用中固化对象，不替换本次正文。Task 1、3 固定测试。
4. CAS 已成功而客户端在推进 Git 基线前退出：重启只对账一次，Git 发布元数据和正文基线原子推进。Task 3、4 固定测试。
5. 同正文重新发布时 Docmost 已被网页修改：仍报告远端冲突，不把旧知识库成功状态说成当前全文已同步。Task 3 固定测试。

---

### Task 1: 不可变 Git 来源与只读交付检查

**Files:**
- Create: `packages/mcp/src/git-source.mjs`
- Create: `packages/mcp/test/git-source.test.mjs`
- Create: `skills/git-delivery/scripts/inspect-git.mjs`
- Create: `packages/mcp/test/git-delivery-helper.test.mjs`

**Interfaces:**
- `openGitSource(root, { signal } = {}) -> Promise<GitSource>`。
- `GitSource.identity() -> { root, commonDir, objectFormat }`，objectFormat 为 `sha1|sha256`。
- `resolveCommit({ commit, branch }) -> { commit, branch }`：branch 使用完整 `refs/heads/...`；校验调用时 ref 等于完整 commit ID。
- `readSnapshot({ commit, filePath }) -> { kind:'body', commit, blob, hash, content } | { kind:'deleted', commit }`：支持历史提交，不再次要求分支仍指向该提交。
- `isAncestor(before, after) -> boolean`：对象缺失返回明确的 `GIT_HISTORY_MISSING`，不返回 false 混淆冲突。
- `findRename({ fromCommit, toCommit, filePath }) -> string|undefined`：原路径消失且目标唯一、blob 完全相同时才返回路径。
- `confirmPush({ commit, branch, remote }) -> { state:'confirmed'|'unconfirmed', commit, branch, remote }`：remote 只接受已配置别名，使用 `ls-remote` 独立核对；失败不能阻断已获授权的 Docmost 发布。
- Skill 检查脚本为自包含的 Node CLI：`node inspect-git.mjs --repo <root> [--commit <oid>]` 输出 JSON，包含分支、HEAD、暂存/未暂存/新增/删除路径、合并状态、近期提交风格样本及所选提交的 Markdown 变化清单；不输出正文或凭据，不执行 Git mutation，不依赖 MCP 源码路径。

- [ ] 写真实临时 Git 仓库测试：提交正文为 A，工作区改成 B，`readSnapshot` 必须返回 A；路径删除、唯一纯改名、SHA-256 对象格式分别验证。
- [ ] 加入 Review Focus 1–3 的断言：非法 ref/commit、symlink/submodule、空白/超限/无效 UTF-8 blob 被拒绝；不通过 shell 执行输入；两工作树读取同一提交结果一致。
- [ ] 运行 `node --test packages/mcp/test/git-source.test.mjs packages/mcp/test/git-delivery-helper.test.mjs`，确认因缺少入口失败，记录失败原因。
- [ ] 实现 Git 参数数组调用、超时/取消、大小上限和身份重检；diff 使用 NUL 分隔，关闭 external diff/textconv；历史读取使用 tree/blob，不执行仓库脚本或过滤器。
- [ ] 用 bare 远端断言推送确认只在目标 ref 等于 commit 时成功；检查脚本在脏工作区不修改 index/HEAD/文件。
- [ ] 重跑上述受影响测试，全部通过后记录审阅检查点；不提交实际项目。

### Task 2: 持久化 Git 关联、配置与来源转换

**Files:**
- Create: `packages/mcp/src/git-binding.mjs`
- Create: `packages/mcp/test/git-binding.test.mjs`
- Create: `packages/mcp/test/git-config.test.mjs`
- Modify: `packages/mcp/src/config.mjs`
- Modify: `packages/mcp/src/sync.mjs`（记录验证、序列化、初始化、来源判断）
- Modify: `packages/mcp/src/index.mjs`（Git 配置可独立启用 manager）

**Interfaces:**
- 新记录 `source:'git'`，仍保留 `bindingId/pageId/spaceId/workspaceId/userId/origin/root/filePath/enabled/localHash/remoteRevision/mirror`。
- `git` 字段形态：`{ version:1, commonDir, objectFormat, published:{commit,blob,branch,hash}, lastChecked?:{commit,branch}, intent?:{commit,blob,branch,hash}, pushReceipt?:{state,commit,branch,remote} }`。
- `validateGitBinding(binding)` 校验来源特定字段及 published.hash 与正文基线一致；`confirmedGitBinding(binding)` 返回已确认 intent 推进为 published 的记录，供 Task 3 的同一次持久化使用。
- manager 新增 `bindGitDocument({filePath,pageId,commit,branch,replaceBindingId?})`：新登记只确认一致基线；replaceBindingId 仅转换同页旧来源，保留 bindingId 和镜像目标。
- `setGitDocumentSync({bindingId,action:'pause'|'resume'|'unbind'|'rebind',filePath?})`：rebind 用于用户确认改名；resume 保留基线，不解决冲突。

- [ ] 写配置失败测试：相对 Git 根、缺私有状态目录、状态位于任一来源根内、多个状态目录不一致均拒绝；没有 Git 配置保持旧启动行为。
- [ ] 写磁盘恢复测试：旧 MD/页面记录仍能加载；Git 新字段完整保存、重启恢复；Git root/仓库 commonDir/用户/页面目标变动拒绝接管。
- [ ] 写来源转换测试：匹配提交和 Docmost 实时/持久化版本才登记；转换同页保留 ID、镜像和归属；旧 pending、不确定镜像任务或活跃租约时拒绝转换；相同文件或同页不能增加第二个自动来源。
- [ ] 运行 `node --test packages/mcp/test/git-config.test.mjs packages/mcp/test/git-binding.test.mjs` 看到预期失败，再实现最小配置和记录扩展。
- [ ] 将所有 watcher、scan、工作区读取分支改为明确只处理 Markdown 来源；Git 来源不会因为保存或启动扫描自动上传。
- [ ] 重跑新测试和现有 `sync-config`、`page-knowledge-config`、`sync-manager` 测试，记录检查点；不自动迁移未明确选定的已有业务关联。

### Task 3: 按提交发布、分支冲突与可靠恢复

**Files:**
- Create: `packages/mcp/src/git-publication.mjs`
- Create: `packages/mcp/test/git-publication.test.mjs`
- Modify: `packages/mcp/src/sync.mjs`（接线和确认边界）
- Modify: `packages/mcp/src/knowledge-adapters/openviking/mirror.mjs`（Git 来源确认与祖先处理）

**Interfaces:**
- `createGitPublication(context)` 接收现有 records、store、enqueue/controlQueue、persist/snapshot、ensureLease/checkIdentity、remoteFor/upload/reconcile、knowledgeRuntime 及 Task 1 的 GitSource；返回下列 manager 方法。
- `publishGitDocuments({commit,branch,bindingIds?,remote?}) -> {commit,branch,documents:[GitStatus],pushReceipt?}`；不传 bindingIds 检查当前仓库全部活跃 Git 关联，包含旧失败任务。
- `getGitDocumentStatus({bindingId?}) -> GitStatus | {bindings:[GitStatus]}`，状态读取不派发上传。
- `resolveGitDocumentConflict({bindingId,commit,branch,expectedRevision}) -> GitStatus`：仅用于用户已经选择的合并提交，仍校验已发布提交为祖先及最新远端 CAS。
- GitStatus 包含安全关联标识、路径、published commit/branch/blob、lastChecked、源状态/错误及独立 knowledgeBase；不返回全文、会话或 Key。
- 延续已有 state 枚举；新增安全错误码 `GIT_BRANCH_CONFLICT/GIT_HISTORY_MISSING/GIT_REF_CHANGED/GIT_SOURCE_DELETED` 表达 Git 原因，Docmost 冲突仍为 `CONFLICT`。

- [ ] 写最小场景：分支 A 提交发布到同一 pageId；push 前已确认 Docmost；分支 B 从旧基线修改同文档返回 GIT_BRANCH_CONFLICT，Docmost 写入计数不变，关联数仍为 1。
- [ ] 补充：合并包含 A 后发布成功；正文相同不倒退 published；同正文但网页版本变动仍冲突；缺历史、删除、唯一改名、配置变化分别有明确状态。
- [ ] 加入退出断点测试：CAS 成功前、确认后写账本前、知识库已派发后分别重启；只读对账，Docmost 条件更新不重复，git.intent 与 pending 同步推进/保留。
- [ ] 运行 `node --test packages/mcp/test/git-publication.test.mjs`，确认预期失败，再实现读取快照→持久化 intent→CAS→确认→知识库的协调。
- [ ] 派发前先调用 store.saveSnapshot 保存并落盘准确正文，再保存 git.intent/binding.pending；快照保留集合包含 git.intent.hash。provider=none 时仍保存这份快照，不依赖镜像是否启用。
- [ ] 调整 `commit(binding)`：Git published 和正文基线在同一次 store.save 中确认；已确认后才清除 intent 并按保留集合回收快照。重启时即使原提交已不再是分支 HEAD，也能用持久化快照完成旧请求的只读对账。
- [ ] Git retry、改名/移动布局刷新、远端删除/恢复仅读取固定已确认提交；所有原本落入“非 page 即 MD”的分支必须按 Git 来源分派，禁止读取工作区正文。Git 页面祖先索引按页面链路完成条件核对。
- [ ] 故障恢复测试验证知识库失败只重试该阶段；Git 检测和网络推送确认失败不得输出任意原始 stderr、仓库凭据或正文。新/受影响测试通过后记录检查点。

### Task 4: MCP 工具与真实 stdio 生命周期

**Files:**
- Modify: `packages/mcp/src/server.mjs`
- Modify: `packages/mcp/src/index.mjs`（help、工具初始化和退出）
- Create: `packages/mcp/test/git-stdio.test.mjs`
- Modify: `packages/mcp/test/knowledge-adapter.test.mjs`（来源及非 OpenViking 适配器回归）

**Interfaces — 新增工具 schema:**
- `bind_git_document({filePath:string,pageId:UUID,commit:OID,branch:string,replaceBindingId?:UUID})`。
- `publish_git_documents({commit:OID,branch:string,bindingIds?:UUID[1..50],remote?:string})`。
- `get_git_document_status({bindingId?:UUID})`。
- `set_git_document_sync({bindingId:UUID,action:'pause'|'resume'|'unbind'|'rebind',filePath?:string})`；filePath 仅 rebind 必填。
- `resolve_git_document_conflict({bindingId:UUID,commit:OID,branch:string,expectedRevision:SHA256})`。
- OID schema 为 40 或 64 位小写 hex，最终仍由 Git 对象格式和仓库内容校验。工具只在有效 Git 配置时注册；只读连接只暴露对应状态工具。

- [ ] 写真实 stdio 测试，覆盖 tools/list、schema 拒绝、provider=none、有知识库、只读、缺条件接口不回退普通更新、保存不会发布。
- [ ] 写 EOF/SIGTERM 中断发布并重启的断言；旧页面/MD 工具的注册和重试别名保持兼容。
- [ ] 运行 `node packages/mcp/build.mjs` 和 `node --test packages/mcp/test/git-stdio.test.mjs`，先观察缺工具失败，再接线 manager 方法、注解和安全结果。
- [ ] 逐工具核对：状态读取无外发，写工具有相应 readOnly/destructive/openWorld 注解，错误不泄露 HTTP 上游正文或 Git stderr。
- [ ] 重跑 git-stdio、knowledge-adapter、sync-stdio、page-knowledge-stdio 受影响测试；停止前保留 pending，释放自身租约。

### Task 5: Skill 行为验证、中文引导和本机安装准备

**Files:**
- Create: `skills/git-delivery/SKILL.md`
- Create: `skills/git-delivery/agents/openai.yaml`
- Create: `skills/git-delivery/references/document-sync.md`
- Modify: `skills/docmost-mcp/SKILL.md`
- Modify: `skills/docmost-mcp/references/setup.md`
- Modify: `skills/docmost-mcp/references/tool-contract.md`
- Modify: `docs/local-mcp.md`
- Create: `docs/git-delivery.md`

**Interfaces:**
- Skill 使用 Task 1 的自包含检查脚本和 Task 4 的实际工具 schema；无 Docmost 配置时只执行 Git 操作。
- UI default_prompt 明确包含 `$git-delivery`，保持默认自动发现；全局安装路径为 `~/.codex/skills/git-delivery`，不覆盖同名未知内容。
- 交付结果结构：仓库/分支、提交及合理摘要、各 remote/ref 推送状态、目标合并状态、逐文档 Docmost/知识库结果和待处理项。

- [ ] 在写 SKILL.md 前，用具备新工具但未加载此 Skill 的独立代理跑隔离压力场景：任意 feature 提交、已有无关暂存、仅 push、推送后合并目标、文档失败但 Git 可继续。记录真实遗漏，不把缺工具当作指导失效。
- [ ] 根据观察写简洁中文 Skill；文档同步细节放在 reference，包含旧记录转换、私有目录、准确来源版本、共页冲突和删除边界；不扩大 Git 操作授权。
- [ ] 用同样原始任务和隔离资源运行加载 Skill 的代理，核对执行的真实 Git 命令、提交信息、工具调用顺序和阶段报告；若基线已正确则保留结果，不捏造失败来增加规则。
- [ ] 生成并验证 openai.yaml，运行 `python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/git-delivery`；检查脚本离开仓库单独复制后仍可运行。
- [ ] 中文安装引导可让 Agent 从 GitHub 读取同版本内容完成配置；保留当前 MCP/Skill、Docmost 凭据和知识库选择。涉及全局目录写入使用正常沙箱授权，不打印凭据。
- [ ] Skill 行为和脚本测试通过后准备安装；实际更新运行中的 MCP 延后到 Task 6 的专用验收连接，避免占用业务页面租约。

### Task 6: 真实验收、清理、完整验证和交付

**Files:**
- Create: `scripts/local-docmost/acceptance-git-delivery.mjs`
- Modify: `docs/git-delivery.md`（自验步骤与已验证边界）
- Reports: ignored `data/local-docmost/git-delivery-<runId>/`，不进入公开提交。

**Interfaces:**
- `node scripts/local-docmost/acceptance-git-delivery.mjs --prepare` 仅只读检查环境和专用目标。
- `... --run` 新建并记录本轮专用资源，在独立临时目录创建 Git 工作仓库和 bare 远端；用户已授权这类真实写验收。
- `... --resume <private-report>` 先验证现有资源身份和已完成阶段，再续验；未知创建/写入结果先对账，不重放。
- 报告保存真实 Git 对象 ID、页面 UUID、MCP 状态、正文哈希、知识库 URI/处理任务/限定检索和清理结果；不保存凭据。

- [ ] 先核对现有 LEASE_BUSY：只读查询持有进程，不能删除活跃租约。验收使用独立私有账本和专用页面，不通过换账本接管已有业务页面。确认为遗留租约时记录诊断，清理只限本轮拥有的资源。
- [ ] 准备本机 fork Docmost 的真实用户会话及协作 WebSocket；沿用既有获授权 OpenViking 服务和模型处理，使用合成正文及专用目录，不运行 ov。
- [ ] 执行规格九组场景：无 Docmost 的 Git 交付、feature 提交即发布、排除未提交内容、分支冲突不建副本、合并目标及去重、网页协作 CAS 冲突、知识库故障补处理、改名/删除/重启、旧来源及个人/共享回归。
- [ ] 独立读回 Docmost 和知识库完整原文核对提交快照；查询本次任务和限定 URI 检索；从 bare 远端读取测试/main ref，核对实际提交与合并结果。明确不覆盖 GitHub 网络认证/保护规则。
- [ ] 通过 MCP 清理专用页面及其镜像，验证本次页面 UUID 和知识库 URI 均无残留；注销专用会话，关闭专用连接；不修改原三篇业务文档。
- [ ] 稳定后运行 `npm test`（cwd `packages/mcp`）、验收脚本自检、Skill validator 和 diff 检查；新失败只重跑失败/受影响部分，修复稳定后再完成完整检查。
- [ ] 按选定执行方式完成独立代码/Skill 审阅，修复有证据的问题；安装同版本 Skill，并核对独立安装后可发现、辅助脚本可运行。
- [ ] 交付可点击文件、使用示例、自验步骤和分层验收结果；开发改动保持未提交，等待用户另行指示 commit/push。

## Plan self-review

- 规格各节映射：Git 交付与提示语归 Task 1/5；配置、记录和转换归 Task 2；快照、共页冲突、可靠恢复归 Task 1/3；工具/权限/生命周期归 Task 4；真实证据和清理归 Task 6。
- 工作区保存、重试、布局变化、远端恢复四类潜在工作区读取均由 Task 2/3 指定来源分派测试，避免新增 Git 来源落入旧 MD 分支。
- 现有账本保留字段和镜像归属，新来源不覆盖旧 pending；无 provider 时的 Docmost intent 也能恢复。
- 此计划未授权实际项目的提交/推送，不把隔离 bare 远端验收表述为 GitHub 远端验收。
- 当前只完成计划；测试、Skill、MCP 新接口和真实验收均待执行。
