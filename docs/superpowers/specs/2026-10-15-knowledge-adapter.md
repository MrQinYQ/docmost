# 可选知识库适配层

用户已确认在当前仓库实施：知识库同步为可选能力，OpenViking 是目前唯一实现；标准 MCP / Skill 安装必须引导选择“不启用 / OpenViking”，再收集连接配置。此次不拆仓库、不增加 Skill-only CLI 同步入口、不扩展到未绑定 MD 或网页端全部页面。

## 边界

- 通用协调层只认识已确认 MD 快照、Docmost 身份及逻辑空间/父子结构、关联和同步状态。仍是 Docmost 确认后才将同一快照交给知识库。
- 注册表目前仅有 OpenViking。它拥有 URI、摘要/向量、任务查询、目录锁和删除恢复协议。现有已验证状态机移入适配器，兼容旧模块导出，不重写协议。
- 适配器提供状态验证/展示、运行时创建、布局映射、受控错误状态和只读连接检查。协调层不判断 viking URI 或 OpenViking 任务阶段。
- 关联账本固定 provider 与目标；旧缺少 provider 的记录解释为 OpenViking。切换 provider 不重定位、不删除或重放旧任务，未知 provider 不回退。

## 配置与入口

`DOCMOST_KNOWLEDGE_PROVIDER=none|openviking`。省略时，有旧 `DOCMOST_OPENVIKING_URL` 则兼容启用 OV，否则关闭。显式 none 优先于旧变量，禁止读取凭据或发网络请求。显式 OV 缺少地址或凭据时仅阻塞知识库子状态；未知 provider 同样独立报告不支持，Docmost 继续工作。

现有 OV 连接变量保留。新只读 `--check-knowledge` 不依赖 Docmost 认证或默认空间；关闭返回 disabled，已配置则验证鉴权身份与私有根，安全 JSON 不含凭据、路径内容或任意远端正文。检查不能代替实际写入/索引验收。

状态新增通用 `knowledgeBase`，保留 OV 的 `openViking` 兼容字段。新增 `retry_knowledge_sync`，OV 时保留旧 `retry_openviking_sync` 别名；只读不注册写工具。安装 Skill 与中文指南先问知识库选择，再按需指导服务根地址、个人 Key 的私密文件、可选身份及根目录。无 ov/Python/新 npm 依赖，不部署服务，不修改全局客户端配置。

## 验收

配置选择、无副作用关闭、未知 provider、旧配置和账本、目标固定、独立检查与敏感信息脱敏先有失败测试。通用层用注入的第二个测试适配器证明无需 OV URI/任务；它不作为产品支持项。跑受影响协议/协调测试、完整包构建与测试、独立单包安装；真实验收仅用户已授权的本机合成范围，不重建或导入现有资料。没有提交或推送授权。
