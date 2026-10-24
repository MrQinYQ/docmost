# 已有 Docmost 页面入库与后续同步

用户要求同步已有、刚创建或刚修改的 Docmost 页面到知识库时，使用本参考。用户要求绑定本地 MD 并在保存后上传全文时，另读 [MD 自动同步](markdown-sync.md)；两种入口共用知识库阶段，页面主动同步不要求 MD 绑定。

## 个人与共享目录

选择 OpenViking 后，引导用户选择“个人（默认）/共享”，并显式保存 `DOCMOST_OPENVIKING_SCOPE=personal|shared`。已有明确选择直接沿用，不从 URL、account 名称或用户提到“资源”推断共享授权。

| 模式 | 默认资源根 |
| --- | --- |
| `personal` | `viking://user/<鉴权用户>/resources/docmost-mcp` |
| `shared` | `viking://resources/docmost-mcp` |

`DOCMOST_OPENVIKING_ROOT_URI` 可覆盖相应模式下的具体子目录；scope 与根类型必须匹配，不允许写资源命名空间根。共享配置示例（合并已有 URL、Key 文件路径与身份校验）：

```toml
DOCMOST_OPENVIKING_SCOPE = "shared"
DOCMOST_OPENVIKING_ROOT_URI = "viking://resources/docmost-mcp"
DOCMOST_KNOWLEDGE_STATE_DIR = "/Users/your-name/.config/docmost/knowledge-shared"
```

共享是同一 OpenViking account 下的资源，由该部署的 ACL 决定可见及可写范围；不复制 Docmost 空间/页面 ACL。目标管理员应先配置需要的共享目录权限，MCP 继承目标 ACL，不设置 `user:*` 或自动扩大授权。当前连接须有写入、重建和清理所需权限；403 单独报告，不换管理员 Key。详见 [OpenViking ACL](https://github.com/volcengine/OpenViking/blob/main/docs/zh/api/12-acl.md)。

每个 MCP 连接只有一个目的地。已有个人任务不能通过修改 scope/root 自动改投共享，包括首次连接离线、尚未确认目标的待办；保留原连接及状态目录，另设共享连接与独立的私有状态目录，再明确同步获准共享的页面。若共享连接不使用 MD，移除它继承的 `DOCMOST_SYNC_ROOT` / `DOCMOST_SYNC_STATE_DIR`，仅配置自己的知识库状态目录。同一页在两套连接的登记相互独立；后续自动跟进各自连接内的 MCP 修改，其他连接/网页改动后须在相应连接显式同步。共享资源根建议由一套同步状态目录负责写入；多台机器独立写同一根无跨机器原子保证。

目录使用 `<资源根>/<空间名>/<完整父页链>/<页面标题>/document.md`。只创建所选页面需要的祖先链，不导入整个空间，父页正文须另行登记。完整 Markdown 保留在 `document.md`；名称经过安全清洗，源部署、工作区、页面 ID 存在私有账本。名称重名、清洗/截断后冲突或目标目录无已知归属时加稳定短后缀；不会仅凭同名或相同正文认领未知目录。

旧长路径记录保持可读；显式同步可写入新位置、核对原文及处理任务后清理已确认属于本页的旧原文。它不自动递归清空旧祖先，也不默认迁移、公开或清理其他资源。清空目录属于单独的破坏性操作，只有用户明确授权该范围后才执行；先备份并等待同步任务结束，不删除活跃租约或清空账本绕过目标保护。所有文档操作通过实际发现的 Docmost MCP 工具，不退回 `ov` CLI。

## 安装、配置与能力发现

源码和 Skill 更新按 [安装配置](setup.md)，使用客户端实际启动的源码版本和入口，构建并重启连接。已有授权和配置直接沿用，不重复询问。选择 `DOCMOST_KNOWLEDGE_PROVIDER=none` 时关闭知识库，不读遗留 Key、不访问服务；当前唯一可选后端为 `openviking`。

在用户选定范围合并现有 OpenViking 连接和私有状态目录，例如：

```toml
DOCMOST_KNOWLEDGE_PROVIDER = "openviking"
DOCMOST_KNOWLEDGE_STATE_DIR = "/Users/your-name/.config/docmost/knowledge-sync"
DOCMOST_OPENVIKING_URL = "http://127.0.0.1:1933"
DOCMOST_OPENVIKING_API_KEY_FILE = "/Users/your-name/.config/docmost/openviking-key"
DOCMOST_OPENVIKING_TIMEOUT_MS = "120000"
```

`DOCMOST_KNOWLEDGE_STATE_DIR` 必须为独立私有绝对目录，省略时复用已有 `DOCMOST_SYNC_STATE_DIR`；保存登记、任务、租约和完整原文快照，不提交 Git 或公开分享。POSIX 目录 `0700`、文件 `0600`，当前用户所有且不是符号链接。页面同步不要求 `DOCMOST_SYNC_ROOT`、本地 MD、绑定或 Docmost 条件同步接口。页面登记和 MD 绑定共用账本，合计最多 50 个关联；同时启用 MD 时，显式知识库状态目录必须与 `DOCMOST_SYNC_STATE_DIR` 相同，否则拒绝启动。已有 MD 绑定不能由主动同步工具自动转换来源。

沿用用户指定的服务和个人身份；远程根 URL 用 HTTPS，不带 API 路径，本机 HTTP 仅允许 loopback。Key 由部署管理员提供，由用户本人私密保存，Agent 只配置文件路径，不索要/读取/回显凭据。可选 `DOCMOST_OPENVIKING_ACCOUNT` / `DOCMOST_OPENVIKING_USER` 校验身份，`DOCMOST_OPENVIKING_ROOT_URI` 指定所选模式的资源根，不能切换 Key 所属身份。详见 [Key 保存与连接](markdown-sync.md#openviking-key-私密保存)。不安装 `ov` CLI、Python 或额外 npm 包，不部署服务。

正文会送往所选服务，摘要/向量供应商由服务管理，可能调用外部模型；首次写入和删除可能刷新祖先目录摘要。沿用已有明确的目的地、用途、正文及摘要刷新授权；缺失且影响是否允许外发时再厘清范围。配置和安装不授权全量工作区导入。

构建后先带入所选连接变量运行独立只读 `--check-knowledge`。它无需 Docmost 登录、默认空间、MD 源目录或页面登记，不上传/创建/重建/删除；通过不证明真实写入或摘要/索引能力。知识库失败单独报告，普通 Docmost 接入可继续。

重启后发现实际工具和 schema。可写连接应有 `sync_page_to_knowledge`、`get_page_knowledge_status`、`retry_knowledge_sync`；只读连接只查询状态，不写知识库。缺少时核对版本、实际入口、状态目录、provider 和只读配置，不能默认改用 CLI、HTTP 或 MD 绑定绕过。

## 同步已有页面

1. 用 `search_pages` / `get_page` 定位用户授权页面并取得规范 UUID；不要传完整 URL 或 slugId。确认用户要求的是入库范围，已有授权直接执行。
2. 调用 `sync_page_to_knowledge({pageId})`。工具重新读取 Docmost 当前已保存的**完整 Markdown**，入库并登记；不是摘要、搜索片段或本次追加内容。尚未保存的浏览器协作修改不属于当前已保存快照。
3. 调用 `get_page_knowledge_status({pageId})`，读取登记的 `bindingId`、精确 URI、原文哈希、处理进度及安全错误；省略 `pageId` 查看登记列表。状态查询不触发外发。
4. 分别报告“Docmost 页面已存在/修改成功”与“知识库等待/处理/完成/失败”。知识库失败时保留关联标识，先排查实际错误，再用 `retry_knowledge_sync({bindingId})` 对账并补知识库阶段，不重复 Docmost 创建、追加或覆盖。

例如用户要求“把刚才那页同步到 OpenViking，并跟进以后的修改”，取得规范 UUID 后调用：

```json
{
  "pageId": "11111111-1111-4111-8111-111111111111"
}
```

上例 UUID 必须换成 `get_page` 的真实 `id`。这组参数用于 `sync_page_to_knowledge`；完成后用同一 UUID 查询状态。

单页结果含 `source: "docmost"`、`bindingId`、页面/空间/工作区 UUID、`enabled`、`state`、`localHash`、`remoteRevision` 和独立的 `knowledgeBase`；后者含 provider、启用状态、状态及适用的 URI / 已确认指纹 / 错误，保留 `openViking` 兼容字段。指定页面的状态工具返回同形态；未登记为 `state: "not_enrolled"`；无参返回 `state`、`readOnly`、`knowledgeBase` 及仅页面来源的 `bindings`。

`localHash` / `remoteRevision` 是当前已保存完整 Markdown 的 SHA-256 正文指纹，不是实时协作版本或 CAS 令牌。顶层 `state` 不等于知识库完成；看 `knowledgeBase.state`。MCP 正文更新已成功但数据库导出尚未追上时显示 `waiting_docmost`，等待并核对，不重放 Docmost 写入或宣称已入库。

新的页面来源须逐级完成页面目录、Docmost 父目录链和空间目录的非递归摘要/向量任务后，知识库才为 `synced`；旧页面账本可通过一次显式同步补齐祖先阶段。此条件不追溯到原有 MD 链路。

同一页上一笔正文保存未确认时，再次改正文会在 Docmost 更新派发前返回 `SAVE_PENDING`。先等待并用 `get_page` 确认上一版保存，再执行这笔尚未派发的修改，不重放已经成功的那一笔。完全相同 Markdown 的替换不应阻塞标题/目录刷新；服务器规范化后正文未变而仍等待时，可在读回确认后显式 `sync_page_to_knowledge` 选择当前已保存完整快照刷新。它不重放写入，也不把尚未落库内容当作已确认版本。

## 后续行为与范围

普通 `create_page` 不会自动开启新页外发；“创建并入库”先创建、读回，再明确同步。登记后，本 MCP 的正文/标题更新、移动该页或其祖先、跨空间移动、软删除/恢复会跟进登记页镜像。父页操作只处理可证明属于本次子树且发生相应状态转换的活跃登记子集，不导入未登记后代。

网页直接修改无后台监听；用户保存后再次显式 `sync_page_to_knowledge` 刷新。MCP 未运行时没有独立守护进程。MD 绑定的暂停、冲突及条件写入另按 MD 参考处理，不强加给无 MD 的页面登记。

URI 使用所选资源根 / 空间名 / 完整父链标题 / 页面标题 / `document.md`。空间/父链变化后以状态返回的精确 URI 为准，不自行拼路径。原文读回与哈希一致后还须核对本次摘要/向量处理任务和限定 URI 检索；HTTP 成功、摘要或旧任务成功都不能替代本次完整原文验收。不使用 `add-resource`，不迁移或清理旧 CLI 导入。

## 各工具的失败处理

| 场景 | 动作 |
| --- | --- |
| 主动同步的 Docmost 读取失败、页面不可访问或不存在 | 报告实际身份/权限/页面错误，不声称已入库，不绕过权限读取。 |
| 主动同步的 provider、私有状态目录、连接或身份配置错误 | 报告知识库阻塞及缺少项，按已授权范围修正；不改目标、不重放 Docmost。 |
| 状态显示未登记 | 如实报告；状态查询不自动外发。用户要求入库时再调用同步工具。 |
| 状态显示 `pending` / `processing` / `retrying` | 报告尚未完成并保留关联；先对账再决定是否需要通用重试。 |
| 再次改同页正文收到 `SAVE_PENDING` | 本次 Docmost 更新未派发，等待上一笔保存确认，再执行本次请求；不重放已成功写入。 |
| 页面返回 `LEASE_BUSY` | 同一账本的另一次有限操作仍在进行，或旧版连接持有页面锁。先等待再重试；旧版连接正常重连一次。新版操作结束即释放，已确认退出的持有者可自动回收。不删活锁、不换账本、不重复创建或改用 `ov` CLI。 |
| 状态显示 `blocked` 或目标变化/外部写入冲突/提交不确定 | 展示安全错误，先查原因；不删账本、不清空目录或构造新 URI 强行重试。 |
| 重试的关联未知、已停止或目标不匹配 | 报告实际返回，不猜 bindingId，不用页面 UUID 冒充关联标识。 |
| 当前只读或工具缺失 | 只读查状态；用户授权配置可写/更新版本后合并并重启，不退回 CLI。 |

明确错误包括 `BINDING_EXISTS`（已有 MD 绑定或占用）、`BINDING_LIMIT`（同目录关联上限）、`IDENTITY_CHANGED` / `TARGET_CHANGED`、`UNAUTHENTICATED` / `FORBIDDEN` / `NOT_FOUND` 和 `INVALID_RESPONSE`。页面响应正文上限 1,000,000 UTF-8 字节；空正文不套用 MD 文件非空限制。重试的未知关联为 `NOT_FOUND`，非法 UUID 由 schema 拒绝。读取 `knowledgeBase.error` 了解知识库单独错误；不把所有失败统称为未配置。返回字段及错误码以实际工具 schema/结果为准。OpenViking 的 `retry_openviking_sync` 是兼容别名，优先通用 `retry_knowledge_sync`。任务绑定原 provider、部署、身份及资源根，改配置不会把旧任务改投新目标。

验收业务原文时只读并入库，完整原文/hash、摘要/向量任务和检索分别核对。镜像内部会做完整原文读回与哈希校验；当前只有 Docmost MCP 时可报告工具确认的知识库状态。没有独立 OpenViking 原文读取/任务/检索能力时，额外独立验收标记未执行，不为此默认退回 CLI，也不把缺少检索工具当作同步失败。正文更新、改名、移动、删除/恢复只在用户已授权的测试副本执行。没有实际目标服务返回时如实标记未验收，不用安装成功或模拟测试结果代替真实服务证据。
