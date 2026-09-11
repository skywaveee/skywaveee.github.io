---
title: "Agentic SFT：数据、训练与评测的完整链路"
short_title: "Agentic SFT"
description: "从能力定义、示范轨迹生产与数据治理，一直讲到 chat template、token mask、Trainer 和端到端评测；Nemotron 仅作为案例。"
track: "Agent Learning"
kind: "系统教程 + 数据集案例"
order: 2
updated_at: "2026-09-11"
source_note: "知识主线独立于单一数据集；Nemotron-SFT-Agentic-v2 仅用于展示一份发布数据在完整流程中的位置。数据集事实快照：2026-09-09。"
---

# Agentic SFT：数据、训练与评测的完整链路

Agentic SFT 是用高质量示范轨迹训练模型做决策：理解目标、选择工具、填写参数、读取环境返回，并持续行动直到任务结束。学习它不能从某个 JSONL 文件开始，而要先建立完整链路：希望模型学会什么，示范怎样产生，轨迹怎样治理，模型实际预测哪些 token，以及最终怎样验证任务能力。

## 学习地图

1. **SPEC — 定义能力与任务：** 目标、工具、环境状态、限制和成功条件。
2. **DEMO — 生产示范轨迹：** 专家 Agent 与真实或模拟环境交互。
3. **CURATE — 治理轨迹：** 校验、过滤、去重、评分和来源追踪。
4. **RECORD — 保存共享轨迹底座：** 语义事件、环境证据与逐次模型调用快照。
5. **TRAIN — 生成 SFT 训练视图：** 逐次还原上下文，再生成 token、labels、mask 与 batch。
6. **EVAL — 训练并评测：** 从格式正确走向真实任务成功。

这六层中，前四层决定示范是否可信，第五层决定训练信号是否正确，第六层检验学到的行为能否迁移。它们不应被“下载数据后交给 Trainer”一句话压缩掉。

## 1. Agentic SFT 的能力目标

普通对话 SFT 常学习从问题到回答的映射；Agentic SFT 还要学习一个与环境交互的 policy：

```text
读取目标和当前状态
→ 判断是否需要工具
→ 选择 action 并构造参数
→ 读取 observation
→ 更新判断并继续
→ 在正确条件下结束
```

在采数据之前，应先定义任务维度与能力覆盖，而不是先寻找一个大数据集：

| 任务维度 | 典型取值或需要覆盖的行为 |
|---|---|
| 工具路由 | no-tool、single-tool、multi-tool、工具不可用 |
| 参数决策 | 参数抽取、缺参澄清、枚举与约束、ID 来源 |
| 长程执行 | 单步、多步、依赖关系、停止判断、循环恢复 |
| 环境反馈 | 成功、空结果、报错、超时、冲突和部分成功 |
| 对话状态 | 多轮补充、确认、修改目标、身份验证与升级 |
| 安全策略 | 拒绝、授权边界、敏感操作确认和最小权限 |

数据量只有放在任务 taxonomy 和能力覆盖关系里才有意义。一百万条相同模式的函数调用，不等于覆盖了长程规划、错误恢复和状态变化。这里的表格列出的是多个任务因素及其取值，不是一个固定的二维矩阵；完整概念见 [后训练基础](/learning/post-training-foundations/)。

## 2. 任务、工具、环境与轨迹

### 任务（Task）与成功条件

Task 不只是用户的一句话。一个可采集、可评测的任务至少包含：

```text
用户目标
初始环境状态
允许使用的工具
业务规则或安全 policy
成功与失败条件
时间、token、调用次数等预算
```

例如“取消明天的酒店预订”还需要预订状态、用户身份、取消规则和环境中的最终状态。只有回答“已经取消”不算成功；预订记录必须真的被更新。

### 工具契约（Tool contract）与环境（Environment）

Tool definition 是模型能看到的动作说明书：

```json
{
  "name": "cancel_booking",
  "description": "Cancel an existing booking",
  "parameters": {
    "type": "object",
    "properties": {
      "booking_id": {"type": "string"}
    },
    "required": ["booking_id"]
  }
}
```

它说明工具名称、用途和参数格式，却不会执行任何动作。Environment 接收调用，检查状态和权限，执行规则，再返回 observation。模型输出格式正确的 JSON，只说明它提出了一个 action；任务是否完成要由环境状态判断。

### 轨迹（Trajectory）与示范（Demonstration）

在最简化的 Agent 中，轨迹可以写成一次任务执行的有序事件序列：

$$
\tau=(m_0,a_0,o_0,m_1,a_1,o_1,\ldots)
$$

- $m_i$：第 $i$ 步的上下文与状态；
- $a_i$：Agent 回复或工具调用；
- $o_i$：工具/环境返回；
- 终点：成功、失败、拒绝、升级、超时或预算耗尽。

这个公式表达的是**语义上的状态—动作—观测循环**，不表示磁盘上的 `messages` 一定能从头串到尾，也不保证后一轮模型输入是前一轮输入的严格前缀。复杂 Agent 还会动态组装 system 指令、工具、memory、文档和运行状态，并可能过滤或压缩历史。后文会把“语义轨迹”和“每次模型真正看到的输入”分开保存。

如果轨迹由人工专家或强 teacher 产生，并通过质量检查，它就可以成为 SFT demonstration。SFT 模仿的是轨迹中的 Agent action，不是环境自身的执行逻辑，也不是日志采集器的内部行为。

### 对话轮数与执行步数

| 说法 | 衡量什么 | 例子 |
|---|---|---|
| single-turn | 用户只发起一次请求 | 用户问天气，Agent 完成后回答 |
| multi-turn | 用户与 Agent 有多轮交流 | 用户先问北京，再追问上海 |
| single-step | 目标只需要一次主要决策或动作 | 直接回答或调用一次工具 |
| multi-step | 一个目标需要多个决策或工具步骤 | 搜索 → 查价 → 下单 → 确认 |

对话轮数与执行步数是两个维度。用户只说一句，Agent 连续调用五个工具，是 single-turn + multi-step；用户在执行中反复补参数，则可能是 multi-turn + multi-step。

模型能否容纳一条轨迹也不由轮数直接决定。工具定义和 system policy 可能很长，两轮轨迹的 token 数可能超过十轮短对话。训练前应分别统计 message 数、user/assistant/tool 数、tool-call 数和模板化后的 token 长度。

## 3. 示范轨迹的生产

### 数据来源组合

Agent 数据通常不是由单一方式产生。Human、Synthetic 和 Automated 描述的是不同生产环节，可以同时成立：

| 来源 | 典型工作 | 优点 | 风险 |
|---|---|---|---|
| 人工（Human） | 人类写任务、操作工具示范、修正轨迹、打质量标签 | 意图真实，能表达隐性规范 | 成本高，标注者可能不一致 |
| 合成（Synthetic） | teacher LLM、user simulator 或 tool simulator 生成内容 | 扩量快，容易定向覆盖场景 | 继承模型偏差，可能产生虚假世界 |
| 自动化（Automated） | 程序组合用例、执行环境、校验 schema、运行 verifier 和过滤 | 可复现，适合规模化 | 只能覆盖已编码规则 |
| 混合（Hybrid） | 人类定义种类，模型扩写，环境执行，程序过滤，人类抽检 | 平衡规模、成本与真实性 | 来源复杂，必须保存 provenance |

例如，任务由人类设计、用户说法由 LLM 改写、工具由代码模拟器执行、坏轨迹由程序过滤，就是一个 hybrid pipeline。

### 用户—智能体—环境采集循环

1. **USER — 提出目标或补充信息：** 真人、固定脚本或 user simulator。
2. **AGENT — 回复或生成工具调用：** 人工专家、teacher model 或现有 policy。
3. **ENV — 执行 action 并返回 observation：** 真实 API、规则模拟器或 LLM tool simulator。
4. **LOOP — 更新消息与环境状态：** 继续交互直到出现终止条件。
5. **STORE — 保存完整 episode：** 事件、版本、状态变化、评分和终止原因。

核心责任边界是：Agent 产生 action，Environment 产生 observation。训练阶段不会重新运行这条循环；它只读取循环已经留下的离线记录。

### 环境保真度

| 环境实现 | 返回怎样产生 | 适用场景 | 主要限制 |
|---|---|---|---|
| 真实工具/API | 调用实际服务并记录真实结果 | 最终验证、高真实性采集 | 成本、权限、隐私和稳定性要求高 |
| 规则模拟器 | 代码执行显式业务规则与状态转移 | 大规模、可重放、可验证的训练 | 搭建成本高，只覆盖已实现状态 |
| LLM tool simulator | 另一个模型根据 schema 和上下文生成结果 | 快速扩展大量工具和领域 | 可能前后矛盾、违反真实规则或漏掉异常 |

规则模拟器可以维护一致状态，例如付款前余额 500、付款 100、付款后余额 400；LLM simulator 更像根据上下文续写一个合理结果。后者仍可用于训练格式和局部决策，但需要 schema 校验、状态一致性检查以及真实执行抽检。

真实 API 同样不能保证数据自动正确：超时、权限错误、服务波动和脏数据都要在日志中被区分。高质量生产通常会组合多种环境，并明确标记每条 observation 的来源。

### 参数的因果来源

工具参数必须能回指当前可见上下文。例如 `user_id="123"` 应来自：

- 用户明确提供的 ID；
- 已认证的会话状态；
- 前一个 `lookup_user` 工具返回；
- 工具协议中明确规定的默认值。

如果没有任何来源，Agent 却凭空生成这个 ID，它就是参数幻觉。仅仅通过 JSON Schema 不能发现这种错误，因此采集和验证还要检查参数的语义来源。

## 4. SFT 与 RL 共用的轨迹数据底座

### 先分清四层数据

复杂 Agent 的数据不是一个 `messages` 数组从运行一直用到训练。更清晰的做法是分成四层：

1. **原始运行事件：** Harness、模型服务、工具和环境按时间写出的请求、返回、重试、报错与诊断。
2. **语义轨迹正本：** 把事件治理成闭合 episode，保存任务、Agent 动作、环境观测、最终状态、评分与来源。
3. **逐次模型调用快照：** 保存第 $i$ 次调用真正生效的指令、消息、工具和额外输入；能取得时还保存输入/输出 token。
4. **算法训练视图：** 从同一底座分别导出 SFT 的 labels，或 RL 的旧策略概率、reward、advantage 等字段。

它们是“由上游事实派生下游视图”，不是四个同义词：

| 层 | 主要回答 | 是否一定是 JSONL |
|---|---|---|
| 原始运行事件 | 实际发生了什么 | 不一定；日志、数据库、追踪系统都可以 |
| 语义轨迹正本 | 任务如何从开始走到结束 | 不一定；JSONL 只是常用存储格式 |
| 模型调用快照 | 第 $i$ 次模型到底看到了什么、生成了什么 | 建议结构化保存，并与 episode/call ID 关联 |
| 训练视图 | 哪些 token 作为条件，哪些 token 接受何种训练信号 | 通常是离线派生文件或训练时生成的 tensor |

这里的“训练视图”具体落到常见 decoder-only SFT batch 时，通常至少有三个等长数组：

| 数组 | 它在回答什么 | tool result | padding |
|---|---|---:|---:|
| `input_ids` | 每个位置实际是什么 token | 保留真实 token id | 填 `pad_token_id` |
| `attention_mask` | 这个位置是真实上下文还是补齐位 | `1`，模型需要读它 | `0` |
| `labels` | 这个位置是否承担预测损失、目标是什么 | 通常为 `-100`，只读不学 | `-100` |

所以你的理解有一半完全正确：**tool result 通常在 `labels` 里被 loss-mask 掉，但不能在 `attention_mask` 里遮掉。** 模型下一步必须能看到它。padding 则同时是 `attention_mask=0`、`labels=-100`。另外还有模型 forward 内部的 causal mask，它限制当前位置只能看左侧历史，不是数据集里给 padding 补 0 的那一个 mask。第 5 节会把三者放进同一条 token 序列再看一遍。

`labels` 本身也不是一串 0/1：需要监督的位置通常保留目标 token id，不监督的位置写 `-100`；因此真正的 loss mask 可理解为 `labels != -100`。因果语言模型内部还会把 logits 与 labels 错一位对齐，让当前位置预测下一个 token。

**JSONL 只规定“一行一个 JSON 对象”，不规定对象必须是一整段会话还是单个事件。** schema 由采集系统自己定义。下面采用一个容易审计的**教学版内部 schema**：`episodes.jsonl` 一行一个 episode，`model_calls.jsonl` 一行一次模型调用。字段名不是从 Nemotron、OpenAI 或 Anthropic 的原始响应中照抄的，也不是业界统一标准；工程上也可以存进数据库，只要 ID、版本和来源能稳定关联。

### 语义轨迹正本：教学版内部 schema

这里的“轨迹正本”（canonical record）是**项目自己选定的稳定内部格式**，不是 provider 的返回格式，也不是全球统一标准。它尽量不绑定某个训练模型的特殊 token，负责保存动作与环境事实：

```json
{
  "episode_id": "ep_001",
  "task": {"id": "取消预订_17", "source": "任务集_v3"},
  "toolset_id": "预订工具_v2",
  "events": [
    {
      "event_id": "e1",
      "type": "user_message",
      "content": "请取消明天的预订 A-17。"
    },
    {
      "event_id": "e2",
      "type": "assistant_action",
      "call_record_id": "mc_001",
      "tool_call": {
        "id": "tool_abc",
        "name": "cancel_booking",
        "arguments": {"booking_id": "A-17"}
      }
    },
    {
      "event_id": "e3",
      "type": "tool_observation",
      "tool_call_id": "tool_abc",
      "content": {"status": "cancelled"}
    },
    {
      "event_id": "e4",
      "type": "assistant_action",
      "call_record_id": "mc_002",
      "content": "预订已经取消。"
    }
  ],
  "termination": "success",
  "final_environment_state": {"booking_A-17": "cancelled"},
  "provenance": {
    "teacher": "teacher_version",
    "environment": "booking_simulator_v2"
  },
  "validation": {"schema": "passed", "task": "passed"}
}
```

这里的 `call_record_id` 是我们建议项目自己生成的外键：它把 episode 中的某个 assistant action 连到另一份“逐次模型调用快照”。它原先写成 `model_call_id`，确实容易让人误以为存在同名的厂商标准字段，所以这里改了名字。

真实接口有各自的 ID，但语义不同。例如 OpenAI Responses API 的整次响应有 `response.id`，工具调用另有 `call_id`；Anthropic 的工具调用块有 `tool_use.id`，返回结果用 `tool_use_id` 配对。它们都不等于一个通用的 `model_call_id`。归一化时可以把厂商原始 ID 另存为 `provider_response_id` / `provider_tool_call_id`，不要冒充内部主键。[OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) 与 [Anthropic 工具调用说明](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) 都展示了各自的真实字段。

读这个例子时，只需抓住三种语义：`user_message` 是任务信息，`assistant_action` 是要模仿或优化的 Agent 动作，`tool_observation` 是环境返回。工具的完整定义可由 `toolset_id` 引用一份不可变版本；某次工具执行的结果则必须留在事件序列中。

这份正本能回答“环境中发生了什么”，但**单独靠它未必能回答每次模型真正看到了什么**。例如 `mc_002` 之前，Harness 可能压缩了历史、换了 system 指令、删掉某个工具或注入了当前目录状态。为此还要保存下一层。

### 模型调用快照：仍是教学版内部 schema

下面也是我们建议的采集格式，不是某个 SDK 会原样吐出的 JSON。它把不同来源能采到的证据统一放在一行；`token_capture.status` 用来防止把“没有采到”误写成“空序列”。

```json
{
  "call_record_id": "mc_002",
  "episode_id": "ep_001",
  "call_index": 2,
  "effective_request": {
    "instructions": ["你是预订助手", "敏感操作完成后必须给出确认"],
    "messages": [
      {"role": "user", "content": "请取消明天的预订 A-17。"},
      {"role": "assistant", "tool_call_id": "tool_abc", "name": "cancel_booking"},
      {"role": "tool", "tool_call_id": "tool_abc", "content": "{\"status\":\"cancelled\"}"}
    ],
    "tools": [],
    "template_inputs": {}
  },
  "assistant_output": "预订已经取消。",
  "token_capture": {
    "status": "captured_at_self_hosted_inference_server",
    "input_ids": [151644, 8948, 198],
    "output_ids": [77091, 1773]
  },
  "versions": {
    "model": "policy_checkpoint_042",
    "context_builder": "ctx_v7",
    "provider_adapter": "adapter_v3",
    "chat_template": "sha256:...",
    "tokenizer": "revision_abc"
  },
  "compaction": {"applied": false}
}
```

`effective_request` 表示真正发往 provider 或自托管模型服务的结构化请求。`input_ids` / `output_ids` 不是“模型测出来的 token 数”，而是 tokenizer 词表中的整数编号序列：前者是最终喂给模型的 token，后者是模型采样后、decode 成文字之前的 token。Hugging Face 的 tokenizer 文档也把 tokenization 定义为 token 与整数 ID 的相互转换。

这两个数组只有在你控制 tokenizer / inference server，并在推理边界埋点时才容易拿全。闭源 API 通常只返回输入/输出 token **数量**，有的接口还可返回输出 token 的文字、bytes 与 logprob；这仍不等于完整的输入 `input_ids`。拿不到时应明确写成：

```json
"token_capture": {
  "status": "unavailable_from_provider",
  "input_ids": null,
  "output_ids": null
}
```

所以你判断得对：不是自己跑的模型或至少不是自己控制的推理网关，通常很难获得精确 token 边界。此时仍可用本地 tokenizer 对已知请求重新编码，但那是 `reconstructed_with_tokenizer_revision_x`，不是服务端实测值。

### 开源 Agent 和闭源会话分别能采到什么

| 场景 | 通常可以可靠保存 | 不能想当然地声称拿到 |
|---|---|---|
| 开源模型 + 自己控制的 Agent 与推理服务 | Harness 事件、每次有效请求、工具调用/返回；在模型服务处记录真实 `input_ids`、`output_ids` 和可选 logprob | 未输出到接口的“隐藏思维”、内部激活或系统未暴露的状态 |
| 闭源模型 API + 自己控制调用代码 | 自己提交的 instructions/messages/tools、API 返回的内容与工具调用，以及接口明确提供的 logprob/状态项 | 服务端私有 chat template、精确内部 token、未公开 system 指令和隐藏推理 |
| ChatGPT/Codex 这类成品聊天界面 | 导出或客户端可见的 user/assistant 内容，以及产品明确展示或导出的部分工具事件 | 完整 system/developer prompt、隐藏推理、服务端压缩内容、精确 input ids、全部内部工具状态 |

所以，“开源 Agent 有每一步工具调用，直接放进 `messages` 就行”只完成了**语义事件记录**。若想忠实复现每次调用，还要在压缩、过滤和模板化之后记录调用快照；显式输出的 reasoning 字段可以保存，模型没有对外输出的隐藏思维不能当成可采数据。

当前这类闭源聊天也可以把**你能看到或合法导出的部分** 转成 JSONL，但那叫“可观测会话记录”，不等于完整训练级轨迹。以 [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) 为例，客户端可以保存输入/输出 items、工具调用，并可请求部分输出 logprob；[OpenAI 的长上下文压缩说明](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2#4-compaction-extending-effective-context) 则明确描述了加密、不透明、用于继续会话而非检查内部内容的压缩项。换句话说，可以采“接口暴露了什么”，不能补写“服务端一定还看到了什么”。

### Codex / Claude Code SDK 接自己的模型时怎么采

先澄清最容易混淆的一点：**Codex SDK、Claude Code 和 Claude Agent SDK 负责运行 Agent 与踩轨迹，不负责更新模型权重。** 真正的 SFT 仍由 TRL、NeMo、Megatron-LM、LLaMA-Factory 等训练栈完成。这里所谓“用 Codex/CC 接自己的模型训”，实际是把它们当作 rollout harness：让 student 或 teacher 在任务环境里行动，保存轨迹，离线训练出新 checkpoint，再把新 checkpoint 部署回 harness。

关键不在 Agent 外壳是不是开源，而在于**最终推理边界是否由你控制**。至少同时记录 Harness 与请求边界；如果推理服务也是自己的，就再加第三层：

```text
Codex / Claude Code / Agent SDK
  └─ Harness 层：原始 episode、工具事件、压缩事件、环境状态
       └─ Gateway / provider 边界：实际请求与响应、内部 call_record_id
            └─ 自托管 inference server：实际 input_ids、output_ids、logprob、模型版本
```

- **Codex：可以走官方支持的自定义 provider。** 配置中的 `model_providers.<id>.base_url` 可指向自有服务，但当前 `wire_api` 只支持 `responses`，因此你的服务或网关要实现兼容的 Responses API。Codex/Harness 日志保存完整语义 episode；你的网关给每次请求分配 `call_record_id` 并保存实际 request/response；推理服务再补 token IDs。三层用同一个 trace/call ID 关联。Codex SDK 的职责是以程序方式启动、继续和恢复 Codex task，仍然不是 Trainer。
- **Claude Code / Claude Agent SDK：可经过 Anthropic-format LLM gateway 做请求审计，但“任意自有非 Claude 模型”不是官方支持路径。** Anthropic 文档明确说 gateway 可以记录每个模型请求，同时不支持经 gateway 把 Claude Code 路由到非 Claude 模型。即使某个兼容层实验上能跑，也应标成兼容性实验，不能写成官方保证。
- **压缩仍要双记。** Harness 层保留压缩前的语义事件；gateway 只会看到压缩后真正发出的有效请求。这样既能研究完整 episode，也能精确构造当次 $(Q_i,a_i)$。如果只留 gateway 日志，压缩掉的历史已经无法从请求中恢复。
- **token IDs 仍来自推理端。** SDK 事件能给你 tool call、result、session 等语义信息，但不会凭空产生精确 `input_ids`。只有自有 tokenizer / inference server 的埋点才把“请求内容”升级为“模型实际吃到的 token 序列”。

#### Codex 接自有模型的最小结构

一个研究用配置可以表达为：

```toml
model = "student-checkpoint-000"
model_provider = "lab"

[model_providers.lab]
name = "Lab inference gateway"
base_url = "http://127.0.0.1:8000/v1"
env_key = "LAB_MODEL_API_KEY"
wire_api = "responses"
```

这段配置只解决“Codex 把请求发给谁”。要让它真的工作，自有 gateway 还必须把 Responses 请求完整翻译成 student 所需的 chat template 和工具协议，并把 student 输出解析回 Codex 能理解的 response item。模型只会输出普通文字、不会稳定生成函数名和 arguments 时，即使 HTTP 接口兼容，也不代表 Agent 行为兼容。

一轮可训练的闭环应是：

1. **SERVE：** 把冻结的 student checkpoint 放进自托管推理服务，记录 model/tokenizer/template revision。
2. **ADAPT：** 在 gateway 实现 Codex 所需的 Responses 协议与 tool-call 映射，不在训练脚本里偷偷使用另一套模板。
3. **ROLLOUT：** Codex SDK 从冻结任务集中启动 task；环境执行工具并返回 observation。每个 task 使用不可变 `episode_id`，每次推理使用新的 `call_record_id`。
4. **CAPTURE：** Harness 保存语义 episode；gateway 保存每次有效 request/response；推理服务保存可取得的 token IDs 与 logprob。
5. **VERIFY：** 用环境最终状态、单元测试或规则判断 success/failure，再处理死循环、超时、无效工具参数和重复轨迹。
6. **EXPORT：** 把通过的数据导出为目标 student 的 SFT view；如果要做 RL，则另行保存 rollout policy、旧 logprob、reward 与 group 信息。
7. **TRAIN：** 关闭 rollout 服务的写入或固定数据版本，使用独立训练进程更新权重，产生新 checkpoint。
8. **EVAL：** 在从未用于训练和筛选的任务上运行新 checkpoint，与旧 checkpoint 使用完全相同的 harness、tools 和预算比较。
9. **ITERATE：** 只有新模型通过门槛，才把它登记成下一轮 rollout policy；不能覆盖上一轮 checkpoint 与轨迹。

```text
任务 + 环境
   ↓
Codex/CC rollout harness ──→ episode + call snapshots
   ↓                              ↓
冻结 student 推理服务        过滤 / 评分 / 切分
                                  ↓
                           SFT / OPD / RL Trainer
                                  ↓
                           新 checkpoint（重新部署）
```

因此“接自己的模型”和“训练自己的模型”是两个相邻但独立的工程面：前者是在线推理与采集，后者是离线权重更新。官方边界可分别参考 [Codex SDK](https://developers.openai.com/codex/sdk/)、[Codex configuration reference](https://developers.openai.com/codex/config-reference/) 和 [Claude Code 的 LLM gateway 说明](https://code.claude.com/docs/en/llm-gateway)。

### 治理：从原始事件得到闭合正本

采集系统最初留下的运行事件可能包含重试、半截调用、服务故障、judge 记录和内部诊断。进入训练候选集前应完成：

1. **闭合 episode：** 每个调用有对应结果，任务有明确终止；悬空调用与基础设施故障单独保存。
2. **结构校验：** 检查 role、JSON、函数名、参数 schema、call ID 和 observation 对应关系。
3. **调用对齐：** 每个 assistant action 能回指内部 `call_record_id`，每个模型调用快照能回指 episode/event；厂商原始 ID 另存，不混用。
4. **执行式评分：** 能重放的任务优先运行环境或 verifier，确认最终状态满足目标。
5. **语义式评分：** LLM judge 补充目标满足度、policy 合规和解释质量，并保存 rubric 与判词。
6. **安全与隐私：** 清理密钥、个人信息、危险动作、prompt injection 与不应进入训练的数据。
7. **去重与切分：** 按 source、tool family、domain、模板或环境谱系隔离 train/validation/test。
8. **来源与版本：** 保存 teacher、环境、处理阶段、质量分数、许可、prompt 和编码组件版本。

不需要 LLM judge 的硬校验包括：函数名存在、参数通过 schema、参数能回指可见上下文、每个工具调用有且只有一个结果、事件没有被截断、终止状态和最终环境状态可读取。结构通过仍不等于任务正确；最终目标、安全规则与 observation 使用情况还需环境 verifier、规则或 judge 判断。

## 5. 从数据正本到训练 Batch

### 一次模型调用是最小保真单元

令 $H_i$ 是第 $i$ 次调用前已经发生的持久化事件历史。Harness 还持有多份指令 $P_i$、工具集合 $T_i$、文档或 memory $D_i$、环境状态 $Z_i$。上下文组装器在这一刻构造有效上下文：

$$
C_i=\operatorname{Build}_i(H_i,P_i,T_i,D_i,Z_i)
$$

有效上下文再被转换为具体接口请求与模型 token：

$$
Q_i=\operatorname{Adapt}_i(C_i),\qquad
p_i^{\mathrm{tok}}=\operatorname{Encode}_i(Q_i)
$$

模型生成 action $a_i$，环境返回 observation $o_i$，原始事件历史继续追加：

$$
H_{i+1}=\operatorname{Append}(H_i,a_i,o_i)
$$

但下一次有效上下文是重新构造的：

$$
C_{i+1}=\operatorname{Build}_{i+1}(H_{i+1},P_{i+1},T_{i+1},D_{i+1},Z_{i+1})
$$

因此复杂 Agent 中更可靠的训练原子是每次调用的 $(Q_i,a_i)$；若模型边界可控，则进一步保存 $(p_i^{\mathrm{tok}},a_i^{\mathrm{tok}})$。一整条 episode 用于连接因果、环境和最终评分，它不自动等于一条可从头编码到尾的训练序列。

### 压缩为什么破坏严格前缀

没有过滤或压缩时，第二次调用可能只是追加 action 和 observation：

```text
调用 1 输入：system + user
调用 2 输入：system + user + assistant tool call + tool result
```

这时第一段通常可以是第二段的语义前缀。发生压缩后却可能变成：

```text
调用 1 输入：旧 system + 很长历史 + 当前 user
调用 2 输入：新 system + 压缩项/摘要 + 当前状态 + tool result
```

此时即使 $H_i$ 是 append-only，$p_i^{\mathrm{tok}}\Vert a_i^{\mathrm{tok}}$ 也不一定是 $p_{i+1}^{\mathrm{tok}}$ 的前缀。消息过滤、动态 system/tools、服务商协议规范化、detokenize → parse → re-encode 都可能产生同样问题。

解决方式不是伪造一个“更整齐的长 messages”，而是：

1. 在**每次模型调用边界** 保存实际有效请求；能控制推理服务时再保存真实输入/输出 token。
2. 把每个调用先当成独立 prompt–completion 样本，保证训练条件与该步行为一致。
3. 只有通过等价性检查、证明相邻调用严格前缀一致后，才为了效率合并或复用 prefix cache。
4. 如果只有 episode 事件、没有逐次调用快照，可以按一个明确、可复现的 context recipe 重建近似输入；但应标注为“重新构造的训练视图”，不能声称精确复现原 Agent。

如果压缩结果是可读 summary，就把**当时实际使用的 summary** 放入调用快照。如果它是服务端的不透明加密项，它可以供原服务继续会话，却不能直接变成另一个开源 student 的可读 SFT 文本；此时只能重新制作透明摘要，或回到未压缩事件重建 student 上下文。两者都属于新的训练设计，不是原调用的精确回放。

### SFT 是否需要考虑压缩

需要。关键不在训练算法是否叫 SFT，而在 expert action 当时依赖了什么条件：

| 现有数据 | 推荐的 SFT 构造 | 能声称什么 |
|---|---|---|
| 有每次调用的有效结构化请求 | 每个 call 独立序列化为目标 student 的 prompt，assistant action 作为 label | 语义条件尽量忠实；换 tokenizer/template 后不是 teacher 原 token 回放 |
| 同模型/同 tokenizer，且保存真实输入输出 token | 直接按 call 构造 prompt/action 与 loss mask | 可以做更严格的同协议行为克隆 |
| 只有完整 M/A/O 语义事件 | 用固定 context recipe 为每个 action 重建当步上下文 | 是基于轨迹事实的新 SFT view，不是原调用的精确输入 |
| 只有聊天界面可见记录 | 先标注缺失 system、工具和 compaction 信息，再决定是否只用于回答风格或局部行为 | 不能当成完整 Agent 轨迹 |

把完整 episode 直接串成一个 `messages` 样本，只有在以下条件成立时才保真：没有中途压缩/过滤；system、tools 和额外输入不变；每一步解析与重新编码不改变条件；长序列仍在上下文上限内。否则应以逐次调用样本为主。

### 不压缩，就能把多个 step 放在一条序列里一起训吗

**不压缩是必要条件之一，但不是充分条件。** 对第 $i$ 个 assistant action，假设它在整条训练序列中的起点是 $s_i$。要安全合并，训练时 action 左侧的 token 前缀必须与 rollout 当时模型看到的 token 条件等价：

$$
x_{<s_i}^{\text{train}} \equiv p_i^{\mathrm{tok}}
$$

还要逐项检查：

| 条件 | 为什么会破坏整轨合并 |
|---|---|
| system/developer 指令是否中途变化 | 后续调用可能替换或追加规则，不再是简单前缀 |
| tools 是否动态增删、延迟加载 | 后续调用看到的工具定义可能不同 |
| documents、memory、目录状态是否动态注入 | 这些信息可能没有出现在 M/A/O 事件串里 |
| observation 是否原样进入下一次请求 | Harness 可能裁剪、格式化或只保留摘要 |
| provider 是否维护服务端会话状态 | 本地 `messages` 可能不是完整有效条件 |
| chat template/tokenizer 是否一致 | 同样的语义消息可能产生不同 token 边界 |
| 是否发生截断 | 截断可能删掉早期约束或拆开 tool call/result |

全部成立时，可以把：

```text
system → user → assistant tool call → tool result
       → assistant tool call → tool result → assistant answer
```

编码成一个长样本，并让多个 assistant 区段共同产生 loss。causal mask 会保证第 1 个 action 看不到第 2 个 tool result，也保证每个后续 action 只能读取它左侧已经发生的历史，所以并不存在“训练时偷看未来”。

但这里仍是 **teacher forcing**：训练第 3 步时，前两步 assistant action 来自正确示范；部署时，前两步却是 student 自己采样的。只要 student 早期犯错，它就可能进入训练数据没覆盖的状态，这正是离线 SFT 的 exposure bias，也是后续 OPD/on-policy imitation 或 Agentic RL 有价值的原因。

#### 后面的 action 需要知道前面所有时刻的状态吗

它需要的是**当时可观测、且足以决定下一步的状态**，不一定是环境内部的全部真实状态：

- 如果 Harness 保留完整历史，后续 action 可以读取此前所有 user、assistant 与 tool result token。
- 如果 Harness 使用可读摘要或 memory，后续 action 只需读取这份实际摘要和仍然有效的近期事件。
- 数据库真实值、隐藏测试答案、未来 reward 等若当时没有展示给 Agent，就不能为了“信息完整”塞进训练前缀，否则会产生标签泄漏。
- 如果某个状态会改变正确 action，却既不在历史、summary、memory，也不在当前 observation 中，那么问题首先是 Agent observation 设计不充分，不是靠 SFT mask 能修复。

因此训练条件应该复现“Agent 当时知道什么”，而不是复制“环境管理员知道什么”。

### 闭源模型是怎么被蒸馏成开源 student 的

闭源 teacher 不需要公开权重，也不需要泄露隐藏思维，才能做最常见的**行为蒸馏**：

```text
任务状态 Q₁ → 闭源 teacher → 可见 action a₁ → 环境 → observation o₁
Q₂(Q₁,a₁,o₁) → 闭源 teacher → 可见 action a₂ → 环境 → ...
                                      ↓
                     收集 (有效上下文 Qᵢ, teacher action aᵢ)
                                      ↓
                           开源 student 做 SFT
```

能蒸馏的是接口暴露的行为：tool selection、arguments、可见 reasoning、最终回答、拒绝和恢复策略。通常拿不到的 hidden chain-of-thought、完整 logits、内部 token IDs 和服务端 prompt 不应被伪造。若 API 提供输出 logprob，可以做比 hard-label SFT 更软的 token 监督；只返回生成结果时，就把 teacher 实际输出当 hard target。

有三种常见数据策略：

| 策略 | 谁走到状态 | 谁给 action | 主要问题 |
|---|---|---|---|
| 离线 teacher demonstration | teacher | teacher | 数据质量高，但状态都偏向 teacher 自己会到达的区域 |
| student rollout + teacher relabel | student | teacher | 覆盖 student 会犯错后到达的状态，成本更高；接近 OPD/DAgger 思路 |
| student rollout + verifier/reward | student | student，环境评分 | 不必逐步模仿 teacher，但进入 Agentic RL 与 credit assignment |

所以“用闭源模型蒸馏”不等于抓取成品聊天界面的隐藏记录。更正规的流程是：你控制任务和环境，通过允许使用的 API 请求 teacher，在客户端保存自己提交的有效上下文与 teacher 明确返回的 action，再训练 student。还要单独确认 provider 条款、数据许可和隐私边界。

### 为什么 SFT 与 RL 共用底座，但不合并成一套训练

你的直觉有一半完全正确：**轨迹采集与调用边界应该合并讲，训练目标不应该混在一起。**

| 数据或处理 | Agentic SFT | Agentic RL |
|---|---|---|
| 语义 episode、工具结果、环境状态、call ID | 共用 | 共用 |
| 每次有效请求 | 需要，尤其有压缩时 | 需要，而且必须对应 rollout 当时条件 |
| action 来源 | 人类/teacher 的离线高质量示范 | 当前或 rollout policy 实际采样 |
| token 处理 | 用目标 student 的模板与 tokenizer 生成 labels | 尽量保存采样时真实 input/output token |
| 额外字段 | 质量分、样本权重、loss mask | policy version、旧 logprob、group、reward、advantage/credit |
| 目标 | 交叉熵模仿 expert action | 用环境反馈改变 action 概率 |

因此本站保留两篇课：本页负责“共享数据底座 → SFT view”，[Agentic RL](/learning/agentic-rl/) 继续讲“同一底座 → rollout、reward 与 policy loss”。这样既不重复假设一条完美 `messages`，也不会把离线示范误当成 on-policy rollout。

### 从调用快照到训练输入

现在这些组件已经在真实数据流中出现，可以对齐它们的职责：

| 组件 | 中文 | 在这一层做什么 |
|---|---|---|
| Context Builder | 上下文组装器 | 从事件历史、指令、工具、文档、memory 和状态中选出本次有效上下文 $C_i$ |
| Provider Adapter | 服务商/API 协议适配器 | 把 $C_i$ 转成目标接口需要的 role、content block、tool schema 等请求 $Q_i$ |
| Chat Template | 对话序列化模板 | 把结构化请求排成目标模型约定的文本与控制 token 格式 |
| Tokenizer | 分词器/编码器 | 把序列化结果编码为 `input_ids` |

`documents` 是供模型参考的检索材料或代码/知识库片段，属于上下文**原料**；`messages` 是带角色和时序的对话/工具事件；`effective messages` 是原料经过筛选、压缩、包装后，本次请求中真正生效的消息。三者都不是整条 canonical episode 的同义词。

```text
[持久化事件历史 + 多份指令 + tools + documents/memory + 当前状态]
        ↓ 上下文组装器：选择、过滤、压缩、包装
[本次有效上下文]
        ↓ 服务商协议适配器：转成目标 API 请求结构
[effective messages + effective tools + 其他模板输入]
        ↓ 目标模型对话序列化模板
<tools>...</tools><user>...</user><assistant>...
        ↓ 分词器编码
[151644, 8948, 198, ...]
```

并非每个框架都显式暴露四个组件。直接训练开源模型时，协议适配层可能很薄；调用托管 API 时，对话模板与分词通常在服务端，客户端只能保存自己提交的有效请求和接口明确返回的信息。

### 对话序列化模板与工具协议

模板通常跟随 tokenizer 保存在模型仓库中：

```python
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained(
    "Qwen/Qwen2.5-7B-Instruct"
)

print(tokenizer.chat_template)

text = tokenizer.apply_chat_template(
    messages,
    tools=tools,
    tokenize=False,
)
```

`tokenize=False` 返回展开后的单一文本；`tokenize=True` 直接返回 token ids。不同模型家族可能使用不同的 role token、tool-call 标签和结束符，因此同一份语义轨迹必须为目标 student 生成独立训练视图。

模板会依次遍历**某一次调用** 的有效 `messages`。tool call 和 tool result 应处在该请求的正确位置；顶层 `tools` 通常只渲染一次。Hugging Face 的 `apply_chat_template` 还允许模板访问其他关键字参数，但只有模板实际引用并渲染的内容才会进入模型输入。

### 输入、注意力与监督信号

一种常见的 assistant-only SFT 可以表示为。下面用一条已经通过严格前缀检查、可以合并的短轨迹示意；逐调用样本使用相同规则，只是每个样本通常只有最后一个 assistant action 接受监督：

```python
input_ids = [system, tools, user, assistant_call, tool_result, assistant_answer]

attention_mask = [1, 1, 1, 1, 1, 1]  # 都是真实 token；tool result 也必须可见

labels = [
    -100, ...            # system 和 tools：读取，不预测
    -100, ...            # user：读取，不预测
    assistant_call, ...  # 产生 loss
    -100, ...            # tool result：读取，不预测
    assistant_answer ... # 产生 loss
]
```

如果把这条样本补齐到固定长度，新增 pad 位置应同时满足 `attention_mask=0` 与 `labels=-100`。因此“tool result 不计算 loss”和“padding 不参与 attention”是两件不同的事。

三个名称相似的 mask 负责不同事情：

| 名称 | 作用 | 产生位置 |
|---|---|---|
| `attention_mask` | 区分真实 token 与 padding；tool result 是真实输入，通常为 1 | data collator / model input |
| causal mask | 当前 token 只能读取自己及之前的位置 | Transformer forward / attention kernel |
| loss mask / `labels=-100` | 决定哪些目标 token 进入 cross-entropy | dataset mapper / collator / Trainer |

Causal mask 是 decoder-only Transformer 的结构规则，通常不作为数据字段保存，也不是通过训练学出来的参数。框架在 forward 中构造它，或由 attention kernel 的 causal 模式实现，再与 padding mask 共同限制可见位置。

“不计算 loss”不等于“模型看不到”。System、user 和 tool result 通常被模型读取，却不要求模型预测。相反，部署时需要模型生成的 `<tool_call>`、函数名和 arguments 通常属于 assistant action，应参与监督。assistant 边界与 EOS 是否参与监督取决于具体模板和训练 recipe。

| Token 区段 | Loss mask | 作用 |
|---|---:|---|
| system + tools | 0 | 输入条件 |
| user | 0 | 输入条件 |
| assistant tool call | 1 | 学习 action |
| tool result | 0 | observation |
| assistant answer | 1 | 学习回复 |

### Trainer 与 TRL

Trainer 是组织训练循环的软件组件，不是模型权重自身提供的能力：

- PyTorch 提供张量、自动微分和优化器；
- Hugging Face Transformers 提供模型实现、tokenizer 和通用 `Trainer`；
- Hugging Face TRL 提供 `SFTTrainer`、DPO、GRPO、Reward Modeling 等 post-training 流程；
- 模型厂商提供权重、chat template、工具协议与推荐 recipe，也可能维护自己的训练代码；
- LLaMA-Factory、Axolotl、Unsloth 等项目继续封装数据、配置和分布式训练。

TRL 全名是 Transformer Reinforcement Learning。虽然名称来自 RL，它现在也覆盖 SFT 和偏好优化。它的 `SFTTrainer` 可以接收 conversational dataset：

```python
from trl import SFTConfig, SFTTrainer

trainer = SFTTrainer(
    model="Qwen/Qwen2.5-7B-Instruct",
    train_dataset=dataset,
    processing_class=tokenizer,
    args=SFTConfig(
        assistant_only_loss=True,
        max_length=8192,
    ),
)
```

当样本包含 `messages` 和 `tools` 时，兼容的 Trainer 会在数据准备阶段应用 chat template、tokenize、截断并生成训练字段。它不会在 SFT 期间执行工具；`role: tool` 的 observation 已经是离线记录。

`assistant_only_loss=True` 依赖模板正确标出 assistant 生成区。TRL 对部分模型家族提供训练模板支持；自定义模板应检查 `{% generation %}` / `{% endgeneration %}` 是否能产生正确的 assistant mask。使用任何自动处理前，都应抽样打印模板化文本、解码后的 `input_ids` 和 `labels`，确认工具协议与监督区域没有错位。

### 逐次调用优先，严格前缀时才合并

复杂 Agent 默认先按 call 拆分：

```text
样本 1：调用 1 的真实有效请求 → assistant tool call
样本 2：调用 2 的真实有效请求 → assistant next action
样本 3：调用 3 的真实有效请求 → assistant final answer
```

这样能单独审计和加权每个决策，代价是重复存储与计算相同前缀。只有证明调用 1 的 prompt + action 确实是调用 2 prompt 的 token 前缀，并且所有监督边界一致时，才可合并为一个长样本，让多个 assistant action 位置共同产生 loss。合并是计算优化，不应改变训练条件。

“一个 JSONL row 是一个 episode”也不等于“Trainer 必须得到一个长样本”。存储单位、审计单位与训练单位可以不同：一个 episode 可以派生出多个 call-level 样本，多个短样本也可以在保持 attention 边界的前提下被 packing 到同一个 batch block。

### 长度、截断与 packing

训练上限应使用模板化后的 token 数定义，而不是对话轮数。过长轨迹不能盲目截尾，否则可能保留 tool call，却删除对应 observation 或最终答案。

合理顺序是：

1. 统计目标 tokenizer 下的长度分布；
2. 为过长轨迹选择过滤、提高上下文长度或按完整事件边界拆分；
3. 验证每个拆分样本仍有闭合的工具交互和监督目标；
4. 最后才用 packing 减少 padding。

Packing 是把多个较短样本装入固定长度块，提高吞吐；它不会修复本身已经超过上限的坏轨迹，也不应破坏不同 episode 之间的 attention 边界。

## 6. SFT 目标函数与训练选择

对第 $i$ 次 expert 调用，设目标 student 的模板和 tokenizer 将有效请求 $Q_i$ 与 expert action $a_i$ 转换为：

$$
x_{1:T}^{(i)}=\operatorname{Tok}_m\left(S_{m,v}(Q_i,a_i)\right)
$$

给每个 token 一个 loss mask $w_t\in\{0,1\}$，assistant-only SFT 可写作：

$$
\mathcal{L}_{\mathrm{SFT}}^{(i)}(\theta)
=-\frac{1}{\sum_{t=1}^{T}w_t}
\sum_{t=1}^{T}w_t
\log\pi_\theta(x_t^{(i)}\mid x_{<t}^{(i)})
$$

其中 $w_t=1$ 的位置对应 expert assistant action，输入条件、用户消息和环境 observation 通常取 0。它本质上是行为克隆：在 demonstration 到达过、并由 $Q_i$ 表达的上下文里，提高专家 action token 的概率。

### 监督范围

常见选择包括：

- 只监督 assistant 的 tool call 与最终回答；
- 同时监督可公开的 reasoning、tool call 与回答；
- 为 tool-selection、arguments 和 final answer 设置不同权重；
- 将每个 action 拆成 prompt–completion 样本单独加权。

`reasoning_content` 不应仅按字段名决定去留。监督它会让 student 模仿 teacher 的推理风格，也会继承冗余和错误过程；删除它则要确保推理时的 action 条件与训练一致。可靠做法是固定任务、模型、训练 token 预算和评测，比较 `action + answer` 与 `reasoning + action + answer`。

### 能力边界

Agentic SFT 可以学习：

- 何时调用工具、选择哪个工具；
- 怎样构造合法参数；
- 怎样读取 observation 并继续；
- teacher 展示过的多轮 policy、确认、拒绝与升级；
- 常见错误场景中的恢复动作。

它不会自动解决：

- demonstration 没覆盖的新状态；
- 环境和工具本身的真实性与安全性；
- 长程任务中的稀疏 credit assignment；
- 超越 teacher 的在线探索；
- 训练 loss 与真实任务成功之间的差距。

### 为什么同一批轨迹，不同模型与方法会得到不同结果

答案是肯定的。轨迹只是上游事实，最终训练样本和优化过程还有很多自由度：

| 变化项 | 即使原始轨迹相同，也会改变什么 |
|---|---|
| base model | 先验能力、上下文长度、工具语法熟悉度与可学习上限 |
| chat template / tokenizer | token 边界、特殊 token、工具调用格式和序列长度 |
| 整轨合并或逐 call 训练 | 前缀重复量、每步权重、长上下文压力与保真要求 |
| assistant-only / reasoning / 加权 loss | 哪些行为被模仿，工具选择、参数、答案各占多少梯度 |
| 全参、LoRA、学习率、batch、epoch | 参数可塑性、稳定性、过拟合与遗忘程度 |
| 数据 mixture 与采样权重 | 模型更偏搜索、客服、多工具还是短函数调用 |
| rollout harness 与解码参数 | 训练后实际可调用的工具、system prompt、温度和停止条件 |

因此公平比较至少要冻结：原始数据版本、train/validation/test 分组、训练 token 预算、目标模板、评测 harness、工具版本和推理解码设置。否则看到的差异可能来自数据泄漏或协议适配，而不是训练算法本身。

## 7. 训练与评测流程

1. **BASELINE — 冻结初始评测：** 固定模型、Harness、工具版本和失败分类。
2. **INSPECT — 审计训练视图：** 从 JSONL 一直检查到 input_ids 与 labels。
3. **OVERFIT — 32–128 条过拟合：** 验证模板、mask、EOS、保存和加载链路。
4. **PILOT — 分层小样本训练：** 按任务 taxonomy 与能力覆盖控制样本和 assistant token 预算。
5. **EVAL — 环境重放与泛化：** 同时比较格式、决策、任务成功和成本。

### 四层评测

| 层级 | 关键指标 |
|---|---|
| 序列与协议 | role/EOS 正确、tool call 可解析、arguments 通过 schema |
| 决策 | 工具选择、缺参澄清、停止判断、异常恢复、读取 observation |
| 任务与环境 | end-to-end success、最终状态、policy 合规、工具次数与延迟 |
| 泛化 | held-out tool/domain/schema、未见组合、更长 horizon、噪声和注入 |

Loss 下降只能说明模型更像训练 token，不能替代环境任务成功率。如果 tool call 仍无法执行，应优先检查 chat template、special tokens、assistant mask、arguments 序列化和 EOS，而不是先调学习率。

## 8. Nemotron-SFT-Agentic-v2 案例

[NVIDIA Nemotron-SFT-Agentic-v2](https://huggingface.co/datasets/nvidia/Nemotron-SFT-Agentic-v2) 用来展示一份已发布 Agent 数据位于完整链路的什么位置。它不是 Agentic SFT 的定义，也不覆盖前面任务 taxonomy 中的所有问题。

### 发布内容

Hugging Face 上的数据集说明页通常由仓库 `README.md` 渲染，也称 dataset card。它记录发布者声明的数据用途、来源、格式、规模、许可和限制，但不保证包含完整生成代码、prompt、过滤阈值或训练 recipe。

Nemotron 发布三类 JSONL：

| 文件 | 主要内容 | 更适合观察的能力 |
|---|---|---|
| `tool_calling.jsonl` | 通用 function/tool calling | 工具路由、参数构造、多工具与多步调用 |
| `interactive_agent.jsonl` | 多轮客服式交互 | 鉴权、确认、查询、修改、拒绝与升级 |
| `search.jsonl` | 搜索轨迹 | 连续检索、证据综合与停止判断 |

数据卡正文和量化表存在数量差异：正文称通用工具调用约 120 万条、搜索 6,977 条；量化表分别写 707,052 与 5,968，总计 991,900。使用时应保留这一差异，而不是自行选择一个数字当作确定事实。

### 它是否已经分成 train / validation / test

**没有发布常规意义上的 train/validation/test 三分。** Hugging Face 页面目前显示 `Split (3)`，但这三个名字是 `interactive_agent`、`search`、`tool_calling`；仓库 `data/` 下也正好是三个同名语义文件。它们表示客服交互、搜索和通用工具调用子集，不是训练集、验证集和冻结测试集。

数据卡也没有声明一个统一、可直接复现实验的 held-out test。因此正式训练前应自行建立 manifest，先按语义组切分，再决定比例：

1. 用 source/original ID、近重复簇或共同生成模板分组，避免同源改写跨集合。
2. tool schema 高度相似的样本按 tool family 分组，避免只记住函数名。
3. 客服数据可按 domain 留出，搜索数据可按实体、图路径或问题模板留出。
4. validation 用于选 epoch、学习率和数据配比；test 一旦冻结，不能再用于筛样本、改 prompt 或选择 checkpoint。
5. 最终泛化最好再使用独立 benchmark，而不是只在同一合成数据源的随机留出行上报告结果。

切分比例不是最重要的；**防止任务谱系、工具模板和近重复轨迹穿越边界** 比随机做一个 90/5/5 更关键。

### 生产信息

数据卡说明，通用工具调用部分在构造任务和工具场景时使用了 UltraTool、ToolEyes、AutoTools、API-Bank、glaive-function-calling-v2 等公开资源，并纳入 Agent-Ark/Toucan-1.5M 的一部分轨迹。这里能确认的是这些资源参与了数据生产；数据卡没有公开每个来源的占比、逐条转换关系、改写方式和去重规则。

通用工具调用轨迹通过 User、Agent、Tool Environment 三类角色生成，并使用 DeepSeek-V3.2、GLM-4.6 参与生成或评分。LLM judge 会过滤不连贯、不一致或工具使用错误的轨迹。搜索部分则由配备 web-search 工具的模型生成，数据卡称大部分轨迹约有 10–30 次搜索调用。

因此，不能把整个集合简单理解为“全部真实 API 日志”或“全部由 LLM 凭空写出”。它混合了合成、自动化和已有轨迹来源，不同子集的环境真实性也不同。

### 在训练链路中的位置

按前面的四层划分，发布 JSONL 主要属于治理后的**语义轨迹记录**：它不是生成器最初日志，也不是可直接计算 loss 的 tensor。记录中即使有 `messages`，也不能据此推断 NVIDIA 同时发布了 teacher 每次调用的完整有效请求、压缩前后状态或真实输入 token；除非相应字段和生成协议明确提供，否则应把它用于重新构造目标 student 的 SFT view，而不是宣称精确回放原始 teacher 调用。

抽样记录的 `processing_info.stages` 包含：

```text
reasoning_extraction
uuid_addition / uuid_removal
identity_filter
propaganda_filter
loop_detection
tool_validation
token_counting
```

这说明数据发布前已经经过字段提取、过滤、循环检测、工具验证和 token 统计。与此同时，下载后仍需要：

1. 分文件读取并审计 schema；
2. 统一 tool call、arguments、tool result 和 metadata；
3. 选择监督范围；
4. 应用目标模型 chat template；
5. tokenize 并生成 labels/mask；
6. 处理长度、拆分、packing 和 batch；
7. 抽样反解 token，确认工具协议没有损坏。

数据卡没有声明整个集合统一的最大轮数。搜索子集的 10–30 次搜索调用也不是全局上限。完整下载后应在目标 tokenizer 下重新统计 message、tool-call 与 token 长度分布，再决定训练上限。

### 使用边界

Nemotron 可以帮助模型学习通用工具语法、局部路由、连续搜索和部分多轮 policy，但不能自动提供：

- 你的真实业务工具和状态机；
- 所有 API 报错、权限、超时与并发问题；
- 针对目标模型验证过的 chat template 和 loss mask；
- 与你的训练 recipe 对应的收益证据；
- 对真实代码、科研或操作系统环境的端到端保证。

因此更合理的使用方式是：把它作为通用 demonstration 来源和数据工程案例，经过本地审计后加入能力可解释的 mixture，再用冻结环境评测验证迁移。

## 9. 与其他学习模块的关系

```text
Agentic SFT
  固定高质量 demonstration
  → 模仿 teacher action

OPD / online imitation
  student 到达自己的新状态
  → teacher 在这些状态上继续指导

Agentic RL
  policy 与环境交互
  → verifier reward + credit assignment

Benchmark
  冻结 model + harness + tools
  → 只测能力，不产生训练更新
```

SFT 提供初始行为能力，OPD 缓解 student 状态分布与 teacher demonstration 的偏移，RL 通过环境结果优化长期决策，Benchmark 则负责提供不随训练过程移动的证据。训练后的模型仍应在 [BenchDecoded](/benchdecoded/) 所代表的冻结评分链上验证。

## 实践检查表

完成一次最小 Agentic SFT 实验前，应能回答：

1. 目标能力、任务初始状态和成功条件是什么？
2. Tool contract 与真实或模拟 Environment 分别由谁维护？
3. Demonstration 中的参数和 observation 是否有可追踪来源？
4. 语义轨迹正本是否能回放、校验并追踪 provenance？
5. 每个 assistant action 是否能回指当时的模型调用快照？
6. 如果发生过滤或压缩，保存的是实际 summary/压缩项，还是事后猜出的历史？
7. 目标模型使用哪个 tokenizer、chat template 和工具协议？
8. 哪些 assistant token 参与 loss，mask 是否经过反解检查？
9. 逐调用样本何时允许合并，是否证明了严格前缀等价？
10. 过长轨迹怎样处理，是否仍保持工具交互闭合？
11. 训练后用什么冻结环境衡量端到端成功，而不只看 loss？
12. Nemotron 或自采数据是否按 source/tool/domain 谱系切分，而不是随机逐行切分？
13. 比较不同模型和方法时，是否冻结了训练 token 预算、模板、Harness 与解码参数？

## 来源与继续阅读

- [NVIDIA · Nemotron-SFT-Agentic-v2 数据卡](https://huggingface.co/datasets/nvidia/Nemotron-SFT-Agentic-v2)
- [Nemotron · Files](https://huggingface.co/datasets/nvidia/Nemotron-SFT-Agentic-v2/tree/main/data)
- [NVIDIA NeMo RL · Supervised Fine-Tuning](https://docs.nvidia.com/nemo/rl/nightly/guides/sft.html)
- [Hugging Face Transformers · Chat templates](https://huggingface.co/docs/transformers/chat_templating)
- [Hugging Face Transformers · Tokenizer、input_ids 与 attention_mask](https://huggingface.co/docs/transformers/main_classes/tokenizer)
- [Hugging Face Transformers · Tool use](https://huggingface.co/docs/transformers/en/chat_extras)
- [Hugging Face TRL · SFT Trainer](https://huggingface.co/docs/trl/sft_trainer)
- [OpenAI Responses API · 可保存的输入、输出与工具项](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI · 长上下文压缩与不透明 compaction item](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2#4-compaction-extending-effective-context)
- [OpenAI Codex · 自定义 model provider 与 Responses wire API](https://developers.openai.com/codex/config-reference/)
- [OpenAI Codex SDK · 程序化运行本地 Codex Agent](https://developers.openai.com/codex/sdk/)
- [Anthropic · 工具调用 ID 与 tool result 配对](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [Anthropic Claude Code · LLM gateway 的支持边界](https://code.claude.com/docs/en/llm-gateway)
- [上一课：后训练的起点](/learning/post-training-foundations/)
- [同站专题：Agentic RL 的多轮 rollout 与上下文重建](/learning/agentic-rl/)
- [下一课：RL 共同基础](/learning/rl-foundations/)

> **证据边界：** 本页建立的是独立于单一数据集的 Agentic SFT 框架。Nemotron 部分来自数据卡和文件头抽样，尚未完成全量质量统计，也没有在你的训练环境中启动 SFT，因此不声称任何模型收益。
