---
title: "GRPO：用组内相对奖励替代 Critic"
short_title: "GRPO"
description: "从同题多采样、group baseline 和 PPO-style clip 出发，理解 GRPO 的优势估计、实现流程、失败模式与多轮 Agent 扩展。"
track: "Agent Learning"
kind: "算法推导 + 工程实践"
order: 6
updated_at: "2026-09-09"
source_note: "核心算法依据 DeepSeekMath；动态采样等后续实践参考 DAPO 与 NeMo RL 官方实现文档。"
---

# GRPO：用组内相对奖励替代 Critic

GRPO 不是“没有 PPO 的 PPO”，也不是只要多采几条答案再做 SFT。它仍然是 policy-gradient 更新：对同一个 prompt 采样一组轨迹，用组内相对奖励估计 advantage，再提高胜出动作的概率、降低落后动作的概率。它主要去掉的是单独训练的 value model。

## 从 PPO 的哪一部分开始改

PPO 的 advantage 常由 critic 与 GAE 得到：

$$
\hat A_t^{\mathrm{PPO}}
=\sum_{l\ge 0}(\gamma\lambda)^l
\left(r_{t+l}+\gamma V(s_{t+l+1})-V(s_{t+l})\right)
$$

在数学、代码等任务里，经常只有终局 verifier reward，训练一个与 policy 规模相近的 critic 成本很高，而且 critic 也要学会从长文本状态预测稀疏回报。

GRPO 的替代想法是：同一道题一次生成 $G$ 个候选，用它们彼此比较，估计“这个结果比当前策略对这道题的平均表现好多少”。DeepSeekMath 将 GRPO 作为 PPO 的变体提出，并强调其相对 PPO 的内存效率。[DeepSeekMath / GRPO](https://arxiv.org/abs/2402.03300)

## 第一步：同一个 prompt 采样一组 rollout

对 prompt $q$，使用 rollout policy 采样：

$$
o_1,o_2,\ldots,o_G\sim\pi_{\theta_{\mathrm{old}}}(\cdot\mid q)
$$

每个 $o_i$ 可以是一段答案，也可以是一整条 Agent trajectory。Verifier 得到对应 reward：

$$
R_i=\operatorname{Verify}(q,o_i,e_i)
$$

其中 $e_i$ 是工具结果、最终 artifact 或环境终局状态。**分组键必须在采样前定义**：通常是同一 task 与相同初始环境，而不是事后把得分相近的轨迹凑在一起。

## 第二步：构造 group-relative advantage

常见的组内标准化形式是：

$$
\hat A_i=
\frac{R_i-\operatorname{mean}(R_1,\ldots,R_G)}
{\operatorname{std}(R_1,\ldots,R_G)+\varepsilon}
$$

假设四条 rollout 的 reward 是 $[1,1,0,0]$，成功轨迹得到正 advantage，失败轨迹得到负 advantage。若 reward 是 $[1,1,1,1]$ 或 $[0,0,0,0]$，组内没有差异，标准化后的有效信号接近 0。

还有 leave-one-out baseline：

$$
b_i=\frac{1}{G-1}\sum_{j\ne i}R_j,
\qquad
\hat A_i=R_i-b_i
$$

标准化、减均值和 leave-one-out 不是完全相同的 estimator。阅读实现时要确认：是否除以标准差、是否 leave-one-out、是否 clip advantage，以及统计是在 prompt group、batch 还是全局范围完成。

| 组成 | 作用 |
|---|---|
| 1 prompt | 固定任务与初始环境，定义可比较条件 |
| G rollouts | 由同一 rollout policy 独立采样 |
| G rewards | 由同一 verifier/version 计算 |
| relative A | 组内结果取代 learned value baseline |

## 第三步：仍然做 policy-ratio 更新

对第 $i$ 条回答中第 $t$ 个 sampled token：

$$
r_{i,t}(\theta)=
\frac{\pi_\theta(o_{i,t}\mid q,o_{i,<t})}
{\pi_{\theta_{\mathrm{old}}}(o_{i,t}\mid q,o_{i,<t})}
$$

一个教学化的 GRPO objective 为：

$$
L_{\mathrm{GRPO}}=
\frac{1}{G}\sum_{i=1}^{G}
\frac{1}{|o_i|}\sum_t
\min\left(
r_{i,t}\hat A_i,
\operatorname{clip}(r_{i,t},1-\epsilon,1+\epsilon)\hat A_i
\right)
-\beta D_{\mathrm{KL}}(\pi_\theta\|\pi_{\mathrm{ref}})
$$

不同代码库会改变 token/sequence 聚合方式、KL estimator、clipping 与 advantage 定义。最重要的是逐项对齐代码：**ratio 的分母是谁、advantage 在哪个粒度产生、长度怎样归一化、哪些 token 被 mask。**

## 一次 GRPO step 的完整数据流

1. **选择 prompt batch：** 任务与初始环境必须可复制；按 task_id 创建 group，而不是按自然语言字符串临时聚类。
2. **复制 G 份并独立采样：** 记录 rollout policy version、seed、sampling config；同组候选共享题目，不共享后续环境状态。
3. **运行完整 Agent loop：** 每条候选可包含多个模型调用和工具步骤；保存真实 token、action mask、observation 与终止原因。
4. **计算 raw verifier scores：** 区分成功、失败、invalid 与 infra error；保留 correctness、format、cost 等原始分量。
5. **按 group 估计 advantage：** 明确 mean/std/LOO、epsilon、advantage clip 与 zero-variance group 处理。
6. **把 trajectory advantage 映射到 action token：** 最简单是广播；若有 step reward，则需保存 call/turn 到 token 的严格映射。
7. **计算 ratio 与 policy loss：** 用 rollout logprob 作分母、当前 policy logprob 作分子，并应用 response/action mask。
8. **更新并发布新 policy version：** 检查 KL、clip fraction、group accuracy、长度和真实成功率后，才让 collector 使用新权重。

## 为什么“不需要 Critic”不等于“训练更简单”

GRPO 省掉了 value model 的参数、显存、forward/backward 和 value-target 调试，但把压力转移到 rollout：每个 prompt 需要多次生成与环境执行。

| 成本/问题 | PPO | GRPO |
|---|---|---|
| Baseline | learned value model | group mean / LOO 等统计 baseline |
| Advantage | GAE，可随 token/state 变化 | 常见形式在整条 response/trajectory 上共享 |
| 每题采样 | 不一定需要多候选 | 必须有 group 才能形成相对信号 |
| 训练显存 | policy + critic | 通常无需 critic |
| 环境成本 | 可较低 | group size 倍增 rollout 成本 |
| 稀疏奖励 | critic 可学习结构，但也很难 | 依赖组内至少出现不同结果 |
| 多轮 credit | 可用 value/GAE | 常把最终相对 reward 广播到多轮 action |

## Binary verifier 下最关键的概率

若单条 rollout 成功概率为 $p$，组大小为 $G$，整组全失败的概率是：

$$
P(\text{all fail})=(1-p)^G
$$

整组全成功：

$$
P(\text{all pass})=p^G
$$

能产生非零组内差异的概率为：

$$
1-p^G-(1-p)^G
$$

所以太难或太简单的 prompt 都低效。增大 $G$ 可以提高“至少看到一个成功与一个失败”的机会，但会线性增加 rollout 成本。这解释了为什么 curriculum、难度采样和动态筛选会成为 GRPO 系统的一部分。

## Zero-variance group 怎么处理

- **保留并置零：** 统计无偏但浪费生成预算；要监控其比例。
- **重新采样：** 可能得到差异，但改变数据选择分布并增加尾部延迟。
- **动态选题：** 偏向当前策略处于学习边界的 prompt，需防止遗忘简单题。
- **增加稠密分量：** 格式、过程或部分正确 reward 可增加差异，但也扩大 hacking 面。

DAPO 把动态采样、clip 设计、token-level loss 与超长序列处理等作为大规模 RL 稳定性的关键技术；当前 NeMo RL 实现也显式提供 non-zero standard deviation 的动态采样逻辑。[DAPO 论文](https://arxiv.org/abs/2503.14476) · [NeMo RL GRPO API](https://docs.nvidia.com/nemo/rl/latest/apidocs/nemo_rl/nemo_rl.algorithms.grpo.html)

## 长度归一化不是无关细节

假设 trajectory advantage $\hat A_i>0$ 被广播到每个 token。若直接对全部 token 求和，长回答获得更多梯度项；若先按每条序列长度平均，短长序列贡献更接近；若按整个 batch token 平均，又会产生另一种权重。

因此必须记录并消融：

- loss 是 token mean、sequence mean 还是 group mean；
- KL 是逐 token 相加还是平均；
- truncated/overlong 样本如何处理；
- final answer、reasoning 与 tool-call token 是否使用相同 mask/weight。

长度变化可能是能力变化，也可能只是 objective normalization 的直接结果。

## 多轮 Agent 中的三种 advantage 分配

### 方案 A：整条 episode 广播

同一个 $\hat A_i$ 分给该 trajectory 的所有 assistant token。实现最简单，但早期正确动作可能因后续错误一起受罚。

### 方案 B：按 call/turn 分解

为每次模型调用构造 step score 或 return，再映射到该调用的 action token。需要 verifier 能可靠判断中间状态。

### 方案 C：混合 outcome 与 process

最终成功作为主 reward，工具合法性、状态推进或安全 gate 提供有限辅助信号。所有分量必须分别保存，防止辅助 reward 压过任务目标。

> **注意：** 不要把 tool observation token 当成模型 action 参与 policy loss。环境返回可以改变后续状态与 advantage，但它的文本不是 policy 采样的结果。

## 最小伪代码

```python
for prompts in task_loader:
    groups = repeat_each(prompts, G)
    rollouts = agent_rollout(policy_old, groups)
    rewards = verifier(rollouts)

    advantages = group_normalize(
        rewards,
        key=rollouts.task_and_initial_state,
    )

    for _ in range(num_epochs):
        current_logp = policy.logprobs(rollouts)
        ratio = exp(current_logp - rollouts.old_logp)
        loss = clipped_policy_loss(
            ratio,
            broadcast_to_action_tokens(advantages),
            mask=rollouts.action_mask,
        )
        step(loss + reference_kl_penalty(policy, reference))

    publish_new_rollout_policy(policy)
```

## 训练时必须同时看的指标

- group pass-count histogram，而不只是 batch mean reward；
- zero-variance group rate 与重新采样开销；
- reward、advantage 的均值、标准差和极值；
- current/old logprob 差、approx KL 与 clip fraction；
- response/trajectory length、tool-call count、invalid rate；
- 每个难度、domain、tool family 的 held-out success；
- 单次成功消耗的生成 token、GPU 时间和环境时间。

## 三个教学实验

1. 在同一个可验证算术任务上取 $G=2,4,8$，测有效 group 比例与单位提升成本；
2. 固定 rollout 数据，对比 z-score、mean subtraction 与 leave-one-out advantage；
3. 固定总生成 token budget，对比 PPO 与 GRPO，而不是让 GRPO 无限制多采样。

> **学完判断：** 你应该能解释 GRPO 去掉了哪个模型、增加了哪一种采样成本；也能看到一个 reward 全为 0 的 batch 时，先检查 prompt 难度和 verifier，而不是立刻调 optimizer。
