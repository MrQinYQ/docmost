# Lock-free Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 删除所有客户端锁，用可检测的版本冲突提示代替互斥等待。

**Architecture:** 保留有限调用的内存调度和原子文件发布，移除所有跨进程租约与根任务 gate。沿用 Docmost CAS、Git 分支检查、单页知识库任务对账。

**Tech Stack:** Node.js ESM、node:test、本地 stdio MCP、Docmost/OpenViking HTTP。

**Spec:** docs/superpowers/specs/2026-11-03-lock-free-sync-design.md

## Global Constraints

- 保留配置、绑定 ID、页面 ID、待处理任务、快照和凭据。
- 不使用 ov 命令，不创建 worktree，不新增 daemon。
- 当前用户已明确选定无锁方案，当前会话直接执行；不自动 commit/push。

## Review Focus

- 遗留的存活/死进程锁均不能阻止调用或被重建。
- 账本变化和远端正文/分支冲突应报告，不能覆盖另一方已确认记录。
- 未知写入不重复派发，其他页面的任务不再锁住整棵知识库。
- 启用 watcher 的并发进程不能使全局 manager 永久阻塞。
- 会话原子发布仍不能覆盖有效凭据，现有权限检查保留。

### Task 1: 无锁运行时和回归

**Files:** packages/mcp/src/{sync-work,sync-store,sync,git-publication,session}.mjs、packages/mcp/src/knowledge-adapters/openviking{.mjs,/mirror-tree.mjs}、相关 test。

- [x] 写入并运行失败用例：遗留锁无效、执行时无锁、不同页面不互斥、账本变化冲突、会话无锁发布。
- [x] 删除租约/操作锁/根互斥；替换为读回校验和冲突提示，兼容旧 `LEASE_BUSY` 状态。
- [x] 更新过时的锁测试，保留条件写、未知结果、暂停/关闭及身份保护回归。
- [x] 一次集中运行 MCP 完整测试和构建，修复实际失败。

### Task 2: 安装、文档与真实验收

**Files:** docs/{local-mcp,md-auto-sync,knowledge-sync,openviking-sync,git-delivery}.md、skills/、scripts/local-docmost/acceptance-git-delivery.mjs。

- [x] 更新 Skill 和中文引导，说明无锁、冲突处理及普通 API 的竞态限制。
- [x] 实际 stdio 多连接/本地 Docmost 验收条件写冲突，OpenViking 独立验证，不修改业务页面。
- [x] 备份并更新本机实际安装包及 Skill，清理仅锁记录并核对绑定/待处理记录未变。
- [x] 核对 diff、验收结果和状态，向用户说明证据与剩余限制。

## 验收记录

- `npm test --prefix packages/mcp`：425/425，通过；最终构建和 `git diff --check` 通过。
- 独立审阅六项发现已集中修复，87 项相关回归通过；两个 Skill validator 通过。
- 最终真实 Docmost：9/9，包括真实会话、双 stdio、分支冲突、WebSocket 协作冲突；测试空间、会话、客户端和本次启动的服务已清理/关闭。报告：`data/local-docmost/git-delivery-0e63f36b-cb88-4f7f-a421-ec065089f571/report.json`。
- OpenViking 完整原文哈希读回通过，但摘要/索引任务一直 running，完整入库验收超时，未宣称成功；精确测试任务已取消至 cancelled，唯一测试命名空间经 HTTP 删除并确认不存在。共享连接本次只读检查通过，未宣称共享完整入库重新验收。
- 本机实际安装入口及两个 Skill 已备份更新，30 个运行文件字节一致；个人10/共享5条绑定和原有记录哈希未变；两连接 `--check` 均通过。旧锁目录移除，凭据/客户端配置保留，现有客户端需正常重连一次。
- 当前改动保留在工作区，未自动 commit/push。
