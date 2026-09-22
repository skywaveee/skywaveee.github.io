# skywaveee.github.io

Personal research website and learning hub for `skywaveee`.

The homepage introduces ywaveee, a fourth-year PhD student at Tsinghua University, the current internship at Zhipu AI, and current research interests in Agents, Post-training, and Self-evolution. It features selected knowledge-base entries and a note about future updates. The light purple homepage presentation is isolated in `src/pages/index.astro` and `src/styles/home.css`.

The homepage links two complementary surfaces:

- `/learning/` — a ten-part Agent Learning curriculum spanning post-training foundations, Agentic SFT, RL foundations, PPO, reward/verifiers, GRPO, OPD, multi-turn Agentic RL, training systems, and evaluation;
- `/benchdecoded/` — executable benchmark walkthroughs synced from the sibling repository.

## Learning content

The Markdown files in `src/content/learning/` are the canonical source for the learning library. Write portable Markdown and keep presentation in Astro/CSS so the same document remains readable on the website, GitHub, and Markdown previewers.

See [Learning knowledge-base content authoring](docs/CONTENT_AUTHORING.md) for the required structure, math conventions, supported content patterns, and validation command.

## BenchDecoded content

The site does not duplicate project content by hand. Before every local development session or production build, `scripts/sync-benchdecoded.mjs` copies public Markdown and JSON from the BenchDecoded repository into generated Astro content.

Local development uses the sibling repository by default:

```text
<workspace>/
├── benchdecoded/
└── skywaveee.github.io/
```

GitHub Actions checks out both repositories and performs the same build. The workflow also runs on a schedule so newly pushed BenchDecoded Markdown is published without editing this website repository.

Local-only files such as `CLAUDE.md`, `AGENTS.md`, hidden tool configuration, and personal context are explicitly excluded from the content sync.

## Commands

```bash
npm install
npm run dev
npm run build
npm run preview
```

To build from a different checkout:

```bash
BENCHDECODED_SOURCE=/absolute/path/to/benchdecoded npm run build
```

## Deployment

The GitHub repository must be named `skywaveee.github.io`. In repository settings, configure Pages to use **GitHub Actions**. Pushing the website repository to `main` triggers deployment.

The scheduled workflow checks the public `skywaveee/benchdecoded` repository hourly. Immediate cross-repository deployment can be added later with a `repository_dispatch` event and a narrowly scoped GitHub token.


## Mindspace

新增 `/mindspace/` 项目页，以及快速开始、工作方法和教学示例三篇指南。首页、Learning 与 BenchDecoded 导航均有入口。

内容正本在相邻的 `mindspace` 公开模板目录。构建前运行 `npm run sync:mindspace`，只复制其 `site-manifest.json` 中显式列出的文件，生成 `src/content/mindspace/` 快照和 `public/downloads/mindspace-v0.1.zip`。这些生成内容需要随网站提交，以便首次发布或远程仓库临时不可用时仍能构建。

可通过 `MINDSPACE_SOURCE` 指定公开仓库路径；明确指定但不存在的路径会报错。未指定且相邻仓库不存在时，使用已提交的快照。不要将该变量指向私人研究空间。

GitHub Actions 在现有每小时构建中尝试检出 `skywaveee/mindspace` 的 `main` 分支，并同步最新内容；检出失败则记录回退提示，使用快照。模板仓库发布在前、网站发布在后；完整命令由维护者本人执行。
