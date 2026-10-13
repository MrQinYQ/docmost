# 本地 Docmost / WebMCP 自验指南

本地地址：http://127.0.0.1:3000 。当前服务已经启动。使用当前 fork 的真实 NestJS 服务、PostgreSQL 18 和 Redis，前端是当前源码的生产构建。环境配置在未纳入 Git 的 `.env`，数据库名固定为 `docmost_webmcp_local`。

官方开发环境要求见 [Docmost 开发文档](https://docmost.com/docs/self-hosting/development)。本次实际安装的是 Node 24.19.0、PostgreSQL 18.6、Redis 8.10.2。没有使用 Docker，也没有启用系统登录时自动启动的 Homebrew 服务。

## 1. 启动、停止和重跑

在终端进入仓库：

```sh
cd /absolute/path/docmost
node scripts/local-docmost/start.mjs status
```

如果已经运行，`status` 会显示 `running: true`、`ready: true`。下一次重新启动时运行：

```sh
node scripts/local-docmost/start.mjs --build
```

保持这个终端运行。该命令会构建前后端、启动独立数据库和 Redis、应用数据库迁移，然后启动 Docmost。服务端口分别是 3000、55432、56379，都绑定到 `127.0.0.1`。不修改其他 PostgreSQL/Redis 服务。

停止时按 Ctrl+C，或在另一个终端进入仓库后执行：

```sh
node scripts/local-docmost/start.mjs stop
```

数据库、上传文件和测试账号都会保留。重新启动后继续使用原账号。改了产品源码后用 `--build` 重建；只重启已有构建可以省略这个参数。

一键重跑真实登录与权限验收：

```sh
node scripts/local-docmost/acceptance-api.mjs --test
```

当前预期是 `17 passed, 0 failed`。脚本使用真实登录 Cookie 和服务端 API，并生成当次独立测试页面；不会重置整个数据库。首次重新构造本地数据时可用 `--seed --test`。该脚本拒绝非回环 API、远程数据库和其他数据库名。

日志在 `data/local-docmost/logs/`。API 验收结果在 `data/local-docmost/api-acceptance-latest.json`。

## 2. 测试账号与页面

密码已经随机生成，查看 本地账号文件 `data/local-docmost/accounts.json` 中各账号的 `password`。这个文件权限为 `0600`，Git 已忽略。不要把密码放进提交或聊天截图。

| 账号 | 本次测试空间内的权限 |
| --- | --- |
| `admin@webmcp.test` | 工作区 owner；可管理、读写全部测试对象 |
| `writer@webmcp.test` | shared 空间可读写普通页；restricted 页和子页只有读取权限 |
| `reader@webmcp.test` | shared 空间只能读取普通页；restricted 页和子页不可见、不可读 |

writer/reader 是工作区 member，表中的读写级别是**测试空间的角色**。默认 General 空间通过 Everyone 组提供的权限可能不同，验收时选择 `WebMCP shared 42d6827586ad`，不要用 General 判断 reader 的测试权限。

当前页面：

- [双会话协作页](http://127.0.0.1:3000/s/webmcp-shared-42d6827586ad/p/Dw2LuARmK5)
- [普通页](http://127.0.0.1:3000/s/webmcp-shared-42d6827586ad/p/otV4j0Sras)
- [受限子页](http://127.0.0.1:3000/s/webmcp-shared-42d6827586ad/p/r5Z31vKsBu)

最新对象 ID、其他页面链接、空间与附件信息都在 本地 fixture 文件 `data/local-docmost/fixtures.json`。如果你重建了本地测试数据，以该文件为准。

社区版源码没有页面限制的企业管理接口。因此，本地脚本只在这个独立数据库中构造 `page_access` / `page_permissions` 测试数据；实际读取、写入、搜索和下载的拒绝行为由运行中的服务端执行。不要把这个测试理解为企业限制管理界面的验收。

## 3. 在 Codex 中自己测 WebMCP

在 Codex 内置浏览器打开本地地址并登录 admin。保持页面打开，然后发给 Codex：

> 使用当前 Docmost 页面的 WebMCP 工具。列出可用工具、当前账号以及我可以访问的空间。

预期：发现 20 个工具，当前账号是 `admin@webmcp.test`，能看到 shared 和 private 测试空间。本次 WebMCP 登录后自动注册，不需要打开 AI & MCP 设置中的付费远程 MCP 开关。

接着测试一条完整读写链：

> 用 WebMCP 在 WebMCP shared 测试空间创建“我的 WebMCP 自验”，写入“第一行”；在正文末尾追加“第二行”，然后读取回来。不要替换整篇正文。

预期：页面和侧栏出现新文档，读回正文包含两行。再让 Codex 添加一条评论、修改自己刚创建的评论、复制页面、移动页面。参数需要精确确认时，让 Codex先通过读取工具获取对象 ID。完整参数见 [工具说明](webmcp.md)。

如果测试移动页，明确指定保留原父页面、移动到另一个父页面，或移动到根目录；不要省略父页面意图。跨空间移动用 `move_page_to_space`。

## 4. 自己测权限

在 Codex 的本地 Docmost 页面点击顶部工作区名称，选择 `Logout`。登录 reader 后：

1. 打开普通页，应能阅读，标题和正文没有编辑模式；侧栏不出现受限页。
2. 让 Codex 用 WebMCP 读取普通页，应成功。
3. 让 Codex 修改该页标题或正文、创建新页，应得到权限错误；刷新后原文不变。
4. 打开受限子页链接，或让 Codex用 `get_page` 读取它，应被拒绝。
5. 用关键词 `wmcp42d6827586ad` 搜索页面和附件，不应返回受限对象或 private 空间对象。
6. 退出登录后，让 Codex重新发现页面工具，预期没有可用 WebMCP 工具。重新登录时重新发现，不复用旧句柄。

reader 仍可能发现 20 个工具；“看见工具”不代表有写入权限。权限由服务端根据账号和对象判定。当前 shared 空间也没有开放 reader 评论写入，reader 添加评论失败是预期结果。

## 5. 自己测实时协作与保存

用两个独立登录会话：例如 Codex 内置浏览器登录 admin，Chrome 登录 writer；或者同一浏览器的普通窗口与无痕窗口。**两个普通标签页共享 Cookie，不能用来登录两个不同账号。**

两个会话都打开上面的协作页：

1. 在 writer 窗口正文中输入独特标记，如 `WRITER_MANUAL_001`。
2. 在 admin 的 Codex 页面请求：用 WebMCP 在当前正文末尾追加 `ADMIN_TOOL_001`，使用 append，不替换全文。
3. 两边都应出现两份标记，原文保留。再在 admin 窗口手工输入第三份标记，writer 也应实时看到。
4. 停止输入，通常等约 10 秒，再让 Codex读取正文；随后刷新两个窗口，标记应仍存在。持续编辑会延迟数据库保存，上限约 45 秒。
5. 刚在当前页输入新内容就立即请求复制，若尚未保存，应提示等待保存；保存后重试应成功，副本应包含最新正文。

“另一端看见变化”“服务端 ACK”“数据库已经保存”是三个不同检查点。本次保存保护会分别检查待发送更新，以及当前编辑器与数据库正文是否一致，不通过替换原文强行触发保存。

## 6. 已完成的真实验收

2026-10-13 已在这套本地服务完成：

- 真实 API：17 个用例、71 次 HTTP 请求，0 失败。
- 原生 WebMCP：登录 admin 后，全部 20 个工具逐一调用成功；副本保留追加正文。
- reader 浏览器权限：9 项通过；只读状态、写入拒绝、祖先限制、搜索/附件隔离、拒绝后原文不变。
- 两个真实浏览器：Chrome writer 的手工编辑与 Codex admin 的工具写入双向同步，数据库读回保留两份内容。
- 保存保护：立即复制被拒绝，保存后复制成功。
- 侧栏：此前未展开的父页首次展开后，原有子页和新建/复制子页都存在。
- 注销：真实退出登录后不再有页面工具。
- 重启：完整停止、重建和启动后，账号与权限保留，三份协作标记仍在，20 个工具恢复，17 个 API 用例再次全部通过。

原生调用与权限证据：`data/local-docmost/native-webmcp-acceptance.json`、`native-reader-acceptance.json`、`collaboration-save-guard.json`、`restart-acceptance.json`。本次数据、日志、测试密码都只保存在本地；未提交或推送。
