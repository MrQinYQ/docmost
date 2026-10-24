# 可选 OpenViking 镜像

OpenViking 是[可选知识库适配层](knowledge-sync.md)当前唯一实现。已有 Docmost 页面可通过 `sync_page_to_knowledge` 将当前已保存的完整 Markdown 入库并登记；登记后，本 MCP 的正文/标题更新、移动（含祖先）、跨空间移动、软删除与恢复会跟进镜像。也保留本地 MD → Docmost 确认 → 知识库链路。只管理明确登记的页面，不导入整个工作区；普通 `create_page` 不会自动开启外发，网页直接修改没有后台监听，保存后再显式同步即可。

可复制的安装指令见 [知识库接入指南](knowledge-sync.md#可直接交给-agent-的安装与接入指令)。先按 [本地 MCP 安装指南](local-mcp.md) 配置连接，合并 OpenViking 变量及私有 `DOCMOST_KNOWLEDGE_STATE_DIR`（省略时复用已有 `DOCMOST_SYNC_STATE_DIR`）。页面同步不需要本地 MD、源目录、绑定或条件同步接口；仅本地 MD 链路按 [Markdown 自动同步](md-auto-sync.md) 另行配置。核对实际源码版本、构建入口，重启连接发现工具；知识库失败独立报告，不重放 Docmost 写入。

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

每个 MCP 连接只有一个目的地。已有个人任务不能通过修改 scope/root 自动改投共享；保留原连接及状态目录，另设共享连接与独立的私有状态目录，再明确同步获准共享的页面。若共享连接不使用 MD，移除它继承的 `DOCMOST_SYNC_ROOT` / `DOCMOST_SYNC_STATE_DIR`，仅配置自己的知识库状态目录。同一页在两套连接的登记相互独立；后续自动跟进各自连接内的 MCP 修改，其他连接/网页改动后须在相应连接显式同步。共享资源根建议由一套同步状态目录负责写入；多台机器独立写同一根无跨机器原子保证。

目录使用 `<资源根>/<空间名>/<完整父页链>/<页面标题>/document.md`。只创建所选页面需要的祖先链，不导入整个空间，父页正文须另行登记。完整 Markdown 保留在 `document.md`；名称经过安全清洗，源部署、工作区、页面 ID 存在私有账本。名称重名、清洗/截断后冲突或目标目录无已知归属时加稳定短后缀；不会仅凭同名或相同正文认领未知目录。

旧长路径记录保持可读；显式同步可写入新位置、核对原文及处理任务后清理已确认属于本页的旧原文。它不自动递归清空旧祖先，也不默认迁移、公开或清理其他资源。清空目录属于单独的破坏性操作，只有用户明确授权该范围后才执行；先备份并等待同步任务结束，不删除活跃租约或清空账本绕过目标保护。所有文档操作通过实际发现的 Docmost MCP 工具，不退回 `ov` CLI。

## 服务、身份与授权

标准 MCP/Skill 安装主动提供“不启用知识库 / OpenViking”选择，已有明确设置不重复询问。新安装显式配置 `DOCMOST_KNOWLEDGE_PROVIDER=none|openviking`：`none` 跳过后端问题并覆盖遗留 OpenViking 变量，不读取 Key、不访问服务。明确选择 OpenViking 时必须提供 URL；省略 provider 时，才为旧安装兼容由已有非空 URL 推断启用，无 URL 则关闭。其他 provider 独立报告不支持，不回退到 OpenViking。

OpenViking 可以是本机已有服务，也可以是远程 HTTPS 部署。本地 MCP 仅通过 HTTP 连接，无需安装 `ov` 命令、Python 或额外 npm 包；安装 MCP 不会自动部署、启动或修改 OpenViking 服务，也不检查本机是否安装 OpenViking。

协议适配基于 OpenViking 0.4.19 的内容写入、重建、任务和文件接口。远端部署须提供兼容接口与可核对的个人鉴权身份；地址能访问不能代替兼容性验收。

向 OpenViking 部署管理员取得属于预期个人用户的 API Key，复用用户选择的现有账户和用户。不要默认新建用户，也不要要求共享管理员身份。Key 的创建方式由该部署的管理能力决定；本 MCP 不提供管理员发 Key 的入口。OpenViking Key 与 Docmost 的个人会话、企业 API Key 相互独立，不能互用；启用镜像也不要求 Docmost 企业许可。

连接会核对鉴权返回的账户和用户；HTTP 200 或 `/health` 可访问本身不能证明身份正确。可选账户/用户配置用于校验，不能把已有 Key 切换成另一个用户。已有持久化任务固定到原 provider、部署、身份和根 URI；首次连接尚未成功时，也保存排队时的个人/共享模式及根意图，修改配置不会将它们自动迁到新目标；不清空账本绕过目标保护。

OpenViking 的摘要可能调用该部署配置的外部模型，向量供应商也由该服务管理。启用前应明确目标服务、所选页面完整正文或已绑定 MD 的处理目的和授权；已有明确授权无需重复确认。复用现有个人用户时，还须理解：首次写入及删除可能向上刷新目录摘要，祖先目录可能已有其他资料的摘要。授权这种摘要刷新不等于授权导入或改写其他原始资料。新页面来源逐级执行页面目录、Docmost 父链和空间目录的非递归摘要/向量任务，全部完成后知识库才为 `synced`；旧页面账本可显式同步补齐该链。MD 链路保持原有处理语义，不据此声称已具备强制全祖先阶段。

## 用户在自己的终端保存 Key

Key 保存到仓库外、当前用户所有的私有普通文件，POSIX 权限 `0600`，目录 `0700`，不使用符号链接。Agent 可以配置文件路径，但不索要、读取、显示或记录 Key，不把 Key 写进聊天、环境变量值、命令参数、源码或 npm 配置。模型 Key 也不属于此 MCP 的配置。

以下示例由用户在自己的真实本机 **Bash 或 Zsh** 终端运行，交互输入隐藏；`read` 和 `printf` 明确使用 shell 内建命令。示例保留已有凭据文件，轮换时先由用户确认用途，再私密更新并撤销旧 Key。

```bash
(
  set +x
  umask 077
  mkdir -p "$HOME/.config/docmost"
  chmod 700 "$HOME/.config/docmost"
  docmost_ov_key_file="$HOME/.config/docmost/openviking-key"
  if [ -e "$docmost_ov_key_file" ] || [ -L "$docmost_ov_key_file" ]; then
    builtin printf '凭据文件已存在，请先确认用途并保留原文件。\n' >&2
  else
    builtin printf 'OpenViking API Key: ' >&2
    if ! builtin read -r -s docmost_ov_key || [ -z "$docmost_ov_key" ]; then
      builtin printf '\n未输入 Key，未创建凭据文件。\n' >&2
      unset docmost_ov_key
      exit 1
    fi
    builtin printf '\n' >&2
    set -o noclobber
    if ! builtin printf '%s\n' "$docmost_ov_key" > "$docmost_ov_key_file"; then
      unset docmost_ov_key
      exit 1
    fi
    unset docmost_ov_key
  fi
)
```

客户端配置只填写生成文件的实际绝对路径。不要让 Agent 读取文件内容来验证；连接错误通过安全错误码、路径权限与部署身份排查。

## 配置连接

在已有 MCP 环境变量中合并以下项目，保留 Docmost 的部署、认证和默认位置。例如本机已有 OpenViking HTTP 服务：

```toml
DOCMOST_KNOWLEDGE_PROVIDER = "openviking"
DOCMOST_KNOWLEDGE_STATE_DIR = "/Users/your-name/.config/docmost/knowledge-sync"
DOCMOST_OPENVIKING_URL = "http://127.0.0.1:1933"
DOCMOST_OPENVIKING_API_KEY_FILE = "/Users/your-name/.config/docmost/openviking-key"
DOCMOST_OPENVIKING_SCOPE = "personal"
# 以下项目均可省略；填写时必须与模式和鉴权身份相符。
# DOCMOST_OPENVIKING_ACCOUNT = "personal"
# DOCMOST_OPENVIKING_USER = "your-user"
# DOCMOST_OPENVIKING_ROOT_URI = "viking://user/your-user/resources/docmost-mcp"
# 完整摘要处理较慢时建议设置；省略时默认 30000。
DOCMOST_OPENVIKING_TIMEOUT_MS = "120000"
```

远程服务将 URL 改为部署根地址，如 `https://openviking.example.com`，不附加 `/api/v1`、查询参数或凭据。HTTP 只接受 `localhost`、`127.0.0.1` 或 `[::1]`；远程必须 HTTPS，不能关闭证书检查。

| 变量 | 作用 |
| --- | --- |
| `DOCMOST_KNOWLEDGE_PROVIDER` | 新安装明确设置 `openviking`；`none` 覆盖遗留配置，省略仅用于兼容 URL 推断。 |
| `DOCMOST_KNOWLEDGE_STATE_DIR` | 页面镜像登记、任务与原文快照的私有绝对目录；省略时复用已有 `DOCMOST_SYNC_STATE_DIR`，不要求 MD 源目录；同时启用 MD 时须与 MD 状态目录相同。 |
| `DOCMOST_OPENVIKING_URL` | 选择 OpenViking 时必需的部署根 URL；缺失仅阻塞知识库。 |
| `DOCMOST_OPENVIKING_API_KEY_FILE` | 选择 OpenViking 时必需，仓库外私有 Key 文件的绝对路径。 |
| `DOCMOST_OPENVIKING_ACCOUNT` | 可选预期账户，仅校验身份。 |
| `DOCMOST_OPENVIKING_USER` | 可选预期用户；省略时使用鉴权确认的用户。 |
| `DOCMOST_OPENVIKING_SCOPE` | `personal`（默认）或显式 `shared`。 |
| `DOCMOST_OPENVIKING_ROOT_URI` | 可选所选模式的具体资源根，默认值见个人与共享目录。 |
| `DOCMOST_OPENVIKING_TIMEOUT_MS` | 单次 HTTP 请求超时，默认 `30000` 毫秒，范围 `100`–`120000`。 |

完整摘要处理可能使删除旧路径的请求超过 30 秒；本机真实验收曾测得超过 40 秒。因此上例将超时设为 120 秒，远程部署也应按模型和网络耗时设置。父子页会排队，多次处理的总耗时可能超过单次请求上限。超时不证明删除失败；出现 `OV_UNCONFIRMED` 时先核对状态，不能反复重放删除或清空关联账本。

页面同步仅需知识库连接和私有状态目录，不要求 `DOCMOST_SYNC_ROOT`、MD 绑定或 Docmost 条件同步路由。构建并重启后核对实际工具和 schema：可写连接可用 `sync_page_to_knowledge`、`get_page_knowledge_status`、`retry_knowledge_sync`；OpenViking 兼容别名 `retry_openviking_sync` 保留。只读模式仅查询状态，不发起同步、重建或删除。配置不完整、身份不符或连接失败仅影响知识库状态，Docmost 仍按自己的配置启动和处理。网络暂时不可达保留队列，显示 `retrying` 并在 MCP 运行期间补处理；配置和身份错误须先修正。

### 独立只读连接检查

构建后先带入所选 OpenViking 变量运行检查，无需 Docmost 登录、默认空间或 MD 目录：

```sh
DOCMOST_KNOWLEDGE_PROVIDER=openviking \
DOCMOST_OPENVIKING_URL=https://openviking.example.com \
DOCMOST_OPENVIKING_API_KEY_FILE=/Users/your-name/.config/docmost/openviking-key \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge
```

如已配置预期账户、用户、根或超时，带入相同设置。输出只包含安全状态、部署 origin、鉴权账户/用户与私有根，不含 Key。配置错误、不可达、身份错误或不支持时此检查非零，普通 Docmost 仍独立可用。选择 `none` 时仅需 provider 变量运行同一检查，返回关闭状态，不读取遗留 Key、不访问网络。

检查不上传正文、不创建目录、不重建索引、不删除资源；通过检查只能证明本次只读连接与身份核对，不能证明写入、摘要或索引能力。后续真实验收仍需用户已授权的测试对象和模型处理范围。

## 已有 Docmost 页面主动入库

先用 `search_pages` / `get_page` 定位用户授权的页面并取得规范 UUID，再调用 `sync_page_to_knowledge({pageId})`。工具读取当前已保存的完整 Markdown，登记后写入所选资源根的 `document.md` 并生成摘要/向量；不把搜索片段、摘要或 `update_page` 的追加增量当成全文。刚创建的页面也须显式调用该工具才能登记外发。

用 `get_page_knowledge_status({pageId})` 查看登记状态、`bindingId`、精确 URI、原文哈希和安全错误；不带页面参数可查看登记列表。查询不触发外发。知识库失败后以返回的 `bindingId` 调用 `retry_knowledge_sync`，它只补知识库阶段，不重新创建或改写 Docmost。未登记、配置阻塞、Docmost 读取失败和后端处理中/失败分别报告，具体错误以工具实际返回为准。

通过 MCP 修改已登记页面后会跟进；网页直接编辑没有后台监听，用户保存后再次主动同步。既有页面无需先导出 MD、调用 `ov` CLI 或 `add-resource`，也不迁移或清理旧 CLI 导入。完整状态与错误处理见 [知识库接入](knowledge-sync.md#状态与错误的处理)。

## 本地 MD 的创建、绑定与确认版本

只有选择本地 MD 保存自动上传时，才需要源目录与 MD 状态目录，以及目标部署的条件同步接口。新建 MD 页面使用以下流程，避免普通 Markdown 创建与条件同步生成不同编辑器版本：

1. 按授权的空间和父页调用 `create_page`，只给标题和位置，不发送 `content`，先创建空页。
2. 取得规范页面 UUID，调用 `bind_markdown` 绑定指定相对 `.md` 文件。
3. 调用 `get_markdown_sync_status({bindingId})` 读取当前 `currentRevision`，再在用户已授权初始全文写入的范围内调用 `resolve_markdown_sync({bindingId, expectedRevision})`。
4. 用 `get_page` 核对 Docmost，继续查看该关联的 `knowledgeBase` 状态（兼容字段 `openViking`），分别报告两个目标。

绑定本身不覆盖 Docmost。既有页仅在服务端预览版本同时匹配实时与持久化版本时，将初始 MD 作为已确认内容入库；不匹配则等待下一次成功保存上传或显式解决冲突。普通创建入口生成的 block ID 可能不同，“Markdown 看起来一样”不能代替版本一致，也不能通过忽略 ID 绕过检查。

这条 MD 链路使用本次 Docmost 确认的精确 MD 快照；后续保存不会替换先前任务的正文。MD 绑定页通过网页或普通 `update_page` 修改正文仍会触发 MD 关联冲突，不自动把远端修改覆盖成本地 MD；页面主动登记不依赖这套 MD 版本基线。创建响应丢失时先查目标，不重复创建。

## 空间和父子目录

资源布局遵从 Docmost 的当前空间与祖先链：

```text
<所选资源根>/<空间名>/
  <父页标题>/
    <子页标题>/document.md
```

名称经 NFC 规范化、不安全字符清洗和长度限制，保留可读 Unicode；仅冲突时增加短后缀。账本身份是部署、工作区和页面 UUID，URI 可以随名称与位置变化。祖先缺失、不可访问、已删除、循环或空间归属不符时暂停该项，不猜测目录。

通过 MCP 修改已登记页正文/标题、移动该页或其祖先、跨空间移动后，以及下次页面主动同步或 MD 确认同步时，会重新核对布局。新位置确认写入并完成处理后，只清理账本拥有的旧原文及可证明已空的页目录；父目录中的子页或未知文件不能被递归删除。本地 MD 目录不会代替 Docmost 目录。跨空间移动不自动修改 MD 的固定目标空间，后续 MD 上传仍需重新确认关联。

## 删除、恢复与暂停

只有明确的 `delete_page` / `restore_page` 操作触发对应镜像工作。Docmost 操作包含子树，但镜像候选只取仍活跃登记、可证明属于本次子树且已确认发生删除/恢复状态转换的页面。不会枚举或导入未登记后代，也不会借此次操作清理早先在网页删除的无关页。403、404、超时不是删除证据，响应不确定先对账，不重放 Docmost 操作。

子树删除会保存登记后代的依赖，先完成子页清理，再清理父页，避免子页删除重新生成父目录的摘要与目录索引。旧已派发任务仍先对账。删除和旧路径清理前后还会等待 OpenViking 的摘要、向量队列；这是只读等待，复用部署中其他正在处理的资料可能延长等待，不会取消或清空队列。请求超时或 MCP 退出后，下次连接继续核对。收到明确成功的删除响应后，等待队列与核对目录会单独持久化；重试这一阶段不会重发已确认的删除。未确认的删除仍保持暂停保护。

页面主动登记的恢复以 Docmost 恢复后当前已保存的完整 Markdown 重新入库。MD 绑定页还须以本地 MD 预览版本核对恢复后的实时与持久化正文；文件不存在、正文不匹配或版本变化时暂停，由用户确认本地/合并版本。删除本地文件、改名或变空只暂停 MD 关联，不级联删除两端文档。

删除后立即恢复时，尚未派发的镜像删除可以取消；已确认删除后的索引任务先对账，再补恢复正文。若删除请求的结果因断网无法确认，会保留 `OV_UNCONFIRMED`，避免迟到的删除请求清掉刚恢复的正文。此时先核对服务端结果；仍无法确认时保持暂停，必要时在明确授权后选择新的镜像根并重新关联，不清空账本来强行重试。

下面的 `pause` / `unbind` 是 MD 绑定的控制，不是页面主动登记工具的参数。`pause` 禁止普通 MD 保存派发新正文任务；已提交任务只读对账。明确的 MCP 改名、移动可使用已确认的同一正文调整镜像位置，仍须核对版本，不能越过正文冲突；暂停时最终旧路径占位清理仍等待 `resume`，不能期待整个布局任务立即进入 `synced`。明确 Docmost 删除形成新的删除授权，确认状态转换后允许镜像删除越过普通 MD 暂停；只读模式和退出仍禁止新派发。恢复正文仍受暂停与版本确认约束。`unbind` 停止未来工作，留下已有两端资源，目标账本成为非活跃历史归属，不再参与自动删除、恢复或补同步。

解除关联后，尚未确认终止的旧服务端任务仍作为只读的目录锁检查依据，直到查到终态；它不会恢复成活跃关联或继续派发正文。重新关联同一页也不会抹掉此前任务记录。

## 状态、重试与私有快照

页面主动登记使用 `get_page_knowledge_status` 查询单页快照或仅页面来源的登记列表；未登记返回 `not_enrolled`。`localHash` / `remoteRevision` 为完整已保存 Markdown 的 SHA-256 指纹，不是协作实时版本或 CAS 令牌；知识库状态单独看 `knowledgeBase.state`，正文保存尚未被数据库导出确认时为 `waiting_docmost`。查询会提供适用的 URI 和安全错误；MD 绑定仍使用 `get_markdown_sync_status`。状态不返回正文或密钥。MD 状态的通用字段 `knowledgeBase` 报告 `provider`、`enabled`、`state` 及适用的安全进度；兼容字段 `openViking` 保留以下状态：

| 字段 | 含义 |
| --- | --- |
| `state` | `waiting_docmost`、`pending`、`processing`、`retrying`、`blocked`、`synced` 或 `deleted`。 |
| `uri` | 已登记的 OpenViking 目标。 |
| `confirmedRevision` | 已确认镜像对应的 Docmost 版本。 |
| `phase` / `operation` | 当前阶段与正文/删除操作。 |
| `taskId` | 已提交处理任务的标识。 |
| `error` | 安全错误码和说明。 |

Docmost 已同步且 OpenViking 处理中/失败时分别报告，不合并成“两端成功”。HTTP 成功或正文读回一致还不足以证明摘要和向量完成，须核对服务端处理任务。

`taskId` 在待处理阶段提供，完成后会从关联状态清除。验收时在 `processing` 阶段记录本次 ID；也可通过 OpenViking 按精确页目录 `resource_id` 查询本次 `admin_reindex` 任务历史。不要等 `synced` 后再向关联状态索取已清除的 ID，也不要拿上一次完成记录证明这一次成功。

需要人工补处理时调用 `retry_knowledge_sync({bindingId})`；现有 `retry_openviking_sync` 作为 OpenViking 兼容别名继续可用。两者只接受活跃关联，先核对已有结果和任务，再补可确认的 OpenViking 阶段，不重新创建、追加或覆盖 Docmost，不接受任意 URI，也不解决正文冲突或绕过暂停。认证、目标变化、外部写入冲突或无法确认的提交须先排查原因。

页面镜像使用 `DOCMOST_KNOWLEDGE_STATE_DIR`（默认复用已有 `DOCMOST_SYNC_STATE_DIR`）保存登记、任务、租约及**完整 Markdown 原文快照**。页面与 MD 来源共用同一账本；同时启用 MD 时显式状态目录必须相同，不同目录拒绝启动。目录 `0700`、文件 `0600`，当前用户所有、非符号链接，每份最多 1,000,000 字节；确认处理且恢复不再需要后清除。关联元数据不包含正文，状态文件与快照都不保存密码、Docmost Token、OpenViking Key 或模型 Key。不要把整个私有状态目录提交到 Git 或当作无正文日志分享。

每轮提交、查询任务和对账完成或失败后即释放本地页面及知识库目录锁，MCP 空闲不持锁。远端异步任务以账本中的持久任务标记协调，不为等待摘要或向量而长期持有本地锁。MCP 的 EOF、SIGINT、SIGTERM 停止新工作，取消请求并保留待确认进度。已提交的 OpenViking 服务端处理可能继续；重启后先查询和对账，没有独立后台守护进程。本机租约只能串行本链路，OpenViking 没有正文 CAS 或业务幂等键，不能保证其他写入者不会竞争，也不能宣称跨系统原子事务或 exactly-once。

OpenViking 的目录处理会锁住整棵子树，父页和子页即使使用非递归重建也可能竞争。因此同一私有状态目录、同一镜像根下的任务会排队，等待已有服务端任务结束后再处理下一页。`OV_TREE_BUSY` 表示等待，Docmost 已完成的写入不受影响；明确的目录锁超时只重试索引阶段，不重写正文或 Docmost。

## 在授权测试范围验收

页面主动同步先验证两种范围，不能由安装或只读检查推导业务页面改写授权：

1. 对已授权的业务原文，仅用 `get_page` 读取并主动登记入库，不修改源文档。核对状态给出的精确 URI，读回完整 `document.md` 并与 Docmost 已保存 Markdown 的哈希比较，再核对本次摘要/向量任务和限定 URI 的检索。摘要或历史成功任务不能替代完整原文验收。
2. 创建授权测试副本，显式登记后，分别通过 MCP 追加/替换、只改标题、移动页面/祖先、跨空间移动、软删除和恢复。核对原文、当前布局、旧路径及检索清理；业务原文和旧 CLI 导入保持原状。
3. 验证普通新建页未显式登记不会外发、网页改动未被后台监听、再次显式同步后更新完整原文，以及只读状态、配置错误、后端不可达和通用重试不会重放 Docmost 写入。

使用当前已连接的 OpenViking 读取、任务与检索能力做独立核对；若没有这些能力，分别报告 MCP 内部原文/hash 校验及同步状态、尚未额外独立验收的项目，不为此默认回退 CLI。

下面仍是本地 MD 链路的专用验收步骤，不能把它当作页面主动同步的前提。使用专门的测试 MD、Docmost 测试空间和该用户下独立的 OpenViking 测试根，按以下步骤自验：

1. 明确选择 OpenViking，配置两个同步目录、服务根 URL 和私有 Key 文件路径，构建后先做只读 `--check-knowledge`，再重启 MCP。确认有 MD 四个工具、`retry_knowledge_sync` 和兼容别名 `retry_openviking_sync`，并发现实际 schema。
2. 在同步目录创建 `我的自验.md`，写入“第一行”。要求 Agent 在测试空间创建空页并绑定此文件，查询当前版本，再按上述流程显式写入初始全文。
3. 在处理中记录本次 `taskId`，或通过 OpenViking 按精确页目录查询本次任务历史，再等待两端状态分别完成。用 `get_page` 读回 Docmost；通过已有 OpenViking 连接读取状态给出的精确 `uri`，核对正文、摘要、向量处理任务和限定该 URI 的检索结果。
4. 在 MD 追加“第二行”并保存，分别读回两端。摘要和检索须等待这次的新任务完成，不能只看上次成功记录。
5. 在 Docmost 测试页下建立已绑定子页，再通过 MCP 改父页标题、移动子页。核对新的空间/父子路径及旧原文清理，其他文件应保留。
6. 在网页端修改正文，再保存 MD。确认冲突暂停、网页内容保留，未确认的 MD 没有导出；合并 MD 后按当前版本显式解决，再核对两端。
7. 通过 MCP 明确删除测试页，确认已绑定子树的镜像及检索清理；明确恢复后等待重新入库。不要用删除本地文件模拟删除页面。
8. 暂停关联、关闭 MCP、保存 MD，确认不再上传；重启后先对账。再用只读配置确认零写入、重建与删除。
9. 如需测试 OpenViking 不可达，在独立测试配置和新绑定上模拟连接失败，确认 Docmost 保存仍成功；恢复同一部署的可达性并重启后补镜像，不重写 Docmost。不要把既有绑定改向另一个部署，它会触发目标变化保护。另用显式 `none` 且遗留 OpenViking 变量的独立配置确认只运行 Docmost 同步、不读取 Key 或访问知识库；省略 provider 与 URL 的旧关闭分支也应保留。
10. 解除关联后，仅清理本次创建的测试页、空间、MD 与 OpenViking 测试根，保留其他资料。解除关联本身不会删除已有镜像。

安装和工具发现不能代替上述验收，也不会授权修改公司现有页面。测试结果按实际执行记录，不使用之前仅 Docmost 同步的验收数字证明镜像已验收。

自动验收脚本为 [`scripts/local-docmost/acceptance-openviking-sync.mjs`](../scripts/local-docmost/acceptance-openviking-sync.mjs)。它限定于本仓库既有的本机合成 Docmost fixtures 和本次 OpenViking 部署/个人身份，会创建独立测试根、测试页及专用会话并清理；不适用于任意公司或远程部署，也不应移除这些限制来使用公司凭据。当前本机开发环境和已授权模型处理准备好后，先运行 `node scripts/local-docmost/acceptance-openviking-sync.mjs --prepare`，再运行不带参数的同一命令。当前适配层脚本的私有结果记录在 ignored 的 `data/local-docmost/openviking-sync-acceptance-provider.json`；`--tail-only` / `--delete-only` 分组分别使用 `-provider-tail-only.json` / `-provider-delete-only.json` 后缀。此前不含 provider 的报告保留为历史证据。其他部署使用上面的手工自验步骤。

以下为页面主动同步和知识库通用适配层加入前的历史基线，不覆盖新页面工具。2026-10-14 当时的 MCP 构建与全部测试为 **286/286**，新建临时目录独立安装单包后同样 **286/286**；无需 monorepo 安装、ov CLI 或发布 npm 包。这些数字不覆盖后来加入的 provider 选择、通用状态、重试别名或 `--check-knowledge`。当时真实验收使用本机 Docmost、个人会话和 OpenViking 0.4.19，按组保留证据：

| 分组 | 结果与范围 |
| --- | --- |
| 主流程 | 此前 17 项通过，覆盖修改、空间与父子结构、改名移动、网页冲突、退出重启及只读零写入；在未配置分支因验收脚本遇到暂时为空的正文而中断，未宣称整轮成功。 |
| `--tail-only` | 修正脚本后 **7/7**，验证无 ov 的 PATH、未配置与不可达时 Docmost 成功、镜像重试不重放 Docmost、私有状态。 |
| `--delete-only` | 最终队列等待及后代依赖修复后 **9/9**：初始与恢复的四个新完整处理任务成功；恢复前父子页原文、目录、L0/L1 均缺失，六个限定目录的 level 0/1/2 查询均为零。 |

后两组均清理自己的页面、空间、测试根、临时文件和会话；会话重放返回 401，队列完成后测试根为精确 404，至少 10 秒后再确认。报告为 `data/local-docmost/openviking-sync-acceptance-tail-only.json` 和 `openviking-sync-acceptance-delete-only.json`，权限 `0600`，不提交 Git。分组结果不计作一次完整的 20/20 重跑。远程 HTTPS 的配置和请求边界已测试，本次没有连接真实远程 TLS 部署验收。
