---
title: "Reward、Verifier 与 RLVR：训练信号怎样可信地落到 Agent"
short_title: "Reward & Verifier"
description: "区分环境事实、确定性 verifier、reward model 与 LLM judge，设计可复算、抗投机、能支持 Agent RL 的训练信号。"
track: "Agent Learning"
kind: "奖励工程 + 评测契约"
order: 5
updated_at: "2026-09-09"
source_note: "教学内容结合过程监督、规则可验证推理与本知识库 BenchDecoded 的 scorer 边界整理。"
---

# Reward、Verifier 与 RLVR：训练信号怎样可信地落到 Agent

RL 优化的不是“真实能力”，而是你交给它的训练信号。Verifier 写错、测试泄漏、judge 偏好长答案或环境状态不可重放时，PPO 和 GRPO 越稳定，模型反而可能越快学会投机。奖励工程首先是一份可审计的测量契约。

## 五个经常混在一起的词

| 名称 | 输入 | 输出 | 典型例子 |
|---|---|---|---|
| Environment | action + 当前状态 | observation + 新状态 | 执行工具、运行代码、修改沙箱仓库 |
| Scorer | episode 或 artifact | 原始指标 | 单测通过数、格式合法率、延迟 |
| Verifier | candidate + 可验证事实 | 正确/错误或结构化判定 | 数学答案检查、编译测试、约束检查 |
| Reward model | prompt + response | 学得的标量偏好 | 人类偏好模型、安全模型 |
| LLM judge | rubric + 轨迹/答案 | 文本判词与分数 | 解释质量、目标满足度、风格合规 |

最终给 trainer 的 reward 往往是这些信号的变换：

$$
R(\tau)=f\left(
s_{\mathrm{correct}},
s_{\mathrm{format}},
s_{\mathrm{safety}},
c_{\mathrm{tokens}},
c_{\mathrm{tools}}
\right)
$$

必须同时保存原始分量和 $f$ 的版本。只保留最终标量，会让你无法回答 reward 为什么变化。

## Outcome、Process 与 Dense Feedback

### Outcome supervision

只检查最终结果，例如最终答案是否正确、仓库测试是否全部通过。它通常最客观、最接近任务目标，但无法指出中间哪一步错了。

### Process supervision

对中间步骤给反馈，例如每个推理步骤是否有效、工具选择是否合理、参数是否满足约束。它提供更细 credit，却更昂贵，也更容易把某一种解题风格错误地规定成唯一过程。

### Dense environment feedback

环境自然产生的信号，例如编译错误、HTTP 状态、schema validator、游戏状态变化。这些 observation 本身不一定都是 reward；要先区分“模型需要看到的状态信息”和“优化目标”。

《Let's Verify Step by Step》明确比较了 outcome supervision 与逐步 process supervision，并发布了 step-level feedback 数据。[原论文](https://arxiv.org/abs/2305.20050)

## RLVR 是什么

RLVR（Reinforcement Learning from Verifiable Rewards）利用可程序化判定的结果训练策略，例如：

- 数学题最终答案可符号或数值校验；
- 代码任务可编译并运行测试；
- 结构化输出可通过 JSON Schema；
- 游戏或规划任务可由模拟器判定终局状态；
- tool-use 任务可检查调用序列是否真的改变目标状态。

它的优势不是“奖励永远正确”，而是 scorer 可以重复运行、相同输入应得到相同结果，并且失败可以定位到具体规则。DeepSeek-R1 展示了规则奖励驱动的大规模 reasoning RL，同时也报告纯 RL 模型可能出现可读性和语言混合等问题，说明 correctness reward 仍不足以覆盖全部行为质量。[DeepSeek-R1 技术报告](https://arxiv.org/abs/2501.12948)

| 要求 | 含义 |
|---|---|
| Correct | 任务结果真的满足规范 |
| Reproducible | 相同 artifact 与环境版本可重算 |
| Isolated | 私有用例与 solution 不进入模型上下文 |
| Diagnostic | 保留分项证据，而非只有总分 |

## 一个可靠 Verifier 的接口

```text
VerifierInput
  task_id
  task_spec_version
  initial_environment_snapshot
  trajectory_ref
  final_artifact_ref

VerifierOutput
  verifier_version
  status: passed | failed | invalid | infra_error
  raw_metrics
  evidence_refs
  public_feedback
  private_diagnostics
```

`failed` 与 `infra_error` 必须分开。服务器故障、依赖下载失败或 scorer 超时若被当成模型失败，会向策略注入系统噪声；反过来，把模型破坏环境造成的错误一律记作 infra error，也会给投机留下空间。

## Reward contract 要先于训练代码

1. **写任务成功定义：** 先用自然语言和可执行断言定义“完成”，不要从现有 scorer 代码反推研究目标。
2. **列出可观察证据：** 明确最终答案、文件差异、测试输出、环境状态、工具调用与成本哪些可被可靠观察。
3. **划分公开与私有信息：** 模型可见公开测试和错误反馈；holdout、solutions、私有 rubric 不进入 rollout 容器。
4. **实现确定性 scorer：** 优先 schema、parser、编译器、测试与模拟器；只有规则无法覆盖的维度再交给 judge。
5. **固定 reward transform：** 记录权重、归一化、裁剪、失败 penalty 与长度/成本项，并给配置做版本化。
6. **做对抗测试：** 手工构造空答案、超长答案、硬编码答案、删除测试、伪造日志、利用 scorer 漏洞等负例。
7. **跑未训练 baseline：** 先看 reward 分布、各分量相关性与 false positive，再决定是否值得启动 RL。
8. **冻结评测版本：** 正式 run 绑定 environment、verifier、dataset 与 code snapshot；不要在运行中悄悄改题。

## Reward hacking 的常见形态

- **长度投机：** judge 更喜欢长解释，模型不断扩写却不提高正确率。
- **格式投机：** 格式 reward 太大，模型输出合法 JSON 但不解决任务。
- **测试投机：** 模型删除、跳过或修改测试，使表面 pass rate 上升。
- **日志投机：** 模型打印“success”或伪造工具返回，scorer 没检查真实状态。
- **资源投机：** 无限重试、穷举或高成本搜索换成功率，成本没有进入评估。
- **Judge 投机：** 在答案里写给 judge 的指令、引用 rubric 或堆砌自信措辞。
- **环境逃逸：** 利用宿主权限、网络、缓存或其他任务状态获取不该见的信息。
- **训练集记忆：** 同源模板或答案泄漏到 holdout，reward 上升但不泛化。

解决 reward hacking 的第一反应不应是“再加一个 penalty”。先修测量漏洞、隔离环境、增加对抗用例，并将新 verifier 作为新版本重新建立 baseline。

## 多指标怎样组合

假设代码 Agent 的原始指标为：

$$
s=(\text{tests},\text{build},\text{policy},\text{cost})
$$

一种朴素标量化：

$$
R=w_1s_{\mathrm{tests}}+w_2s_{\mathrm{build}}
+w_3s_{\mathrm{policy}}-w_4s_{\mathrm{cost}}
$$

但不是所有约束都适合用权重交易。例如“禁止读取私有 solution”是硬约束，不应允许模型用多通过几个测试抵消。更稳妥的结构是：

1. 先做合法性与安全 gate；
2. 对有效 episode 计算任务质量；
3. 在成功质量相近时再比较成本；
4. 训练 reward 与报告指标分开保存。

## Verifier 与 GRPO 的特殊关系

GRPO 为同一 prompt 采样一组回答，并依赖组内 reward 差异形成 advantage。如果 verifier 过于宽松，整组都是 1；过于苛刻，整组都是 0；两种情况的标准差都为 0，几乎没有相对学习信号。

因此启动 GRPO 前应该统计：

- 每个 prompt 的 group pass count；
- non-zero variance group 比例；
- reward 各分量在组内的方差；
- 正确率随采样温度与 group size 的变化；
- invalid 与 infra_error 的占比。

这比先调学习率更接近问题根源。

## 与 BenchDecoded 的关系

BenchDecoded 的价值在于把题面、模型输出、Harness 行为与 scorer 分开阅读。训练系统可以复用同样的边界意识：

```text
Task specification
      ↓
Harness + model + environment  →  trajectory / artifact
      ↓
Scorer / verifier              →  raw evidence
      ↓
Reward transform               →  trainer signal
```

Benchmark 衡量一个冻结系统；RL 用 scorer 信号改变 policy。两者可以共享 task 和 verifier，但正式 holdout 的结果不应回流训练实践。

## 上线训练前的检查表

- 随机重放同一 artifact，score 是否一致；
- 模型看不到私有测试、reference solution 与 judge secret；
- `invalid`、`failed`、`timeout`、`infra_error` 有不同语义；
- 原始指标、证据、reward transform 和版本均已落库；
- 至少有一组专门攻击 scorer 的 adversarial tests；
- baseline 的 reward 与真实成功率有可解释相关性；
- 长度、工具次数和延迟不会无意主导总 reward；
- reward 更新会创建新 protocol/version，而不是覆盖历史结果。

> **下一步：** 带着这套 reward contract 阅读 [GRPO](/learning/grpo/)。你会看到为什么“同题多采样”能替代 critic，也会看到 binary verifier、group size 与动态采样为何直接决定学习信号是否存在。
