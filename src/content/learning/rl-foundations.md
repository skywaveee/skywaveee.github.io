---
title: "RL 共同基础：把 Agent 轨迹变成可优化的策略"
short_title: "RL 共同基础"
description: "从状态、动作、回报和优势函数出发，用同一套符号理解 REINFORCE、PPO、GRPO、OPD 与多轮 Agent 训练。"
track: "Agent Learning"
kind: "基础推导 + Agent 映射"
order: 3
updated_at: "2026-09-09"
source_note: "教学主线参考 Sutton & Barto、Policy Gradient、GAE 与 PPO 原始工作；公式按 Agent/LLM 训练语境重新组织。"
---

# RL 共同基础：把 Agent 轨迹变成可优化的策略

PPO、GRPO 和 OPD 看起来是三套算法，其实都在回答同一个问题：模型已经采出一批 action token 之后，我们应该给每个 token 多大的学习方向，同时怎样避免一次更新把策略推得太远？先把这套共同语言学会，后续算法只是在替换 advantage 与约束方式。

## 先把传统 RL 翻译成 Agent 语言

Agent 往往不是完全可观测的 MDP，更接近 POMDP：仓库真实状态、用户真正意图和外部服务状态不一定全部出现在上下文里。训练时仍可把模型当前可见的信息记作 $s_t$，把它当作 policy 的条件。

| RL 对象 | Agent / LLM 中的对应物 | 容易犯的错误 |
|---|---|---|
| 状态 $s_t$ | 当前 system、messages、工具定义、observation、环境摘要 | 把磁盘上的整条 session 当成模型实际输入 |
| 动作 $a_t$ | 一个 token、一次 tool call，或一个 assistant turn | 在公式里按 token，落库时却只保存整段文本 |
| 策略 $\pi_\theta$ | 给定上下文后的下一个 token 分布 | 用模型名称代替具体 checkpoint/version |
| 转移 $P$ | 工具执行、环境变化、Harness 更新上下文 | 让模型虚构 tool result，跳过真实环境 |
| 奖励 $r_t$ | verifier、测试、judge 或 reward model 的信号 | 把训练 reward 当成真实能力本身 |
| episode $\tau$ | 从任务开始到成功、失败、超时或升级的完整执行 | 未闭合轨迹和成功轨迹混在一起 |

一条轨迹写成：

$$
\tau=(s_0,a_0,r_0,s_1,a_1,r_1,\ldots,s_T)
$$

在自回归模型里，若把每个生成 token 当成动作，则某一轮回答 $y=(y_1,\ldots,y_K)$ 的概率为：

$$
\pi_\theta(y\mid x)=\prod_{t=1}^{K}\pi_\theta(y_t\mid x,y_{<t})
$$

因此序列 log probability 是 token log probability 的和。后续所有 policy-gradient loss，最终都会落实到这些被采样 token 上。

## Return：最终得分怎样传回早期动作

从时刻 $t$ 开始的 discounted return 为：

$$
G_t=\sum_{k=t}^{T-1}\gamma^{k-t}r_k
$$

对许多代码或数学任务，只有 episode 结束时才有一次 $R\in\{0,1\}$。若 $\gamma=1$，每个生成 token 都会拿到同一个最终 return。这很简单，却没有回答“究竟是哪一步工具调用造成成功或失败”。这就是 credit assignment。

| 粒度 | 信号特点 |
|---|---|
| Token | 粒度细，但最终奖励常被广播到所有 action token |
| Turn | 可为不同模型调用分配不同信号 |
| Step | 工具选择、参数、观察消费可以分别评分 |
| Episode | 最终是否完成任务，最可靠但最稀疏 |

不要因为 token-level loss 就误以为拥有 token-level credit。**loss 的计算粒度** 和**监督信号真正包含的信息粒度** 是两回事。

## Policy Gradient：为什么是 log probability 乘 advantage

目标是最大化当前策略产生轨迹时的期望回报：

$$
J(\theta)=\mathbb E_{\tau\sim\pi_\theta}[R(\tau)]
$$

用 log-derivative trick，可以把对一个不可微采样过程的梯度写成：

$$
\nabla_\theta J(\theta)
=\mathbb E_{\tau\sim\pi_\theta}
\left[
\sum_t \nabla_\theta\log\pi_\theta(a_t\mid s_t)G_t
\right]
$$

直觉只有两句话：

- 如果某个已采样动作带来的回报高，就提高它在相同状态下的概率；
- 如果回报低，就降低它的概率。

REINFORCE 的最小版本就是采轨迹、计算 return，再优化 $-G_t\log\pi_\theta(a_t|s_t)$。它在期望上正确，但方差很大：同一个动作会被任务难度、后续动作和环境随机性共同影响。

## Baseline 与 Advantage：不是问“得几分”，而是问“比预期好多少”

从 return 中减去一个不依赖当前 action 的 baseline，不会改变期望 policy gradient，却能显著降低方差：

$$
\hat A_t=G_t-b(s_t)
$$

当 baseline 是 value function 时：

$$
V^\pi(s_t)=\mathbb E[G_t\mid s_t]
$$

$$
A^\pi(s_t,a_t)=Q^\pi(s_t,a_t)-V^\pi(s_t)
$$

Advantage 的问题不是“这条轨迹是否成功”，而是“在这个状态下，这个动作比当前策略通常会做的动作好多少”。这也是 PPO 与 GRPO 的核心分叉：

- PPO 训练 value model 来估计 baseline；
- GRPO 用同一 prompt 下其他采样结果形成 group baseline；
- OPD 可以用 teacher 与 student 的 log-prob gap 构造 token-level 信号。

## GAE：用一个参数控制偏差与方差

Temporal-difference residual：

$$
\delta_t=r_t+\gamma V(s_{t+1})-V(s_t)
$$

Generalized Advantage Estimation：

$$
\hat A_t^{\mathrm{GAE}(\gamma,\lambda)}
=\sum_{l=0}^{T-t-1}(\gamma\lambda)^l\delta_{t+l}
$$

$\lambda$ 越接近 1，越依赖长程真实回报，通常偏差更低、方差更高；越接近 0，越依赖一步 TD bootstrap，方差更低但更受 value 误差影响。GAE 原论文的主线正是通过 value function 与指数加权估计，在 policy-gradient 方差和偏差之间做可控交换。[GAE 原论文](https://arxiv.org/abs/1506.02438)

## On-policy、Off-policy 与 Importance Sampling

如果轨迹来自策略 $\mu$，但现在要更新 $\pi_\theta$，两者分布已经不同。最基本的 importance ratio 是：

$$
w_t(\theta)=\frac{\pi_\theta(a_t\mid s_t)}{\mu(a_t\mid s_t)}
$$

理论上它修正“数据由谁采样”的差异；实践中长序列上的比例可能爆炸或趋近于零。Agent 训练尤其容易出现这种问题，因为一次 rollout 很慢，trainer 更新若干步后才收到旧轨迹。

- **真正 on-policy：** 采样后立即用同一策略做一次更新，策略版本严格一致。
- **PPO 式近似：** 固定一批 old-policy 数据，在有限 epoch 内重复更新并约束 ratio。
- **异步 rollout：** collector 和 trainer 并行，必须记录 policy version 与 trajectory age。
- **离线数据：** 行为策略可能未知，不能仅凭文本重建可靠 importance ratio。

所以每条训练轨迹至少需要 `rollout_policy_version`；只保存模型名字或最终文本，不足以判断它对当前策略有多旧。

## KL 与 Entropy：两个经常被混淆的约束

策略更新常加入 reference-policy KL：

$$
D_{\mathrm{KL}}\left(\pi_\theta(\cdot|s)\,\|\,\pi_{\mathrm{ref}}(\cdot|s)\right)
$$

它限制模型偏离一个参考策略，常用于保留语言质量或防止 reward 诱导出极端分布。Entropy 则衡量当前策略自身有多分散：

$$
H(\pi_\theta)=-\sum_a\pi_\theta(a|s)\log\pi_\theta(a|s)
$$

KL 不是 entropy；PPO clip 也不是 KL。三者可能同时存在：clip 限制本轮相对 old policy 的更新，reference KL 限制长期漂移，entropy bonus 鼓励探索。

## Agent 训练中的 mask

一条多轮轨迹含 system、user、assistant、tool 与 environment event。不是每个 token 都是 policy 采取的动作：

| Token 区段 | 来源 | Action mask |
|---|---|---:|
| system / tools | condition | 0 |
| user | condition | 0 |
| assistant action | sampled | 1 |
| tool result | environment | 0 |
| assistant answer | sampled | 1 |

如果 tool result 被错误设成 mask 1，trainer 会试图提高环境文本的概率；如果 tool-call JSON 没有被覆盖，模型就学不到动作协议。mask 应从 rollout 时的 token 边界产生，而不是训练前靠字符串查找猜出来。

## 一个两步 Agent 的手算例子

任务是查库存后下单。策略采出：

1. `lookup_inventory(item=A)`，环境返回库存 3；
2. `place_order(item=A, count=2)`，最终 verifier 给 $R=1$。

如果 baseline 预测该任务成功率为 $0.6$，最简单的 episode-level advantage 是：

$$
\hat A=1-0.6=0.4
$$

两个 action turn 的 sampled token 都被赋予正方向。如果第二步参数写错导致 $R=0$，则 $\hat A=-0.6$，两步都被压低——即使第一步其实完全正确。这说明：增加 process verifier 或 step-level credit 不是为了让公式更漂亮，而是为了减少错误归因。

## 一次最小实验应该记录什么

```text
task_id / rollout_id / attempt_id
policy_version / tokenizer_version / template_hash
每次调用的 input_ids / output_ids / action_mask
rollout logprobs（算法需要时）
raw verifier outputs / transformed reward
return / baseline / advantage
episode status / latency / token count / tool count
```

> **学完这一页的判断标准：** 你应该能拿任意一个训练 batch，逐字段说明它来自哪一步采样、哪一个环境事实、哪一种 reward 变换，以及最终是哪几个 token 获得了什么方向的梯度。

## 下一步

沿着同一套符号继续读 [PPO](/learning/ppo/)：它用 value model + GAE 估计 advantage，再用 clipped probability ratio 限制一批 rollout 上的重复更新。
