# skywaveee.github.io

Personal website and project hub for `skywaveee`.

The homepage intentionally remains blank until its visual identity is designed. The first project route is `/benchdecoded/`.

## BenchDecoded content

The site does not duplicate project Markdown by hand. Before every local development session or production build, `scripts/sync-benchdecoded.mjs` copies public Markdown from the BenchDecoded repository into generated Astro content.

Local development uses the sibling repository by default:

```text
/Users/yuuweii/Documents/code/skywaveee/
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
