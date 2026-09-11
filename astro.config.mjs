// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

// https://astro.build/config
export default defineConfig({
	site: 'https://skywaveee.github.io',
	output: 'static',
	markdown: {
		shikiConfig: {
			theme: 'github-light',
		},
		processor: unified({
			remarkPlugins: [remarkMath],
			rehypePlugins: [rehypeKatex],
		}),
	},
});
