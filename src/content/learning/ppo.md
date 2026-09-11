---
title: "PPO：从 Policy Gradient 到可控策略更新"
short_title: "PPO"
description: "逐式理解 old-policy ratio、clipped surrogate objective、critic、GAE、KL 与 Agent/LLM PPO 训练循环。"
track: "Agent Learning"
kind: "算法推导 + 训练诊断"
order: 4
updated_at: "2026-09-09"
source_note: "核心公式依据 Schulman 等人的 PPO 与 GAE 原论文；LLM/Agent 映射为本站教学整理。"
---

# PPO：从 Policy Gradient 到可控策略更新

PPO 的价值不只是“某个经典 RL 算法”。它提供了一套阅读现代 LLM RL 的坐标系：rollout policy 是谁、advantage 从哪里来、一批样本能重复训练几次、策略偏移怎样监控。GRPO、DAPO 和不少 Agent RL 系统都在复用或改造这些部件。

## PPO 想解决的核心矛盾

普通 policy gradient 拿一批样本做一步更新最干净，但生成长文本和运行工具环境非常昂贵；如果对同一批轨迹做很多步更新，当前策略又会迅速离开生成这些数据的 old policy，梯度估计随之失真。

PPO 在两者之间取一个工程上稳定的折中：

1. 用 $\pi_{\theta_{\mathrm{old}}}$ 采一批 rollout；
2. 计算 return 与 advantage；
3. 固定这批数据，进行若干 minibatch epoch；
4. 用 probability ratio 和 clipping 限制更新幅度；
5. 更新 old policy，再采下一批数据。

PPO 原论文把它描述为交替执行环境采样与 surrogate objective 优化，并允许对同一批数据进行多轮 minibatch 更新。[PPO 原论文](https://arxiv.org/abs/1707.06347)

## 第一个部件：Old-policy probability ratio

对 old policy 采到的动作 $a_t$：

$$
r_t(\theta)=
\frac{\pi_\theta(a_t\mid s_t)}
{\pi_{\theta_{\mathrm{old}}}(a_t\mid s_t)}
=\exp\left(\log\pi_\theta-\log\pi_{\mathrm{old}}\right)
$$

- $r_t=1$：当前策略对这个动作的概率与采样时相同；
- $r_t>1$：当前策略更偏好这个动作；
- $r_t<1$：当前策略降低了这个动作的概率。

在 LLM 中通常按 sampled token 计算 ratio。不能只保存整条回答的平均 logprob，否则无法精确构造 token mask、clip fraction 与长度归一化。

## 第二个部件：Clipped surrogate objective

$$
L^{\mathrm{CLIP}}(\theta)=
\mathbb E_t\left[
\min\left(
r_t(\theta)\hat A_t,
\operatorname{clip}(r_t(\theta),1-\epsilon,1+\epsilon)\hat A_t
\right)
\right]
$$

这条公式要分 advantage 的符号来读：

| 情况 | 希望发生什么 | clip 阻止什么 |
|---|---|---|
| $\hat A_t>0$ | 提高该动作概率 | 概率一次提高得过多 |
| $\hat A_t<0$ | 降低该动作概率 | 概率一次降低得过多 |

`min` 与 `clip` 合在一起形成悲观下界：当更新已经朝“有利方向”走得超过区间时，不再从这个 token 获得额外收益。它不是把参数限制在某个半径内，也不能保证真实 KL 一定小，所以仍要显式监控 policy KL。

> **常见误解：** `ratio` 是当前 policy 相对 rollout/old policy 的比值；reference policy KL 中的 `reference` 通常是训练初始模型或 SFT 模型。old policy 与 reference policy 可以是两个不同角色。

## 第三个部件：Critic 与 GAE

PPO 通常是 actor–critic：actor 是要优化的语言模型，critic 估计当前状态的 value。TD residual：

$$
\delta_t=r_t+\gamma V_\phi(s_{t+1})-V_\phi(s_t)
$$

GAE advantage：

$$
\hat A_t=\sum_{l=0}^{T-t-1}(\gamma\lambda)^l\delta_{t+l}
$$

value target 可由 return 或 GAE 对应的 bootstrapped return 构造。critic 的目标不是预测模型回答“好不好看”，而是在当前状态下预测未来累计 reward。当前 NeMo RL 的 PPO 文档也把 PPO 与 GRPO 的主要差异概括为：PPO 训练 critic 并使用 GAE，GRPO 则采用 group baseline 而不训练 value model。[NeMo RL PPO](https://docs.nvidia.com/nemo/rl/nightly/about/algorithms/ppo.html)

## LLM PPO 的总目标

一个常见组合可以概念化为：

$$
\mathcal L
=-L^{\mathrm{CLIP}}
+c_v\mathcal L_{\mathrm{value}}
-c_e H(\pi_\theta)
+\beta D_{\mathrm{KL}}(\pi_\theta\|\pi_{\mathrm{ref}})
$$

不同实现会把 reference KL 作为 reward shaping、显式 loss 或近似 estimator；符号与缩放方式必须以具体代码为准，不能只看配置键名。

| 角色 | 作用 |
|---|---|
| Actor | 提高正 advantage 动作、压低负 advantage 动作 |
| Critic | 预测未来 return，为 policy 提供低方差 baseline |
| Old policy | 定义采样分布和 importance ratio 分母 |
| Reference | 限制长期漂移，通常固定或缓慢更新 |

## 从 rollout 到一次 PPO update

1. **冻结 rollout policy version：** 为本轮采样绑定 checkpoint、tokenizer、template 与 decoding 参数；异步系统还要记录每条轨迹的实际版本。
2. **运行 Agent 环境：** 保存每次模型调用的 input/output token、old logprob、action mask、工具与终止原因。
3. **执行 verifier / reward model：** 先保存原始评分，再执行组合、KL shaping、裁剪或标准化；不要只保留最终 reward。
4. **Critic forward：** 对有效状态/token 计算 value；环境 token 不应被误作 policy action。
5. **计算 return 与 GAE：** 明确 episode terminal、timeout 与 truncated 的 bootstrap 语义；不同语义会改变最后一步 value target。
6. **多轮 minibatch update：** 重算 current logprob，构造 ratio、clipped policy loss、value loss、entropy/KL，并按 mask 聚合。
7. **检查漂移与退化：** 同时看 reward、KL、ratio、clip fraction、entropy、value error、长度和真实环境成功率。
8. **发布下一版 rollout policy：** 权重同步成功后再标记新版本可采样；正在运行的轨迹保持原始 policy identity。

## Token、Turn 与 Episode 怎样分配 advantage

单轮 RLHF 常把 response 视为一个序列，终局 reward 经 GAE 或广播作用于全部 response token。多轮 Agent 还必须决定：

- 每次 assistant call 是否独立构造 value 序列；
- tool observation 位置是否参与 critic bootstrap；
- 一个 episode reward 是广播给所有 call，还是经 step reward 分解；
- timeout 是 terminal failure，还是因基础设施中断而应丢弃；
- compaction 后的下一轮输入能否与 rollout token 精确重建。

PPO 公式不会替系统回答这些问题。若轨迹语义错了，优化器只会更稳定地学习错误目标。

## 训练日志应该如何诊断

| 指标 | 正常时告诉你什么 | 异常时先查什么 |
|---|---|---|
| environment success | 真实任务是否改善 | train/eval 环境是否一致、是否数据泄漏 |
| raw reward | scorer 输出是否变化 | reward 分量、长度和格式偏置 |
| policy KL | 与 reference 偏离多少 | $\beta$、学习率、reward scale |
| approx KL | 相对 old policy 的更新幅度 | epoch 数、batch size、ratio 实现 |
| clip fraction | 多少 token 碰到 clip 区域 | 更新是否过猛，或 old logprob 是否错位 |
| entropy | 策略分布是否塌缩 | 过强 reward、低温 rollout、KL/entropy 系数 |
| value loss / explained variance | critic 是否能预测 return | terminal mask、reward scale、value warmup |
| response length | 是否靠变长/变短拿分 | token 聚合、长度归一化与 verifier 偏差 |
| invalid tool-call rate | 协议能力是否退化 | action mask、chat template、格式 reward |

单看 reward 上升不能证明训练成功。若 reward 上升同时真实 pass rate 不变、长度暴涨或工具调用退化，模型可能只学会了 scorer 的代理特征。

## PPO 在 Agentic RL 中为什么更难

- **轨迹更长：** importance ratio 与 credit assignment 的误差会沿 token 和 turn 累积。
- **环境更慢：** 采样成本高，异步 collector 更容易产生 stale rollout。
- **状态会重建：** 工具、parser、compaction 使下一轮输入不一定是前缀追加。
- **奖励更复杂：** 测试、artifact、成本、安全与 judge 可能互相冲突。

这也是后续算法常去掉 critic、改写 advantage、动态筛 prompt 或采用异步校正的原因。它们不是让 RL 基础失效，而是在应对 PPO 系统中暴露出的具体瓶颈。

## 最小教学实现

```python
for batch in task_loader:
    rollouts = collect(policy_old, batch)
    raw_scores = verifier(rollouts)
    rewards = transform(raw_scores, reference_kl=reference)

    old_logp = rollouts.sampled_token_logprobs
    values = critic(rollouts.states)
    advantages, returns = compute_gae(rewards, values, terminals)

    for _ in range(num_epochs):
        logp = policy.logprobs(rollouts)
        ratio = exp(logp - old_logp)
        policy_loss = -masked_mean(
            min(ratio * advantages,
                clip(ratio, 1 - eps, 1 + eps) * advantages)
        )
        value_loss = masked_mse(critic(rollouts.states), returns)
        step(policy_loss + value_coef * value_loss)

    policy_old.load(policy)
```

这段伪代码故意省略了 distributed、packing 和 microbatch，但没有省略语义边界：数据由谁采、old logprob 来自谁、terminal 如何定义、哪些 token 被 mask。

## 建议做的三个消融

1. 固定 rollout，比较 `num_epochs=1/2/4`，观察 reward、KL 与 clip fraction；
2. 固定 policy，改变 reward scale，观察 critic loss 和 advantage 分布；
3. 固定任务与 token budget，对比 PPO 与 [GRPO](/learning/grpo/) 的显存、吞吐和真实成功率。

> **学完判断：** 看到一份 PPO 配置时，你应该能指出 actor、critic、old policy、reference policy 分别在哪里；并能从日志区分“reward 设计失败”“critic 没学好”“policy 更新过猛”和“rollout 已经过旧”。
