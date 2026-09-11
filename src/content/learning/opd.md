---
title: "OPD：让学生在自己的轨迹上接受教师反馈"
short_title: "OPD"
description: "从知识蒸馏、Forward/Reverse KL 与 exposure bias 出发，理解 GKD、full-logit OPD、sampled-token OPD/MOPD 和多轮 Agent 蒸馏。"
track: "Agent Learning"
kind: "教师-学生学习 + 在线轨迹"
order: 7
updated_at: "2026-09-09"
source_note: "OPD 在不同系统中的具体 objective 并不唯一；本页明确区分 GKD/full-logit 路线与 sampled-token policy-gradient 路线。"
---

# OPD：让学生在自己的轨迹上接受教师反馈

On-Policy Distillation 的关键不是“请教师批量生成答案，再拿去做 SFT”。学生先按照自己的当前策略生成轨迹，教师再对学生真正走到的上下文给反馈。训练分布会随着学生变化，因此它既像知识蒸馏，也像有专家可查询的在线模仿学习。

## 为什么固定教师数据还不够

离线 SFT 或 sequence-level distillation 的训练前缀主要来自专家正确轨迹。部署时，student 必须继续处理自己已经生成的 token、工具调用和错误 observation。只要早期有一点偏差，后续状态分布就可能离开训练数据。

把教师数据分布记为 $d_T(s)$，学生部署时的状态分布记为 $d_S(s)$。离线训练优化的是：

$$
\mathbb E_{s\sim d_T}\left[\mathcal L(\pi_S,\pi_T;s)\right]
$$

而真正部署关心：

$$
\mathbb E_{s\sim d_S}\left[\mathcal L(\pi_S,\pi_T;s)\right]
$$

两者的差异就是 exposure/distribution mismatch。OPD 通过学生 rollout 让训练上下文逐渐靠近 $d_S$。

## 先分清四种教师-学生数据流

| 方法 | 谁产生训练序列 | 教师提供什么 | 学生在哪里学习 |
|---|---|---|---|
| SFT | 人类/教师离线示范 | 目标 token | 专家前缀 |
| Offline KD | 固定数据或教师序列 | token distribution/logits | 固定前缀 |
| Sequence distillation | 教师 | sampled final sequence | 教师前缀 |
| On-policy distillation | 学生当前策略 | logits、distribution 或 sampled-token score | 学生自己的前缀/轨迹 |

因此 OPD 的 on-policy 描述的是**训练状态由学生采样**，不必然意味着它使用传统 scalar reward，也不意味着每个实现都采用 PPO clipping。

## Knowledge Distillation 的基本目标

给定同一个上下文 $s_t$，教师和学生分别给出下一个 token 分布 $p_T(\cdot|s_t)$ 与 $p_S(\cdot|s_t)$。

### Forward KL

$$
D_{\mathrm{KL}}(p_T\|p_S)
=\sum_a p_T(a|s)
\log\frac{p_T(a|s)}{p_S(a|s)}
$$

它按教师概率覆盖教师支持的模式，通常被称为更偏 mean-seeking；需要教师完整或截断后的 vocabulary distribution。

### Reverse KL

$$
D_{\mathrm{KL}}(p_S\|p_T)
=\sum_a p_S(a|s)
\log\frac{p_S(a|s)}{p_T(a|s)}
$$

它更强地惩罚学生把概率放在教师认为很差的区域，通常更偏 mode-seeking。对表达能力小得多的 student，集中学习教师的高质量模式有时更现实，但也可能牺牲覆盖与多样性。

### JSD 与 generalized divergence

不同方向的 KL 对容量受限 student 的行为不同。GKD 把 student-generated sequences 与多种 divergence 放在统一框架中，并报告 on-policy/mixed 数据与 reverse-KL/JSD 选择的重要性。[GKD / On-Policy Distillation 原论文](https://arxiv.org/abs/2306.13649)

> **注意：** “Forward KL 一定好”或“Reverse KL 一定好”都不是结论。必须同时固定 student 容量、temperature、数据混合比例和任务，再比较准确率、覆盖、多样性与校准。

## GKD：把 on-policy 比例显式化

GKD 可以混合固定数据与 student-generated 数据。若 $\lambda\in[0,1]$ 表示学生数据比例，可概念化写作：

$$
\mathcal L_{\mathrm{GKD}}
=(1-\lambda)
\mathbb E_{y\sim p_{\mathrm{data}}}
\left[D(p_T,p_S)\right]
+\lambda
\mathbb E_{y\sim p_S}
\left[D(p_T,p_S)\right]
$$

- $\lambda=0$：完全固定前缀上的 supervised/offline KD；
- $0<\lambda<1$：保留稳定专家数据，同时覆盖学生错误状态；
- $\lambda=1$：完全 on-policy student rollout。

学生 sampling 过程通常 stop-gradient；梯度来自采样到的上下文上教师与学生分布的差异，而不是穿过离散采样本身反传。

## 两条常见 OPD 实现路线

### 路线 A：Full-logit distillation

```text
student rollout
    ↓
重放每个 student prefix 给 teacher
    ↓
teacher full-vocabulary logits
    ↓
Forward KL / Reverse KL / JSD
    ↓
student backward
```

优点是获得每个 token 位置的稠密分布信息；代价是 teacher 需要返回大词表 logits，通信和显存压力高，teacher/student tokenizer 不同则更复杂。

当前 NeMo RL 的基础 On-policy Distillation 路径允许学生先生成样本，再做 teacher-logit distillation；其 NeMo Gym 路径可以采集多步/多轮 student rollout。[NeMo RL On-policy Distillation](https://docs.nvidia.com/nemo/rl/latest/about/algorithms/on-policy-distillation.html)

### 路线 B：Sampled-token teacher gap

学生已经采出 token $a_t\sim\pi_S$，只查询教师对这个 token 的 log probability：

$$
\hat A_t^{\mathrm{OPD}}
=\operatorname{sg}\left[
\log\pi_T(a_t|s_t)-\log\pi_S(a_t|s_t)
\right]
$$

- gap 为正：教师比学生更认可该 sampled token，应提高其概率；
- gap 为负：学生过度偏好教师不认可的 token，应降低其概率。

这不需要传输教师完整 vocabulary logits，可以把 gap 当作 token-level advantage 接入 policy-gradient trainer。NeMo RL 的 MOPD 文档明确区分这条运行在 async GRPO trainer 上的 sampled-token 路线与基础 teacher-logit distillation，并将工具/环境 token mask 为零。[NeMo RL MOPD](https://docs.nvidia.com/nemo/rl/nightly/about/algorithms/mopd.html)

## OPD、GRPO 与 PPO 的信号差异

| 方法 | 信号路径 |
|---|---|
| PPO | reward → critic/GAE → token advantage |
| GRPO | group rewards → relative trajectory advantage |
| OPD | teacher/student distribution gap → dense token signal |
| Hybrid | teacher guidance 与 environment reward 可以组合 |

OPD 不要求先把教师判断压缩成一个最终标量，因此信号更稠密；但它主要把学生推向 teacher，而不是自动超越 teacher。若环境 verifier 表示真实目标，RL 可以直接优化它；若 teacher 只是一种近似专家，两种信号可以混合，但要分别记录。

## 一次 Agentic OPD 的完整循环

1. **冻结 student rollout version：** 记录 student checkpoint、tokenizer、template、工具协议与 sampling config。
2. **让 student 运行 Agent loop：** 不是让 teacher 代跑；学生自己选择工具、消费 observation、犯错并尝试恢复。
3. **保存真实调用 token：** 每轮记录 input_ids、sampled output_ids、student logprob 与 action mask，避免事后重编码漂移。
4. **教师重放 student context：** 教师看到与学生决策时语义一致的上下文；若模板或 tokenizer 不同，必须定义对齐与投影。
5. **生成 teacher signal：** 选择 full logits/divergence，或 sampled-token teacher logprob；原始信号与 teacher version 一起保存。
6. **应用 loss mask：** 只训练 student 采出的 assistant action；system、user、tool result 与私有 verifier 信息不产生 policy loss。
7. **更新 student：** 监控 distillation loss、student-teacher KL、entropy、行为成功率与 teacher query 成本。
8. **用新 student 重新采样：** 这是 on-policy 的关键；若长期复用旧 student 轨迹，训练会逐渐退化为 off-policy distillation。

## 多轮 Agent 中教师到底评价什么

### Token distribution

教师在学生真实前缀上为每个 assistant token 提供概率。信号最密，但教师可能只是在文本层偏好另一种表达，并不理解工具是否真的改变了环境。

### Action choice

只蒸馏 tool name、arguments、stop/continue 等结构化动作。可以减少自然语言风格迁移，更聚焦 policy。

### Teacher rerun / correction

让教师看到当前状态后生成下一步正确动作，再做 imitation。它更像 DAgger 式专家查询，但需要明确：student 原动作是负样本、teacher 动作是新 target，还是两者共同进入 preference 数据。

### Environment + teacher hybrid

环境 verifier 决定结果正确性，teacher gap 提供局部方向。二者可能冲突：teacher 偏好常规步骤，但 student 找到一个同样有效的新策略。必须保留分量并做冲突统计。

## Cross-tokenizer 是独立工程问题

teacher 与 student 若使用不同 tokenizer，不能直接比较同一位置的 vocabulary logits，因为：

- token 边界不同；
- vocabulary id 不同；
- chat template 和特殊 token 不同；
- 同一字符串重编码后的 prefix 长度不同。

可选路径包括：使用同 tokenizer 教师、比较字符/字节对齐后的分布、建立 token projection、只用 sequence/action 级监督，或让教师输出结构化 correction。任何投影都会引入新的近似，必须独立验证。

## OPD 的主要失败模式

- **Teacher ceiling：** 学生被稳定拉向教师错误，环境真实指标不再提升。
- **Teacher overconfidence：** 分布过尖，student entropy 快速塌缩。
- **Stale student data：** 旧轨迹比例太高，所谓 on-policy 已经名不副实。
- **Context mismatch：** 教师评分的序列与学生实际决策上下文不一致。
- **Tokenizer mismatch：** 位置或词表被错误对齐，KL 数值有意义但语义错误。
- **Style domination：** teacher 的措辞偏好压过工具成功与任务效率。
- **Teacher leakage：** teacher 看到了 student 部署时不会拥有的私有事实或 solution。
- **Query bottleneck：** teacher forward、logits 传输与多轮重放吞掉主要算力。

## OPD 需要看的指标

- student 与 teacher 的 sampled-token logprob gap 分布；
- forward/reverse KL 或 chosen divergence，按 token 类型分层；
- teacher query tokens、延迟、吞吐与缓存命中；
- student rollout 的任务成功率、工具合法率和恢复率；
- on-policy trajectory age 与 student version 分布；
- teacher 与 environment reward 的一致/冲突矩阵；
- entropy、输出长度、工具次数和行为多样性；
- teacher 不可见 holdout 上的迁移能力。

## 最值得做的对照实验

固定 prompt、student 初始权重、teacher 和总训练 token 预算，对比：

1. 教师生成数据的 SFT；
2. 固定 student 初始轨迹上的 offline KD；
3. 每轮刷新 student 轨迹的 full-logit OPD；
4. sampled-token gap OPD；
5. GRPO/RLVR；
6. OPD + environment reward hybrid。

不能只对齐 optimizer step；还要报告 student rollout token、teacher scoring token、环境执行次数与总 GPU 时间。

> **学完判断：** 听到“我们做 OPD”时，你应该立刻追问：轨迹由谁生成、多久刷新、teacher 返回 full logits 还是 sampled-token score、优化哪种 divergence、teacher 与 student 的上下文/分词是否严格对齐，以及环境真 reward 是否仍独立评测。
