# 从 GitHub 安装本地 Docmost MCP 与 Skill

`@docmost/local-mcp` 是独立的 Node.js stdio MCP：AI 客户端启动本地进程，由它携带用户的 Docmost API Token 请求已部署的 Docmost HTTPS API。无需启动本仓库的 Docmost 服务，也不会直接写数据库。`skills/docmost-mcp` 指导 Agent 完成安装配置和授权的文档操作；MCP 与 Skill 需分别安装。

源码交付入口是 [MrQinYQ/docmost 的本指南](https://github.com/MrQinYQ/docmost/blob/main/docs/local-mcp.md)。本文使用 GitHub 源码安装，不需要发布 npm 包、`npm pack` 或在线 `npx` 包。安装前应确认所选分支确实含有 `packages/mcp`、`skills/docmost-mcp` 和本指南；缺少时停止并说明版本问题，不改装同名第三方包。代码、Skill 和指南随同一 GitHub 分支交付，安装时以该分支实际文件为准。

## 可以直接交给 Agent 的安装指令

将下面这段完整指令交给有本机安装能力的 Agent。填得出的信息可先填；Token 不要填进这段指令。

```text
请阅读 https://github.com/MrQinYQ/docmost/blob/main/docs/local-mcp.md，按指南从 GitHub 源码为我安装本地 Docmost MCP 和 docmost-mcp Skill，不发布 npm 包。

先确认我的 Docmost 部署域名、使用的 AI 客户端（如 Codex 或 Claude Code）、源码安装目录，以及 MCP/Skill 使用当前项目还是当前用户作用域；已有信息不要重复问。请检查当前操作系统、Git、Node.js 22+ 和 npm，在我确认的未占用目录下载源码，只在 packages/mcp 安装依赖并构建，不安装整个 Docmost 工作区，不覆盖已有目录或其他客户端配置。

请引导我到目标 Docmost 的 Settings → Account → API keys 创建个人 API Key，并由我在可信的本地编辑器把它写入仓库外的私有 Token 文件。不要让我把 Token 发到聊天，不要读取、回显或记录文件内容，不要把 Token 明文写进配置、命令或源码。macOS/Linux 的文件使用 0600 权限；其他系统请适配当前用户私有权限。

在我完成保存后，用 DOCMOST_URL 和 DOCMOST_API_TOKEN_FILE 运行 --list-spaces，按 meta.nextCursor 翻页，展示空间名称和真实 UUID，让我选择必填的默认空间；再询问可选的默认父页面，留空表示空间根目录。不要把页面链接中的 slug 当成配置 UUID。运行 --check，核对身份、默认空间和默认父页面的空间归属。

我授权你在已选作用域安装 MCP 与 Skill：在检查通过后合并客户端配置，保留现有其他设置；遇到同名 docmost 配置先比较，有冲突再让我选择。正常配置使用可写模式 DOCMOST_READ_ONLY=0，具体写入仍需我提出的文档任务授权。安装完成后做只读连接验证，报告配置位置、身份、默认空间和父页面；未经我另外授权不要创建测试页面。若部署不支持官方 API Key，说明原因并停止 Token 接入，不绕过企业许可或自动改用 Cookie。
```

如果 Agent 仅能提供建议，用户按下列步骤执行即可。后面的 shell 示例适用于 macOS/Linux；Windows 等系统应调整命令、路径和文件权限，不照搬 POSIX 命令。

## 1. 确认部署与本机前提

先确定四项信息：Docmost 部署根 URL、AI 客户端、源码安装位置、客户端与 Skill 的安装作用域。根 URL 例如 `https://wiki.example.com`，不带 `/api`、页面路径或登录路径。

本机需要 Git、Node.js **22 或更新版本**及 npm，可先检查：

```sh
git --version
node --version
npm --version
command -v node
```

依赖缺失时说明所需版本并按用户授权安装；不要擅自改变全局 Node 或包管理器配置。桌面客户端的 `PATH` 可能不同于终端，最终配置优先使用实际 Node 的绝对路径。

目标 Docmost 必须支持官方 API Key。Docmost 官方 API 指南说明 API 需要有效企业许可证，个人 API Key 继承创建者的权限。[官方 API 指南](https://docmost.com/docs/user-guide/api)

本次检视的社区源码不包含 `apps/server/src/ee/api-key/api-key.service`；`JwtStrategy.validateApiKey()` 在该模块缺失时返回 401。前端有 API keys 界面或数据库有 `api_keys` 表，不能证明当前服务器支持 Token。MCP 不启用企业模块、不绕过许可证，也不把登录 Cookie 或自行签名的 JWT 当作 API Token。缺少能力时应联系该部署管理员确认版本和许可。

## 2. 从 GitHub 下载并构建 MCP

选择一个用户确认的**未占用目录**，将示例路径替换为它。目录已存在时先检查用途；不要覆盖、删除或重置已有内容。

```sh
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/MrQinYQ/docmost.git \
  /absolute/path/docmost-mcp-source
cd /absolute/path/docmost-mcp-source
git sparse-checkout set packages/mcp skills/docmost-mcp docs
cd packages/mcp
npm install --workspaces=false
npm run --workspaces=false build
```

稀疏检出保留 MCP、Skill、指南和仓库根文件（包括许可证）。`--workspaces=false` 将安装限定在 MCP 包，不需要在仓库根目录运行完整工作区的 `pnpm install`。构建后入口为 `/absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs`。

需要运行包内模拟测试时，在同一 `packages/mcp` 目录执行：

```sh
npm run --workspaces=false test
```

保留源码和许可证。迁移到新机器时可重新执行同样的 GitHub 安装流程，并重新设置本机路径和 Token 文件；无需 npm 发布流程。

## 3. 创建并私有保存 Token

登录**目标部署**，进入 **Settings → Account → API keys → Create API Key**，创建个人 Key，选择合适的有效期。Key 创建后只显示一次。[官方 API 指南](https://docmost.com/docs/user-guide/api)

本仓库客户端页面路径为 `/settings/account/api-keys`。工作区策略可能只允许管理员创建 Key；不要因此自动改用管理员凭据。

推荐在仓库外建立私有纯文本文件，内容只有 Token。macOS/Linux 可先创建空文件，然后由**用户本人在可信的本地编辑器填写**：

```sh
install -d -m 700 "$HOME/.config/docmost"
touch "$HOME/.config/docmost/api-token"
chmod 600 "$HOME/.config/docmost/api-token"
```

如果已有 Token 文件，不要覆盖或读取它；确认用户是否沿用或另建文件。配置只保存绝对路径，例如 `/Users/your-name/.config/docmost/api-token`。POSIX 文件应为当前用户所有、权限 `0600` 的普通文件，不支持符号链接。其他系统应设置当前用户私有访问权限。

不要把 Token 发到聊天、写进命令行参数、源码、日志或客户端 MCP 配置；Agent 不读取或回显文件内容。下面的检查由 MCP 进程直接读取文件并发送到用户指定的 Docmost 部署。轮换 Key 后由用户更新该文件、重启 MCP，并在 Docmost 设置中撤销旧 Key。

## 4. 选择默认空间和可选父页面

首次配置可先不填写默认空间，用下面的只读命令列出 Token 用户可访问的空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --list-spaces
```

输出包含 `items` 和 `meta`。展示空间名称及真实 UUID，让用户选择默认空间；若 `meta.nextCursor` 非空，用服务器返回的原始游标继续翻页：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs \
  --list-spaces --cursor '服务器返回的游标'
```

`DOCMOST_DEFAULT_SPACE_ID` **必填**且必须为 UUID；正常 stdio 启动和 `--check` 都需要它。空间名称、网址片段不能代替 UUID。不要因为第一项可访问就替用户选择。

`DOCMOST_DEFAULT_PARENT_PAGE_ID` **可选**：不想指定父页面时直接跳过，默认在空间根目录创建。设置时必须为该空间中父页面的规范 UUID，父页所在空间必须与默认空间一致，且不能已删除；不要把页面 URL 中的 slugId 当成配置 UUID。

如果用户只有父页标题或链接，可以先只配置默认空间、不设置父页，完成下面的 `--check` 和客户端登记；然后仅用 `search_pages` / `get_page` 读取确认父页的规范 `id` 与 `spaceId`。获得 UUID 后再补充父页环境变量，重新运行 `--check`、合并该配置项并重启连接，无需用户预先懂得如何获取 UUID。

选择完成后检查身份、默认空间访问和父页归属。下面以空间根目录为例；需要父页时另加 `DOCMOST_DEFAULT_PARENT_PAGE_ID=<真实父页UUID>`：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check
```

所有 UUID 示例均为占位值，必须替换。`--check` 只读取 Token 身份、默认空间和可选父页，父页空间不匹配或已删除会失败；它不会创建页面，也不证明写权限。

## 5. 合并客户端 MCP 配置

用户已授权安装并选择作用域时，Agent 可执行登记或合并配置，无需让用户再手工抄写。保留其他服务器和客户端设置；同名 `docmost` 配置有冲突时先比较并让用户选择，不覆盖整个配置文件。配置中保存部署 URL、默认空间/父页和私有文件路径，**不保存 Token 值**。

### Claude Code

下面是**当前用户级**登记示例，当前项目可改为用户选定的 `--scope local`（本机当前项目）或 `--scope project`（项目配置）。替换 Node、源码、Token 文件和 UUID 的示例值：

```sh
claude mcp add \
  --scope user \
  --env DOCMOST_URL=https://wiki.example.com \
  --env DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
  --env DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
  --env DOCMOST_READ_ONLY=0 \
  --transport stdio docmost \
  -- /absolute/path/to/node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs
claude mcp get docmost
```

若选择默认父页，加一项 `--env DOCMOST_DEFAULT_PARENT_PAGE_ID=<真实父页UUID>`。`--` 前是客户端选项，后面是服务启动命令。在 Claude Code 中用 `/mcp` 查看连接。[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)

### Codex

**当前用户级**可用 CLI 登记；本机 `codex mcp add --help` 已核对支持 stdio 的 `--env KEY=VALUE`：

```sh
codex mcp add docmost \
  --env DOCMOST_URL=https://wiki.example.com \
  --env DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
  --env DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
  --env DOCMOST_READ_ONLY=0 \
  -- /absolute/path/to/node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs
codex mcp list
```

也可将下面的配置**合并**到用户级 `~/.codex/config.toml`，或用户选定且受信任项目的 `.codex/config.toml`。项目配置只在项目受信任时加载。父页为空时不添加它，设置父页时再加入对应行：

```toml
[mcp_servers.docmost]
command = "/absolute/path/to/node"
args = ["/absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs"]

[mcp_servers.docmost.env]
DOCMOST_URL = "https://wiki.example.com"
DOCMOST_API_TOKEN_FILE = "/Users/your-name/.config/docmost/api-token"
DOCMOST_DEFAULT_SPACE_ID = "11111111-1111-4111-8111-111111111111"
DOCMOST_READ_ONLY = "0"
# DOCMOST_DEFAULT_PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222"
```

`env` 设置子进程环境；`env_vars` 可转发客户端已继承的环境变量。桌面启动通常更适合私有 Token 文件。更改后重启相应 MCP 连接或客户端，使用 `/mcp` 检查工具。[OpenAI 官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[配置作用域文档](https://learn.chatgpt.com/docs/config-file/config-basic)

### 配置项

| 变量 | 含义 |
| --- | --- |
| `DOCMOST_URL` | 必填，部署根 HTTPS URL，不含 `/api`。 |
| `DOCMOST_API_TOKEN_FILE` | 私有 Token 文件绝对路径；与下面的 Token 环境变量二选一，推荐使用。 |
| `DOCMOST_API_TOKEN` | 由安全的进程环境注入 Token；不要在配置、聊天或示例命令中填写明文值。 |
| `DOCMOST_DEFAULT_SPACE_ID` | 必填的默认空间 UUID；首次 `--list-spaces` 可不设置。 |
| `DOCMOST_DEFAULT_PARENT_PAGE_ID` | 可选的默认父页 UUID，必须属于默认空间；不设置或为空表示空间根目录。 |
| `DOCMOST_READ_ONLY` | 默认 `0`，注册读写工具；设为 `1` 时仅注册六个读取工具。 |
| `DOCMOST_TIMEOUT_MS` | API 超时，默认 `30000` 毫秒，范围 `100`–`120000`。 |
| `DOCMOST_ALLOW_LOCAL_HTTP` | 仅本机调试设为 `1`，允许 `localhost`、`127.0.0.1`、`::1` 的 HTTP；远程仍需 HTTPS。 |

正常安装提供写工具，是否执行写入由用户的具体任务授权决定。用户只需只读连接时可选择 `DOCMOST_READ_ONLY=1`；以后需要创建、编辑、删除或恢复时改回 `0` 并重启连接。两个 Token 来源不能同时设置。Token 不是工具参数；工具返回的文档会进入所选 AI 客户端上下文，只读取用户授权用于当前任务的内容。

## 6. 安装 Skill 并验证连接

将 `skills/docmost-mcp` 的**完整目录**（含 `references`、`agents`）复制到用户选择的位置，安装后参考文档自包含：

| 客户端 | 当前项目 | 当前用户 |
| --- | --- | --- |
| Claude Code | `.claude/skills/docmost-mcp` | `~/.claude/skills/docmost-mcp` |
| Codex | `.agents/skills/docmost-mcp` | `~/.agents/skills/docmost-mcp` |

例如在目标项目根目录执行以下一种；目标已存在时先比较后更新，不把目录套进已有同名目录：

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

重启连接后先做只读验收：调用 `get_current_user` 查看身份及 `defaults`，调用 `get_space` 核对默认空间，再按用户授权检索并读取页面。`get_current_user` 返回的 `defaults` 含 `spaceId` 和 `parentPageId`，根目录为 `null`。报告配置位置、部署 URL、身份、默认空间和父页；不报告凭据。创建测试页需要用户已经授权该写验收，不从安装授权推导写入授权。

## 工具与默认创建行为

| 工具 | 用途 |
| --- | --- |
| `get_current_user` | 检查 Token 用户和配置的 `defaults`。 |
| `list_spaces` / `get_space` | 查找可访问空间与空间信息。 |
| `search_pages` | 按关键词检索有权限的页面，获取真实页面 ID。 |
| `list_pages` | 分页列出近期可访问页面，可按空间限制；不是目录树。 |
| `get_page` | 读取页面及 Markdown/HTML 正文。 |
| `create_page` | 在默认或指定空间/父页下创建页面。 |
| `update_page` | 修改标题或正文。 |
| `delete_page` | 软删除页面及其子页，内部固定 `permanentlyDelete: false`。 |
| `restore_page` | 恢复页面及全部后代，包含此前已软删的后代；不恢复原分享链接。 |

`create_page` 省略 `spaceId` 时使用默认空间；省略 `parentPageId` 且目标是默认空间时使用默认父页。默认父页未设置就是空间根目录。显式 `parentPageId: null` 表示在目标空间根目录创建；明确指定其他空间时不继承默认父页，省略父页即在该空间根目录创建。显式父页必须属于目标空间。默认位置不限制 Token 的访问范围，读取或写入其他空间仍须符合服务器权限和用户任务范围。

例如用户要求“在默认位置创建‘MCP 接入记录’，正文为……”时，Agent 可调用：

```json
{
  "title": "MCP 接入记录",
  "content": "# MCP 接入记录\n\n用户要求的内容。",
  "format": "markdown"
}
```

可直接向助手提出“搜索‘发布流程’，给我页面链接并总结”“在这篇已找到的页面末尾追加以下段落”“把正文替换为以下 Markdown”。服务器始终按 Token 用户权限校验。正文更新走 `/pages/update` 的编辑器/Yjs 同步流程，不通过数据库 SQL 替换。

正文为非空 Markdown 或 HTML，默认 Markdown；不支持空字符串清空。`update_page` 带 `content` 时必须明确 `operation: "append" | "prepend" | "replace"`，仅改标题不需要正文操作。页面 ID 来自检索或列表，不凭标题猜测。删除和恢复只接受规范 UUID `id`，不能使用 URL 中的 slugId。空间列表和近期页面按 `meta.nextCursor` 翻页；搜索使用 `limit/offset`，没有搜索游标。

删除影响整棵子树并移除分享链接。恢复会递归恢复全部后代，包括此次删除前就已软删的后代；原分享链接不会恢复。现有工具不能完整枚举子树，删除或恢复都需要用户明确授权整个受影响子树，不能把近期列表中没有子页视为没有子页。写操作限于用户请求的对象；超时可能已在服务器生效，应先读取核对，尤其不要盲目重试创建或追加。

## 排错、验收范围与许可证

| 现象 | 检查项 |
| --- | --- |
| 缺少默认空间或 UUID 错误 | 先用 `--list-spaces` 选择真实空间 UUID；正常启动/`--check` 必须填写默认空间。 |
| 默认父页检查失败 | 父页必须为 UUID、属于默认空间且未删除；不需要父页则移除该变量。 |
| Token 文件错误 | 检查绝对路径、权限与文件类型，确保只设置一个 Token 来源；不要打印内容排查。 |
| 401 | Token 是否过期、撤销或属于别的部署；服务器是否实际支持企业 API Key。 |
| 403 | Token 用户权限、部署许可和工作区策略；不要自动更换管理员凭据。 |
| 404 | 部署根 URL 和版本是否匹配；URL 不加 `/api`。 |
| 连接、TLS 或超时错误 | 检查客户端进程网络、代理、证书与服务器，保留 HTTPS 证书校验。 |
| Node 无法启动 | 配置实际 Node 绝对路径，核对 Node 22+ 和 `dist/index.mjs`。 |
| 找不到写工具 | 检查是否设置了 `DOCMOST_READ_ONLY=1`；需要写工具时改为 `0` 并重启。 |

正常 stdio 启动后进程等待客户端 MCP 协议输入，不出现普通交互提示是正常的。不要向 stdout 添加调试输出；诊断写 stderr，避免凭据和完整请求头。

本地构建及 33/33 测试通过（10 项配置/HTTP、23 项 stdio/CLI 模拟上游测试）。仿 GitHub 稀疏目录中的单包安装、构建与同样 33 项测试也已通过。新配置与创建默认目标先复现失败再验证通过，独立审查没有剩余实质问题。Skill 校验及安装示例语法检查通过。上述验证覆盖协议、参数、配置和请求映射；不能证明真实部署许可、Token 或页面写权限。此次未取得真实 API Token，**真实 Token 连通性及真实页面写入/恢复尚未验收**。真实接入以目标部署的 `--list-spaces`、`--check` 和用户授权的客户端验证结果为准。

本地包遵循仓库 [AGPL-3.0 许可证](../LICENSE)。企业目录另有许可证；MCP 只调用服务器公开 API，不复制或补齐企业实现。服务器 API 能力取决于部署版本、许可和管理员配置。[Docmost 官方 API 参考](https://docmost.com/api-docs)
