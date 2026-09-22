---
title: 把 Mindspace 接入你正在用的 AI
description: 下载模板，选工具，复制入口，再用一个新会话确认生效。
order: 1
---

# 把 Mindspace 接入你正在用的 AI

适合已经能使用 Codex、Claude Code、Cursor 或 ZCode 的人。无需搭服务器，也无需先学 Git。第一次先接通一个工具、一个项目。

## 01 · 下载，留下自己的副本

在 [项目首页](/mindspace/#start) 下载 ZIP 并解压。新建一个叫 `ResearchMindspace` 的文件夹，把解压包中 `mindspace/template/` **里面的内容**复制进去。

打开新文件夹，应该直接看到 `HOME.md`、`WORKFLOW.md`、`DAILY.md` 和几个子目录。不要只复制出一个套在里面的 `template` 文件夹。

记下这个文件夹的**完整路径**。例如 macOS 的 `/Users/你的用户名/ResearchMindspace`，或 Windows 的 `C:/Users/你的用户名/ResearchMindspace`。用 Finder / 资源管理器复制实际路径，不要照抄示例。远程或 WSL 会话要填写该会话能访问的路径。

喜欢终端的话，也可以在解压后的 `mindspace` 目录执行 `python3 scripts/init.py ~/ResearchMindspace`（需要 Python 3；目标已存在会停止）。手动复制不需要 Python。

## 02 · 选工具，找到入口文件

先在工具里打开你平时工作的**项目文件夹**。没有项目时，直接打开刚创建的 `ResearchMindspace` 就可以。

| 工具 | 在当前打开的项目根目录创建或编辑 | 说明 |
| --- | --- | --- |
| Codex | `AGENTS.md` | 检查同目录是否已有 `AGENTS.override.md`；它可能替代普通入口 |
| Claude Code / CC | `CLAUDE.md` | 多工具共用时可用 `@AGENTS.md` 引用共同入口 |
| Cursor | `AGENTS.md` | 本指南使用简单 Markdown 入口；已有 `.cursor/rules` 可以保留 |
| ZCode Agent | `AGENTS.md` | 放在当前 Workspace 根目录，不依赖子目录扫描或 `@import` |

注意是 **AGENTS.md，复数、大写**，不是 `Agent.md`。文件保存为纯文本，不要变成 `.md.txt`。

### 方式 A：让 AI 帮你添加（推荐）

到 [首页接入生成器](/mindspace/#start) 选择工具、填写个人空间路径，复制“让 AI 帮我配置”。把它发给当前项目里的 AI。

它会先检查目录与现有规则，再创建或追加入口。工具若要求确认文件改动，先看清目标和差异；不要为了接入而关闭全部权限限制。

### 方式 B：自己复制

同一生成器选择“手动粘贴到文件”。在工具的文件侧栏新建上表文件，或者打开已有文件，把生成内容追加在末尾后保存。已有同名 Mindspace 段落时更新该段，不要清空其他规则。

离线使用时，打开模板包中的 [接入提示词](../prompts/connect.md)，替换 `<MINDSPACE_PATH>` 后复制代码块正文。

入口只告诉 AI 去哪里读取文件；不会自动授予目录访问权限。若个人空间在项目之外且读取被拒绝，按工具提示仅添加这个目录的访问权限，或先在个人空间目录里开启会话验证。

## 03 · 新建会话，确认真的接通

保存后，在**同一个项目**新建会话，发送：

```text
请按项目指令接入 Mindspace。
先实际读取 HOME.md 和 WORKFLOW.md，列出成功读取的完整路径。
从 HOME.md 复述我的研究方向、当前问题；没填的内容就说未填写，不要猜。
如果路径不存在或读取被拒绝，说明卡在哪里。
```

对照你自己的 `HOME.md` 检查结果。第一次还是空白时，再发送：

```text
请帮助我初始化 Mindspace。每次只问一个问题：
我研究什么、正在推进什么问题、已有材料在哪里。
依据我的回答填写 HOME.md；不知道的保持待明确。
不要批量生成知识卡或计划，先帮我推进眼前这一个问题。
```

如果没有接通，依次检查：文件是否在当前项目根目录、文件名是否正确、路径是否属于当前机器、目录能否读取、是否存在覆盖规则。不要只凭 AI 说“已记住”判断成功。

## 04 · 完成一次共读，下一次接着做

提供一篇论文或一份材料，说明你想解决的问题。可以用 [共读提示词](../prompts/co-read.md)。结束时说：

```text
请把这次讨论沉淀回 Mindspace：论文细节进入共读笔记，
摘要里的错误直接修正并保留依据，跨论文判断进入专题。
记录我实际表达的疑问；如果发现值得长期保留的阅读偏好，说明理由。
更新当前项目的证据、未解决问题和下一步，不把建议写成已验证。
告诉我下次只需要先学哪一个概念，以及它影响哪个判断。
```

新会话可以正确接上问题、关键证据和下一步，就完成了第一轮。知识库比你读过的范围更大是正常的；具体组织方法见 [知识与讨论如何积累](workflow.md)。

## 之后：接到更多项目，变成自己的工作台

同一份 Mindspace 可以被不同项目引用，代码与实验数据保留在原项目里。先让一个项目用顺，再考虑全局入口：

- Codex：`~/.codex/AGENTS.md`；自定义 `CODEX_HOME` 时以实际目录为准。
- Claude Code：`~/.claude/CLAUDE.md`。
- Cursor：设置中 Rules 的 User Rules；项目入口依然可用。
- ZCode Agent：`~/.zcode/AGENTS.md`。

已有全局文件只追加，避免在全局和项目中重复放完整说明。个人路径一般留在私人配置中；分享项目规则时改成适合团队的路径或说明。

以 Codex 为例，你可以从一个研究项目开始，让每次会话先恢复问题，推进阅读或实验，最后写回进展。模板本身不提供定时任务、自动训练或跨设备同步；这些能力可以在后续按实际需要接入。

## 适配依据

以上入口按 2026-09-18 查阅的官方说明整理；客户端版本与自定义配置可能不同。见 [Codex 指令文件](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Claude Code 记忆](https://code.claude.com/docs/en/memory)、[Cursor Rules](https://cursor.com/docs/rules)、[ZCode Agent](https://zcode.z.ai/cn/docs/agents)。ZCode 此处指自研 Agent，其他后端使用对应工具的规则。
