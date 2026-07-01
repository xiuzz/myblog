---
title: Hermes + Obsidian 联动：让 AI Agent 拥有持久记忆
date: 2026-06-14
categories: [ai]
tags: [Hermes, Obsidian, Agent, 知识管理, LLM Wiki, 记忆]
---

## 为什么需要这个联动

AI Agent 最大的痛点：**会话结束，记忆清零**。每次新开对话都要重新交代背景、偏好、项目结构。Hermes Agent 的设计目标之一就是解决这个问题，而 Obsidian 在其中扮演"持久记忆层"的角色——所有对话上下文、研究成果、决策记录都存在本地 Markdown 文件里，不依赖任何云服务。

核心逻辑很简单：

```
你的任务 → Hermes Agent 推理执行
              ↓ 读/写
         Obsidian Vault (本地 Markdown)
              ↓ 可视化
         Obsidian App (图谱/搜索/编辑)
```

## 环境准备

- Hermes Agent ≥ v0.13（推荐 v0.14+）
- Obsidian（桌面端或移动端均可，但 vault 路径要对）
- macOS / Linux / WSL2 均可

## Step 1: 配置 Vault 路径

Hermes 通过 `OBSIDIAN_VAULT_PATH` 环境变量找到你的 Obsidian vault。

编辑 `~/.hermes/.env`：

```bash
# macOS（iCloud vault 示例）
export OBSIDIAN_VAULT_PATH="/Users/xiu/Library/Mobile Documents/iCloud~md~obsidian/Documents/my-vault"

# Linux / WSL2
export OBSIDIAN_VAULT_PATH="/home/xiu/vaults/knowledge"

# Windows（在 WSL2 内访问宿主机 Obsidian）
export OBSIDIAN_VAULT_PATH="/mnt/d/obsidian_work/knowledge"
```

也可以让 Hermes 自己来配置：

```bash
hermes memory setup --provider obsidian --path ~/vaults/knowledge
hermes memory status   # 验证配置是否生效
```

重启 Hermes 后生效。

## Step 2: 内置 Obsidian Skill

Hermes 自带 `obsidian` skill，开箱即用。它可以直接：

- **读取笔记** — "帮我总结 vault 里关于分布式系统的笔记"
- **创建/编辑笔记** — "把刚才讨论的 Raft 选举流程写成笔记"
- **搜索知识库** — "搜索笔记里所有关于 QUIC 的内容"
- **建立双向链接** — 自动在笔记间建立 `[[wikilinks]]`

不需要安装任何 Obsidian 社区插件，Hermes 直接读写文件系统上的 Markdown 文件。Obsidian 应用甚至不需要开着——文件变了，下次打开 Obsidian 就能看到更新。

## Step 3: LLM Wiki —— 让知识自己生长

这是 Hermes v0.14 最亮眼的功能：`llm-wiki` skill。它不同于传统的 RAG（检索增强生成），而是**让 Agent 自己维护一个结构化 Wiki**。

### 三层架构

```
wiki/
├── SCHEMA.md          # 结构约定、标签体系
├── index.md           # 内容目录（带单行摘要）
├── log.md             # 按时间顺序的操作日志
├── raw/               # Layer 1: 原始材料（只读）
│   ├── articles/      #   网页文章
│   ├── papers/        #   论文 PDF
│   └── transcripts/   #   会议记录
├── entities/          # Layer 2: 实体页面
├── concepts/          # Layer 2: 概念/主题页面
├── comparisons/       # Layer 2: 对比分析
└── queries/           # Layer 2: 有价值的查询结果
```

### 三种核心操作

**收录（Ingest）**：Agent 读取一篇来源 → 提取关键信息 → 创建/更新多个 wiki 页面 → 添加交叉引用。一篇来源可能触发 5-15 个页面的更新，形成知识复利。

**查询（Query）**：Agent 先读 index.md 找到相关页面 → 阅读后综合回答 → 有价值的答案归档回 wiki，下次遇到同类问题直接命中。

**健康检查（Lint）**：定期扫描孤立页面、断链、过时内容、标签不一致等问题。

### 与 Obsidian 的天然契合

LLM Wiki 生成的是标准 Markdown + YAML frontmatter + `[[wikilinks]]`：

- **Graph View** 直接可视化知识网络
- **Dataview 插件** 可以查询 frontmatter 做动态列表
- **反向链接面板** 显示哪些页面引用了当前页面
- 人类可以随时手动编辑，Agent 会尊重已有内容

## 典型工作流

### 场景一：研究新主题

```
你: 帮我研究一下 HTTP/3 和 QUIC 的关系

Hermes:
  1. 搜索 web → 获取多篇来源
  2. raw/articles/ 存入原文
  3. entities/ 创建 QUIC、HTTP/3、UDP 等实体页
  4. concepts/ 创建"传输层演进"概念页
  5. comparisons/HTTP2-vs-HTTP3.md 做对比
  6. index.md 更新目录
  7. log.md 记录操作

你打开 Obsidian → Graph View → 看到一个互联的知识子图
```

### 场景二：代码审查归档

```
Hermes 调 Claude Code 完成代码审查
    ↓
审查报告 → Obsidian vault
    ↓
与项目笔记建立 [[双向链接]]
    ↓
下次审查时 Agent 自动引用历史上下文
```

### 场景三：日常笔记自动整理

```
你随手写了一条碎片笔记 → Obsidian
    ↓
Hermes 定期扫描 vault（llm-wiki lint）
    ↓
发现孤立笔记 → 建议归并/链接
    ↓
自动更新相关页面的"相关内容"section
```

## 进阶：多 Agent 共享 Vault

如果你同时用 Hermes、Claude Code、Cursor 等多个 AI 工具，可以用 `obsidian-wiki` 这个 Python 包让它们共享同一个 vault：

```bash
pip install obsidian-wiki
```

它提供一个统一的读写接口，15+ 种 AI 工具都能往里存笔记。这样一来，你在 Claude Code 里写的代码分析、在 Cursor 里调出来的 bug 记录、在 Hermes 里生成的研究报告，全部汇入同一个 Obsidian vault。

## 避坑指南

| 坑 | 解法 |
|----|------|
| WSL2 里 `$OBSIDIAN_VAULT_PATH` 不生效 | 不要用环境变量占位符传给 file tool，要展开成绝对路径 |
| vault 路径有空格 | 加引号包裹，或用 `\` 转义 |
| Hermes 写的文件 Obsidian 看不到 | 检查文件是否在 `.obsidian/` 同级的 vault 根目录下 |
| iCloud vault 在 macOS 上的路径 | `/Users/<name>/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault-name>` |
| vault 在移动硬盘上 | 确认挂载点路径，避免 `/Volumes/` 下名称变动 |

## 小结

Hermes + Obsidian 的本质是**把 Agent 的记忆从 API 调用栈里搬到文件系统上**。这意味着：

- 记忆不会随会话消失
- 你可以随时手动编辑 Agent 的"大脑"
- 所有数据都是本地 Markdown，不绑任何平台
- Obsidian 提供免费的可视化层（图谱、搜索、反向链接）

配置只消一行 `OBSIDIAN_VAULT_PATH`，之后 Hermes 的 obsidian skill 和 llm-wiki skill 会自动接管知识管理。
