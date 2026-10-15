# 本地 Markdown 自动同步

本功能把已明确绑定的本地 `.md` 正文单向同步到 Docmost。同步随实际 MCP 服务进程启动和退出；关闭聊天窗口不一定结束该进程。Docmost 上传由本地程序执行，不调用模型；可选[知识库适配层](knowledge-sync.md)当前仅实现 [OpenViking 镜像](openviking-sync.md)，在 Docmost 确认后生成摘要和向量，可能使用该服务配置的模型。它不导入整个工作区，也不自动同步网页正文。

## 前提与安装

先按 [本地 MCP 指南](local-mcp.md) 完成 GitHub 单包安装、登录、默认空间设置和检查。同步仍使用相同的部署域名与个人会话/API Key，不另存密码或凭据。

目标服务器须包含此 fork 的 `POST /api/pages/sync-state` 和 `POST /api/pages/sync-update`。它们读取实时协作正文版本，并在持有该文档的服务端事务中比较版本后替换正文。仅升级本地 MCP 不会升级服务器；缺少接口会报告 `UNSUPPORTED_DEPLOYMENT` 并停止自动上传，不会改用普通 `update_page` 绕过冲突保护。

更新本地安装后重新构建并重启连接：

```bash
cd /absolute/path/docmost-mcp-source
git pull --ff-only
cd packages/mcp
npm install --workspaces=false
npm run --workspaces=false build
```

## 配置目录

默认不开启同步。在已有 MCP 客户端配置的环境变量中增加两个绝对路径，例如：

```toml
DOCMOST_SYNC_ROOT = "/Users/your-name/Documents/wiki-project"
DOCMOST_SYNC_STATE_DIR = "/Users/your-name/.config/docmost/md-sync"
```

`DOCMOST_SYNC_ROOT` 是允许关联的现有源目录；目录内的文件不会自动全部上传。`DOCMOST_SYNC_STATE_DIR` 是私有状态目录，两者不能相同，也不能互相包含。状态目录为当前用户所有，权限 `0700`，文件 `0600`。关联元数据记录摘要、版本、待确认操作和页面租约，不包含正文；**启用 OpenViking 镜像后，这个目录还会暂存原始 MD 正文快照**，每份最多 1,000,000 字节，非符号链接，确认处理且恢复不再需要后清除。状态与快照均不保存密码或凭据，不要将私有目录提交 Git。Docmost 凭据仍保存在原来的仓库外私有文件。

重启 MCP 后，可写模式增加四个本地扩展工具，共 26 个；只读模式只增加状态查询，共 11 个。同时选择 OpenViking 时，可写模式再增加 `retry_knowledge_sync` 和兼容别名 `retry_openviking_sync`，共 28 个，只读模式仍为 11 个。未配置目录时仍是原来的 22 / 10 个工具。`DOCMOST_READ_ONLY=1` 不启动上传，也不写入、重建或删除知识库。

标准 MCP/Skill 安装应主动提供“不启用知识库 / OpenViking”选择；已有明确选择不重复问。新安装明确保存 `DOCMOST_KNOWLEDGE_PROVIDER=none|openviking`。`none` 跳过后端问题并覆盖遗留 OpenViking 变量，不读取 Key 或发起网络请求；省略 provider 时仅为旧安装兼容由已有 URL 推断 OpenViking。明确选择 OpenViking 却缺少 URL、未知 provider 或连接失败单独报告知识库状态，Docmost 成功仍独立成立。

OpenViking 使用 `DOCMOST_OPENVIKING_URL` 与仓库外私有 `DOCMOST_OPENVIKING_API_KEY_FILE`；账户、用户和私有根可额外校验。无需安装 `ov`、Python 或额外 npm 包，也不部署服务；远程使用 HTTPS，本机可用 loopback HTTP。Key 与 Docmost 凭据不能互用。独立只读 `--check-knowledge` 无需 Docmost 登录或默认空间，返回安全状态、身份和私有根；检查不证明写入、摘要或索引能力。完整配置及用户隐藏输入保存 Key 的步骤见 [OpenViking 指南](openviking-sync.md)。

## 关联与保存

先用已有工具定位并读取目标页面，取得规范 UUID。然后可对 Agent 说：

> 将同步目录中的 `docs/发布流程.md` 绑定到这个页面并启用自动同步。只同步这份文件的正文。

工具输入示意（页面 UUID 须替换成实际值）：

```json
{
  "filePath": "docs/发布流程.md",
  "pageId": "00000000-0000-4000-8000-000000000001",
  "enabled": true
}
```

`bind_markdown` 不会立刻上传：它记录关联时的本地摘要和远端版本。启用后，下一次修改并保存会以完整 MD 替换目标正文。关联时两端内容可以不同，首次保存会上传本地全文；目标位置固定，不受默认空间/父页配置变化影响。只接受源目录内的相对 `.md` 路径，拒绝路径越界、符号链接、非普通文件、超过 1,000,000 字节、无效 UTF-8 或空白正文。

新建本地 MD 页面时，按已授权的位置用 `create_page` 创建空页（不发 `content`）→ 取得规范 UUID 并 `bind_markdown` → 查询该关联的 `currentRevision` → 显式 `resolve_markdown_sync` 条件写入初始 MD。普通 Markdown 创建入口的编辑器 block ID 可能与条件同步不同，不能凭文字相同忽略 ID 或版本差异。

启用镜像后，既有绑定只有在预览目标版本同时等于实时和持久化版本时，才将初始 MD 视为 Docmost 已确认；两端不匹配时等待下一次确认上传或显式解决，不提前导出本地全文。每次镜像使用该次确认的快照，不以稍后的本地保存替换先前任务正文。

连续保存会等待约 1 秒后合并，同一关联串行处理。编辑器用临时文件替换原文件的保存方式也能检测。本地 MD 只提供正文，不自动修改 Docmost 标题、空间、父页或本地图片/附件。镜像路径保留 Docmost 空间与父子层级，使用部署哈希、工作区 UUID 以及安全名称加 UUID；明确 MCP 改名/移动或下次确认保存会重新核对布局。文件消失、改名或暂时变空会暂停处理，不删除或清空两端文档。

## 冲突与待确认

自动更新前先读取当前实时协作版本；服务器在写入时再次原子比较。网页端正文已变化时暂停该关联，不自动覆盖。版本指服务端已接收到的协作状态，不能阻止后续被授权的编辑，也不能对尚未到达服务器的消息排序。

用 `get_markdown_sync_status` 查询关联状态和错误。列表读取缓存；传入 `bindingId` 时会只读查询实时版本，返回 `currentRevision` 和 `currentPersistedRevision`，原 `remoteRevision` 仍是上次基线。它不触发上传、不重置基线，也不返回文档正文或凭据。`knowledgeBase` 报告 `provider`、`enabled`、`state` 及适用的安全进度；现有 `openViking` 字段保留兼容，可含 `uri`、`confirmedRevision`、`phase`、`operation`、`taskId` 和安全 `error`（无值字段可省略）。Docmost 已同步与知识库处理中/失败须分别报告；人工 `retry_knowledge_sync({bindingId})` 只补知识库阶段，不重放 Docmost 写入，OpenViking 旧调用 `retry_openviking_sync` 仍可用。

出现冲突后，用 `get_page` 读取远端，人工保留或合并需要的内容到本地 MD。确认要使用当前本地/合并结果时，再查该关联的 `currentRevision` 并显式调用 `resolve_markdown_sync`，提交关联 ID 与 `expectedRevision`。如果远端又变化，仍会拒绝；不要猜版本或在 Agent 未获得覆盖授权时自动解决冲突。网页或普通 `update_page` 改动正文不会自动导出到 OpenViking。

`set_markdown_sync` 支持 `pause`、`resume`、`unbind`。恢复保留原基线，不会把冲突当成已解决。暂停禁止普通 MD 保存派发新正文任务，已提交 OpenViking 任务只读对账；明确 MCP 改名、移动仍可用已确认正文调整位置，但不能越过正文冲突。解除关联停止后续任务，保留文件、页面与已有镜像；目标账本成为非活跃历史归属，不继续参与自动删除、恢复或补同步。目录锁排队和删除后立即恢复的处理见 [镜像指南](openviking-sync.md)。

仅明确的 MCP `delete_page` / `restore_page` 操作触发镜像删除/恢复，候选限定仍活跃登记、可证明属于本次子树且确认发生状态转换的页面。既有网页删除、403/404 或未知结果不能成为镜像删除证据。明确删除的镜像清理可越过普通 MD 暂停；只读和退出仍禁止派发。恢复须再次验证本地 MD 匹配已恢复正文，仍受暂停与版本确认约束。旧路径清理只删除本链路拥有的资源，不递归清理含子页或未知文件的父目录。

每次上传前先保存待确认记录。网络断开、超时、服务器无法确认存储时，不自动重发；重启后先核对实时与持久化版本。只有两者均确认目标内容后才推进基线。不能确认时保持暂停，先检查状态和远端内容。

401/过期时由用户在自己的终端重新登录，再重启 MCP；不保存密码或自动登录。403 不改用管理员。目标空间、账号或工作区变化时应重新确认关联。

## 生命周期与多个客户端

MCP 的 stdin EOF、SIGINT、SIGTERM 会停止新任务、取消请求、保留未确认状态并释放自身租约。已发出的 Docmost 写入及 OpenViking 服务端处理仍可能完成，下次启动会先对账。没有独立守护进程或开机后台服务。OpenViking 没有正文 CAS 或业务幂等键，本机租约不能约束其他写入者；不能宣称两端原子提交或 exactly-once。

多个客户端应使用相同的私有状态目录。一个目标页面只允许一个进程持有同步租约；其他进程仍可使用一般 MCP 工具，但不能并行自动上传该页。异常强制终止可能留下租约；看到租约错误后，先确认状态中的旧进程确实结束，再清理对应私有租约并重启，不能删除仍在使用的租约。切换 provider、服务地址、身份或根不会将旧持久化任务改投新目标，先核对旧任务，不清空账本绕过保护。

## 自己验收

在已授权的测试页面与测试 MD 上依次检查：

1. 配置目录、重启连接，确认四个同步工具出现。
2. 关联后查询状态，确认绑定不会立即覆盖页面。
3. 在 MD 追加“第一行”并保存，等待数秒，用 `get_page` 读回；连续保存以及编辑器原子保存也应更新。
4. 在网页端修改同一正文，再修改并保存 MD。查询状态确认冲突暂停，网页内容未被自动覆盖。
5. 合并 MD 后显式解决冲突，读回核对。暂停关联后再次保存，应停止上传。
6. 关闭 MCP 连接/进程后保存 MD，确认页面没有继续更新；重启后先核对两端状态。
7. 使用只读配置或 reader 账号，确认自动上传不能绕过权限。
8. 解除关联，清理自己创建的测试对象。

2026-10-14 此前仅 Docmost 自动同步的验收结果：完整 MCP 测试 **152/152**，独立 GitHub 单包安装布局同样 **152/152**；服务端同步专项 **25/25**，隔离真实 Redis owner 测试 **1/1**；真实本地个人会话、PostgreSQL、Redis、stdio 与协作 WebSocket 验收 **31/31**。已验证网页修改尚未落库时 MD 保存暂停并保留网页正文、陈旧版本拒绝、合并后显式恢复、只读/reader 权限、固定空间和生命周期。这些历史结果不代表 OpenViking 镜像已验收；镜像步骤见 [独立指南](openviking-sync.md#在授权测试范围验收)。

真实验收脚本为 [`scripts/local-docmost/acceptance-md-sync.mjs`](../scripts/local-docmost/acceptance-md-sync.mjs)，仅允许既有本机合成 fixtures，不读取或写入公司部署。完整本地开发环境已按 `scripts/local-docmost/start.mjs` 准备并启动后，可运行 `node scripts/local-docmost/acceptance-md-sync.mjs --prepare` 检查，再运行 `node scripts/local-docmost/acceptance-md-sync.mjs`。结果写入 ignored 的 `data/local-docmost/md-sync-acceptance.json`。本次创建的 4 个页面、1 个临时空间已清理，三个专用会话已注销并重放确认401，临时源/状态/会话文件与连接已关闭清除。

服务端全量测试为 450 通过、15 失败、1 个默认跳过的可选 Redis 测试；15 个失败均为本次之前已存在的裸 `TestingModule` 缺少依赖注入 providers，未作无关修复。同步专项、显式真实 Redis 测试和构建均通过，不将全量测试表述为全绿。

这里的步骤不会授权 Agent 修改公司现有页面；测试目标须由用户明确指定。公司启用前仍须部署支持条件同步接口的服务端，并按自己的权限与页面再验收。
