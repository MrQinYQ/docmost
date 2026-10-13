# 本地 MCP 工具约定

客户端工具名称可能加前缀。下表是用途索引，实际参数、枚举、分页和返回字段以已连接工具的 schema 为准。只读连接仅注册六个读取工具。

| 工具 | 输入参数（`?` 表示可选） | 使用时机 |
| --- | --- | --- |
| `get_current_user` | `{}` | 确认当前凭据用户及 `defaults` 中的默认空间/父页。 |
| `list_spaces` | `query?`, `limit?`, `cursor?` | 定位可访问空间；按 `meta.nextCursor` 翻页。 |
| `get_space` | `spaceId` | 确认所选空间的信息。 |
| `search_pages` | `query`, `spaceId?`, `titleOnly?`, `limit?`, `offset?` | 关键词检索；搜索无游标，按 offset 分页。 |
| `list_pages` | `spaceId?`, `limit?`, `cursor?` | 分页查看可访问的近期页面，不是目录树。 |
| `get_page` | `pageId`, `format?` | 读取正文；默认 Markdown，也可 HTML 或编辑器 JSON。 |
| `create_page` | `spaceId?`, `title?`, `parentPageId?`（UUID、slugId 或 `null`）, `content?`, `format?` | 在默认或明确指定的空间/父页下创建。 |
| `update_page` | `pageId`, `title?`, `content?`, `format?`, `operation?` | 改标题或以明确操作修改正文。 |
| `delete_page` | `pageId` | 软删除整棵子树，内部固定 `permanentlyDelete: false`。 |
| `restore_page` | `pageId`（UUID） | 恢复整棵子树，含本次删除之前就已软删的后代；不会恢复分享。 |

`spaceId` 传入时必须为 UUID。读取和更新的 `pageId` 可为 UUID 或 slugId；**删除和恢复必须使用 `get_page` 返回的规范 UUID `id`**。`limit` 为 1–100，默认 20。搜索 `offset` 默认 0；结果没有 total，不能据此宣称完整覆盖。

## 默认创建位置

`get_current_user` 返回 `defaults: { spaceId, parentPageId }`，其中 `spaceId` 是必填配置 UUID，`parentPageId` 是配置 UUID 或 `null`（空间根目录）。创建时遵循下面的参数规则：

- 省略 `spaceId` 使用默认空间。
- 省略 `parentPageId`，且创建空间等于默认空间时，继承默认父页；未配置父页则创建在根目录。
- 显式 `parentPageId: null` 表示目标空间根目录，覆盖默认父页。
- 明确指定其他空间时不继承默认父页；省略父页即该空间根目录。
- 显式传入父页 ID 时，该页必须属于目标空间；工具参数支持 UUID/slugId，但默认父页环境变量仅支持规范 UUID。

默认值便利创建，不改变服务器权限或用户授权范围。其他工具的可选空间参数按当前 schema 使用，不假定也会继承创建默认值。

## 正文

写正文仅接受非空 Markdown 或 HTML 字符串，默认 Markdown，不支持编辑器 JSON 写入或空字符串清空。更新正文时必须提供 `operation`，没有默认覆盖操作：

```json
{
  "pageId": "从检索或列表取得的真实页面ID",
  "content": "\n## 新增说明\n\n用户授权追加的内容。",
  "format": "markdown",
  "operation": "append"
}
```

完整替换使用 `replace`；开头插入使用 `prepend`。`create_page` 不使用更新的 `operation`。工具层通过 Docmost API 的编辑器/Yjs 路径更新内容，仍受服务器用户权限校验。schema 严格拒绝额外字段，不要添加未声明参数。

## 授权与结果

服务器能力与用户授权分开判断：工具可写、当前账号有权限，不等于用户授权修改所有可访问页面。明确请求的对象和动作即可提供当前操作授权，不重复询问；但不能从“总结页面”推导出修改权限。会话模式与 API Key 模式使用同一组工具和正文/Yjs 更新流程，默认创建位置规则相同。

结果引用使用工具返回的 URL。缺少 URL 时展示标题、空间和 ID，不凭未知路由拼接链接。`list_pages` 是近期列表，不能判断某页是否有后代，搜索和分页结果也不保证覆盖整个工作区。

若工具缺失、返回身份/许可错误或未知参数契约，报告具体限制；不要自行构造 HTTP 后门、绕过企业许可或伪造 API Token。
