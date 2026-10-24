# 从 GitHub 安装本地 Docmost MCP 与 Skill

`@docmost/local-mcp` 是独立的 Node.js stdio MCP：AI 客户端启动本地进程，由它使用个人凭据请求已部署的 Docmost。社区版可明确选择邮箱/密码登录建立的**个人专用会话**；支持企业 API Key 的部署也可使用 Key 模式。无需启动本仓库的 Docmost 服务，也不会直接写数据库。`skills/docmost-mcp` 指导 Agent 安装配置和操作用户授权的页面；MCP 与 Skill 需分别安装。

标准安装会主动提供“不启用知识库 / OpenViking”选择，明确保存 `DOCMOST_KNOWLEDGE_PROVIDER=none|openviking`。当前可选知识库适配层只实现 [OpenViking 镜像](openviking-sync.md)：已有 Docmost 页面可显式入库并登记后续 MCP 修改跟进，也保留本地 MD 在 Docmost 确认后入库的链路。两种入口都通过 HTTP 写入指定个人用户私有目录并生成摘要/向量。选择 `none` 跳过后端配置；无需本机安装 `ov`、Python 或额外 npm 包，也不自动部署服务。选择与兼容规则见 [知识库接入](knowledge-sync.md)。

源码交付入口是 [MrQinYQ/docmost 的本指南](https://github.com/MrQinYQ/docmost/blob/main/docs/local-mcp.md)。本文使用 GitHub 源码安装，不需要发布 npm 包、`npm pack` 或在线 `npx` 包。代码、Skill 和指南应来自同一分支。**社区会话模式要求所选版本已包含 `--login` / `--logout` 和 `DOCMOST_AUTH_MODE=session`**；先核对实际文件和构建后的 `--help`。此前仅有 API Key 模式的版本不支持这些步骤；缺少新入口时说明版本问题并停止，不声称远程版本已支持，也不改装同名第三方包。

需要 MD 或 OpenViking 时，同样先核对所选版本实际包含对应源码和指南，再构建并发现扩展工具；本地指南不能证明 GitHub 默认分支或用户现有安装已具备这些可选能力。

选择 OpenViking 后继续引导“个人（默认）/共享”：配置 `DOCMOST_OPENVIKING_SCOPE=personal|shared`，默认根分别为 `viking://user/<用户>/resources/docmost-mcp` 与 `viking://resources/docmost-mcp`。共享使用同一 account 的目标 ACL，不自动复制 Docmost 权限；已有个人任务不得直接改投共享，应另设连接和独立私有知识库状态目录。目录规则、授权和双连接跟进范围见 [OpenViking 个人与共享目录](openviking-sync.md#个人与共享目录)。

## 可以直接交给 Agent 的安装指令

将下面的完整指令交给有本机安装能力的 Agent。填得出的信息可先填；密码和凭据不要填进指令。

```text
请阅读 https://github.com/MrQinYQ/docmost/blob/main/docs/local-mcp.md，按指南从 GitHub 源码为我安装本地 Docmost MCP 和 docmost-mcp Skill，不发布 npm 包。我的部署没有企业 API Key，我选择并授权社区版邮箱/密码的个人会话接入。

先确认我的 Docmost 部署根域名、AI 客户端（如 Codex 或 Claude Code）、源码安装目录，以及 MCP/Skill 使用当前项目还是当前用户作用域；主动让我选择“不启用知识库 / OpenViking”，已有明确选择和授权不要重复问。新配置显式写 DOCMOST_KNOWLEDGE_PROVIDER=none 或 openviking。检查操作系统、Git、Node.js 22+、npm，以及所选分支确实含 packages/mcp、skills/docmost-mcp 和社区会话登录入口。在我确认的未占用目录下载源码，只在 packages/mcp 用 --workspaces=false 安装依赖并构建，不安装整个 Docmost 工作区，不覆盖已有目录或其他客户端配置。旧版缺少 --login/--logout 时先说明版本问题。

明确使用 DOCMOST_AUTH_MODE=session，DOCMOST_SESSION_FILE 默认建议为我用户目录下 .config/docmost/session.json 的绝对路径，保存在仓库外。不要让我把密码发到聊天，不接受密码环境变量或参数，也不要读取、回显或记录会话 JSON 内容。请给我使用实际 Node 和 dist/index.mjs 绝对路径的 --login 命令，让我在自己的真实本机终端执行并亲自输入邮箱和隐藏密码；你不要代跑登录或把密码送入模型。登录只向我指定的部署发送。SSO/MFA 或缺少可撤销会话 ID 的旧版认证不支持时说明并停止，不绕过认证、不抓浏览器 Cookie、不伪造 Token、不自动切换 API Key。已有未过期会话不能静默覆盖，更换账号先 --logout；过期的同部署记录可重新 --login。

我完成登录后，你可以用 DOCMOST_URL、DOCMOST_AUTH_MODE=session 和 DOCMOST_SESSION_FILE 运行只读 --list-spaces，按 meta.nextCursor 翻页，展示空间名称和真实 UUID，让我选择必填默认空间；再询问可选默认父页，留空表示空间根目录。不要把页面链接里的 slug 当配置 UUID。运行 --check，核对身份、默认空间和父页的空间归属。只有父页标题或链接时，先不设置父页完成只读连接，再用 search_pages/get_page 取得规范 UUID，补充配置并重新检查。

我授权你在已选作用域安装 MCP 与 Skill：检查通过后合并客户端配置，保留现有其他设置；遇到同名 docmost 配置先比较，有冲突再让我选择。正常配置使用 DOCMOST_READ_ONLY=0，具体写入仍需我的文档任务授权。安装完成后只读验证并报告配置位置、身份、默认空间和父页，不输出凭据，也不要创建测试页面。会话过期或撤销后提示我在自己的终端重新登录，不保存密码或自动登录。退出使用 --logout，只撤销本 MCP 的专用会话并清理本地文件；远程撤销失败时如实报告不确定性。

我选择“不启用知识库”时设为 none，跳过所有后端地址、Key、身份与私有根问题；即使遗留 OpenViking 配置也不读取 Key 或访问服务。我选择 OpenViking 时，按同版本 docs/knowledge-sync.md 和 docs/openviking-sync.md 引导既有服务根地址、仓库外私有 Key 文件、个人/共享模式、可选预期账户/用户与所选资源根。已有页面同步只配置 DOCMOST_KNOWLEDGE_STATE_DIR 私有绝对目录（默认可复用已有 DOCMOST_SYNC_STATE_DIR），不要求本地 MD、源目录、绑定或条件同步接口。Key 由部署管理员提供给指定个人用户，再由我本人在真实终端隐藏输入保存到仓库外 0600 文件；你只配置路径，不读取/回显 Key 或代跑私密输入。沿用已明确授权的该服务模型处理和父目录摘要刷新范围，不重复询问。无需安装 ov/Python、额外 npm 包或部署服务。

构建后先只读 --check-knowledge，再重启实际 MCP 连接发现工具及 schema。已有页面优先用 sync_page_to_knowledge({pageId:规范UUID}) 将当前已保存完整 Markdown 入库并登记，用 get_page_knowledge_status({pageId}) 查看 URI、原文哈希、进度和错误；失败时用状态返回的 bindingId 调用 retry_knowledge_sync，仅补知识库，不重放 Docmost。不要默认退回 ov CLI、add-resource 或要求先导出 MD。普通 create_page 不会自动开启外发；登记后本 MCP 的正文/标题修改、移动页面或祖先、跨空间移动、软删除/恢复会跟进，网页直接改动保存后须再次显式同步。只有我另选本地 MD 保存上传时，才按 docs/md-auto-sync.md 配置两个 MD 目录和绑定/条件同步流程。不导入工作区，不迁移或清理旧 CLI 导入。知识库失败单独报告，继续可用的 Docmost 接入；只读检查不能代替完整原文哈希、摘要/向量与检索验收。
```

后面的 shell 示例适用于 macOS/Linux；其他系统应调整路径和权限。Agent 可以完成源码构建、非秘密配置和已授权的只读查询；`--login` 必须留给用户在自己的本机终端执行。

## 1. 确认部署与本机前提

先确定部署根 URL、AI 客户端、源码安装位置和安装作用域，并主动提供“不启用知识库 / OpenViking”选择；已有明确选择直接沿用。选择 `none` 后跳过后端问题。选择 OpenViking 时按[知识库接入](knowledge-sync.md)引导服务根地址、私有 Key 文件、可选身份与私有根。根 URL 例如 `https://wiki.example.com`，不带 `/api`、页面路径或登录路径。本机需要 Git、Node.js **22 或更新版本**及 npm：

```sh
git --version
node --version
npm --version
command -v node
```

依赖缺失时按用户授权安装，不擅自改变全局 Node 或包管理器配置。桌面客户端的 `PATH` 可能不同于终端，最终配置优先使用实际 Node 的绝对路径。

社区会话接入使用目标部署正常的邮箱/密码登录及当前用户权限。它不需要企业 API Key，也不修改企业许可证检查。当前仅支持带可撤销 session ID 的个人会话；SSO、MFA、没有 session ID 的旧版 ACCESS 登录不支持。遇到这些情况停止并说明限制，不降级认证或切换共享管理员账号。

## 2. 从 GitHub 下载并构建 MCP

选择用户确认的**未占用目录**，替换示例路径。目录已存在时先检查用途，不覆盖、删除或重置内容。需要指定包含会话模式的分支时，在下载前核对并选用该分支：

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

`--help` 应包含 `--login`、`--logout`、`DOCMOST_AUTH_MODE` 和 `DOCMOST_SESSION_FILE`；需要知识库功能时，还须包含 `--check-knowledge`、`DOCMOST_KNOWLEDGE_PROVIDER` 和 `DOCMOST_KNOWLEDGE_STATE_DIR`，重启后实际发现页面同步/状态工具。稀疏检出保留 MCP、Skill、指南和根文件（包括许可证）。`--workspaces=false` 将安装限定在 MCP 包，不需要根目录完整工作区的 `pnpm install`。构建入口为 `/absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs`。

需要运行包内测试时，在同一 `packages/mcp` 目录执行：

```sh
npm run --workspaces=false test
```

保留源码和许可证。迁移机器时重新安装，并由用户在新机器重新登录；不要通过复制会话文件扩散凭据。

### 更新已有安装

在实际安装的源码目录中先检查 `git status --short`；有自己的改动时先处理，保留配置和仓库外的凭据文件。源码无冲突时执行：

```bash
cd /absolute/path/docmost-mcp-source
git pull --ff-only
cd packages/mcp
npm install --workspaces=false
npm run --workspaces=false build
```

如已安装 Skill，比较并更新授权作用域中的 Skill 文件。随后重启 Docmost MCP 连接，让客户端重新发现工具；运行中的旧进程不会自动加载新代码。基础、MD 和知识库扩展按当前配置发现实际工具与 schema，不依赖旧工具总数；仅在另一个目录构建不会更新客户端实际指向的安装。旧安装省略 provider 但已有 OpenViking URL 时兼容启用；显式 `none` 可覆盖遗留配置。

## 3. 用户在自己的终端建立个人会话

明确设置 `DOCMOST_AUTH_MODE=session`，并将 `DOCMOST_SESSION_FILE` 指向仓库外的私有 JSON 文件**绝对路径**。建议位置是 `~/.config/docmost/session.json`，shell 中用 `"$HOME/.config/docmost/session.json"` 展开为绝对路径；客户端配置应写实际绝对路径。

把以下命令交给用户，在其自己的真实本机终端执行。URL 和入口路径先替换为实际值；无需默认空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE="$HOME/.config/docmost/session.json" \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --login
```

CLI 提示邮箱与隐藏密码。密码只在该登录进程内存中短暂存在，不保存到磁盘，不接受环境变量（包括 `DOCMOST_PASSWORD`）、命令行参数或工具参数。Agent 不代跑 `--login`、不向聊天索要密码、不用管道或模拟终端灌入密码。不要把邮箱/密码直接拼进上述命令。

登录只向配置的同一 HTTPS origin 发送正常 `POST /api/auth/login`，拒绝重定向；CLI 验证个人身份和可撤销的专用会话后再保存。会话 JSON 含敏感凭据，Agent 不打开、读取、展示或复制其中内容。POSIX 下使用当前用户私有目录 `0700` 和普通文件 `0600`，不接受符号链接；MCP 会检查权限和文件格式。其他系统按实现支持设置私有访问权限。

`--login` 不会静默覆盖已有未过期会话；更换账号先按下一节 `--logout`。同部署的过期记录可重新登录替换。来源不同或格式错误的记录会拒绝，不通过删除未知文件来跳过检查。运行时只读取已保存会话，过期、撤销或 401 时要求用户重新登录，不保留密码、不自动登录、不回退到 API Key。

### 退出、重新登录与撤销

使用同一部署和同一会话文件路径执行：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE="$HOME/.config/docmost/session.json" \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --logout
```

`--logout` 只撤销这个 MCP 专用的服务器会话并清理本地文件，不执行“退出全部设备”。远程撤销失败或无法确认时，如实报告；清理本地文件不能证明服务器会话已撤销，可由用户在 Docmost 账号的 Sessions 中检查并撤销对应会话。重登录后重启 MCP 连接，让它重新加载文件。尚未过期但已撤销的本地记录先 `--logout` 清理，再 `--login`；本地过期记录可直接重登录。登录成功但本地保存失败时，CLI 会尝试撤销刚创建的会话，失败也会说明。

## 4. 选择默认空间和可选父页面

用户完成登录后，Agent 可运行以下只读命令。首次列表无需默认空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --list-spaces
```

输出含 `items` 和 `meta`。展示空间名称及真实 UUID，让用户选择默认空间；`meta.nextCursor` 非空时，用同样环境继续运行：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs \
  --list-spaces --cursor '服务器返回的游标'
```

`DOCMOST_DEFAULT_SPACE_ID` **必填**且必须为 UUID，正常 stdio 启动和 `--check` 都需要它。空间名称、网址片段不能代替 UUID；不要替用户选第一项。

`DOCMOST_DEFAULT_PARENT_PAGE_ID` **可选**，不设置或为空表示在默认空间根目录创建。设置时须为该空间内未删除父页的规范 UUID，不能使用页面 URL 的 slugId。用户只有父页标题或链接时，先只配置默认空间、不设父页，完成 `--check` 和客户端登记；再仅用 `search_pages` / `get_page` 读取父页的 `id` 和 `spaceId`，补充父页变量、重新 `--check`、合并配置并重启连接。

下面以根目录为例；有父页时增加 `DOCMOST_DEFAULT_PARENT_PAGE_ID=<真实父页UUID>`。所有 UUID 示例均须替换：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_AUTH_MODE=session \
DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check
```

`--check` 只读取当前凭据身份、默认空间和可选父页；父页空间不匹配或已删除会失败。它不会创建页面，也不证明写权限。

## 5. 合并客户端 MCP 配置

用户已授权安装并选择作用域时，Agent 可登记或合并配置，保留其他设置。同名 `docmost` 配置有冲突时先比较并让用户选择，不覆盖整个配置文件。配置保存 URL、认证模式、私有文件路径和默认位置，**不保存密码或会话值**。

### Claude Code

下面是当前用户级示例；当前项目可按用户选择改为 `--scope local` 或 `--scope project`。替换 Node、源码、会话文件和 UUID：

```sh
claude mcp add \
  --scope user \
  --env DOCMOST_URL=https://wiki.example.com \
  --env DOCMOST_AUTH_MODE=session \
  --env DOCMOST_SESSION_FILE=/Users/your-name/.config/docmost/session.json \
  --env DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
  --env DOCMOST_READ_ONLY=0 \
  --env DOCMOST_KNOWLEDGE_PROVIDER=none \
  --transport stdio docmost \
  -- /absolute/path/to/node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs
claude mcp get docmost
```

有默认父页时再加其 `--env` 项；用 `/mcp` 检查连接。[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)

### Codex

当前用户级 CLI 登记示例：

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

也可将下面配置合并到用户级 `~/.codex/config.toml`，或用户选定且受信任项目的 `.codex/config.toml`。项目配置只在受信任项目中加载；无父页不添加对应行：

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

更改后重启 MCP 连接或客户端，使用 `/mcp` 检查工具。[OpenAI 官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[配置作用域文档](https://learn.chatgpt.com/docs/config-file/config-basic)

### 配置项与 API Key 备选

| 变量 | 含义 |
| --- | --- |
| `DOCMOST_URL` | 必填，部署根 HTTPS URL，不含 `/api`。 |
| `DOCMOST_AUTH_MODE` | `session` 或 `api_key`；兼容默认是 `api_key`，社区会话必须明确设为 `session`。 |
| `DOCMOST_SESSION_FILE` | 会话模式必填的私有 JSON 文件绝对路径，建议 `~/.config/docmost/session.json` 的实际绝对路径。 |
| `DOCMOST_API_TOKEN_FILE` | 仅 API Key 模式：私有纯文本 Key 文件绝对路径，与下一项二选一。 |
| `DOCMOST_API_TOKEN` | 仅 API Key 模式：由安全进程环境注入，不在配置、聊天或命令中填写明文。 |
| `DOCMOST_DEFAULT_SPACE_ID` | 正常 stdio 启动和 `--check` 必填的默认空间 UUID；`--login` / `--logout` / `--list-spaces` 无需填写。 |
| `DOCMOST_DEFAULT_PARENT_PAGE_ID` | 可选默认父页 UUID，须属于默认空间；不设置或为空表示根目录。 |
| `DOCMOST_READ_ONLY` | 默认 `0`；只读设为 `1`，不向两端派发写入，知识库仅查询状态。 |
| `DOCMOST_TIMEOUT_MS` | 请求超时，默认 `30000` 毫秒，范围 `100`–`120000`。 |
| `DOCMOST_ALLOW_LOCAL_HTTP` | 仅本机调试设为 `1`，允许 loopback HTTP；远程仍需 HTTPS。 |
| `DOCMOST_SYNC_ROOT` | 可选 MD 同步的现有绝对源目录，只访问明确绑定的文件。 |
| `DOCMOST_SYNC_STATE_DIR` | 配合源目录的独立私有绝对目录；0700/0600，启用镜像后会暂存原始 MD 快照。 |
| `DOCMOST_KNOWLEDGE_PROVIDER` | 新安装明确选择 `none` 或 `openviking`；`none` 覆盖遗留后端配置，不读取 Key、不访问服务。省略时兼容由已有 OpenViking URL 推断。 |
| `DOCMOST_KNOWLEDGE_STATE_DIR` | 页面主动同步的私有绝对状态目录，保存登记、任务与完整原文快照；省略时复用已有 `DOCMOST_SYNC_STATE_DIR`，不要求 MD 源目录；同时启用 MD 时须与 MD 状态目录相同。 |
| `DOCMOST_OPENVIKING_URL` | OpenViking 部署根 URL；HTTPS 或本机 loopback HTTP。明确选择 OpenViking 时必需，缺失仅阻塞知识库。 |
| `DOCMOST_OPENVIKING_API_KEY_FILE` | 选择 OpenViking 时必需的独立私有 Key 文件绝对路径。 |
| `DOCMOST_OPENVIKING_ACCOUNT` / `DOCMOST_OPENVIKING_USER` | 可选预期身份校验，不能切换 Key 所属用户。 |
| `DOCMOST_OPENVIKING_SCOPE` | `personal`（默认）或显式 `shared`，后者写同一 account 的共享 resources。 |
| `DOCMOST_OPENVIKING_ROOT_URI` | 所选模式的具体子目录，默认个人为 `viking://user/<已确认用户>/resources/docmost-mcp`，共享为 `viking://resources/docmost-mcp`。 |
| `DOCMOST_OPENVIKING_TIMEOUT_MS` | OpenViking 单次 HTTP 超时，默认 `30000` 毫秒，范围 `100`–`120000`。 |

认证模式严格互斥：`session` 拒绝 `DOCMOST_API_TOKEN` / `DOCMOST_API_TOKEN_FILE`，`api_key` 拒绝 `DOCMOST_SESSION_FILE`；不会隐式切换。`DOCMOST_PASSWORD` 等密码环境变量不受支持。

仅当目标部署具备官方 API Key 能力和有效许可、用户选择该方式时，配置 `DOCMOST_AUTH_MODE=api_key`，移除 `DOCMOST_SESSION_FILE`，改用一个 Key 来源。Docmost 官方将 API Key API 列为企业许可功能；界面或数据库表存在不能证明服务器具备该能力。[官方 API 指南](https://docmost.com/docs/user-guide/api)

由用户在目标部署的 **Settings → Account → API keys** 创建个人 Key，再本人用可信本地编辑器保存到仓库外的私有纯文本文件，例如 `/Users/your-name/.config/docmost/api-token`。POSIX 文件须当前用户所有、普通文件 `0600`、无符号链接。Agent 不读取、展示或记录 Key 内容。API Key 模式复用上面的列表、检查和客户端配置流程，只替换认证模式和凭据文件变量；不运行 `--login` / `--logout`。轮换 Key 由用户更新文件，并在服务器撤销旧 Key。

正常安装提供写工具，实际写入以用户文档任务授权为准。只有用户选择只读连接时设 `DOCMOST_READ_ONLY=1`。凭据不是工具参数；工具返回文档会进入所选 AI 客户端上下文，只读取当前任务授权内容。

### 可选 MD 与知识库

已有 Docmost 页面用 `sync_page_to_knowledge` 入库，只需知识库连接及 `DOCMOST_KNOWLEDGE_STATE_DIR` 私有绝对目录（默认复用已有 `DOCMOST_SYNC_STATE_DIR`），不需要 MD 源文件、绑定或条件同步路由。仅在选择本地 MD 保存自动上传时，两个 MD 目录才须同时配置且不能互相包含，目标部署还须具备条件同步路由；详见 [Markdown 自动同步](md-auto-sync.md)。增加 OpenViking 时由用户从该部署取得个人 Key，按 [私密保存与连接步骤](openviking-sync.md#用户在自己的终端保存-key) 写入仓库外文件；OpenViking Key 不能代替 Docmost Token，也不受 Docmost 企业 API Key 许可决定。

上述客户端示例对应选择 `none`；选择 OpenViking 时将 provider 改为 `openviking` 并合并其连接变量。远程使用部署根 HTTPS URL；本机 HTTP 仅允许 loopback。MCP 通过 HTTP 请求既有服务，不检查 `ov` 命令，也不自动部署服务。显式 `none` 覆盖遗留配置；省略 provider 时才按已有 URL 兼容推断。明确选择 OpenViking 但缺少 URL、未知 provider 或连接失败只影响知识库状态，不阻止普通 Docmost 工具。

配置后运行独立只读 `node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge`，带入所选后端变量即可，无需 Docmost 登录、默认空间或 MD 目录。检查返回安全状态、鉴权身份和私有根，不输出 Key；它不写入资源，也不证明摘要或索引能力。失败仅使此检查返回非零，单独报告后继续可用的 Docmost 配置。示例与边界见 [知识库接入](knowledge-sync.md)。

已有页面调用 `sync_page_to_knowledge({pageId})` 读取当前已保存完整 Markdown 并登记后续 MCP 修改跟进，用 `get_page_knowledge_status({pageId?})` 读登记、URI、`localHash` / `remoteRevision` 正文 SHA-256 指纹和独立 `knowledgeBase` 错误；未登记为 `not_enrolled`，数据库保存尚未导出确认为 `waiting_docmost`。这些指纹不是实时协作版本或 CAS 令牌。普通新建页须显式登记才外发；网页直接修改无后台监听，再显式同步即可。MD 绑定仍通过 `get_markdown_sync_status.knowledgeBase` 查看进度，兼容保留 `openViking`。通用重试 `retry_knowledge_sync({bindingId})` 及 OpenViking 兼容别名仅补知识库阶段，不重放 Docmost 写入。开启前沿用或取得完整正文及祖先目录摘要刷新的明确授权；切换 provider、地址、身份或根不改投旧任务，不迁移/清理旧 CLI 导入。

## 6. 安装 Skill 并验证连接

将 `skills/docmost-mcp` 的完整目录（含 `references`、`agents`）复制到用户选择的位置：

| 客户端 | 当前项目 | 当前用户 |
| --- | --- | --- |
| Claude Code | `.claude/skills/docmost-mcp` | `~/.claude/skills/docmost-mcp` |
| Codex | `.agents/skills/docmost-mcp` | `~/.agents/skills/docmost-mcp` |

例如在目标项目根目录执行以下一种；已有同名目录时先比较后更新，避免嵌套复制：

```sh
# Claude Code 项目级
mkdir -p .claude/skills
cp -R /absolute/path/docmost-mcp-source/skills/docmost-mcp .claude/skills/docmost-mcp
```

```sh
# Codex 项目级
mkdir -p .agents/skills
cp -R /absolute/path/docmost-mcp-source/skills/docmost-mcp .agents/skills/docmost-mcp
```

用户级安装复制到表中用户目录即可。安装 Skill 不会登记 MCP 或授予 Docmost 权限。Codex 可显式调用 `$docmost-mcp`，Claude Code 可调用 `/docmost-mcp`。[Claude Code Skill 文档](https://code.claude.com/docs/en/skills)、[OpenAI 官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills)

重启后先调用 `get_current_user` 查看身份及 `defaults`，再 `get_space` 核对默认空间，按用户授权检索、读取页面。`defaults` 包含 `spaceId` 和 `parentPageId`，根目录为 `null`。报告安装和配置位置、部署 URL、身份、默认空间和父页，不报告凭据。创建测试页须已有写验收授权，不能从安装授权推导任意文档修改权限。

## 工具与默认创建行为

可选的本地 MD 保存自动同步见 [Markdown 自动同步](md-auto-sync.md)：随 MCP 进程启停、显式关联、条件更新和冲突暂停。默认不启用；需要配置源目录与私有状态目录，以及包含条件同步接口的服务器。

选择 OpenViking 后，已有 Docmost 页面可显式调用 `sync_page_to_knowledge` 入库并登记，独立于 MD 绑定；MD 链路也可增加 [可选镜像](openviking-sync.md)。空间名、完整父页链和页面标题构成可读路径，规范 ID 保留在私有账本，完整 Markdown 原文用于摘要与向量；已登记页的 MCP 修改及移动祖先会跟进，网页保存后再次显式同步。`retry_knowledge_sync({bindingId})` 与兼容别名 `retry_openviking_sync` 不提供任意路径写入能力。明确的删除/恢复只处理可证明属于本次操作且发生状态转换的活跃登记子集；删除本地 MD 不传播到远端。

本地包对齐 [Docmost 官方 MCP 指南](https://docmost.com/docs/user-guide/mcp) 公开列出的 20 个工具能力，另保留 `delete_page` / `restore_page` 两个本地扩展，共 22 个工具。官方指南公布工具名称和用途，未公布输入 schema；本地输入依据本仓库实际 REST DTO 和权限检查实现，不声称与私有企业 MCP 实现完全一致。官方远程 `/mcp` 的许可与 OAuth 接入要求仍按官方指南执行；本地 stdio 的个人会话方式见前文。

客户端可能给工具名称加前缀，应发现当前连接实际提供的工具，并以其 schema 为准；不能把旧版十工具清单当作固定接口。注册工具不代表目标部署的每个后端接口都可用。

可选知识库工具另行发现：`sync_page_to_knowledge({pageId: 规范UUID})` 主动读取并登记完整原文，`get_page_knowledge_status({pageId?})` 查询状态/URI/指纹，`retry_knowledge_sync({bindingId})` 仅补知识库阶段。`none` 或缺少私有状态目录时页面工具不注册；只读模式仅注册状态读取。各工具返回、错误和重试流程见 [知识库接入](knowledge-sync.md#状态与错误的处理)，不默认退回 CLI。

| 工具 | 读写 | 来源 | 用途 |
| --- | --- | --- | --- |
| `search_pages` | 读取 | 官方 | 按关键词检索有权限的页面，获取真实页面 ID。 |
| `get_page` | 读取 | 官方 | 读取页面及 Markdown/HTML/编辑器 JSON 正文。 |
| `create_page` | 写入 | 官方 | 在默认或指定空间/父页下创建页面。 |
| `update_page` | 写入 | 官方 | 修改标题或正文。 |
| `list_pages` | 读取 | 官方 | 分页列出近期可访问页面，可按空间限制；不是目录树。 |
| `list_child_pages` | 读取 | 官方 | 分页列出指定页面的可见直接子页；按需继续读取各层。 |
| `duplicate_page` | 写入 | 官方 | 在同一空间复制页面。 |
| `copy_page_to_space` | 写入 | 官方 | 将页面及可访问子树复制到另一个空间。 |
| `move_page` | 写入 | 官方 | 调整页面位置或父页。 |
| `move_page_to_space` | 写入 | 官方 | 将页面及可访问子树移动到另一个空间。 |
| `get_space` | 读取 | 官方 | 获取可访问空间的信息。 |
| `list_spaces` | 读取 | 官方 | 分页查找可访问空间。 |
| `create_space` | 写入 | 官方 | 创建空间。 |
| `update_space` | 写入 | 官方 | 更新空间名称或描述。 |
| `get_comments` | 读取 | 官方 | 读取页面评论。 |
| `create_comment` | 写入 | 官方 | 向页面添加评论。 |
| `update_comment` | 写入 | 官方 | 更新评论。 |
| `search_attachments` | 读取 | 官方 | 检索当前用户可见的文件附件；需要目标部署提供对应接口。 |
| `list_workspace_members` | 读取 | 官方 | 分页列出当前账号可查询的工作区成员。 |
| `get_current_user` | 读取 | 官方 | 检查当前凭据用户和配置的 `defaults`。 |
| `delete_page` | 写入 | 本地扩展 | 软删除页面及其子页，内部固定 `permanentlyDelete: false`。 |
| `restore_page` | 写入 | 本地扩展 | 恢复页面及全部后代，包含此前已软删的后代；不恢复原分享链接。 |

`search_attachments` 请求 `/api/search-attachments`。本 fork 增加了支持个人会话和页面权限过滤的社区接口；仅安装本地 MCP 不会给公司原版服务器增加该接口。原版或较旧部署可能缺少该路由；工具确认是路由不存在时返回 `UNSUPPORTED_DEPLOYMENT`，普通资源 404 仍返回 `NOT_FOUND`，不能解释成“没有附件”或宣称已验收全部能力。需要时由管理员合法部署包含该接口的版本；不通过数据库、浏览器抓取或绕过企业许可补齐能力。

`create_page` 省略 `spaceId` 时使用默认空间；省略 `parentPageId` 且目标是默认空间时使用默认父页。默认父页未设置就是空间根目录。显式 `parentPageId: null` 表示在目标空间根目录创建；明确指定其他空间时不继承默认父页，省略父页即在该空间根目录创建。显式父页必须属于目标空间。默认位置不限制 账号的访问范围，读取或写入其他空间仍须符合服务器权限和用户任务范围。

例如用户要求“在默认位置创建‘MCP 接入记录’，正文为……”时，Agent 可调用：

```json
{
  "title": "MCP 接入记录",
  "content": "# MCP 接入记录\n\n用户要求的内容。",
  "format": "markdown"
}
```

可直接向助手提出“搜索‘发布流程’，给我页面链接并总结”“在这篇已找到的页面末尾追加以下段落”“把正文替换为以下 Markdown”。服务器始终按 当前账号权限校验。正文更新走 `/pages/update` 的编辑器/Yjs 同步流程，不通过数据库 SQL 替换。

正文为非空 Markdown 或 HTML，默认 Markdown；不支持空字符串清空。`update_page` 带 `content` 时必须明确 `operation: "append" | "prepend" | "replace"`，仅改标题不需要正文操作。页面 ID 来自检索或列表，不凭标题猜测。删除和恢复只接受规范 UUID `id`，不能使用 URL 中的 slugId。列表按实际返回的 `meta.nextCursor` 翻页；页面和附件搜索使用 `limit/offset`，没有搜索游标。

`move_page` 必须显式提供 `parentPageId` 和 `position`：同父页重排传当前父页 ID，移动到空间根目录传 `null`；`position` 是 5–12 位排序字符串，不是数字序号。跨空间复制或移动影响子树，先核对源页面、目标空间、目标位置及用户对整个范围的授权；不要从单页阅读授权推导跨空间传播或移动权限。评论写入只接收非空纯文本 `text`，包装层转换为编辑器 JSON；不解析 HTML 或 Markdown，不开放 inline selection 或富文本输入。评论、空间和页面写入后使用对应读取工具核对结果。

复制读取服务器已保存快照，不保证包含协作编辑器尚未落库的修改；同空间副本保留原父位置，跨空间副本位于目标根目录。副本不继承源页评论或页面访问限制，须确认目标空间的可见范围；成功响应也不能证明每个附件均已复制。跨空间移动只移动可访问子树，无权访问的子树会留在原空间并脱离为根。按用户授权核对受影响页面，不宣称逐页验证不可见后代。

删除影响整棵子树并移除分享链接。恢复会递归恢复全部后代，包括此次删除前就已软删的后代；原分享链接不会恢复。`list_child_pages` 可按需分页查看可见子页，但权限过滤会隐藏无权读取的后代，不能证明没有隐藏子页，也不能可靠枚举待恢复的软删后代。删除或恢复都需要用户明确授权整个受影响子树，不能把近期列表或子页列表没有结果视为没有子页。写操作限于用户请求的对象；超时可能已在服务器生效，应先读取核对，尤其不要盲目重试创建、复制、评论或追加。

## 排错、验收范围与许可证

| 现象 | 检查项 |
| --- | --- |
| 找不到 `--login` / `--logout` | 所选源码版本尚未包含社区会话模式；核对分支实际文件，不套用旧 API Key 版本。 |
| 登录提示需要 TTY | 用户在自己的真实本机终端执行 `--login`；Agent 不代跑、管道或模拟密码输入。 |
| SSO/MFA 或缺少 session ID | 当前方式不支持，停止并说明限制，不降级认证。 |
| 已有会话或文件来源不符 | 未过期会话先 `--logout`；同部署过期记录可重登录；不要覆盖来源不同或格式异常的记录。 |
| `SESSION_NOT_REVOCABLE` | 服务器没有签发带 `sessionId` 的可撤销会话，需更新社区版会话支持；反复登录或复制浏览器 Cookie 都不能解决。 |
| `SESSION_CHANGED` | 注销期间已有新会话替换旧记录，新凭据已保留；仅在确实要结束新会话时再次注销。 |
| 会话文件错误 | 检查绝对路径、私有权限、文件类型和模式互斥；不要打开 JSON 内容排查。 |
| 会话模式 401 / 过期 / 撤销 | 用户本人重新登录；尚未过期的已撤销本地记录先 `--logout`。没有自动登录或 API Key 回退。 |
| API Key 模式 401 | 检查 Key 过期、撤销、部署归属和服务器企业 API Key 能力。 |
| 403 | 当前账号权限不足；不自动更换管理员或修改工作区策略。 |
| 缺少默认空间或 UUID 错误 | `--list-spaces` 取得真实 UUID；正常启动/`--check` 必填。 |
| 默认父页检查失败 | 父页须 UUID、属于默认空间且未删除；无父页则移除变量。 |
| 404、TLS 或超时错误 | 核对根 URL（不加 `/api`）、版本、网络和证书；保留 HTTPS 证书校验。 |
| `search_attachments` 返回 `UNSUPPORTED_DEPLOYMENT` | 目标服务器缺少附件搜索接口；本地 MCP 安装不会更新服务器。由管理员合法部署支持 `/api/search-attachments` 的版本，不当作空结果。 |
| Node 无法启动或缺写工具 | 核对 Node 22+ 绝对路径和 `dist/index.mjs`；需要写工具时检查 `DOCMOST_READ_ONLY`。 |
| 知识库工具未出现 | 核对源码/构建版本、实际入口、provider、私有知识库状态目录及只读配置，再重启连接；已有页不要求 MD 两个目录。 |
| `--check-knowledge` 失败 | 单独排查所选 provider、服务根地址、私有 Key 文件权限、鉴权身份与根；无需先配置 Docmost 默认空间，不影响普通 Docmost 工具。 |
| Docmost 已成功、知识库 `retrying` / `blocked` | 页面登记看 `get_page_knowledge_status`，MD 关联看 `knowledgeBase`（兼容 `openViking`）；保留 bindingId，先排查再通用重试，不重复 Docmost 创建或正文写入。 |
| 页面未登记或主动同步失败 | 状态查询不自动登记；按工具实际错误区分未配置、页面身份/权限、目标变化及后端处理失败，见 [知识库状态与错误](knowledge-sync.md#状态与错误的处理)。 |
| 再次更新同页正文返回 `SAVE_PENDING` | 上一笔正文保存未确认，本次 Docmost 更新尚未派发；等待并读回后再执行这次请求，不重复已成功的上一笔。 |

正常 stdio 启动后进程等待 MCP 协议输入；登录交互只属于单独的 `--login` 命令。不要向 stdout 添加调试输出；诊断写 stderr，避免凭据和完整请求头。

2026-10-13 基础工具对齐后的完整构建与回归测试为 **91/91 通过**，独立 GitHub 单包安装布局也通过同组测试。覆盖 22/10 工具发现、严格参数、REST 请求和投影、复制/移动预读、评论换行、附件路由能力检测及响应上限，以及既有 API Key、个人会话、终端隐藏输入、过期和并发注销保护。这些历史结果不覆盖后来增加的 MD / OpenViking 能力，各自按对应指南验收。

新增 12 工具已在独立本地社区版通过真实个人会话与 stdio 验收，**29/29 检查通过**：复制与移动子树后读回，创建/更新空间，评论/回复/作者更新，附件和成员检索；reader 的 8 个新增写工具均返回 403，管理员修改 writer 评论也返回 403，受限子页和评论不可读，向无权目标空间复制/移动被拒绝。测试创建的评论、页面和空间已清理，三个专用会话注销后重放均返回 401，会话文件已删除。此前还完成了终端密码登录、`0600` 会话存储、默认空间校验，以及通过真实 stdio 创建、追加、读回和软删除的验收。真实验收使用本机合成测试账号，没有修改公司文档。

以上不能代替目标公司部署验收。真实公司接入需要用户在本机亲自登录，再用 `--list-spaces`、`--check` 和已授权客户端查询确认。页面写入、删除和恢复须分别在用户授权范围验证；未执行时如实标记未验收。当前密码登录模式不完成 SSO/MFA，也不接受旧版无 `sessionId` 的不可撤销凭据。

本地包遵循仓库 [AGPL-3.0 许可证](../LICENSE)。企业目录另有许可证；MCP 不复制或补齐企业实现。个人会话调用现有社区登录和文档接口，企业 API Key 能力仍由部署许可与管理员配置决定。[Docmost 官方 API 参考](https://docmost.com/api-docs)
# Git 提交后发布

保存即同步之外，可选择 Git 来源，在任意分支成功提交后发布固定 Markdown 快照，并通过 git-delivery Skill 执行 add/commit/push/指定分支合并。Skill 自动识别当前仓库，同一 MCP 支持多个项目；用户不必配置 Git 地址/路径，不为切换项目改配置或重启。旧 Git 根仅保留为兼容默认值，原账本无需迁移。多个分支共用同一页面，冲突暂停。安装、状态目录、旧记录转换及自验见 [Git Delivery](git-delivery.md)。配置本身不绑定文件或安装 Git hook。
