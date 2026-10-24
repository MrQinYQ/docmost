# 多项目 Git 文档发布

用户已确认：Skill 自动识别当前仓库，同一 MCP 支持多个项目，兼容原同步记录，更新安装引导并真实验收。

连接级配置只包含 Docmost、认证、默认位置和可选知识库；私有状态目录由安装向导自动选择一次，不随项目变化。禁止让用户为每个项目修改 MCP 环境变量、另建连接或重启。普通页面操作不要求 Git。

采用每次调用的 `repositoryRoot` 上下文：Skill 从实际项目目录向上查找 Git 根，传入规范绝对目录、完整分支 ref 与提交。MCP 不猜自己的 cwd。旧 `DOCMOST_GIT_ROOT` 仅作为省略上下文时的兼容默认值。

考虑过让 Agent 自动改静态环境变量；该方式仍需逐项目修改和重启，不采用。采用单连接、多仓库 reader，保留同一本私有账本和页面租约。Git 身份使用 commonDir、对象格式及目录实例 dev/ino/birthtime 指纹；关联保存的 root 保留为来源位置，并固定 Git 路径前缀。同仓库的链接工作树可提供不同调用路径，但不能把另一仓库的关联混进来，也不能重新解释旧子目录相对路径。

`bind_git_document`、`publish_git_documents`、`get_git_document_status`、`resolve_git_document_conflict` 增加可选 repositoryRoot；新 Skill 始终传入。发布必须有显式上下文或旧默认值；缺省不能猜仓库。批量发布仅选该仓库关联，显式 bindingIds 含其他仓库时整批拒绝并且无写入。无上下文的只读状态可列出全部项目。

已有记录原位加载，不复制账本、不重建页面、不要求编辑 JSON。已固定实例的记录移除旧 Git 环境变量后仍可恢复；知识库重试、布局变化和 pending 对账从绑定仓库的已确认提交读取。丢失或更换某个仓库只暂停相关记录，不使其他项目失效。早期无实例字段的记录无法区分同路径 clone，保留 ID/page/pending 以 GIT_IDENTITY_UNCONFIRMED 暂停；用户明确确认可信原仓库后调用 set_git_document_sync 的 confirm-repository，验证原 root 的已确认 blob/hash 并保存实例和前缀，只对账旧写入，不上传新正文。普通 resume/retry 不授权首次信任；原路径/历史不可确认时继续暂停。

来源路径去重同时保护物理路径以及 Git commonDir+相对路径；同一页仍只有一个正文来源。保持完整提交快照、同页分支冲突、网页 CAS、只读模式、MD 保存行为、知识库目标及错误隔离。新工具只需一次服务级私有状态配置；未选择知识库也可使用 Git 发布。

在当前主目录实现，不创建 worktree，不提交或 push 项目改动。测试采用临时 Git 仓库及合成数据；真实验收使用本机 Docmost 的专用空间、个人会话、同一个 stdio 进程内两个项目，以及已有个人/共享 OpenViking 测试目标。清理只限本轮资源，不使用 ov。
