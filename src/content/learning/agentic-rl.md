---
title: "Agentic RL：多轮 rollout、上下文重建与训练样本"
short_title: "Agentic RL"
description: "围绕模型调用边界，理解多轮 Agent rollout 如何记录 token、重建上下文、聚合评分并进入 RL trainer。"
track: "Agent Learning"
kind: "文章学习存档"
order: 8
updated_at: "2026-09-09"
source_note: "原作者：Hongliang Cao；本站依据本地保存的公开文章核心技术内容整理，原文链接见页尾。"
---

# Agentic RL：多轮 rollout、上下文重建与训练样本

一条 Agent session 看起来像连续聊天，但 trainer 真正需要的是每次模型调用时实际出现的 token 条件、采样 action、策略版本与奖励映射。理解这个边界，是把 Harness 接进 RL 的第一步。

本页是对 Hongliang Cao 公开文章《聊聊 Agentic RL 中的多轮 rollout、上下文重建与 RL 训练》的学习归档。保留核心公式与论证结构，去掉公众号推广内容，并增加与前一篇 Agentic SFT 的边界对照。原作者与原文链接见页尾。

## 这篇文章解决什么混乱

讨论 Agentic RL 时，人们常把四类对象都叫“轨迹”：

1. Harness 保存的 session 消息；
2. 一次次发给模型 API 的结构化 request；
3. 推理服务器实际编码出的 token 输入与采样输出；
4. 含工具、环境、最终 artifact 和 reward 的完整 episode。

这四者有关联，但不等价。尤其当 Harness 会 compaction、消息过滤、分支恢复、动态 system prompt 或跨协议适配时，append-only 的 session 并不能证明后一轮模型输入是前一轮的 token 前缀。

| 层级 | 含义 |
|---|---|
| message | Harness 可读、可恢复的结构化状态 |
| request | 某个 provider 协议下的一次 LLM call |
| token | Rollout policy 真正条件化与采样的序列 |
| episode | 调用 + 环境 + artifact + score 的闭合记录 |

## 推理：一次模型调用

令 $M_i$ 表示第 $i$ 次调用前，Agent Harness 维护的内部消息状态。它可以包含 system、user、assistant、tool call、tool result 与 environment observation。

Harness 先按协议 $v$ 组织请求：

$$
Q_i^{(v)}=\operatorname{Adapt}_v(M_i)
$$

$Q_i^{(v)}$ 可能包含 messages、工具定义与生成参数；其中只有进入上下文构造的字段影响模型输入 token。推理服务再针对模型 $m$ 和协议 $v$ 编码：

$$
p_i^{\mathrm{tok}}=\operatorname{Encode}_{m,v}\left(Q_i^{(v)}\right)
$$

若服务显式使用 chat template，可继续拆成：

$$
p_i^{\mathrm{text}}=S_{m,v}\left(Q_i^{(v)}\right)
$$

$$
p_i^{\mathrm{tok}}=\operatorname{Tok}_m\left(p_i^{\mathrm{text}}\right)
=\operatorname{Tok}_m\left(S_{m,v}\left(Q_i^{(v)}\right)\right)
$$

模型在该条件下自回归采样：

$$
a_i^{\mathrm{tok}}\sim\pi_\theta\left(\cdot\mid p_i^{\mathrm{tok}}\right)
$$

随后经历 detokenization 与协议解析：

$$
a_i^{\mathrm{text}}=\operatorname{Detok}_m\left(a_i^{\mathrm{tok}}\right)
$$

$$
R_i=P_v\left(a_i^{\mathrm{text}}\right)
$$

$R_i$ 是 Harness 使用的结构化响应，可能含自然语言、推理字段和 tool calls。Harness 再结合工具结果或环境观测 $o_i$ 更新状态：

$$
M_{i+1}=U(M_i,R_i,o_i)
$$

一次调用的完整数据流因此是：

$$
M_i\xrightarrow{\operatorname{Adapt}_v}Q_i^{(v)}
\xrightarrow{\operatorname{Encode}_{m,v}}p_i^{\mathrm{tok}}
\xrightarrow{\pi_\theta}a_i^{\mathrm{tok}}
\xrightarrow{\operatorname{Detok}_m}a_i^{\mathrm{text}}
\xrightarrow{P_v}R_i
\xrightarrow{U}M_{i+1}
$$

> **关键边界：** RL 更新的是在真实 $p_i^{\mathrm{tok}}$ 条件下采样 $a_i^{\mathrm{tok}}$ 的 policy。session JSON、API request 和 token trajectory 都可以保存，但不能互相冒充。

## 多轮 rollout 与上下文重建

令 $\rho$ 表示一次 Agent 与环境交互的 rollout。message-level 记录可以写成：

$$
\mathcal{C}^{\mathrm{msg}}(\rho)=
\left((M_1,R_1,o_1),(M_2,R_2,o_2),\ldots\right)
$$

将每次调用的文本输入与生成文本配对，可得 text-level 记录：

$$
\mathcal{C}^{\mathrm{text}}(\rho)=
\left((p_1^{\mathrm{text}},a_1^{\mathrm{text}}),
(p_2^{\mathrm{text}},a_2^{\mathrm{text}}),\ldots\right)
$$

有些 Harness 将 session 保存为 append-only JSONL tree。恢复 session、切换分支或 compaction 时，会沿当前分支构造有效消息；早期消息可能被摘要替代。即使磁盘上的 session 只追加，$M_i$ 仍可能经过：

- 消息过滤；
- 上下文窗口裁剪；
- 摘要压缩；
- 动态 system/tool 信息注入；
- provider adapter 重排或规范化。

因此不能默认：

$$
p_i^{\mathrm{tok}}\Vert a_i^{\mathrm{tok}}
\preceq_{\mathrm{tok}}p_{i+1}^{\mathrm{tok}}
$$

要得到严格前缀关系，需要同时固定上下文状态、system prompt、工具定义、协议转换、chat template 与 tokenizer，并排除 detokenize → parse → re-encode 引起的 token 边界变化。

## RL 需要保存的模型调用轨迹

训练系统在模型边界直接观察到的调用轨迹是：

$$
\mathcal{C}^{\mathrm{tok}}(\rho)=
\left((p_1^{\mathrm{tok}},a_1^{\mathrm{tok}}),
(p_2^{\mathrm{tok}},a_2^{\mathrm{tok}}),\ldots\right)
$$

令 $a_{i,t}^{\mathrm{tok}}$ 表示第 $i$ 次调用生成的第 $t$ 个 token，$\pi_{\mathrm{roll}}$ 是实际执行采样的 rollout policy：

$$
a_{i,t}^{\mathrm{tok}}\sim
\pi_{\mathrm{roll}}\left(
\cdot\mid p_i^{\mathrm{tok}},a_{i,<t}^{\mathrm{tok}}
\right)
$$

若训练目标需要旧策略概率，还需保存或可复现地计算：

$$
\ell_{i,t}^{\mathrm{roll}}=
\log\pi_{\mathrm{roll}}\left(
a_{i,t}^{\mathrm{tok}}\mid p_i^{\mathrm{tok}},a_{i,<t}^{\mathrm{tok}}
\right)
$$

一条可用于训练的调用记录至少要精确恢复：

- 实际 `input_ids`；
- 实际采样的 `output_ids`；
- response/action mask；
- rollout policy checkpoint/version；
- tokenizer、chat template 与协议 adapter 版本；
- 如果算法需要，采样 token 的旧策略 log probability；
- rollout ID、attempt ID、call index 与终止原因。

异步采样时，“模型名字”不能替代策略版本。同名模型在多个 trainer step 后权重已不同；不记录版本，trainer 无法判断轨迹对当前 policy 有多 off-policy。

## Serving gateway 在采集什么

对 Pi、Claude Code、OpenClaw 等现成 Harness 做黑盒 RL 时，常见做法是在 Harness 与 rollout inference service 之间放一个协议兼容 gateway/proxy。

1. **HARNESS — 维护 Agent loop：** 工具调用、compaction、状态与任务终止。
2. **GATEWAY — 标记 rollout/call：** 协议适配、版本与追踪信息。
3. **INFERENCE — 返回真实 token：** input_ids、output_ids 与可选 logprob。
4. **ENV — 执行 action：** 工具结果、文件变化与最终 artifact。
5. **STORE — 聚合闭合轨迹：** 模型调用与环境证据共同入库。

Harness 仍使用熟悉的 OpenAI Chat Completions、Responses 或 Anthropic Messages 等客户端；gateway 将请求转换给推理服务，并把结构化协议响应送回 Harness。关键不是“有一个代理服务器”，而是它能否取得**推理服务实际使用的 token 与概率**。

只记录 request/response 文本的普通 API gateway 不足以可靠恢复训练样本。若事后再用另一个 tokenizer 或 template 编码，条件序列已经可能发生变化。

白盒 Agent loop 可以在自定义 rollout 函数里直接完成同样记录，所以 gateway 是接入黑盒 Harness 的常见方式，不是 Agentic RL 的必要定义。

## 跨轮重编码为什么危险

模型生成 $a_i^{\mathrm{tok}}$ 后，下一轮输入通常经历：

$$
a_i^{\mathrm{tok}}
\xrightarrow{\operatorname{Detok}_m}a_i^{\mathrm{text}}
\xrightarrow{P_v}R_i
\xrightarrow{U}M_{i+1}
\xrightarrow{\operatorname{Adapt}_v}Q_{i+1}^{(v)}
\xrightarrow{\operatorname{Encode}_{m,v}}p_{i+1}^{\mathrm{tok}}
$$

这里任一步都可能改变序列：parser 将 tool call 规范化成 JSON、Harness 插入 tool result、compaction 替换历史、template 在消息边界加控制 token、重新分词改变 token 切分。

所以训练时有两种清晰方案：

### 方案 A：每次模型调用独立成样本

对每个 $(p_i^{\mathrm{tok}},a_i^{\mathrm{tok}})$ 独立计算 policy loss。它最忠实、易校验，但相邻调用共享的大量前缀会重复计算。

### 方案 B：满足严格条件后再合并

线性合并、serving token buffer 或训练期 prefix tree 可以省计算，但必须证明每个 action token 的条件序列与 rollout 时完全一致。不能为了“对齐”而把下一轮真实输入替换成训练期构造的 token；那会改变 policy 实际采取 action 时的条件。

> **注意：** 训练阶段事后把下一轮 prompt 中的一段 token 换成“更整齐的前一轮输出”，即使文字看起来等价，也会破坏 on-policy 数据的条件一致性。先保真，再优化重复计算。

## 从 rollout 到 trainer 的七层映射

模型调用轨迹还不是可直接训练的 batch。中间至少有下面七层：

1. **Token-level call records：** 每次模型调用的真实 prompt tokens、sampled tokens、mask、logprob 与 policy version。
2. **Complete rollout records：** 按 rollout/attempt 聚合所有 calls、环境状态、工具结果、最终 artifact 与版本信息。
3. **Rollout groups：** 按任务、初始状态或采样批次建立可比较集合；分组键必须在采样前定义。
4. **Verifier scores：** 保存每条 rollout 的原始标量、多指标或结构化判定；不要只存变换后的 reward。
5. **Reward transform：** 组合、过滤或归一化原始 score，保留 reward 到原始判据的映射。
6. **Credit assignment：** 把 rollout reward 转成 call-level 或 token-level return、advantage、weight。
7. **Training samples：** 按调用拆分或在条件一致时合并，打包成 trainer 所需的 ids、mask、旧策略概率与训练信号。

形式化地，一条完整 rollout 记录可写作：

$$
\mathcal{R}_\rho=
\left(x_\rho,\mathcal{C}^{\mathrm{tok}}(\rho),e_\rho,v_\rho\right)
$$

其中 $x_\rho$ 是任务输入，$e_\rho$ 是环境轨迹与最终产物，$v_\rho$ 是 policy 及编码组件版本。多个 rollout 按键 $g$ 进入 group：

$$
\mathcal{G}_g=\left\{\mathcal{R}_\rho\mid g(\rho)=g\right\}
$$

评分过程：

$$
\mathcal{S}_g=\operatorname{Score}(\mathcal{G}_g)
$$

奖励变换：

$$
\mathcal{Y}_g=\operatorname{Reward}(\mathcal{G}_g,\mathcal{S}_g)
$$

信用分配：

$$
\mathcal{K}_g=\operatorname{Credit}(\mathcal{G}_g,\mathcal{Y}_g)
$$

样本构造：

$$
\mathcal{D}_g=\operatorname{Build}
\left(\mathcal{G}_g,\mathcal{S}_g,\mathcal{Y}_g,\mathcal{K}_g\right)
$$

将 Score、Reward、Credit 与 Build 分开，才能在不重跑环境的情况下比较奖励归一化、优势估计与样本权重，并明确“环境事实”与“训练算法假设”的边界。

## SFT 与 RL 共用什么，不共用什么

| 层 | Agentic SFT | Agentic RL |
|---|---|---|
| Harness message / tools | 共用，可采用同一事件 schema | 共用，可采用同一事件 schema |
| action 来源 | teacher/offline demonstration | rollout policy 实际采样 |
| 环境 | 可是真实、模拟或离线保存 | 必须能产生可评分的 rollout 结果 |
| token 正本 | 目标模型渲染后的 input/assistant labels | 采样时真实 input/output tokens |
| 概率 | 通常不需要 teacher logprob | 许多目标需要 rollout/old-policy logprob |
| 训练信号 | token-level cross entropy | reward → credit → advantage/weight |
| 核心风险 | mask/template 错、坏示范被模仿 | 条件重建错、策略版本错、reward/credit 混淆 |

最自然的工程路线是先让同一 Harness 的事件、工具与环境记录满足 SFT 审计，再扩展 rollout policy version、logprob、group、score、reward 与 credit 字段。不要为了复用而把 SFT trajectory 假装成 on-policy rollout。

## 实现检查清单

### 模型调用层

- [ ] 每个 call 有稳定的 rollout / attempt / call ID。
- [ ] 记录推理服务实际 input_ids、output_ids，而非只存重编码文本。
- [ ] action mask 能回指生成 token 的来源。
- [ ] tokenizer、chat template、provider adapter 有不可变版本或 hash。
- [ ] rollout policy 使用 checkpoint/version，而不只写模型名。
- [ ] 算法需要时保存 rollout logprob 与采样配置。

### 环境与轨迹层

- [ ] 工具结果、文件变化、测试输出与最终 artifact 进入同一 rollout record。
- [ ] 失败、超时、取消和 Harness 崩溃有明确 termination status。
- [ ] 只有 calls 与环境记录都闭合后才进入 verifier。
- [ ] 原始 verifier score 独立保存，不被 reward transform 覆盖。

### 训练构造层

- [ ] group key 在实验协议里定义。
- [ ] score、reward、credit、sample weight 分字段记录。
- [ ] 每个训练 token 能追溯到真实 call 与条件序列。
- [ ] 拆分、合并、packing 不会悄悄改变 rollout 权重。
- [ ] prefix cache 或线性合并先有等价性测试，再做吞吐优化。

## 来源

- [作者博客原文 · Agentic RL Research](https://chlience.com/articles/agentic-rl-research/)
- [微信公众号「青稞AI」转载](https://mp.weixin.qq.com/s/mcQptCdRNxf_1wZYNcwxuA)
- 本地学习源文件：`RL_learn/聊聊AgenticRL中的多轮rollout、上下文重建与RL训练.md`
- 相邻学习页：[Agentic SFT：从工具轨迹到可训练样本](/learning/agentic-sft/)

> **证据边界：** 这篇内容描述的是 Agentic RL 数据与系统边界，不等于已经实现某个训练框架。真正验收仍要落到：调用 token 能否精确回放、环境证据是否闭合、reward/credit 是否可追踪，以及 frozen evaluation 是否改善。
