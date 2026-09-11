# 学习知识库内容写作规范

本规范适用于 `src/content/learning/*.md`。这些 Markdown 文件是学习知识库的内容正本；Astro 生成的 HTML 是展示产物，不应反过来决定正文怎样写。

## 核心原则

1. **内容优先可移植。** 正文使用 GitHub Flavored Markdown，以及 `$...$`、`$$...$$` 数学公式。
2. **展示交给网站。** 字体、颜色、间距、浅色代码块、滚动区域和首段引言样式由 CSS 或 Astro 处理。
3. **正文不写展示型 HTML。** 不在学习文章中使用 `<div>`、`<span>`、`<strong>`、`<small>`、`<section>`、HTML 表格等标签。
4. **信息不能只存在于视觉结构中。** 即使离开网站，标题、步骤、对照关系、警告和证据边界仍要完整可读。

## 内容结构

每篇文章保留 frontmatter，并至少包含：

- 一个一级标题；
- 标题后的引言段落；
- 按知识依赖组织的二级、三级标题；
- 关键概念、流程、例子、边界和来源。

标题后的第一个普通段落会在网站中自动显示为引言块，不需要额外 HTML 包裹。

## 选择合适的 Markdown 结构

### 有顺序的过程

使用有序列表，每一步采用“粗体名称 + 一句话说明”：

```md
1. **采集轨迹：** 保存完整的消息、工具调用与环境返回。
2. **校验轨迹：** 检查 schema、调用对应关系和终止状态。
3. **构造样本：** 应用模板、tokenizer 和 loss mask。
```

### 无顺序的要点或风险

使用无序列表：

```md
- **模板错位：** 模型看到的控制 token 与训练期不一致。
- **参数幻觉：** 工具参数无法回指当前可见上下文。
```

### 一组明确映射或对照

使用 Markdown 表格：

```md
| 区段 | Loss mask | 含义 |
|---|---:|---|
| user | 0 | 输入条件 |
| assistant action | 1 | 训练目标 |
```

### 提醒、误区和证据边界

使用普通引用块，让基础 Markdown 阅读器也能完整显示：

```md
> **注意：** 不要把 tool observation 当成 policy action 计算 loss。
```

## 加粗、代码和链接

- 加粗使用 `**内容**`，不用 `<strong>`。
- 加粗结束后若继续写正文，必须留一个空格，例如 `**结论：** 正文`；否则一些 CommonMark 渲染器会把星号原样显示。
- 行内字段、命令、文件名和标识符使用反引号。
- 多行代码使用带语言名称的 fenced code block，例如 `json`、`python`、`text`。
- 长代码块由网站统一限制最大高度；文章中不写滚动容器。
- 本站页面使用根路径链接，例如 `[PPO](/learning/ppo/)`；外部证据直接链接原始来源。

## 数学公式

行内公式使用单个美元符号：

```md
策略记作 $\pi_\theta$。
```

独立公式前后留空行，并让 `$$` 单独占一行：

```md
$$
\ell_{i,t}^{\mathrm{roll}}=
\log\pi_{\mathrm{roll}}\left(
a_{i,t}^{\mathrm{tok}}\mid p_i^{\mathrm{tok}},a_{i,<t}^{\mathrm{tok}}
\right)
$$
```

多行对齐可使用 KaTeX 与 MathJax 都支持的 `aligned`：

```md
$$
\begin{aligned}
J(\theta)
&=\mathbb{E}_{\tau\sim\pi_\theta}[R(\tau)] \\
&=\sum_\tau \pi_\theta(\tau)R(\tau)
\end{aligned}
$$
```

不要把公式放进原始 HTML、代码块或表格单元格。网站使用 `remark-math` 与 `rehype-katex`；GitHub 使用 MathJax，VS Code Markdown Preview 使用 KaTeX。不同渲染器支持的宏并不完全相同，因此优先使用基础 LaTeX 命令，避免自定义宏。

参考：

- [GitHub：Writing mathematical expressions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions)
- [VS Code：Markdown and Visual Studio Code](https://code.visualstudio.com/docs/languages/markdown)
- [Astro：Markdown in Astro](https://docs.astro.build/en/guides/markdown-content/)

## 教学与证据要求

- 第一次出现缩写时解释全称或职责。
- 公式之后补一句自然语言解释，不能只给符号。
- 区分“数据卡或论文声称”“本地抽样观察”“已经运行验证”。
- 外部事实附来源；尚未运行的流程不能写成已经复现。
- 流程图、表格和列表不能重复同一段信息；保留最容易读懂的一种表达。

## 提交前检查

```bash
npm run check:learning-content
npm run build
```

自动检查会拒绝学习正文中的展示型 HTML、不兼容的加粗连接、未闭合代码围栏和不成对的 `$$`。构建通过后仍应抽查公式、表格、长代码滚动和移动端阅读效果。
