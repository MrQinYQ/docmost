# 可选知识库同步

本地 MCP 为已绑定 Markdown 提供可选知识库适配层，当前只实现 OpenViking。同步顺序是本地 MD → Docmost 确认 → 所选知识库；它不导入整个工作区，也不自动导出网页或普通 `update_page` 修改的正文。Docmost 与知识库分别报告结果，知识库失败不重放已成功的 Docmost 写入。

## 可直接交给 Agent 的安装指令

```text
请按同版本 docs/local-mcp.md 从 GitHub 源码安装或更新 Docmost MCP 和 docmost-mcp Skill。标准安装时，主动让我选择“不启用知识库 / OpenViking”；已有明确选择和授权直接沿用，不重复询问。新配置明确写 DOCMOST_KNOWLEDGE_PROVIDER=none 或 openviking。

选择“不启用知识库”时设为 none，跳过知识库地址、Key、身份和私有根问题，不读取遗留 OpenViking Key，也不访问该服务。选择 OpenViking 时，引导我提供既有服务根地址、仓库外私有 Key 文件绝对路径，以及可选预期账户/用户和私有资源根；说明它们分别用于连接、鉴权和目标范围。MD 同步还需要我选择允许绑定的源目录和独立私有状态目录，只处理明确绑定的文件。

Key 由部署管理员提供给指定个人用户，再由我在自己的真实本机终端隐藏输入保存到仓库外 0600 文件。你只配置路径，不读取或回显 Key，不代跑私密输入。沿用已明确授权的模型处理与父目录摘要刷新范围，不重复确认。不要安装 ov/Python、发布 npm 包、部署服务或把地址改成未经确认的目标。

构建后运行独立只读 node /absolute/path/packages/mcp/dist/index.mjs --check-knowledge；此命令不需要 Docmost 登录或默认空间。报告所选 provider、安全状态、鉴权身份及私有根，不输出凭据。该检查不创建资源，也不能证明写入、摘要或索引能力；实际写验收仅在已有授权的测试范围执行。知识库未配置、不可达或不支持时单独报告，继续完成可用的 Docmost 接入。
```

## 选择与兼容

| 配置 | 行为 |
| --- | --- |
| `DOCMOST_KNOWLEDGE_PROVIDER=none` | 明确关闭知识库；覆盖遗留 `DOCMOST_OPENVIKING_*`，不读取其 Key 或发起其网络请求。 |
| `DOCMOST_KNOWLEDGE_PROVIDER=openviking` | 使用现有 `DOCMOST_OPENVIKING_*` 配置；缺少 URL 时知识库独立报告阻塞。 |
| 省略 provider，已有非空 `DOCMOST_OPENVIKING_URL` | 为旧安装兼容选择 OpenViking。新安装应显式保存选择。 |
| 省略 provider，也无 OpenViking URL | 关闭知识库。 |
| 其他 provider | 独立报告不支持，不静默切换后端或关闭后继续声称成功。 |

配置的地址、身份、私有根与 provider 构成任务目标。切换配置不会将旧的持久化任务改投新目标；先核对旧任务和状态，不删除账本来强行补同步。

OpenViking 的地址、Key 文件、可选身份与私有根设置见 [OpenViking 指南](openviking-sync.md)。设置知识库不改变 Docmost 的认证模式，也不要求企业 API Key。无需本机 `ov`、Python 或额外 npm 包；本 MCP 不部署知识库服务。

## 独立只读检查

关闭知识库的检查无需其他配置：

```sh
DOCMOST_KNOWLEDGE_PROVIDER=none \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge
```

OpenViking 检查只需它自己的连接配置；不要求 Docmost 会话、默认空间或 MD 目录：

```sh
DOCMOST_KNOWLEDGE_PROVIDER=openviking \
DOCMOST_OPENVIKING_URL=https://openviking.example.com \
DOCMOST_OPENVIKING_API_KEY_FILE=/Users/your-name/.config/docmost/openviking-key \
node /absolute/path/docmost-mcp-source/packages/mcp/dist/index.mjs --check-knowledge
```

已提供预期账户、用户、私有根或超时的安装，应把相同变量带入检查。`none` 返回关闭状态。选中后端配置错误、鉴权失败、不可达或不支持时，此检查返回非零；不因此禁用普通 Docmost 工具。输出仅包含安全连接状态、身份和根，不含 Key。只读检查不上传正文、不创建目录、不重建索引、不删除资源；通过后仍需在已授权测试范围核对实际写入与处理任务。

## 工具与适配边界

启用 MD 同步的可写/只读模式为 26/11 个工具；选择 OpenViking 后为 28/11。`retry_knowledge_sync({bindingId})` 是通用重试入口，`retry_openviking_sync` 是 OpenViking 兼容别名。两者仅补知识库阶段，不重放 Docmost 写入，也不接受任意 URI。未启用 MD 同步时仍为基础 22/10 个工具。

`get_markdown_sync_status` 通过 `knowledgeBase` 报告 `provider`、`enabled`、`state` 等安全状态；已有 `openViking` 字段保留兼容。仅查询状态不构成覆盖授权。完整绑定、冲突和生命周期约定见 [MD 自动同步](md-auto-sync.md)。

开发者在适配边界实现后端配置校验、只读连接检查、安全状态投影、同步操作及后端专属任务对账。共享层保留 Docmost 条件写入、绑定授权、私有快照和持久化协调；OpenViking URI、摘要/向量任务与目录清理留在其适配器内部。入口见 [知识库注册与协调](../packages/mcp/src/knowledge.mjs)及 [OpenViking 适配器](../packages/mcp/src/knowledge-adapters/openviking.mjs)。不得绕过这些保护直接重放 Docmost 写入，或把旧任务重定向到新后端。当前只支持 `none` 与 `openviking`，本文不承诺其他提供商接口或未来兼容性。

## 验证记录

2026-10-15 适配层的完整 MCP 构建与测试 **325/325**；在新建临时目录仅安装本包现有依赖后，同样 **325/325**，源码与测试一致。覆盖显式关闭的零知识库凭据读取/零请求、旧配置推断、不支持的 provider、独立只读诊断、目标固定、旧账本及协议回归。额外的测试适配器使用非 OpenViking URI 验证通用入口；它不属于可选产品后端。安装流程经独立场景审阅；shell 示例仅做语法检查，不代表已部署用户的真实服务。

本次适配层的本机真实回归按组完成：

| 分组 | 结果 |
| --- | --- |
| `--tail-only` | **8/8**：28 个工具及兼容别名、显式 none 覆盖遗留配置、独立只读探针、不可达时 Docmost 仍成功，通用重试前后 Docmost 写请求均为 2。 |
| `--delete-only` | **10/10**：初始与恢复的四个新完整处理任务成功；通用状态与旧字段一致；恢复前父子页原文、目录和 L0/L1 摘要均缺失，六个 level 0/1/2 限定查询均为零。 |

两组均清理自己的页面、空间、测试根和临时文件，专用会话注销后重放返回 401；队列结束后精确测试根为 404，至少 10 秒后再次确认。独立探针的 none 模式零请求，OpenViking 模式只读 `GET /health`；入库、删除与恢复由后续已授权的测试步骤分别证明。报告权限 `0600`，位于 ignored 的 `data/local-docmost/openviking-sync-acceptance-provider-tail-only.json` 和 `openviking-sync-acceptance-provider-delete-only.json`。

这是当前版本的分组验收，未重跑脚本的完整主流程；此前 OpenViking 验收记录保留在 [原始指南](openviking-sync.md#在授权测试范围验收)。真实验证对象为本机 Docmost 与 OpenViking 0.4.19，未对远程 TLS 部署执行真实写验收。
