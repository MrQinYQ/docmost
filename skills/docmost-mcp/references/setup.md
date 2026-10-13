# 安装配置本地 Docmost MCP

本参考随 Skill 安装，足以在没有原仓库目录时引导接入。[完整中文 GitHub 指南](https://github.com/MrQinYQ/docmost/blob/main/docs/local-mcp.md) 是源码交付入口。安装前确认 `main` 含有 MCP 包和 Skill；缺少时说明版本问题，不改装同名第三方包。代码、Skill 和指南随同一分支交付，以所选分支实际文件为准。

## 确认安装范围与服务器能力

先确认用户的部署根 URL（例如 `https://wiki.example.com`，不含 `/api`）、客户端、源码安装目录和 MCP/Skill 作用域。根据当前操作系统执行命令，不照搬 macOS/Linux 示例到 Windows。检查 Git、Node.js 22+、npm，记录实际 Node 绝对路径；缺少依赖时说明所需版本，按用户授权安装。使用用户确认的新目录，已有目录不能覆盖、删除或重置。

目标部署必须支持官方 API Key。Docmost 官方将 API 列为需要有效企业许可证的功能；个人 Key 继承创建者权限。[官方 API 指南](https://docmost.com/docs/user-guide/api)

这份社区源码缺少服务器企业 API Key 模块，Key 界面或 `api_keys` 表存在不能证明 Token 能用。401 时检查部署能力、Token 过期/撤销等，不绕过许可、不修改企业模块、不自动改用 Cookie、管理员凭据或自行签名 JWT。

## 下载与构建

macOS/Linux 示例，替换为用户确认的未占用绝对路径：

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

只安装 MCP 包依赖，不在根目录安装整个 Docmost 工作区；无需 pnpm、npm 发布或 `npm pack`。保留稀疏检出的源码及根许可证。入口是 `packages/mcp/dist/index.mjs`；要验证包内模拟测试可在包目录运行 `npm run --workspaces=false test`。

## 用户私有保存 Token

引导用户在目标部署的 **Settings → Account → API keys → Create API Key** 创建个人 Key。Key 只显示一次，选择适当有效期。用户本人用可信的本地编辑器把它写入仓库外私有纯文本文件；不要索要聊天中的 Token，也不读取、回显或记录文件内容。

可帮助创建空文件。下面是 macOS/Linux 示例，已有文件先确认是否沿用，不覆盖：

```sh
install -d -m 700 "$HOME/.config/docmost"
touch "$HOME/.config/docmost/api-token"
chmod 600 "$HOME/.config/docmost/api-token"
```

配置仅保存文件绝对路径。POSIX 文件必须是当前用户所有、权限 `0600` 的普通文件，不支持符号链接；其他系统设置当前用户私有权限。Token 值不进入聊天、命令、客户端配置、源码或日志。MCP 进程会直接读取私有文件并请求用户指定部署。用户确认已保存后继续，不通过打印文件内容检查。

## 选择默认空间与父页

先仅用 URL 和 Token 文件运行只读列表，无需预先填写默认空间：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --list-spaces
```

输出 `items` 和 `meta`，向用户展示名称及 UUID。`meta.nextCursor` 非空时，用同样环境运行 `--list-spaces --cursor '返回的原始游标'` 继续翻页。让用户选择必填默认空间，不擅自选择第一项。保存 `DOCMOST_DEFAULT_SPACE_ID=<真实空间UUID>`；正常 stdio 启动和 `--check` 必填。

再询问可选的默认父页：用户不需要时直接跳过，不设置或为空即默认空间根目录；配置时使用该空间中的规范 UUID，不能用页面 URL slugId。用户只有父页标题/链接时，先仅配置默认空间、不设置父页，运行下面的 `--check` 并按下一节登记客户端；然后仅做只读查询，用 `search_pages` / `get_page` 获取父页 `id` 并核对 `spaceId`。再补充 `DOCMOST_DEFAULT_PARENT_PAGE_ID=<真实父页UUID>`，重新 `--check`、合并父页配置并重启连接。父页必须属于默认空间且未删除，无需用户预先知道获取 UUID 的方法。

下面的示例 UUID 必须替换。无父页时运行：

```sh
DOCMOST_URL=https://wiki.example.com \
DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check
```

有父页时增加 `DOCMOST_DEFAULT_PARENT_PAGE_ID`。`--check` 只读验证 Token 身份、默认空间访问、父页空间归属和未删除状态；失败先解决，不声称写权限已验收。

## 合并客户端配置

用户已授权安装并选定作用域时，执行登记或合并，保留所有其他设置；同名配置冲突时先比较并让用户选择。客户端配置只含非秘密的 URL、默认空间/父页、私有文件路径和启动命令，不含 Token 值。

正常配置 `DOCMOST_READ_ONLY=0`（默认也是 `0`），提供全部读写工具；实际写入须有用户任务授权。只有用户选择只读时设为 `1`，此时仅有六个读取工具。两个 Token 来源 `DOCMOST_API_TOKEN_FILE` / `DOCMOST_API_TOKEN` 二选一，不能同时配置；若使用后者，应由安全的进程环境注入，不把值写进配置。

Claude Code 的当前用户级示例（替换所有路径/UUID），当前项目按用户选择改用 `--scope local` 或 `--scope project`；有默认父页时加其 `--env` 项：

```sh
claude mcp add --scope user --transport stdio \
  --env DOCMOST_URL=https://wiki.example.com \
  --env DOCMOST_API_TOKEN_FILE=/Users/your-name/.config/docmost/api-token \
  --env DOCMOST_DEFAULT_SPACE_ID=11111111-1111-4111-8111-111111111111 \
  --env DOCMOST_READ_ONLY=0 \
  docmost -- /absolute/path/to/node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs
claude mcp get docmost
```

Codex 的用户级 CLI 可使用同样的 `--env` 项执行 `codex mcp add docmost ... -- <Node绝对路径> <入口绝对路径>`。或将下面内容合并到用户级 `~/.codex/config.toml` / 用户选择的受信任项目 `.codex/config.toml`；项目配置只在项目受信任时加载：

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

可选配置：`DOCMOST_TIMEOUT_MS` 默认 `30000`，允许 `100`–`120000` 毫秒；`DOCMOST_ALLOW_LOCAL_HTTP=1` 只允许本机调试 HTTP，远程部署仍用 HTTPS。[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)、[OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## 安装 Skill 与只读验收

复制源码的整个 `skills/docmost-mcp` 目录，包含 `references` 和 `agents`。目标已有同名目录时先比较后更新，不直接 `cp -R` 导致嵌套。

| 客户端 | 项目级目标 | 用户级目标 |
| --- | --- | --- |
| Claude Code | `.claude/skills/docmost-mcp` | `~/.claude/skills/docmost-mcp` |
| Codex | `.agents/skills/docmost-mcp` | `~/.agents/skills/docmost-mcp` |

例如在目标项目根目录 `mkdir -p .agents/skills`，再 `cp -R /absolute/path/docmost-mcp-source/skills/docmost-mcp .agents/skills/docmost-mcp`。仅在已授权的作用域安装；Skill 不自动登记 MCP 或授予权限。[Claude Code Skill 文档](https://code.claude.com/docs/en/skills)、[OpenAI Skill 文档](https://learn.chatgpt.com/docs/build-skills)

重启 MCP 连接/客户端，通过 `/mcp` 或对应工具列表检查。调用 `get_current_user` 核对身份和 `defaults`（`spaceId` UUID、`parentPageId` UUID 或 `null`），再 `get_space` 核对默认空间，并在用户授权内容范围内检索、读取。报告安装和配置位置、部署 URL、身份、默认空间及父页，不输出凭据。没有真实 Token 或实际返回时如实说明未验证；创建测试页必须已有该写验收授权。

默认创建位置遵循 [工具约定](tool-contract.md)：默认空间下省略父页继承默认父页，显式 `null` 表示根目录，明确其他空间不继承默认父页。安装授权不代表用户授权修改任意文档。
