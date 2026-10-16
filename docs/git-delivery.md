# Git 提交与文档发布

`git-delivery` Skill 处理授权的 add、合理提交信息、commit、push，以及源分支推送后合并到明确指定的测试/main 分支。每次成功 commit 后，先发布已关联文档，再继续 push。任何分支共用一个 Docmost 页面；分支内容冲突时暂停。仅 push 也先补齐当前提交的发布。它不是 Git hook，不在任意终端提交时自动运行。

## Agent 安装与配置

让 Agent 读取本文件和 [Skill](../skills/git-delivery/SKILL.md)，从同一个 fork/commit 安装，避免文档和工具版本不一致：

1. 在已安装 fork 中 `git pull --ff-only`，仅安装 MCP 包依赖并构建（命令见 [本地 MCP](local-mcp.md)）。保留已有客户端连接、认证、默认空间和知识库选项。
2. 复制完整 `skills/git-delivery/` 到 `~/.codex/skills/git-delivery/`；若已有同名目录，先检查并备份。同步更新 `docmost-mcp` Skill 的同版本文件。
3. 在此项目的 MCP 连接增加下面两项，绝对路径按用户实际位置填写；一个连接对应一个仓库。状态目录不进 Git，权限 0700，记录/快照由 MCP 以 0600 管理。已有状态目录必须沿用，不能复制一份账本同时运行。

```toml
[mcp_servers.docmost.env]
DOCMOST_GIT_ROOT = "/absolute/project"
DOCMOST_KNOWLEDGE_STATE_DIR = "/absolute/private/docmost-project-state"
```

这是原 env 的增量，不能覆盖原 URL、session/API Key 文件、默认空间等。若同时设置 DOCMOST_SYNC_STATE_DIR，必须与上述状态目录相同。没有知识库显式选 `DOCMOST_KNOWLEDGE_PROVIDER=none`；OpenViking 使用既有本地/远程 URL、私有 Key 文件、personal/shared 配置。详见 [知识库引导](../skills/docmost-mcp/references/knowledge-sync.md)。缺少 OV 不阻止独立 Docmost 发布。

重启该 MCP 连接并检查实际 tools/list；应发现五个 Git 工具。仅配置不会上传任何文件。首次关联时指定已存在页面与提交中的 Markdown，原文必须一致；bind_git_document 不初次覆盖页面。已有 MD/页面记录加 replaceBindingId 转换，保留原关联、知识库归属，并停止旧保存监听。完整调用与冲突处理见 [约定](../skills/git-delivery/references/document-sync.md)。

## 使用

```text
使用 $git-delivery 提交当前分支全部修改并 push。
使用 $git-delivery 只提交 docs/design.md，不 push，维护已有文档关联。
使用 $git-delivery push 当前分支，再合并到 qa 并 push qa。
```

Skill 会检查变更并生成符合仓库惯例的提交信息。已有无关暂存保持原样；未关联 MD 不自动创建页面。正文只读固定 Git blob；未提交草稿不会上传。Git 的成功、Docmost 条件保存、知识库完整原文/处理结果分别报告。

网页修改或分支分叉会暂停文档，已授权且独立的 Git 交付可继续。分支冲突先合并已发布提交，再发布合并结果；网页冲突先比较并提交用户选定结果，再携带观察到的 revision 显式解决。删除本地文件保留远端；删除 Docmost 页面另行授权。

## 自验

准备临时 repo 和 bare origin，创建一篇授权测试页并关联已提交原文。修改后 commit，再留下不同的未提交草稿。调用 publish_git_documents，读回 Docmost 应为提交正文，bare origin 仍是旧提交；随后 push 才改变远端 ref。

从旧基线新开另一分支修改同页并提交，发布应返回 GIT_BRANCH_CONFLICT，页面数和原文不变。合并已发布提交、解决内容冲突、commit 后再发布应成功。网页编辑后再次发布应暂停；仅 resume 不会覆盖网页。知识库失败时只补 retry_knowledge_sync，Docmost 不重复写入。改名保留同页，删除本地文件暂停并保留远端；重启 MCP 不上传草稿。

完整隔离验收入口：`node scripts/local-docmost/acceptance-git-delivery.mjs --prepare`，环境就绪并已授权测试写入后 `--run`。仅本机合成账号、独立测试页/空间/账本和 bare 远端；报告位于忽略的 data/local-docmost 目录，不覆盖业务三篇文档。报告区分真实服务证据、合成故障注入和 Skill 行为测试。bare 远端不代表 GitHub 网络认证或分支保护已经验证。

验收依赖已启动的本机 Docmost 与 `data/local-docmost/fixtures.json`、`accounts.json` 中的合成账号，不能用公司账号替代。可用 `DOCMOST_ACCEPTANCE_FIXTURE_ROOT` 指向另一个本机 fixture 仓库。只验核心链路时加 `--core-only`，不需要 OpenViking。完整验收需 `DOCMOST_ACCEPTANCE_OV_PROFILE` 指向私有 JSON，其中仅包含既有连接的 `DOCMOST_OPENVIKING_*` 配置项（URL、私有 Key **文件路径**、身份与范围；不能包含 Key 内容）。Agent 可从客户端配置中只选择这些字段生成 0600 文件，保留个人/共享授权；脚本不会安装服务。

`--resume <报告路径>` 只接受已结束且逐页清理已确认的旧报告；校验专用空间 slug 并清理残留空间后，用新资源重新验收。进程被强制终止、写入结果仍未知时拒绝重放，需要先人工只读对账。

本次本地验收（2026-10-16）：完整 MCP 回归 405 项通过；Skill 的 5 组同任务对照测试及无 Docmost 交付通过。真实个人会话、实时协作 CAS 冲突/显式解决、准确提交与草稿隔离、同页分支冲突、bare 目标合并推送、改名/删除/重启、MD 来源原位转换均通过。既有 OpenViking 个人及共享目录均核对完整原文哈希、完成任务、限定 URI 语义检索；故障代理注入验证知识库补处理，未停止实际服务。专用页面、镜像、空间和会话清理已确认。公司部署条件接口、GitHub 认证与分支保护需要在各自目标另验。

已知小限制：辅助检查脚本暂不支持还没有首次提交的空仓库；本次验证使用已有提交的仓库。
