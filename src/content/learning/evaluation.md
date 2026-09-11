---
title: "Agent 评测与失效分析：从 Reward 曲线到可信能力证据"
short_title: "评测与失效分析"
description: "建立从任务成功、轨迹质量、成本到泛化的评测层级，识别 reward hacking、数据泄漏与训练系统假进步。"
track: "Agent Learning"
kind: "实验设计 + 失败复盘"
order: 10
updated_at: "2026-09-09"
source_note: "本页聚焦研究协议与可复查证据；任何模型能力结论都应绑定冻结的 task、environment、harness、policy 与 scorer 版本。"
---

# Agent 评测与失效分析：从 Reward 曲线到可信能力证据

训练 reward 上升只说明模型越来越擅长优化当前 scorer。可信的能力结论还要证明：在冻结、隔离、未回流的任务上，模型以可接受成本完成了真实目标，而且提升不是来自格式投机、模板记忆、Harness 改动或评测环境泄漏。

## 评测对象不是“一个模型名字”

Agent 的行为由一整个系统决定：

$$
\mathcal A=(\pi,\text{tokenizer},\text{template},\text{harness},
\text{tools},\text{environment},\text{decoding})
$$

一次 benchmark 结果还需要：

$$
\mathcal E=(\text{tasks},\text{initial states},\text{scorer},
\text{budgets},\text{protocol})
$$

最终报告的是：

$$
\operatorname{Evaluate}(\mathcal A,\mathcal E)
$$

只说“Model-X 在某 bench 得 42”会隐藏 temperature、最大 turn、工具集合、重试、上下文压缩和 scorer 版本。对 Agent 来说，Harness 改动可能与 policy 更新一样显著。

## 指标金字塔

### 第一层：Task outcome

- success rate / pass rate；
- pass@k；
- partial correctness；
- 安全与 policy violation；
- 未完成、拒绝、超时、invalid、infra error 分布。

### 第二层：Trajectory quality

- 工具选择、参数合法率；
- observation 是否被正确消费；
- 重复调用、无效循环、错误恢复率；
- first-error position；
- planning/action/final-answer 分层失败。

### 第三层：Efficiency

- input/output token；
- 模型调用数、工具调用数、turn 数；
- wall-clock latency 与 environment time；
- GPU-hour、teacher query 与 verifier cost；
- success per cost。

### 第四层：Generalization

- held-out task template；
- held-out tool family/domain；
- 环境版本和初始状态变化；
- 不同语言、长度、干扰 observation；
- 新 Harness 或新模型协议上的迁移。

| 维度 | 问题 |
|---|---|
| Outcome | 任务是否完成 |
| Process | 怎样完成或在哪里失败 |
| Cost | 成功付出了什么资源 |
| Transfer | 换条件后能力是否仍存在 |

## Pass@k 应该怎样读

若每题生成 $n$ 个独立样本，其中 $c$ 个通过，从中选 $k$ 个至少一个成功的无偏估计常写作：

$$
\operatorname{pass@k}
=1-\frac{\binom{n-c}{k}}{\binom{n}{k}}
$$

pass@1 衡量一次执行的可靠性；更大的 pass@k 衡量通过重复采样发现可行解的能力。Agent 场景还应同时报告总生成 token 与环境执行次数，因为高 pass@k 可能只是用昂贵重试换来的。

一个更贴近部署的指标是：

$$
\text{success-per-cost}
=\frac{\#\text{successful tasks}}
{\text{generated tokens, tool cost, GPU time 或 wall time}}
$$

不要把不同成本口径强行压成唯一数字；至少保留成功率与关键资源的二维比较。

## Train、Validation、Practice 与 Holdout

| 分区 | 能否看详细结果 | 能否据此改数据/奖励 | 用途 |
|---|---:|---:|---|
| Train | 可以 | 可以 | 产生梯度、诊断数据质量 |
| Validation | 可以 | 可以，但会逐渐过拟合 | 选超参数、early stop |
| Practice | 可以 | 可以 | Agent 自我改进与错误复盘 |
| Holdout | 受限 | 不可以回流本轮实践 | 最终能力声明 |

关键不是文件叫 `test.jsonl`，而是结果有没有进入人的决策或模型上下文。一旦看过 holdout 失败并针对性修复，它就变成 practice set，应另建新的未见评测。

## 不要随机切行，要按因果来源隔离

Agent 任务常由模板、仓库、工具图或原始问题改写生成。随机切行会把近似副本放到 train 与 test 两边。

建议按以下 group key 切分：

- 原始 source / repository / issue family；
- task generator template 与 seed family；
- tool family 与 API domain；
- environment snapshot lineage；
- solution strategy 或 dependency graph；
- teacher/source dataset provenance。

同一任务的 paraphrase、不同采样答案和不同 agent attempt 必须跟随同一个 split group。

## 失败分类要互斥、可回到证据

- **Perception / state：** 漏读题面、忽略 observation、错误理解当前环境。
- **Planning：** 目标分解错误、顺序错误、没有选择必要工具。
- **Action protocol：** 工具名、参数、JSON、权限或调用顺序非法。
- **Execution：** 代码/命令本身失败，或环境状态没有按预期改变。
- **Recovery：** 看到错误后循环、忽略反馈、过早放弃或破坏状态。
- **Finalization：** 任务已完成却回答错误，或未验证就声称成功。
- **Policy / safety：** 读取私有信息、越权操作、违反不可逆操作约束。
- **Infrastructure：** 服务、挂载、GPU、网络或 scorer 故障，不归因于模型。

分类应该链接到 `rollout_id + call_index + evidence_ref`。只保存一句“planning error”无法复查，也无法可靠产生下一批训练数据。

## Reward hacking 的证据模式

当出现以下组合时，应先怀疑测量问题：

| 观测 | 可能的原因 |
|---|---|
| train reward 上升，holdout success 不动 | scorer 过拟合、数据泄漏、reward proxy 偏差 |
| judge score 上升，答案越来越长 | verbosity bias 或长度未归一化 |
| test pass 上升，真实 artifact 不可用 | 修改/跳过测试，或只满足公开用例 |
| format reward 很高，任务 success 很低 | 辅助 reward 权重压过主目标 |
| tool-call 数暴涨，success 小幅上升 | brute force、无成本约束或循环重试 |
| KL 很小，行为却明显改变 | KL estimator/mask/聚合范围错误 |
| reward 突然跳变，policy 指标平滑 | verifier/environment 版本变化 |
| 某个 domain 独占提升 | sampling mix 或模板记忆，而非通用能力 |

每条异常都应该能触发一组自动 drill-down：代表性轨迹、reward 分量、版本差异和相关成本。

## Ablation：证明是哪个部件带来提升

一次完整方法可能同时改变数据、reward、算法、采样温度、group size、环境和 Harness。若全部一起变化，最终只能证明“整套新系统不同”，不能证明 OPD 或 GRPO 有效。

最小消融矩阵：

```text
Base policy        固定
Task release       固定
Environment        固定
Verifier           固定
Token budget       固定

A: SFT baseline
B: A + online rollout data
C: A + GRPO
D: A + OPD
E: A + hybrid OPD/RL
```

然后每次只改变一个关键轴：advantage estimator、teacher signal、reward component、group size、data refresh 或 async policy age。

> **注意：** 公平预算不能只对齐 optimizer step。GRPO 多采 G 条，OPD 还需要 teacher forward。至少同时报告 student-generated tokens、teacher-scored tokens、environment steps、wall time 与 GPU-hours。

## Seed 与不确定性

Agent 评测包含 sampling、环境和并发噪声。单个 seed 的最好结果不等于稳定改进。

建议至少保存：

- task sampling seed；
- model generation seed（后端若能保证）；
- environment seed；
- training initialization/data-order seed；
- 每题多次 attempt 的全部结果，而非只保存成功者。

报告均值时同时给任务级 bootstrap interval、跨 seed 方差或至少原始样本数。不同 task 的 attempt 不能被错误当成完全独立样本。

## 一份冻结评测协议

1. **注册被测系统：** 绑定 policy、tokenizer、template、Harness、tools、decoding、预算与代码 snapshot。
2. **加载不可变 task release：** 验证 task manifest、环境初态和 scorer hash；practice 与 holdout 使用不同 release。
3. **预注册主指标：** 先指定 success、安全与成本指标，再运行；避免看结果后挑最有利数字。
4. **执行隔离 rollout：** 每题使用干净环境；失败与重试有独立 attempt ID，模型看不到其他任务残留。
5. **运行独立 scorer：** 私有用例只在评分环境出现；保存原始证据、状态与版本。
6. **生成分层报告：** 按 difficulty、domain、tool family、长度和失败类型切片，不只报告总平均。
7. **人工审计样本：** 抽查成功、失败、judge disagreement、极端成本和 scorer 边界案例。
8. **冻结结论：** 报告适用范围与已知限制；holdout 结果不回流当前实践，后续改进另建 protocol。

## 连接训练曲线与最终能力

训练期间可以频繁看：reward、KL、entropy、group variance、loss、长度和吞吐。它们是**控制指标**。最终能力声明应来自冻结评测：task success、安全、成本和泛化。二者关系如下：

```text
训练控制指标
  ├─ 发现数值/系统异常
  └─ 指导是否停止或回滚

冻结能力指标
  ├─ 比较方法
  ├─ 支持研究结论
  └─ 不回流本轮训练实践
```

训练曲线回答“优化过程是否健康”；benchmark 回答“冻结系统现在会什么”。

## 与 BenchDecoded 的分工

[BenchDecoded](/benchdecoded/) 适合用来逐条阅读公开 benchmark 的题面、输出和 scorer，从而训练“评测究竟测到什么”的直觉。本页则提供建立自己实验协议的通用骨架。

把每个新 benchmark 接入知识库时，建议固定写六个问题：

1. 被测对象是什么：model、Harness 还是完整 Agent system？
2. task 初态如何产生，是否可重放？
3. 模型实际看到哪些公开信息？
4. scorer 用哪些私有证据，能否复算？
5. 主指标是否被长度、重试、成本或格式影响？
6. 结果能否回流训练；如果能，它就不再是最终 holdout。

## 每次实验结束后的研究账本

```text
Hypothesis
Protocol / task release
System under test
Training data and token budget
Reward / teacher signal
Primary and guardrail metrics
Result with uncertainty
Representative successes and failures
Known confounders
Decision: keep / reject / needs new experiment
Artifact and evidence paths
```

> **学完判断：** 你应该能拒绝一句没有 protocol 的“模型提升了 8 分”，并把它改写成可复查结论：在哪个冻结系统、哪些未见任务、什么预算和 scorer 下，哪类成功率提升，同时付出了多少成本、出现了哪些新失败。
