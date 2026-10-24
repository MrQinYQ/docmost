# 安装配置本地 Docmost MCP

本参考随 Skill 安装，不依赖原仓库目录。[完整中文 GitHub 指南](https://github.com/MrQinYQ/docmost/blob/main/docs/local-mcp.md) 含可直接交给 Agent 的安装提示词。代码、Skill 和指南应来自同一分支；社区会话要求所选版本已包含 `--login` / `--logout` 和 `DOCMOST_AUTH_MODE=session`，不能把旧的 API Key 版本当成已支持。缺少入口时说明版本问题，不安装同名第三方包。

选择 OpenViking 后继续引导“个人（默认）/共享”：配置 `DOCMOST_OPENVIKING_SCOPE=personal|shared`，默认根分别为 `viking://user/<用户>/resources/docmost-mcp` 与 `viking://resources/docmost-mcp`。共享使用同一 account 的目标 ACL，不自动复制 Docmost 权限；已有个人任务不得直接改投共享，应另设连接和独立私有知识库状态目录。目录规则、授权和双连接跟进范围见 [知识库参考](knowledge-sync.md#个人与共享目录)。

## 确认范围与认证模式

确认部署根 HTTPS URL（如 `https://wiki.example.com`，不含 `/api`）、AI 客户端、源码安装目录和 MCP/Skill 作用域。已有信息不重复询问；用户授权安装并选定作用域后可以构建和合并配置，保留其他设置。检查 Git、Node.js 22+、npm，记录实际 Node 绝对路径；缺少依赖时按授权安装，不擅自改变全局配置。示例为 macOS/Linux，其他系统适配命令、路径和私有权限。

标准安装主动提供“不启用知识库 / OpenViking”选择，不能等用户另外要求才提及。已有明确选择和授权沿用，新配置显式保存 `DOCMOST_KNOWLEDGE_PROVIDER=none|openviking`。选择 `none` 跳过所有后端地址、Key、身份和所选资源根问题，覆盖遗留 OpenViking 变量，不读取 Key 或访问服务。选择 OpenViking 按[知识库接入](#可选知识库接入)引导已有服务根地址、私有 Key 文件、可选身份和根；只实现这一后端，不自动部署服务。

没有企业 API Key 且用户选择邮箱/密码接入时，明确使用 `DOCMOST_AUTH_MODE=session`。它通过目标部署正常个人登录建立专用可撤销会话，继承当前账号权限，不需要企业 API Key。SSO/MFA 或没有 session ID 的旧版 ACCESS 登录不支持，停止并说明；不抓取浏览器 Cookie、不伪造 JWT、不修改许可检查、不自动更换管理员或切换凭据模式。

兼容默认模式仍为 `api_key`，不能省略模式后期待自动进入社区登录。会话模式拒绝 `DOCMOST_API_TOKEN` / `DOCMOST_API_TOKEN_FILE`，API Key 模式拒绝 `DOCMOST_SESSION_FILE`。需要切换时仅在用户选择的模式下替换对应配置，不保留旧模式的凭据变量。

## 下载与构建

使用用户确认的未占用绝对路径，已有目录先检查用途，不覆盖、删除或重置。若需非默认分支，先核对它包含会话模式并选用：

```sh
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/MrQinYQ/docmost.git \
  /absolute/path/docmost-mcp-source
cd /absolute/path/docmost-mcp-source
git sparse-checkout set packages/mcp skills/docmost-mcp docs
cd packages/mcp
npm install --workspaces=false
npm run --workspaces=false build
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --help
```

核对 `--help` 列出 `--login`、`--logout` 和会话配置变量；知识库版本还须包含 `--check-knowledge`、`DOCMOST_KNOWLEDGE_PROVIDER` 和 `DOCMOST_KNOWLEDGE_STATE_DIR`；重启后发现页面主动同步和状态工具。只安装 MCP 包依赖，不安装整个工作区；不需要 pnpm、npm 发布或 `npm pack`。保留源码和根许可证。入口是 `/absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs`；包内测试可在包目录运行 `npm run --workspaces=false test`，不能代替目标公司部署验收。

已有安装升级时，在客户端配置实际指向的源码目录核对 `git status --short`，保留本地改动；无冲突后 `git pull --ff-only`，在 `packages/mcp` 重新执行上述单包 install/build，并比较更新已授权作用域的 Skill。重启 MCP 连接重新发现实际工具和 schema，不依赖旧扩展工具总数；已有页面同步应能发现主动同步、状态与通用重试入口。旧进程或其他目录的构建不会自动更新当前连接。部署域名、默认空间/父页和仓库外凭据不需因升级重设；省略 provider 且已有 OpenViking URL 的旧安装兼容启用，已有明确配置不重复询问。

## 用户本人在终端登录

`DOCMOST_SESSION_FILE` 必须为仓库外的私有 JSON 绝对路径。建议为 `~/.config/docmost/session.json` 的实际绝对路径；shell 可用 `"$HOME/.config/docmost/session.json"` 展开，客户端配置须写绝对路径。CLI 管理私有目录和会话文件，POSIX 下目录 `0700`、当前用户所有的普通文件 `0600`，不支持符号链接。不要手写会话 JSON，也不要创建空文件供登录覆盖。

把替换好实际部署、Node 和源码路径的命令交给用户，由用户在自己的真实本机终端执行；登录无需默认空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE="$HOME/.config/docmost/session.json" \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --login
```

CLI 提示邮箱和隐藏密码，只向配置的同一 HTTPS origin 登录，拒绝重定向，并验证身份与可撤销会话后保存。密码只短暂存在于进程内存，不保存、不接受 `DOCMOST_PASSWORD` 等环境变量、argv、工具参数或模型输入。Agent 不代跑 `--login`，不向聊天索要密码，不用管道或模拟 TTY 灌入密码，不读取、回显、复制或记录会话文件内容。用户完成后继续只读配置检查，不通过打开文件验证。

已有未过期记录不会被 `--login` 静默覆盖；更换账号先退出。同部署过期记录可重新登录替换；来源不同或格式异常记录拒绝，不删除未知文件绕过。运行时只加载已保存会话，401、撤销、过期后提示用户自行重新登录，没有自动登录或 API Key 回退。

退出使用同一部署和同一文件，无需默认空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE="$HOME/.config/docmost/session.json" \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --logout
```

`--logout` 只撤销 MCP 专用会话并清理本地文件，不退出全部设备。远程撤销失败时说明不确定性；清理文件不能证明服务器会话已撤销，由用户在 Docmost 账号的 Sessions 检查对应会话。尚未过期但已撤销的本地记录先 `--logout` 再 `--login`；同部署已过期记录可直接重登录。重登录后重启 MCP 连接。登录成功却保存失败时 CLI 尝试撤销新会话，不能声称失败的撤销已成功。

## 选择默认空间与父页

用户完成登录后，Agent 可先仅用 URL、模式和会话路径执行只读列表，无需默认空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --list-spaces
```

展示 `items` 的空间名称及 UUID。`meta.nextCursor` 非空时以同样环境运行 `--list-spaces --cursor '返回的原始游标'` 翻页。让用户选择必填默认空间，不擅自选择第一项。`DOCMOST_DEFAULT_SPACE_ID` 必须为真实 UUID，正常 stdio 启动和 `--check` 必填；名称和 URL 片段不能代替。

再询问可选默认父页：留空或不设置即空间根目录；配置须为默认空间中未删除父页的规范 UUID，不能用页面 URL slugId。用户只有标题/链接时，先只设置默认空间、运行 `--check` 并登记客户端；用 `search_pages` / `get_page` 只读取得 `id` 并核对 `spaceId`，再补充 `DOCMOST_DEFAULT_PARENT_PAGE_ID`、重新检查并合并配置。无需用户预先懂得获取 UUID。

无父页的检查示例，UUID 必须替换；有父页时增加对应变量：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check
```

`--check` 只读验证身份、默认空间和父页归属/未删除状态，失败先解决，不声称写权限已验收。

## 合并客户端配置

用户已授权安装并选择作用域时，登记或合并配置，保留其他设置；同名 `docmost` 冲突先比较再让用户选择。配置只保存 URL、模式、私有文件路径、默认位置和启动命令，不含密码或会话值。默认 `DOCMOST_READ_ONLY=0` 提供当前配置下的读写工具，写入仍以用户的具体文档任务授权为限；只有用户选择只读连接时设 `1`，不注册写工具。重启后通过当前连接的 `tools/list` 核对实际工具名称和 schema；MD、知识库选择及源码版本都会影响工具集合，不用固定计数判断能力。

Claude Code 当前用户级示例；项目级按用户选择改用 `--scope local` / `--scope project`，有父页时加其环境变量项：

```sh
claude mcp add --scope user --transport stdio \
  --env DOCMOST_URL=https://wiki.example.com \
  --env DOCMOST_AUTH_MODE=session \
  --env DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
  --env DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
  --env DOCMOST_READ_ONLY=0 \
  --env DOCMOST_KNOWLEDGE_PROVIDER=none \
  docmost -- /absolute/path/to/node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs
claude mcp get docmost
```

Codex 用户级 CLI 同样登记，替换所有路径和 UUID：

```sh
codex mcp add docmost \
  --env DOCMOST_URL=https://wiki.example.com \
  --env DOCMOST_AUTH_MODE=session \
  --env DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
  --env DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
  --env DOCMOST_READ_ONLY=0 \
  --env DOCMOST_KNOWLEDGE_PROVIDER=none \
  -- /absolute/path/to/node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs
codex mcp list
```

也可合并到用户级 `~/.codex/config.toml` 或用户选择的受信任项目 `.codex/config.toml`；项目配置只在受信任项目中加载：

```toml
[mcp_servers.docmost]
command = "/absolute/path/to/node"
args = ["/absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs"]

[mcp_servers.docmost.env]
DOCMOST_URL = "https://wiki.example.com"
DOCMOST_AUTH_MODE = "session"
DOCMOST_SESSION_FILE = "/Users/your-name/.config/docmost/session.json"
DOCMOST_DEFAULT_SPACE_ID = "11111111-1111-4111-8111-111111111111"
DOCMOST_READ_ONLY = "0"
DOCMOST_KNOWLEDGE_PROVIDER = "none"
# DOCMOST_DEFAULT_PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222"
```

可选 `DOCMOST_TIMEOUT_MS` 默认 `30000`，范围 `100`–`120000` 毫秒；`DOCMOST_ALLOW_LOCAL_HTTP=1` 仅允许本机 loopback 调试，远程仍需 HTTPS。重启连接后检查工具。[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)、[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## 可选知识库接入

上述客户端配置示例对应“不启用知识库”；选 OpenViking 时将 provider 改为 `openviking` 并合并以下变量，保留 Docmost 认证和默认位置。先引导用户说明各项；已有明确设置直接使用。

| 变量 | 引导内容 |
| --- | --- |
| `DOCMOST_KNOWLEDGE_STATE_DIR` | 页面登记、任务与完整原文快照的私有绝对目录；省略时复用已有 `DOCMOST_SYNC_STATE_DIR`，不要求 MD 源目录；同时启用 MD 时显式目录须相同。 |
| `DOCMOST_OPENVIKING_URL` | 既有服务根地址，远程 HTTPS 或本机 loopback HTTP，不带 `/api/v1`、查询或凭据。明确选 OpenViking 时必填。 |
| `DOCMOST_OPENVIKING_API_KEY_FILE` | 仓库外私有 Key 文件绝对路径，当前用户所有的普通文件 `0600`，非符号链接。Agent 只配置路径。 |
| `DOCMOST_OPENVIKING_ACCOUNT` / `DOCMOST_OPENVIKING_USER` | 可选预期账户和用户，仅校验 Key 返回身份；不能用它们切换 Key 所属用户。 |
| `DOCMOST_OPENVIKING_SCOPE` | `personal`（默认）或显式 `shared`。 |
| `DOCMOST_OPENVIKING_ROOT_URI` | 所选模式的具体子目录；个人默认 `viking://user/<鉴权确认用户>/resources/docmost-mcp`，共享默认 `viking://resources/docmost-mcp`。 |
| `DOCMOST_OPENVIKING_TIMEOUT_MS` | 可选单次 HTTP 超时，默认 30000 毫秒，范围 100–120000。 |

Key 由部署管理员给用户本人；用户在自己的真实 Bash/Zsh 终端隐藏输入并保存到仓库外私有文件。Agent 不索要、读取、回显或记录 Key，不代跑私密输入，不借用 Docmost 凭据。可交给用户的隐藏输入命令见随 Skill 安装的 [MD 与知识库参考](markdown-sync.md#openviking-key-私密保存)。无需安装 ov CLI、Python 或额外 npm 包，不自动部署 OpenViking。

已有 Docmost 页面同步只需知识库连接和私有状态目录；不需要本地 MD、`DOCMOST_SYNC_ROOT`、绑定或条件同步接口。只有用户另选本地 MD 保存上传时，才配置两个 MD 目录与条件同步链路。页面完整正文会交给该服务配置的模型处理，首次写入或删除可能刷新祖先目录摘要；明确目标、用途与授权范围，已有授权直接沿用。目录配置不自动导入工作区。

构建后可以先做独立只读检查，无需 Docmost 登录、默认空间或 MD 目录：

```sh
DOCMOST_KNOWLEDGE_PROVIDER=openviking \
DOCMOST_OPENVIKING_URL=https://openviking.example.com \
DOCMOST_OPENVIKING_API_KEY_FILE=/Users/your-name/.config/docmost/openviking-key \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge
```

检查命令必须同时带入实际连接所选的 `DOCMOST_OPENVIKING_SCOPE`（共享必须为 `shared`）、身份、根和超时设置；不要省略共享 scope。选择 `none` 时仅设置 `DOCMOST_KNOWLEDGE_PROVIDER=none` 运行同一命令，返回关闭状态，不读取遗留 Key 或访问服务。省略 provider 且 URL 非空仅为旧安装兼容推断 OpenViking；明确 OpenViking 但 URL 缺失独立阻塞，其他 provider 独立报告不支持，不自动回退。

检查只输出安全状态、鉴权身份与所选资源根，不创建、上传、重建或删除资源；配置错误、鉴权或网络失败只使此检查非零，不阻止普通 Docmost 工具。通过检查不能证明写权限、摘要或索引完成，实际验收须有用户对测试对象及模型处理的授权。切换 provider、地址、身份或根不改投旧持久化任务，先核对旧状态。检查后重启并发现 `sync_page_to_knowledge`、`get_page_knowledge_status`、`retry_knowledge_sync` 的实际 schema；只读连接只查询状态。页面主动同步与错误处理见 [知识库参考](knowledge-sync.md)，本地 MD 保存上传另见 [MD 参考](markdown-sync.md)。普通新建页不自动外发；用户要求同步已有页时优先新工具，不要求先绑定 MD 或改用 ov CLI。

## API Key 备选模式

仅在目标部署支持官方 API Key、具备有效许可且用户选择它时使用 `DOCMOST_AUTH_MODE=api_key`。官方将该 API 列为企业许可功能；界面或 `api_keys` 表存在不足以证明服务器支持。[官方 API 指南](https://docmost.com/docs/user-guide/api)

用户在目标部署 **Settings → Account → API keys** 创建个人 Key，再本人用可信本地编辑器将 Key 写入仓库外私有纯文本文件，如 `/Users/your-name/.config/docmost/api-token`。POSIX 文件须当前用户所有、普通文件 `0600`、无符号链接。Agent 不索要聊天中的 Key，不读取、回显或记录内容；配置只保存 `DOCMOST_API_TOKEN_FILE` 绝对路径。也兼容由安全进程环境注入的 `DOCMOST_API_TOKEN`，两种来源只能设置一个，不能把明文值写进配置或命令。

移除 `DOCMOST_SESSION_FILE`，将上述列表、检查和客户端配置的模式改为 `api_key`，会话文件变量替换为一个 Key 来源；不运行 `--login` / `--logout`，其他默认空间/父页和工具约定相同。401 检查 Key 过期、撤销、部署归属及企业能力，不自动退回社区登录。轮换由用户更新 Key 文件并在服务器撤销旧 Key。

## 安装 Skill 与只读验收

复制整个 `skills/docmost-mcp`，含 `references` 和 `agents`。目标已有同名目录时先比较后更新，避免嵌套复制；仅在已授权作用域安装：

| 客户端 | 项目级目标 | 用户级目标 |
| --- | --- | --- |
| Claude Code | `.claude/skills/docmost-mcp` | `~/.claude/skills/docmost-mcp` |
| Codex | `.agents/skills/docmost-mcp` | `~/.agents/skills/docmost-mcp` |

例如目标项目根目录执行 `mkdir -p .agents/skills` 后，`cp -R /absolute/path/docmost-mcp-source/skills/docmost-mcp .agents/skills/docmost-mcp`。Skill 不自动登记 MCP 或授予权限。[Claude Code Skill 文档](https://code.claude.com/docs/en/skills)、[OpenAI Skill 文档](https://learn.chatgpt.com/docs/build-skills)

重启后用 `/mcp` 或工具列表检查，调用 `get_current_user` 核对身份及 `defaults`（`spaceId` UUID、`parentPageId` UUID 或 `null`），再 `get_space` 核对默认空间，按授权检索/读取页面。报告安装和配置位置、部署 URL、身份、空间及父页，不输出凭据。没有实际目标部署返回时如实说明未验证；创建测试页须已有写验收授权。403 表示当前用户权限不足，不改用管理员。会话 401 按上节交由用户重新登录。

默认创建位置和各工具行为见 [工具约定](tool-contract.md)。会话与 Key 模式使用同一组工具和页面编辑器/Yjs 更新路径；安装授权不等于修改任意文档的授权。本地包对齐官方公开的 20 个工具能力，另保留两个软删除/恢复扩展，不复制企业 MCP 实现，也不解锁官方远程 `/mcp` 的许可功能。

基础或扩展工具注册成功不能证明目标部署支持全部接口。`search_attachments` 需要目标服务器提供 `/api/search-attachments`；本 fork 新增了支持个人会话和页面权限检查的社区接口，公司原版可能返回 404。工具会明确报告 `UNSUPPORTED_DEPLOYMENT`，不能当作没有附件；仅在管理员合法部署支持版本后再验收，不通过数据库、浏览器或许可绕过补齐。
# Git 提交发布（可选）

用户选择“提交后发布”时，不询问或配置 Git 地址/项目目录。Agent 在原服务连接沿用既有 DOCMOST_KNOWLEDGE_STATE_DIR；若没有，自动选择用户配置目录下的私有 docmost-mcp 状态子目录并保存一次，避免放进安装源码或用户项目。已有 MD/页面/Git 状态必须沿用，DOCMOST_SYNC_STATE_DIR 若同时设置须相同；该别名单独配置不会开启 MD 监听。同一连接可供多个项目使用，Skill 每次自动检测并传 repositoryRoot。

旧 DOCMOST_GIT_ROOT 仅是兼容默认值，不作为新安装必填项；已有关联不需要重建或手改 JSON。已有值可以保留，新 Skill 的显式项目上下文优先。删除旧值也会按原账本仓库身份恢复；切换项目不新增连接、不改凭据或配置、不重启。个人/共享知识库仍按各自目的地连接和私有账本隔离，不合并这些作用域。

早期 Git 记录缺少目录实例指纹时，状态为 GIT_IDENTITY_UNCONFIRMED，保留 bindingId/page/pending，不静默信任同路径 clone。Agent 说明原路径、页面和待处理状态，用户明确确认可信原仓库后才调用 set_git_document_sync 的 confirm-repository（传检测到的 repositoryRoot）。工具核对已确认 blob/hash、保存原路径前缀和 dev/ino/birthtime 指纹并对账，不上传正文。原路径/历史不可核对时保留暂停；不重建关联、不改 JSON。普通 resume/retry 无法代替首次确认。新版本已保存指纹的关联自动恢复，无需此步骤。

从同版本仓库的 `skills/git-delivery` 安装到 `~/.codex/skills/git-delivery`，保留既有 Skill 并在替换前备份。重建 MCP 并重启连接，实际发现五个 Git 扩展工具；先查询状态，再明确转换原来源。配置不自动绑定、上传或安装 hook。中文引导见 `docs/git-delivery.md`。没有知识库时选择 provider=none；选 OpenViking 时沿用上文地址、私有 Key 文件和个人/共享向导。
