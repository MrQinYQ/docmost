# 本地 Markdown 自动同步与可选知识库

用于用户明确请求将本地 MD 关联到 Docmost 并在保存后单向自动上传。跟随实际 MCP 服务进程，没有独立守护进程或文件删除传播。可选知识库适配层当前只实现 HTTP OpenViking，在 Docmost 确认后将本次 MD 快照送到指定个人或共享资源目录，生成摘要和向量；只管理明确绑定页，不导入整个工作区或自动导出网页正文。

需要同步 Docmost 已有页面、但没有本地 MD 时，优先 [页面主动同步](knowledge-sync.md)，不要求这套绑定、源目录或条件同步接口。以下前提和冲突规则只针对本地 MD 链路。

选择 OpenViking 后继续引导“个人（默认）/共享”：配置 `DOCMOST_OPENVIKING_SCOPE=personal|shared`，默认根分别为 `viking://user/<用户>/resources/docmost-mcp` 与 `viking://resources/docmost-mcp`。共享使用同一 account 的目标 ACL，不自动复制 Docmost 权限；已有个人任务不得直接改投共享，应另设连接和独立私有知识库状态目录。目录规则、授权和双连接跟进范围见 [知识库参考](knowledge-sync.md#个人与共享目录)。

## 接入

保留现有部署、个人会话/API Key、默认位置与其他客户端配置。在选定作用域中合并两个环境变量：`DOCMOST_SYNC_ROOT` 为用户选择的现有绝对源目录；`DOCMOST_SYNC_STATE_DIR` 为独立私有绝对目录，两者不能互相包含。只操作授权配置作用域，不默认选整个用户目录。目录 0700、文件 0600，当前用户所有，非符号链接。关联元数据存摘要和版本；**启用镜像后私有状态目录会暂存原始 MD 正文快照**，每份最多 1,000,000 字节，确认处理且恢复不再需要后清除，不保存凭据，不提交 Git。已有安装从同版本 GitHub 源码单包构建并重启连接；有本地改动先保留，不能 reset/覆盖。

服务器必须提供此 fork 的 `pages/sync-state` / `pages/sync-update` 条件同步路由。MCP 安装不会升级服务器。缺少接口报告 `UNSUPPORTED_DEPLOYMENT`，不能退回普通 `update_page`、数据库或浏览器 Cookie 来自动上传。已有邮箱/密码会话方式继续适用；不要求企业 Key，不涉及许可绕过。

配置后发现实际工具与 schema，核对 MD 四个入口及启用知识库时的通用重试，不依赖旧工具总数。只读模式只有状态扩展，不上传，也不写入、重建或删除知识库。状态中报告具体限制，不能以工具注册证明部署支持。

## 可选 OpenViking 接入

标准 MCP/Skill 安装必须主动提供“不启用知识库 / OpenViking”选择；已有明确选择直接沿用。新配置显式保存 `DOCMOST_KNOWLEDGE_PROVIDER=none|openviking`。选择 `none` 时跳过所有后端问题，覆盖遗留 OpenViking 配置，不读取 Key 或访问服务。省略 provider 且已有 URL 只用于旧安装兼容推断 OpenViking；明确选择 OpenViking 却缺 URL 独立阻塞，其他 provider 独立报告不支持，不自动回退。

选择 OpenViking 后引导已有服务根地址、仓库外 Key 文件路径、可选预期账户/用户与所选模式的资源根；已有设置不重复问。本地 MD 链路仍需前述两个目录；页面主动同步则使用私有 `DOCMOST_KNOWLEDGE_STATE_DIR`（默认复用已有 `DOCMOST_SYNC_STATE_DIR`），不需要源目录或绑定；合并以下配置，保留现有 Docmost 认证：

| 环境变量 | 作用 |
| --- | --- |
| `DOCMOST_KNOWLEDGE_PROVIDER` | 明确选择 `none` 或 `openviking`；新安装不依赖兼容推断。 |
| `DOCMOST_KNOWLEDGE_STATE_DIR` | 页面主动登记的私有绝对状态目录，省略时复用已有 `DOCMOST_SYNC_STATE_DIR`；不改变 MD 链路的源目录和条件写入要求。 |
| `DOCMOST_OPENVIKING_URL` | 选择 OpenViking 时必需的部署根 URL：远程 HTTPS 或本机 localhost/127.0.0.1/[::1] HTTP；不带 API 路径、凭据、查询或 fragment。 |
| `DOCMOST_OPENVIKING_API_KEY_FILE` | 选择 OpenViking 时必需，仓库外私有 Key 文件的绝对路径。 |
| `DOCMOST_OPENVIKING_ACCOUNT` / `DOCMOST_OPENVIKING_USER` | 可选预期账户/用户，只校验鉴权返回身份；Key 决定实际身份。 |
| `DOCMOST_OPENVIKING_SCOPE` | `personal`（默认）或显式 `shared`。 |
| `DOCMOST_OPENVIKING_ROOT_URI` | 可选所选模式的具体资源根，默认值见知识库参考。 |
| `DOCMOST_OPENVIKING_TIMEOUT_MS` | 默认 30000 毫秒，范围 100–120000。 |

通过 HTTP 调用既有服务，无需安装 ov CLI、Python 或额外 npm 包，不自动部署 OpenViking。复用用户指定的现有个人账户和用户；普通个人 Key 由该部署管理员提供，不推断管理员生成接口或菜单。不借用 Docmost 企业 Key、会话 Token 或模型 Key。HTTP200/健康端点可达不能证明 Key 身份，须核对鉴权账户/用户；修改 provider、部署、身份或根不自动迁移旧持久化任务。配置无效或不可达只影响知识库状态，不能把已成功 Docmost 写入改成失败。

构建后运行独立只读 `--check-knowledge`，无需 Docmost 认证、默认空间或 MD 目录：

```sh
DOCMOST_KNOWLEDGE_PROVIDER=openviking \
DOCMOST_OPENVIKING_URL=https://openviking.example.com \
DOCMOST_OPENVIKING_API_KEY_FILE=/Users/your-name/.config/docmost/openviking-key \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge
```

带入已选择的可选身份、根和超时。`none` 仅需 provider 变量即可返回关闭状态；选中后端错误时此检查非零，普通 Docmost 仍独立可用。输出安全状态、身份和所选资源根，不含 Key；检查不上传、不建目录、不重建或删除，不证明写入、摘要或索引能力。实际验收只使用用户已授权的测试范围。

### OpenViking Key 私密保存

Key 由用户在自己的真实 Bash/Zsh 终端隐藏输入，Agent 只配置路径，不代跑、索要或读取内容。可交给用户以下命令，已存在文件须由用户确认用途，不能覆盖未知凭据：

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

摘要/向量供应商由 OpenViking 服务管理，摘要可能发送到外部模型。配置前明确已绑定正文的目标、目的与授权；复用用户时首次写入及删除可能向上刷新已有资料所在祖先目录的摘要，这也须在授权范围内。已有明确授权直接沿用，不重复确认。摘要刷新授权不包含导入或改写其他原始资料。

共享连接的 `--check-knowledge` 必须带入 `DOCMOST_OPENVIKING_SCOPE=shared` 和该连接实际资源根；检查输出所选资源根，不证明写权限。

## 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `bind_markdown` | `filePath`（源目录内相对.md）, `pageId`（规范 UUID）, `enabled?`（默认 true） | 建立双方当前基线，不初始上传；启用后未来保存替换整个页面正文。 |
| `get_markdown_sync_status` | `bindingId?` | 列表读取缓存；指定关联只读取得 `currentRevision` / `currentPersistedRevision`，不上传、不重置基线；`knowledgeBase` 报告 provider、启用状态和进度，兼容保留 `openViking`。 |
| `set_markdown_sync` | `bindingId`, `action:pause\|resume\|unbind` | 暂停、保持基线恢复、解除关联。 |
| `resolve_markdown_sync` | `bindingId`, `expectedRevision`（当前远端 64 位 hex 版本） | 用户明确选择本地/合并内容后，条件替换并恢复；远端再次变化仍拒绝。 |
| `retry_knowledge_sync` | `bindingId` | 仅启用知识库的可写模式；活跃关联先对账再补可确认的后端阶段，不重放 Docmost 写入、不接受任意 URI。 |
| `retry_openviking_sync` | `bindingId` | OpenViking 的兼容别名，保留相同重试与目标保护。 |

先用现有工具读取/确认目标 UUID。根目录配置仅限定文件访问范围；目标页面与用户上传授权必须明确。不得凭标题猜页 ID，绑定后也不因默认空间变更而改目标。拒绝越界、符号链接、非普通文件、无效 UTF-8、空白、>1,000,000 字节。本地 MD 只提供正文，不自动修改 Docmost 标题、父页或空间；本地图片附件不在自动上传范围。

新建 MD 页：按授权位置 `create_page` 创建空页（不发送 `content`）→ 取得规范 UUID `bind_markdown` → 查询关联的 `currentRevision` → 用户已授权初始全文写入时，用该版本 `resolve_markdown_sync`。普通 Markdown 创建可能产生不同 block ID，文字相同不是版本一致，不能忽略 ID 或放宽比较。

既有绑定只有预览目标版本同时匹配实时与持久化版本时，才可将初始 MD 作为已确认内容镜像；不匹配等待下一次成功上传或显式解决，不能提前入库。每次镜像固定该次确认的快照，后续保存不能替代旧任务正文。普通 `update_page` 或网页正文修改不自动导出。

## 镜像层级与状态

路径为 `<所选资源根>/<安全空间名>/<完整祖先安全标题链>/<页面安全标题>/document.md`，保留 Docmost 层级。名称 NFC 规范化、清洗不安全字符并限制长度，保留可读 Unicode；仅冲突时增加稳定短后缀。稳定身份是部署/工作区/页面 UUID，URI 可变。不可访问、缺失、删除、循环祖先或归属不符时暂停，不猜目录。

明确 MCP 改标题/移动后或下次确认 MD 同步会核对布局。新位置处理成功后只删除账本拥有的旧原文及可证明已空的页目录，不递归删除包含子页/未知文件的父目录，不迁移未登记页。跨空间移动不偷偷重绑定 MD 固定目标空间，后续上传仍需重新确认关联。

每页 `knowledgeBase` 报告 `provider`、`enabled`、`state` 及适用的安全进度；兼容字段 `openViking` 可能含 `uri`、`confirmedRevision`、`phase`、`operation`、`taskId`、安全 `error`，无值字段可省略，不返回正文/密钥。分别报告“Docmost 已同步”和“知识库等待/处理/失败”。`retrying` 保留队列并在 MCP 运行期间补处理；配置、身份、外部写入冲突或未知提交无法确认时暂停排查。HTTP 成功/正文一致不代表摘要及向量完成，须核对处理任务。

完成后 `taskId` 从关联状态清除；验收在处理中记录本次 ID，或通过 OpenViking 按精确页目录查询本次 `admin_reindex` 历史，不能复用之前的成功任务。暂停时明确改名/移动可调整新位置，但最终旧路径占位清理等待 `resume`，不能声称暂停期间已完成整个布局任务。

## 冲突与恢复

当前同步接口读取实时 owner Ydoc，原子比较版本后更新。正文内容不同于原基线时暂停；普通更新时间和 Markdown 往返字节差异不作为原子版本。只保护服务端已收到的协作状态，不能阻止后续授权修改。

冲突后读远端并让用户决定保留/合并。恢复监听不重置冲突基线；通过 `get_markdown_sync_status({bindingId})` 取得当前 `currentRevision`，将其作为显式解决的 `expectedRevision`，配合用户授权的本地/合并正文。`remoteRevision` 是旧基线，不能拿来代替当前版本。不能把读页面或查询状态解释为覆盖授权。

网络/存储不确定时持久化 pending 并先核对，不重发。只有实时与持久化版本均确认目标才推进 Docmost 基线和镜像意图。401 交用户终端重新登录并重启；403 不切管理员；身份或空间变化重新确认关联。镜像失败不重放已成功 Docmost 创建、追加或替换。查询状态、恢复监听和镜像重试不构成覆盖授权，未确认正文不发新镜像任务。

## 删除、恢复与生命周期

仅明确 `delete_page` / `restore_page` 触发对应镜像任务。Docmost 操作级联子树；镜像候选限定仍活跃登记、可证明属于本次子树且确认发生状态转换的页。不要导入隐藏/未绑定后代，也不要清理早先网页删除的无关页。403/404/超时不是删除证据，响应丢失先查询，不重放 Docmost 删除。恢复还需本地 MD 预览匹配恢复后的实时/持久化版本，不匹配则由用户确认本地/合并内容。

暂停禁止普通 MD 保存派发新正文任务，已提交任务只读对账；明确 MCP 改名、移动仍可使用经版本核对的已确认正文调整位置，不能越过正文冲突。明确删除确认状态转换后，允许镜像删除越过普通 MD 暂停；只读和退出仍禁止新派发。恢复正文仍受暂停与版本确认约束。文件删除/改名/暂时变空只暂停，不删远端。解除关联留下两端资源、取消未开始任务，账本成为非活跃历史归属，不参加自动删除、恢复或补同步；旧服务端任务仅保留只读锁检查，直到终态，不重新派发正文。

多客户端共享私有状态目录，每次有限工作及账本更新串行，获锁后重读记录，成功/失败/取消后释放。空闲连接不占页面锁，MD 保存监听按原配置继续。已确认退出的持有者由工具安全回收，不删除存活或无法确认进程的锁。EOF/SIGINT/SIGTERM 停止新工作、取消请求、保留待确认进度，已提交服务端处理可能继续，重启先对账。没有后台守护进程。OpenViking 无正文 CAS/业务幂等键，本机租约不能约束外部写入者，不能宣称跨系统原子提交或 exactly-once。

同一状态目录和镜像根下的目录任务须等待已有服务端任务结束，避免父子目录的子树锁竞争。删除后立即恢复时，未派发的删除可取消，已确认删除后的索引先对账；未知删除结果不能仅凭正文暂时缺失就重建同 URI，保持 `OV_UNCONFIRMED`。需要完整排查说明时，从安装时记录的源码目录读取同版本 `docs/openviking-sync.md`；Skill 可以安装在其他目录，不能按其相对路径猜测源码位置。

子树删除保存登记后代依赖，先完成子页再清理父页；依赖不阻止旧已派发工作的对账。最终清理还以有界 `/system/wait` 只读等待摘要与向量队列，复用部署的其他工作可能延长等待，不清空或取消队列。明确成功的最终删除响应保存为 `prune_verify`；超时、退出和重试只继续等待与核对，不重发已确认的删除。未知 DELETE 的暂停保护保持不变。

验收使用用户明确授权的测试 MD、Docmost 测试页及 OpenViking 独立测试根，检查创建绑定/条件初始写入、两端读回、更新、层级、改名移动、处理任务和检索、删除恢复、冲突、不可达、退出重启及只读零写入。只清理本次测试对象；安装授权不等于公司现有文档写验收授权，未执行时如实报告。
