---
title: "Agent 训练系统：Rollout、环境、Trainer 与权重同步"
short_title: "训练系统"
description: "把算法公式落到可运行系统：任务、环境、采样、评分、训练、存储与异步权重同步分别负责什么。"
track: "Agent Learning"
kind: "系统架构 + 可复现协议"
order: 9
updated_at: "2026-09-09"
source_note: "本页是系统教学模型；具体框架能力必须以对应版本的代码、配置和运行证据为准。"
---

# Agent 训练系统：Rollout、环境、Trainer 与权重同步

算法公式只定义“拿到一批正确轨迹以后怎样更新参数”。真正的 Agent RL 还要保证：任务初态可复制、模型调用可追踪、工具在隔离环境执行、评分能重算、旧策略概率没有错位、新权重不会污染正在运行的 episode。系统边界错一处，loss 仍可能正常下降。

## 六个平面，不要揉成一个脚本

| 系统层 | 内容 |
|---|---|
| Task | 题面、初态、任务 taxonomy、能力覆盖与 split |
| Rollout | policy 推理、Agent loop 与调用记录 |
| Environment | 工具、状态转移、沙箱和 artifact |
| Learning | verifier、advantage、trainer 与 checkpoint |

更完整的系统可以拆成：

| 平面 | 核心职责 | 不应该偷偷承担的职责 |
|---|---|---|
| Task/Data | 提供任务、初态、工具契约、split 与 provenance | 在运行中根据模型结果修改 holdout |
| Rollout/Serving | 根据指定 policy version 生成真实 token | 凭文本事后猜 old logprob |
| Harness/Agent | 维护多轮 loop、工具协议、compaction 与终止 | 把一次 SDK 请求冒充完整 Agent loop |
| Environment | 执行动作、返回 observation、保存状态与 artifact | 暴露宿主、私有测试或 solution |
| Verifier/Reward | 重放与评分、保存证据、构造 reward 分量 | 修改模型输出或训练权重 |
| Trainer | 计算 advantage/loss、更新参数、产出 checkpoint | 改写正在消费的 rollout 正本 |
| Store/Registry | 保存不可变版本、关系与运行状态 | 用一个可覆盖目录表示所有实验 |

## 一条 episode 的端到端生命周期

1. **解析 task release：** 绑定 task_id、dataset release、environment snapshot、公开/私有资源边界和 verifier version。
2. **分配 run / rollout / attempt：** run 是一次实验；rollout 是某题一次策略执行；attempt 是重试。三者不能复用同一个 ID。
3. **固定 rollout policy：** collector 获得明确 checkpoint hash、tokenizer、chat template、adapter 与 sampling config。
4. **启动隔离环境：** 从确定性初态创建容器/沙箱；只挂载该任务需要的工作区和公开资源。
5. **运行多轮 Agent loop：** Harness 维护状态，serving 返回真实 input/output token，environment 执行 tool call 并返回 observation。
6. **闭合并冻结轨迹：** 成功、失败、拒绝、超时、invalid 与 infra error 都有明确终止语义；原始 events 不再覆盖。
7. **Verifier 重放：** 在隔离评分环境读取 artifact 与私有用例，输出原始指标、证据和版本化判定。
8. **组装训练 batch：** 按算法构造 group、reward、advantage、old logprob 与 masks，保留到正本记录的引用。
9. **Trainer 更新：** 执行 SFT/PPO/GRPO/OPD loss，记录 optimizer state、数据清单、统计与失败。
10. **发布新 checkpoint：** 写入不可变版本，完成兼容性和最小评测后才交给新 collector；运行中的 rollout 不换 policy。

## 统一轨迹协议要保存关系，而不是只保存文本

一个教学版 event schema：

```json
{
  "schema": "agent-trace/1",
  "run_id": "run_...",
  "rollout_id": "rollout_...",
  "attempt_id": "attempt_...",
  "task": {"id": "task_...", "release": "sha256:..."},
  "policy": {
    "checkpoint": "sha256:...",
    "tokenizer": "revision-or-hash",
    "template": "sha256:...",
    "sampling": {"temperature": 0.8}
  },
  "calls": [{
    "call_index": 0,
    "input_ids_ref": "blob:...",
    "output_ids_ref": "blob:...",
    "rollout_logprobs_ref": "blob:...",
    "action_mask_ref": "blob:...",
    "tool_calls": [],
    "observations": []
  }],
  "termination": {"status": "success", "reason": "..."},
  "artifact": {"snapshot": "sha256:..."},
  "scores": []
}
```

大 tensor 可以存在 blob/array store，但事件记录必须引用其 hash、shape、dtype 与 token 区间。否则“有个文件路径”并不能证明 trainer 读取的是哪份数据。

## 同步训练循环

最容易推理的系统是 barrier-based synchronous loop：

```text
policy v12
   ↓ collect all rollouts
rollout batch v12
   ↓ score + train
policy v13
   ↓ collect next batch
```

优点是 policy identity 清晰，轨迹 age 接近 0；缺点是最慢环境决定整轮时间，GPU 可能等待工具与 verifier。教学和首次正确性验证应优先从同步循环开始。

## 异步训练循环

异步系统让 collector、environment、verifier 与 trainer 并行：

```text
collectors(v12, v13, ...)
          ↓
     rollout queue
          ↓
 trainer(current v15)
          ↓
 checkpoint registry
```

吞吐更高，却引入 off-policy drift：训练 v15 时可能收到 v12 的轨迹。当前 NeMo RL 将异步 rollout、replay buffer、multi-turn 环境和快速 generation 作为独立系统能力列出，说明这些不是 GRPO 一个公式能自动解决的问题。[NeMo RL Features](https://docs.nvidia.com/nemo/rl/latest/about/features.html)

异步系统至少需要：

- `policy_version_at_generation`；
- `trajectory_age_steps`；
- old/rollout logprobs；
- 队列优先级与最大 age；
- 超龄轨迹丢弃或 importance correction 规则；
- 权重更新时 KV cache 的一致性策略；
- in-flight episode 是否允许跨版本继续。

## 权重同步：不是简单复制一个目录

训练权重到 rollout engine 之间可能经历：

1. optimizer/sharded checkpoint 保存；
2. 合并或格式转换；
3. 分发到 inference workers；
4. vLLM/serving refit；
5. cache 失效或重建；
6. readiness check；
7. registry 将版本标记为可采样。

必须区分：

- `created`：trainer 已写出；
- `validated`：checkpoint 可完整加载；
- `serving-ready`：全部目标 worker 已切换；
- `active`：新 rollout 被允许引用；
- `retired`：不再创建新 rollout，但历史仍可重放。

如果部分 worker 已更新、部分没有，同一 group 可能由不同 policy 采样。除非算法明确允许并记录，否则这会破坏 group-relative 假设。

## 资源所有权

- **GPU owner：** 明确每张 GPU 属于 trainer、rollout、teacher、reference 或 reward model。
- **Environment owner：** 每个 job 只能停止自己创建的容器、服务和精确 PID。
- **File owner：** 运行读取不可变 snapshot，输出写独立 run directory，不覆盖其他实验。
- **Port owner：** 服务注册端口和健康状态，不通过扫描随机猜测。

并行实验最危险的不是 GPU 不够，而是共享可变状态：同一输出目录、同一环境数据库、同一 checkpoint symlink、同一缓存键或同一服务名。

## Retry、Resume 与 Idempotency

### Retry

一次工具/API/环境操作失败后重新尝试。必须新建 `attempt_id`，保留前一次失败；不能把第二次成功覆盖成“第一次就成功”。

### Resume

从 checkpoint 和运行清单继续一个中断实验。必须验证 code snapshot、dataset、optimizer、scheduler、RNG 与已消费样本位置兼容。

### Replay

用冻结 policy、环境和输入重新执行，用来调查不确定性。Replay 是新 rollout，不应复用原 rollout ID。

### Idempotency

同一个明确操作重复执行不会产生重复副作用。例如 `place_order` 的重试需要 idempotency key；否则网络超时后再次调用可能下两次单。

## 故障分类决定数据能否训练

| 状态 | 含义 | 是否作为负 reward |
|---|---|---|
| success | 任务达成 | 是，正向样本 |
| model_failure | policy 做错或放弃 | 可以，保留证据 |
| invalid_action | 模型违反协议/schema | 可以，通常单列 |
| environment_rejection | 合法动作被业务规则拒绝 | 取决于任务目标 |
| timeout_budget | 模型用尽明确任务预算 | 通常可以 |
| infra_error | GPU、网络、挂载、scorer 自身故障 | 通常不应直接训练 |
| cancelled | 外部主动取消 | 不应伪装为模型失败 |

错误分类比“自动重试三次”更重要。只要 infra failure 被混入 reward，策略就会学习与自身行为无关的噪声。

## 最小可观测指标

### 语义正确性

- closed rollout ratio；
- orphan tool-call/result 数；
- token reconstruction checksum mismatch；
- policy-version mismatch；
- verifier replay disagreement。

### 学习健康度

- reward / advantage / KL / entropy；
- zero-variance group rate；
- invalid action 和 tool-loop rate；
- trajectory age 与 importance ratio 分布。

### 系统效率

- rollout tokens/s；
- environment step latency；
- verifier latency；
- trainer utilization；
- queue wait、weight-refit bubble、straggler time；
- success per GPU-hour / per million generated tokens。

## 安全边界

> **注意：** 模型生成代码只应在受限环境运行：不挂 Docker socket、宿主家目录、模型/密钥根目录；私有测试和 solutions 不进入模型上下文；不提供宿主执行回退；不同用户、job 与 release 的资源彼此隔离。

安全不是训练完成后再补的外围功能。只要 Agent 能从宿主读取答案、修改 scorer 或污染下一条任务，它就改变了数据分布和 reward 的含义。

## 一个最小可复现教学系统

先不要从多节点异步系统开始。建议依次实现：

1. 一个确定性算术/小代码任务环境；
2. 一个同步 rollout worker；
3. 每次调用保存真实 token 与 logprob；
4. 一个独立、可重放 verifier；
5. 一个单机 GRPO 或 OPD trainer；
6. 不可变 run manifest 与 checkpoint；
7. 能从任意 reward 回溯到 task、trajectory、artifact 和 scorer evidence 的 viewer。

确认端到端语义后，再拆分 serving/training、加入多 GPU、异步队列与多教师。

## 与现有两类页面怎样连接

- [Agentic SFT](/learning/agentic-sft/) 负责定义可审计的示范轨迹和训练视图；
- [Agentic RL](/learning/agentic-rl/) 负责解释每次模型调用的 token 边界与多轮上下文重建；
- 本页把这些记录放进可重复运行的 job、环境、评分和权重生命周期；
- [评测与失效分析](/learning/evaluation/) 再判断能力是否真的泛化，而不是只在训练 reward 上变好。

> **学完判断：** 你应该能画出任意一次训练 run 的 task、policy、rollout、environment、verifier、batch 与 checkpoint 关系，并能在某条曲线异常时定位该找哪个不可变证据，而不是只翻 trainer 日志。
