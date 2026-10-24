# 可选知识库同步

选择 OpenViking 后继续引导“个人（默认）/共享”：配置 `DOCMOST_OPENVIKING_SCOPE=personal|shared`，默认根分别为 `viking://user/<用户>/resources/docmost-mcp` 与 `viking://resources/docmost-mcp`。共享使用同一 account 的目标 ACL，不自动复制 Docmost 权限；已有个人任务不得直接改投共享，应另设连接和独立私有知识库状态目录。目录规则、授权和双连接跟进范围见 [OpenViking 个人与共享目录](openviking-sync.md#个人与共享目录)。

## 可直接交给 Agent 的安装与接入指令

```text
请按同版本 docs/local-mcp.md 从 GitHub 源码安装或更新 Docmost MCP 和 docmost-mcp Skill。标准安装时主动让我选择“不启用知识库 / OpenViking”；已有明确选择和授权直接沿用。新配置显式保存 DOCMOST_KNOWLEDGE_PROVIDER=none 或 openviking。

选择 none 时跳过知识库地址、Key、身份和私有根，不读取遗留 Key、不访问服务。选择 OpenViking 时沿用我指定的既有服务根地址、仓库外私有 Key 文件、个人/共享模式、可选预期账户/用户和所选资源根，说明正文、摘要/向量处理及父目录摘要刷新范围。Key 由管理员提供给个人用户，由我本人在真实本机终端隐藏输入保存到仓库外 0600 文件；你只配置路径，不读取或回显 Key，不代跑私密输入，不安装 ov/Python、部署服务或改投别的目标。

我要同步的是 Docmost 已有页面时，不要求本地 MD、DOCMOST_SYNC_ROOT、MD 绑定或条件同步接口。配置独立私有绝对目录 DOCMOST_KNOWLEDGE_STATE_DIR；已有 DOCMOST_SYNC_STATE_DIR 可直接复用为默认知识库状态目录。保留现有 Docmost 认证和默认位置，合并配置后构建并重启实际连接。先独立只读 --check-knowledge，再发现工具与 schema：可写连接应有 sync_page_to_knowledge、get_page_knowledge_status、retry_knowledge_sync；只读连接只查询状态，不能发起同步。

在我授权的页面范围，用 search_pages/get_page 取得规范 UUID，调用 sync_page_to_knowledge({pageId}) 将该页当前已保存的完整 Markdown 入库并登记。不要只上传摘要、搜索片段或本次追加的增量，不要求我先导出 MD，也不要默认改用 ov CLI 或 add-resource。用 get_page_knowledge_status({pageId}) 分别报告登记、URI、原文哈希、处理进度和错误；未成功时按状态排查，必要时用返回的 bindingId 调用 retry_knowledge_sync，只补知识库，不重放 Docmost 写入。

请说明：普通 create_page 不会自动开启新页面外发；登记后，通过本 MCP 修改正文/标题、移动该页或其祖先、跨空间移动、软删除及恢复会跟进登记页镜像。网页直接修改没有后台监听，保存后再次显式调用同步工具即可。不要全量导入工作区，不迁移或清理旧 CLI 导入。安装和只读检查不等于授权创建测试页；真实写验收按已授权对象执行，业务原文只读入库，改名/移动/删除使用测试副本。知识库失败单独报告，继续完成可用的 Docmost 接入。
```

本地 MCP 当前只实现 OpenViking 知识库适配器。用户可主动同步 Docmost 已有页面，也可选择本地 MD → Docmost → 知识库的既有链路；两者共用私有镜像、任务对账和通用重试，分别报告 Docmost 与知识库结果。知识库失败不重放已成功的 Docmost 写入。

## 选择适合的入口

| 用户需求 | 入口与前提 |
| --- | --- |
| 将 Docmost 当前已保存页面入库，后续 MCP 修改也跟进 | `sync_page_to_knowledge({pageId})`；需要规范页面 UUID、知识库连接及私有状态目录，不需要本地 MD、绑定或条件同步接口。 |
| 查看已登记页的镜像、原文哈希和错误 | `get_page_knowledge_status({pageId?})`；不带页面参数查看登记列表，读取状态不会导出正文。 |
| 知识库阶段失败后补处理 | 用状态返回的 `bindingId` 调用 `retry_knowledge_sync`，不重写 Docmost。 |
| 绑定本地 MD，保存后自动替换 Docmost 全文并镜像 | 仍用 `bind_markdown` 等 MD 工具；仅此路径需要 MD 源目录、私有状态目录及部署的条件同步接口，见 [MD 自动同步](md-auto-sync.md)。 |

普通 `create_page` 创建的新页不会仅因配置了知识库就自动外发。用户要求“创建并入库”时先创建、读取确认，再明确调用页面同步工具。用户要求同步已有页时优先页面工具，不强行建立 MD 绑定，不默认退回 `ov` CLI。

## 配置与独立只读检查

| 配置 | 行为 |
| --- | --- |
| `DOCMOST_KNOWLEDGE_PROVIDER=none` | 明确关闭知识库；覆盖遗留 `DOCMOST_OPENVIKING_*`，不读取其 Key 或发起网络请求。 |
| `DOCMOST_KNOWLEDGE_PROVIDER=openviking` | 使用既有 `DOCMOST_OPENVIKING_*` 连接；缺失或错误配置独立报告阻塞。 |
| 省略 provider，已有非空 `DOCMOST_OPENVIKING_URL` | 为旧安装兼容选择 OpenViking；新安装应显式保存选择。 |
| 省略 provider，也无 OpenViking URL | 关闭知识库。 |
| 其他 provider | 独立报告不支持，不静默切换后端。 |
| `DOCMOST_KNOWLEDGE_STATE_DIR` | 页面登记、任务和完整原文快照的私有绝对目录；省略时复用已有 `DOCMOST_SYNC_STATE_DIR`。不需要额外 MD 源目录。 |

页面登记与 MD 绑定共用同一账本。若同时启用 MD 且显式填写 `DOCMOST_KNOWLEDGE_STATE_DIR`，它必须与 `DOCMOST_SYNC_STATE_DIR` 相同；不同目录会拒绝启动。两种来源在同一目录合计最多 50 个关联，已绑定 MD 的页面不能由主动同步工具自动转换成页面来源。

状态目录不提交 Git，不作为可公开日志。POSIX 目录 `0700`、文件 `0600`，当前用户所有且不是符号链接。正文快照可能包含业务原文，检查和分享状态时只使用工具的安全投影，不打开整个目录输出。没有任何可用的私有状态目录时，页面登记/同步不可用，应先补齐配置。

在现有 MCP 环境中合并，例如：

```toml
DOCMOST_KNOWLEDGE_PROVIDER = "openviking"
DOCMOST_KNOWLEDGE_STATE_DIR = "/Users/your-name/.config/docmost/knowledge-sync"
DOCMOST_OPENVIKING_URL = "http://127.0.0.1:1933"
DOCMOST_OPENVIKING_API_KEY_FILE = "/Users/your-name/.config/docmost/openviking-key"
DOCMOST_OPENVIKING_TIMEOUT_MS = "120000"
```

其余可选预期账户/用户、私有根和 Key 保存方法见 [OpenViking 指南](openviking-sync.md)。设置知识库不改变 Docmost 认证，也不要求企业 API Key。无需本机 `ov`、Python 或额外 npm 包，MCP 不部署服务。provider、部署、身份和根固定任务目标；切换配置不会把旧任务改投新目标，不清空账本绕过目标保护。

构建后带入所选 OpenViking 连接变量运行独立只读检查，无需 Docmost 登录、默认空间、MD 源目录或页面登记：

```sh
DOCMOST_KNOWLEDGE_PROVIDER=openviking \
DOCMOST_OPENVIKING_URL=https://openviking.example.com \
DOCMOST_OPENVIKING_API_KEY_FILE=/Users/your-name/.config/docmost/openviking-key \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge
```

已配置预期身份、私有根或超时，应带入相同值。关闭模式只需设置 `DOCMOST_KNOWLEDGE_PROVIDER=none` 运行同一命令，不读遗留 Key、不访问网络。错误配置、身份错误、不可达或不支持时检查非零，普通 Docmost 仍独立可用。检查不上传正文、创建目录、重建索引或删除资源；通过不代表页面状态目录、真实写入、摘要与索引已验收。

## 页面主动同步与后续跟进

1. 确认当前连接实际具有新工具及其 schema；缺少时先检查源码版本、实际启动入口、构建结果、状态目录、provider 和只读设置，再重启。不能仅看安装成功或固定工具总数。
2. 在用户授权的页面范围，通过 `search_pages` / `get_page` 取得规范 UUID；页面 URL 或 slugId 不能直接传给主动同步工具。确认页面已保存，明确目的地及模型处理授权；已有授权直接沿用。
3. 调用 `sync_page_to_knowledge({pageId})`。工具重新读取 Docmost 当前已保存的**完整 Markdown**，登记后送入选定知识库，不把传给 `update_page` 的追加片段当成全文，也不上传摘要代替原文。
4. 调用 `get_page_knowledge_status({pageId})` 查看该页的 `bindingId`、精确 URI、原文哈希、同步/处理阶段及安全错误；工具只读，不创建登记、不触发导出。待处理与失败分别报告，不能把 Docmost 成功合并成“两端成功”。
5. 需要补处理时对返回的关联调用 `retry_knowledge_sync({bindingId})`，先对账再补知识库阶段。它不修改 Docmost、不接受任意 URI、不把旧任务改投新目标。

登记后，本 MCP 的正文/标题更新、`move_page`、`move_page_to_space`、`delete_page` 和 `restore_page` 会跟进镜像。移动或改名祖先时也核对已登记后代的新路径；删除/恢复只处理可证明属于本次操作且发生对应状态转换的活跃登记页，不扩大到未登记子树。Docmost 已成功而知识库待处理/失败时，不重复执行 Docmost 修改。

网页直接修改没有后台监听。用户保存后再次调用 `sync_page_to_knowledge`，以当前已保存全文刷新；MCP 未运行时也没有独立守护进程。布局使用所选资源根下的空间名、完整父链与页面标题，仅名称冲突时增加短后缀，身份保留在私有账本，原文存为 `document.md`，详见 [OpenViking 镜像](openviking-sync.md#空间和父子目录)。不使用 `add-resource`，不迁移、清理或接管旧 CLI 导入。

## 状态与错误的处理

| 工具或阶段 | 应报告和采取的动作 |
| --- | --- |
| `sync_page_to_knowledge` 无法读取页面 | 报告 Docmost 身份、权限或页面不存在等实际错误，不声称已入库，不绕过权限另行抓取。 |
| 页面工具未注册，或同步返回知识库配置/身份阻塞 | `none` 或未配置状态目录时先补已授权配置并重启；其他错误展示实际安全状态。不把它视为 Docmost 写入失败，也不自行改 provider/目标。 |
| `sync_page_to_knowledge` 已登记但后端处理中/失败 | 保留 `bindingId`，查状态并区分排队、处理、重试和需人工处理；不重复创建或追加 Docmost。 |
| `get_page_knowledge_status` 尚未登记 | 报告未登记；查询本身不等于登记或外发授权。 |
| `get_page_knowledge_status` 返回 `retrying` / `blocked` | 展示安全错误，网络问题等待或补处理；配置、身份、外部写入冲突和提交不确定须先排查。 |
| 同一页面再次更新正文返回 `SAVE_PENDING` | 上一次正文保存尚未确认；本次没有派发 Docmost 更新。先等待并读取确认上一版已保存，再执行这次尚未派发的修改，不重放上一笔成功写入。 |
| 页面返回 `LEASE_BUSY` | 同一账本的另一次有限操作仍在进行，或旧版连接持有页面锁。先等待再重试；旧版连接正常重连一次。新版操作结束即释放，已确认退出的持有者可自动回收。不删活锁、不换账本、不重复创建或改用 `ov` CLI。 |
| `retry_knowledge_sync` 未知关联、目标变化或无法确认旧任务 | 报告实际错误，先对账，不删账本、不构造新 URI，也不重放 Docmost。 |
| 当前连接只读或工具缺失 | 只查询状态；用户授权可写连接后合并配置并重启，不用 CLI 绕过。 |

页面主动同步返回单页快照：`source: "docmost"`、`bindingId`、`pageId`、`spaceId`、`workspaceId`、`enabled`、`state`、`localHash`、`remoteRevision`，适用时有来源侧 `error`；独立的 `knowledgeBase` 含 `provider`、`enabled`、`state` 和适用的 `uri` / `confirmedRevision` / `error`，`openViking` 保留兼容。`get_page_knowledge_status({pageId})` 返回同一形态，未登记时返回 `state: "not_enrolled"`；无参返回顶层 `state`、`readOnly`、`knowledgeBase` 和仅包含页面来源的 `bindings` 列表。

这里的 `localHash` / `remoteRevision` 是已保存完整 Markdown 的 SHA-256 正文指纹，不是协作实时版本或 CAS 写入令牌。顶层页面来源的 `state` 不代表知识库已处理完成，必须单独看 `knowledgeBase.state`。MCP 正文更新已成功但数据库导出尚未追上时，知识库为 `waiting_docmost`；等待保存结果后再核对，不重复 Docmost 写入，也不报已入库。

新的页面来源链路须逐级完成页面目录、Docmost 父目录链和空间目录的非递归摘要/向量任务，才将知识库报告为 `synced`；旧页面账本可通过一次显式同步补齐祖先阶段。此完成条件不追溯到原有 MD 链路。

同一已登记页上一笔正文保存未确认时，再次修改正文会在 Docmost 更新派发前返回 `SAVE_PENDING`，避免后一笔覆盖前一笔同步意图。完全相同 Markdown 的替换不应阻塞标题/目录刷新。若服务器规范化后正文未变而仍在等待，先用 `get_page` 确认当前已保存内容，再显式 `sync_page_to_knowledge` 选择这份已保存完整快照刷新；该操作不重放 Docmost 更新，也不代表尚未落库的修改已完成。

常见明确错误包括：已有 MD/占用记录的 `BINDING_EXISTS`、同目录关联上限的 `BINDING_LIMIT`、账号/目标变化的 `IDENTITY_CHANGED` / `TARGET_CHANGED`、页面身份/权限/不存在的 `UNAUTHENTICATED` / `FORBIDDEN` / `NOT_FOUND`，以及响应正文或元数据不合法的 `INVALID_RESPONSE`。页面正文超过 1,000,000 UTF-8 字节也会拒绝，空正文则不套用 MD 文件的非空约束。重试使用未知 `bindingId` 返回 `NOT_FOUND`，不能把页面 UUID 当作关联标识。非法 UUID 先由工具 schema 拒绝。知识库错误读取 `knowledgeBase.error`，不要把它与 Docmost 错误混成一项。

具体返回字段和错误码以当前工具 schema 与实际结果为准。`synced`、原文哈希一致、摘要/向量处理完成、可检索分别是不同证据：验收要读回精确 URI 的完整原文核对哈希，再核对本次处理任务和限定 URI 的检索。看到 HTTP 成功、摘要或历史成功任务不能替代完整原文与本次处理结果。

镜像内部会做完整原文读回与哈希校验；只有 Docmost MCP 能力时，可如实报告工具确认的知识库状态。若当前没有独立的 OpenViking 原文读取/任务/检索工具，额外的独立验收应标记未执行，不为补这一步默认退回 `ov` CLI，也不把缺少检索能力当作同步失败。

## 页面链路验证：初验与恢复后续验

本次完整自动测试 **361/361 通过**。真实页面链路使用用户授权的三篇业务原文及独立测试副本，验证范围与结果如下；不使用此前 MD 链路的验收结果代替新页面能力。

| 范围 | 本次证据与结果 |
| --- | --- |
| 三篇原文入库 | 完整原文读回的哈希与字节数一致；再次从 OpenViking 独立读回的三份原文哈希仍吻合。 |
| 空间与父链 | 已核对目标空间及两级 Docmost 父链对应的私有目录布局，实存 L0/L1、处理任务和限定 URI 检索通过。 |
| 副本正文更新 | MCP 追加后，完整更新正文自动同步与限定检索通过，未仅上传追加片段。 |
| 副本移动 | 恢复访问后从原断点续跑，新 URI 全文正确、旧 URI 原文缺失，页面与父链任务完成并达到 `synced`。未重放创建、追加或移动。 |
| 副本删除 | 新旧两个原文 URI 均缺失；两项限定检索未返回已删除副本，八项父目录摘要检查无残留引用，镜像状态为 `deleted`。 |
| 恢复与目录清理 | 临时恢复专用测试子树，明确登记临时父页；父子全文均重新同步后，通过 MCP 级联软删除。两个镜像均为 `deleted`，临时父目录缺失，六项祖先摘要检查无测试父子页引用。 |
| 最终原文复核 | 三篇业务原文在 Docmost 的正文与元数据保持基线，OpenViking 中的完整原文哈希也全部吻合。两个测试页均确认软删除。 |

初验曾因部署首页和 API 均返回 403 中断，用户本人也无法访问。上述移动、删除及最终复核是在部署恢复后继续原任务完成，未删除账本、重建业务页面或更换接入方式。真实写操作均通过 Docmost MCP；独立 OpenViking 探针只读。自动回归在本轮再次 **361/361 通过**。

本机续验、目录专项清理及独立读回证据分别为 ignored 的私有文件 `data/local-docmost/page-knowledge-acceptance-2026-10-15-resumed.json`、`page-knowledge-parent-cleanup-2026-10-15.json` 和 `page-knowledge-resumed-readback-2026-10-15.json`，不提交 Git。初始失败报告保留供对账；这不是单次从零运行的完整脚本记录。

验收时临时父页也应明确登记入库。仅作为路径出现的未登记父页没有自身的删除任务，可能保留派生目录摘要；验收脚本已加入父页登记及原文、生成目录缺失的清理检查，不以 Docmost 软删除成功代替知识库清理完成。

## 自己验收

1. 重连实际 MCP，确认发现页面入库、状态和通用重试工具。
2. 在默认空间根目录创建一个专用测试父页及其子页，子页写“第一行”；读回后将父子页都显式入库，等待各自 `knowledgeBase.state` 为 `synced`。
3. 用 MCP 给子页追加“第二行”，等待自动同步，再读取确认完整正文；知识库应保留两行。
4. 读取子页当前 `position`，用 `move_page` 将子页移动到同空间根目录，等待 `synced` 并确认状态返回新 URI。具有独立读取能力时核对新 URI 全文与旧 URI 缺失。
5. 先软删除测试子页，再软删除测试父页，分别等待 `deleted`；具有独立读取/检索能力时检查原文、生成目录和索引清理。

只操作这两张专用测试页。网页直接修改后需显式刷新；只有 MCP 操作会自动跟进。只有 Docmost MCP 时按工具报告状态，缺少的独立原文/检索检查如实标记，不默认改走 `ov` 命令。

## 开发与历史验收边界

开发入口见 [知识库注册与协调](../packages/mcp/src/knowledge.mjs)及 [OpenViking 适配器](../packages/mcp/src/knowledge-adapters/openviking.mjs)。共享层保持私有快照、持久化任务和目标保护，OpenViking URI、摘要/向量任务与清理保留在适配器内部。当前只支持 `none` 与 `openviking`，不承诺其他后端接口。

以下记录仅为此前 MD 适配链路的历史基线，**不覆盖本次新增的页面主动同步与自动跟进**。新能力的真实验收应区分业务原文的只读入库和测试副本的改名、移动、删除、恢复，按实际结果记录；不拿旧数字宣称新能力已通过。

### 此前适配层验证记录


2026-10-15 适配层的完整 MCP 构建与测试 **325/325**；在新建临时目录仅安装本包现有依赖后，同样 **325/325**，源码与测试一致。覆盖显式关闭的零知识库凭据读取/零请求、旧配置推断、不支持的 provider、独立只读诊断、目标固定、旧账本及协议回归。额外的测试适配器使用非 OpenViking URI 验证通用入口；它不属于可选产品后端。安装流程经独立场景审阅；shell 示例仅做语法检查，不代表已部署用户的真实服务。

该适配层基线的本机真实回归按组完成：

| 分组 | 结果 |
| --- | --- |
| `--tail-only` | **8/8**：28 个工具及兼容别名、显式 none 覆盖遗留配置、独立只读探针、不可达时 Docmost 仍成功，通用重试前后 Docmost 写请求均为 2。 |
| `--delete-only` | **10/10**：初始与恢复的四个新完整处理任务成功；通用状态与旧字段一致；恢复前父子页原文、目录和 L0/L1 摘要均缺失，六个 level 0/1/2 限定查询均为零。 |

两组均清理自己的页面、空间、测试根和临时文件，专用会话注销后重放返回 401；队列结束后精确测试根为 404，至少 10 秒后再次确认。独立探针的 none 模式零请求，OpenViking 模式只读 `GET /health`；入库、删除与恢复由后续已授权的测试步骤分别证明。报告权限 `0600`，位于 ignored 的 `data/local-docmost/openviking-sync-acceptance-provider-tail-only.json` 和 `openviking-sync-acceptance-provider-delete-only.json`。

这是此前适配层版本的分组验收，未重跑脚本的完整主流程；更早的 OpenViking 验收记录保留在 [原始指南](openviking-sync.md#在授权测试范围验收)。真实验证对象为本机 Docmost 与 OpenViking 0.4.19，未对远程 TLS 部署执行真实写验收。
