# Git 提交与文档发布

`git-delivery` Skill 处理已授权的 add、生成提交信息、commit、push 和指定目标分支合并。每次成功 commit 后先发布已关联文档，再继续 push；仅 push 时先补当前提交的发布。任何分支共用一个 Docmost 页面，冲突暂停。它由 Skill 调用触发，不安装 Git hook，也不监听普通终端提交。

## 用户需要设置什么

只需一次性连接 Docmost：部署 URL、个人登录、默认空间/可选父页，以及是否使用知识库。**不需要提供 Git 地址或项目目录，不需要每个项目创建一个 MCP 连接。**

在 A 项目调用 Skill，它检测 A 的仓库；切到 B 项目再次调用，它检测 B。同一个 MCP 进程按调用中的项目上下文选择关联。只有明确登记的 Markdown 会发布；未登记文档不会自动创建页面。

## Agent 安装与更新

让 Agent 从同版本 fork 读取本文件、[Skill](../skills/git-delivery/SKILL.md) 和 [Docmost 安装引导](../skills/docmost-mcp/references/setup.md)，保留既有客户端配置、凭据、默认位置及知识库选择。完整 MCP 构建方式见 [本地 MCP](local-mcp.md)，不需要发布 npm 包。

1. 更新并构建 MCP；将完整 skills/git-delivery/ 安装到 ~/.codex/skills/git-delivery/。已有目录先检查并备份，同时更新同版本 docmost-mcp Skill。
2. 沿用原有私有状态目录。新安装由 Agent 自动在用户配置目录选择一个服务级私有目录，保存为 DOCMOST_KNOWLEDGE_STATE_DIR；用户不需要填写此内部路径，也不能把它放在工具源码或业务仓库内。目录 0700，记录/快照由 MCP 以 0600 管理。
3. 安装或升级后重启连接并发现实际 tools/list，确认五个 Git 扩展工具。此后切换项目无需改配置或重启。没有知识库时显式 provider=none，Git 发布仍可用；选择 OpenViking 时沿用既有地址、私有 Key 文件和个人/共享作用域，不合并两个知识库目的地的账本。

状态目录是一个连接的持久存储，不是一个项目的配置。DOCMOST_SYNC_STATE_DIR 可兼容作为同一目录的别名，两者同时设置时必须相同；没有 MD 源目录时不会启用保存监听。普通页面操作不需要 Git。

## 自动识别与关联

Skill 在当前项目目录执行自包含的 inspect-git.mjs，从项目子目录也能向上找到 Git 根；返回规范 root、分支、HEAD 和变更，且不修改文件或索引。空仓库返回 head:null，正常首次提交后再发布。若执行工具的 cwd 不在用户项目中，用 --repo <已知的当前项目目录> 提供上下文，不询问用户填写 Git 配置。

Skill 将检测到的 root 作为 repositoryRoot，随 bind_git_document、get_git_document_status、publish_git_documents、resolve_git_document_conflict 调用传入。这是 Agent 自动传的内部参数。MCP 不从自身进程 cwd 猜项目，也不从 Docmost 正文中接受仓库指令。

首次关联指定已存在页面与提交中的 Markdown，原文必须一致。关联只登记基线，不覆盖正文；用户明确授权创建新页面时，先创建并核对保存原文，再关联。已有 MD/页面记录通过 replaceBindingId 原位转换，保留绑定 ID、页面及知识库归属，停止原保存监听。完整参数与处理约定见 [文档同步](../skills/git-delivery/references/document-sync.md)。

每个仓库按 commonDir、对象格式和已保存的目录实例身份识别；同仓库链接工作树共用关联，同远程地址的独立 clone 不自动接管，在原路径重新 clone 也会被阻止。目录实例由本机 dev/ino/birthtime 指纹确认，迁移磁盘或重建目录后不会自动重绑。关联固定保存原来的仓库内路径前缀；从其他子目录或工作树调用，不会重新解释文件路径。相同文件名、分支名甚至 commit ID 不会混淆两个仓库。显式混入其他项目 bindingId 时整批拒绝，避免部分写入。

## 已安装用户兼容

旧 DOCMOST_GIT_ROOT 可以保留，作为旧调用省略上下文的默认值；新 Skill 的显式 repositoryRoot 优先。删除旧变量也会从原账本加载 Git 记录，无需重建页面、复制账本或编辑 JSON。旧确认提交、未确认意图、知识库任务和租约沿用原记录。

早期记录没有目录实例身份，不能仅凭路径和相同 Git 对象判断是否为原仓库。升级时这类记录保留 ID、页面和 pending，并以 GIT_IDENTITY_UNCONFIRMED 暂停。Agent 说明原页面、来源路径和待处理状态，用户确认本机是可信原仓库后，调用 set_git_document_sync({bindingId,action:"confirm-repository",repositoryRoot:检测结果})。工具验证原 root 下已确认的 blob/hash、保存路径前缀与实例，只对账已有写入，不上传新正文；普通 resume、retry 不会代替首次信任。原仓库无法访问或历史无法核对时继续暂停，不能退回普通更新。已保存实例身份的记录无此升级步骤。

新增项目沿用同一连接和账本；某项目目录不可达只暂停该项目。若过去已配置多个独立账本，不自动扫描合并它们；先沿用原连接以保留权限、目标与租约，不能复制文件接管同页。

## 使用与自验

```text
使用 $git-delivery 提交当前项目全部修改并 push，维护已有文档关联。
使用 $git-delivery 只提交 docs/design.md，不 push。
使用 $git-delivery push 当前分支，再合并到 qa 并 push qa。
```

Skill 保留无关暂存，正文只读取固定提交中的 Git blob；未提交草稿不上传。网页修改或分支分叉暂停文档，独立且已授权的 Git 交付可以继续。分支先合并已发布提交；网页冲突需比较、提交用户选择的合并结果，再携带刚观察到的 revision 显式解决。恢复任务不授权覆盖，删除本地文件保留远端。

本机完整隔离验收：先运行 node scripts/local-docmost/acceptance-git-delivery.mjs --prepare，已授权测试写入后用 --run。需要已启动的本机 Docmost、fixtures/accounts 中的合成账号；核心验收加 --core-only，不需要 OpenViking。完整验收用 DOCMOST_ACCEPTANCE_OV_PROFILE 指向仅含既有 DOCMOST_OPENVIKING_* 配置的 0600 JSON，Key 只提供文件路径。可用 DOCMOST_ACCEPTANCE_FIXTURE_ROOT 指向本机 fixture 仓库。

验收使用独立空间、页面、Git/bare 远端与私有账本，同一个不含固定 Git 根的 stdio 连接处理多个项目；报告保存在忽略的 data/local-docmost 目录。核对提交快照、草稿隔离、分支与实时协作冲突、重启、原文哈希、知识库任务和清理；不会修改业务页面，不使用 ov。--resume 只接受已结束且逐页清理可确认的旧报告，不重放未知写入。GitHub 认证、分支保护和公司部署兼容性需在各自目标另验。
