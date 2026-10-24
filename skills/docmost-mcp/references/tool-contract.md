# 本地 MCP 工具约定

客户端工具名称可能加前缀。发现当前连接实际提供的工具，并使用实际名称；下表是当前本地包的用途索引，实际参数、枚举、分页和返回字段以已连接工具的 schema 为准，不硬编码旧版十工具清单。

下面基础表对齐 [官方 MCP 指南](https://docmost.com/docs/user-guide/mcp) 公开能力，另有软删除/恢复扩展。MD 与知识库工具按当前配置另外发现，不用基础表计数判断可选能力。官方只公布名称和用途，未公布输入 schema；本地参数依据实际 REST DTO 和包装层设计，不声称与私有企业 MCP 实现完全一致。

| 工具 | 读写 / 来源 | 输入参数（`?` 表示可选） | 使用时机 |
| --- | --- | --- | --- |
| `search_pages` | 读取 / 官方 | `query`, `spaceId?`, `titleOnly?`, `limit?`, `offset?` | 关键词检索；搜索无游标，按 offset 分页。 |
| `get_page` | 读取 / 官方 | `pageId`, `format?` | 读取正文；默认 Markdown，也可 HTML 或编辑器 JSON。 |
| `create_page` | 写入 / 官方 | `spaceId?`, `title?`, `parentPageId?`（UUID、slugId 或 `null`）, `content?`, `format?` | 在默认或明确指定的空间/父页下创建。 |
| `update_page` | 写入 / 官方 | `pageId`, `title?`, `content?`, `format?`, `operation?` | 改标题或以明确操作修改正文。 |
| `list_pages` | 读取 / 官方 | `spaceId?`, `limit?`, `cursor?` | 分页查看可访问的近期页面，不是目录树。 |
| `list_child_pages` | 读取 / 官方 | `pageId`, `limit?`, `cursor?` | 分页读取可见直接子页；包装层先解析父页规范 ID 和空间。 |
| `duplicate_page` | 写入 / 官方 | `pageId` | 在源空间复制页面及可访问子树。 |
| `copy_page_to_space` | 写入 / 官方 | `pageId`, `spaceId`（目标 UUID） | 复制到明确指定的另一空间，不继承默认创建位置。 |
| `move_page` | 写入 / 官方 | `pageId`, `parentPageId`（UUID、slugId 或 `null`，必填）, `position`（5–12 位字符串，必填） | 在同一空间更换父页或排序；根目录显式传 `null`。 |
| `move_page_to_space` | 写入 / 官方 | `pageId`, `spaceId`（目标 UUID） | 将页面及可访问子树移动到明确指定的另一空间。 |
| `get_space` | 读取 / 官方 | `spaceId` | 确认所选空间的信息。 |
| `list_spaces` | 读取 / 官方 | `query?`, `limit?`, `cursor?` | 定位可访问空间；按 `meta.nextCursor` 翻页。 |
| `create_space` | 写入 / 官方 | `name`, `slug`, `description?` | 创建空间，受服务器工作区权限约束。 |
| `update_space` | 写入 / 官方 | `spaceId`, `name?`, `description?`（至少一个） | 更新空间名称或描述，不开放空间策略字段。 |
| `get_comments` | 读取 / 官方 | `pageId`, `limit?`, `cursor?` | 分页读取页面评论。 |
| `create_comment` | 写入 / 官方 | `pageId`, `text`, `parentCommentId?`（UUID） | 创建页面评论或回复同页的顶层评论。 |
| `update_comment` | 写入 / 官方 | `commentId`（UUID）, `text` | 编辑当前用户自己的评论。 |
| `search_attachments` | 读取 / 官方 | `query`, `spaceId?`, `creatorId?`, `limit?`, `offset?` | 检索可见附件，依赖目标部署对应接口。 |
| `list_workspace_members` | 读取 / 官方 | `query?`, `limit?`, `cursor?` | 按姓名或邮箱查询可见工作区成员。 |
| `get_current_user` | 读取 / 官方 | `{}` | 确认当前凭据用户及 `defaults` 中的默认空间/父页。 |
| `delete_page` | 写入 / 本地扩展 | `pageId`（UUID） | 软删除整棵子树，内部固定 `permanentlyDelete: false`。 |
| `restore_page` | 写入 / 本地扩展 | `pageId`（UUID） | 恢复整棵子树，含本次删除之前就已软删的后代；不会恢复分享。 |

`spaceId` 和 `creatorId` 传入时必须为 UUID。页面工具的 `pageId` 可为 UUID 或裸 slugId，不能传完整页面 URL；**删除和恢复必须使用 `get_page` 返回的规范 UUID `id`**。移动前包装层会解析源页和父页的规范 UUID。`limit` 为 1–100，默认 20。列表按 `meta.nextCursor` 翻页；页面和附件搜索的 `offset` 默认 0，搜索结果没有 total，不能据此宣称完整覆盖。子页和评论列表只代表当前用户可见内容。

## 可选知识库工具

| 工具 | 输入 | 行为与结果 |
| --- | --- | --- |
| `sync_page_to_knowledge` | `pageId`（规范 UUID） | 写知识库：读取 Docmost 当前已保存完整 Markdown，登记并入库，后续 MCP 修改跟进；不修改 Docmost。 |
| `get_page_knowledge_status` | `pageId?`（规范 UUID） | 只读页状态或登记列表，含关联标识、URI、原文哈希、进度和安全错误；未登记不自动导出。 |
| `retry_knowledge_sync` | `bindingId`（从状态结果取得） | 对账后仅补知识库阶段，不重放 Docmost 写入，不接受任意 URI。 |

页面主动同步无需本地 MD、`DOCMOST_SYNC_ROOT`、MD 绑定或条件同步路由。需要知识库连接及 `DOCMOST_KNOWLEDGE_STATE_DIR` 私有绝对目录（默认复用已有 `DOCMOST_SYNC_STATE_DIR`）。页面与 MD 来源共用账本；同时启用 MD 时显式知识库状态目录须等于 MD 状态目录，已绑定 MD 的页面不能自动转成页面来源。单页快照的 `localHash` / `remoteRevision` 为已保存 Markdown SHA-256 指纹，不是 CAS/live 协议；知识库进度独立看 `knowledgeBase.state`，未追上已保存正文时为 `waiting_docmost`，未登记页为 `not_enrolled`。普通新建页不自动外发；已登记页的 MCP 更新、移动页面/祖先、跨空间移动、删除/恢复才跟进，网页直接修改保存后再主动同步。配置阻塞、未登记、只读、页面权限、后端处理和目标变化分别按实际返回报告，详见 [知识库同步](knowledge-sync.md)。OpenViking 保留 `retry_openviking_sync` 兼容别名。

## 默认创建位置

`get_current_user` 返回 `defaults: { spaceId, parentPageId }`，其中 `spaceId` 是必填配置 UUID，`parentPageId` 是配置 UUID 或 `null`（空间根目录）。创建时遵循下面的参数规则：

- 省略 `spaceId` 使用默认空间。
- 省略 `parentPageId`，且创建空间等于默认空间时，继承默认父页；未配置父页则创建在根目录。
- 显式 `parentPageId: null` 表示目标空间根目录，覆盖默认父页。
- 明确指定其他空间时不继承默认父页；省略父页即该空间根目录。
- 显式传入父页 ID 时，该页必须属于目标空间；工具参数支持 UUID/slugId，但默认父页环境变量仅支持规范 UUID。

默认值便利创建，不改变服务器权限或用户授权范围。其他工具的可选空间参数按当前 schema 使用，不假定也会继承创建默认值。

## 正文

写正文仅接受非空 Markdown 或 HTML 字符串，默认 Markdown，不支持编辑器 JSON 写入或空字符串清空。更新正文时必须提供 `operation`，没有默认覆盖操作：

```json
{
  "pageId": "从检索或列表取得的真实页面ID",
  "content": "\n## 新增说明\n\n用户授权追加的内容。",
  "format": "markdown",
  "operation": "append"
}
```

完整替换使用 `replace`；开头插入使用 `prepend`。`create_page` 不使用更新的 `operation`。工具层通过 Docmost API 的编辑器/Yjs 路径更新内容，仍受服务器用户权限校验。schema 严格拒绝额外字段，不要添加未声明参数。

## 复制与移动

复制读取服务器已保存的页面快照；stdio 工具没有用户活跃编辑器状态，不能保证包含尚未落库的协作修改。`duplicate_page` 在同空间原父页下创建副本，根标题加 `Copy of`；`copy_page_to_space` 在目标空间根目录创建，保留根标题。复制会生成新 ID，仅包含可访问子树，不复制评论或源页访问限制；目标空间可能让副本对更多成员可见。先确认源页面、目标空间和用户授权的整个传播范围。响应中的 `hasChildren` / `childPageIds` 是复制返回的结构信息，正文仍须另行 `get_page`；成功响应不保证每个附件均已复制。

`move_page` 的 `parentPageId` 必填：同父页重排时传当前父页 ID，移根时传 `null`。`position` 是 fractional ordering 字符串，不是整数下标；其 5–12 位长度之外仍由服务器验证排序格式。父页必须同空间，服务器拒绝自父和后代循环。

跨空间复制和移动都要求显式目标空间 UUID，包装层先读取确认空间，不借用默认创建位置。`move_page_to_space` 不能移动到源空间；它移动可访问子树，无权访问的子树会在原空间脱离为根，同时更新相关对象的空间关联。源子树与目标空间均须在用户授权范围内。移动结果提供成功状态及规范 ID，不返回新正文；用 `get_page` 和相关目录核对实际位置，不从成功响应推断隐藏后代已逐页验收。

## 空间与评论

空间名称和 slug 长度为 2–100；slug 仅允许字母、数字、下划线和连字符，首字符须字母或数字。`create_space` 的服务器权限是工作区 owner/admin；`update_space` 要求空间管理员。本地更新工具只开放名称和描述，至少提供一个，不添加 slug、分享或评论策略字段。写后用 `get_space` 核对。

评论写入使用非空纯文本 `text`，最多 1,000,000 字符。包装层把文本构造成编辑器 paragraph 文档，再序列化成 REST 所需的 JSON 字符串；HTML 和 Markdown 按字面文本处理，不解析格式。当前工具不接受页面正文的 `content` / `format` / `operation`，也不开放富文本编辑器 JSON、inline selection 或评论解决状态。

`create_comment` 默认创建页面评论；`parentCommentId` 只能指向同页顶层评论，不能回复另一条回复。创建须页面可评论：具有编辑权限，或在空间允许 viewer comments 时拥有读权限。`update_comment` 仅允许评论作者修改，即使空间管理员也不能编辑其他作者的评论。评论写入可能触发 watchers、mention/reply 通知和 websocket 更新；执行用户明确授权的评论操作后，用 `get_comments` 核对结果，不盲目重发。

## 附件与成员

`search_attachments` 的 query trim 后非空且不超过 200 字符；可按空间和创建人 UUID 限制范围，按 `limit/offset` 分页。结果是附件元数据及关联页面/空间，不表示已读取文件内容，也不提供 total。服务按当前用户的空间成员身份、页面限制和未删除祖先过滤。

它调用 `/api/search-attachments`：本 fork 新增社区接口，公司原版或旧部署可能缺少它。只有确定该路由返回 404 时工具报告 `UNSUPPORTED_DEPLOYMENT`；普通资源 404 仍是 `NOT_FOUND`。本地 MCP 安装不更新服务器；需要时由管理员合法部署支持版本。不要把部署不支持解释成零匹配，也不要通过数据库、浏览器抓取或许可绕过补齐。

`list_workspace_members` 按实际服务端 query 搜索姓名或邮箱，返回投影后的成员资料。结果可能含已停用成员，不把列表出现解释成账号仍然活跃。只查询当前任务所需资料，不额外导出整个工作区成员。

## 授权与结果

服务器能力与用户授权分开判断：工具可写、当前账号有权限，不等于用户授权修改所有可访问页面。明确请求的对象和动作即可提供当前操作授权，不重复询问；但不能从“总结页面”推导出修改权限。会话模式与 API Key 模式使用同一组工具和正文/Yjs 更新流程，默认创建位置规则相同。

结果引用使用工具返回的 URL。缺少 URL 时展示标题、空间和 ID，不凭未知路由拼接链接。`list_pages` 是近期列表，不能判断某页是否有后代。`list_child_pages` 可按需分页遍历可见直接子页，但权限过滤不能证明没有隐藏后代，也不能可靠枚举待恢复的软删后代；搜索和分页结果不保证覆盖整个工作区。删除/恢复仍须整棵受影响子树授权，恢复包含此前已软删后代。

若工具缺失、返回身份/许可错误或未知参数契约，报告具体限制；不要自行构造 HTTP 后门、绕过企业许可或伪造 API Token。
# Git 发布扩展

配置一次服务级仓库外私有状态目录即出现，provider=none 也可用，无需固定 Git 根；只读连接只暴露状态工具。以当前 tools/list schema 为准。repositoryRoot 是客户端从当前项目自动检测的规范绝对目录，bind/publish 省略时仅兼容旧 DOCMOST_GIT_ROOT 默认值；status 省略时列出全部项目。

| 工具 | 参数与行为 |
| --- | --- |
| bind_git_document | repositoryRoot、filePath、pageId、commit、branch；已有记录加 replaceBindingId。仅登记一致基线，保留单条记录。 |
| publish_git_documents | repositoryRoot、commit、branch，选填 bindingIds、remote。仅处理当前仓库；显式混入其他项目关联则整批拒绝。完整对象 ID 与完整 refs/heads 分支；正文仅来自提交，remote 只核对推送。 |
| get_git_document_status | 可选 repositoryRoot 和 bindingId；按仓库筛选，指定记录时读取 currentRevision/currentPersistedRevision，不外发知识库。 |
| set_git_document_sync | bindingId、action=pause/resume/unbind/rebind；仅 rebind 需 filePath。早期无实例身份记录以 GIT_IDENTITY_UNCONFIRMED 暂停；用户确认可信原仓库后用 action=confirm-repository 并传 repositoryRoot。核对原路径已确认 blob/hash、保存目录身份及前缀、对账旧写入，不上传。普通 resume 不代替首次信任；保留远端内容，恢复不覆盖冲突。 |
| resolve_git_document_conflict | repositoryRoot、bindingId、commit、branch、expectedRevision。用户选定合并结果并提交后显式条件解决；再次变动继续冲突。 |

Git 来源仍使用原有 retry_knowledge_sync，只补已确认快照。GIT_BRANCH_CONFLICT 需先合并上次 published 提交；GIT_HISTORY_MISSING 需补足历史；GIT_SOURCE_DELETED 保留远端；GIT_REF_CHANGED 需重新检查 HEAD。未确认请求只读对账，不普通更新兜底，不为各分支建副本。
