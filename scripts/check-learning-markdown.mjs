import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const projectRoot = resolve(import.meta.dirname, '..');
const contentRoot = resolve(projectRoot, 'src', 'content', 'learning');
const forbiddenHtml = /<\/?(?:article|aside|br|div|footer|h[1-6]|header|hr|main|p|section|small|span|strong|table|tbody|td|th|thead|tr)(?:\s|\/?>)/i;

const files = (await readdir(contentRoot))
	.filter((name) => name.endsWith('.md'))
	.sort();

const errors = [];

for (const file of files) {
	const source = await readFile(resolve(contentRoot, file), 'utf8');
	const lines = source.split('\n');
	let fence = null;
	let displayMathDelimiters = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!fence) {
				fence = marker;
			} else if (marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
			continue;
		}

		if (fence) {
			continue;
		}

		if (forbiddenHtml.test(line)) {
			errors.push(`${file}:${index + 1}: 学习正文不应包含展示型 HTML`);
		}

		const boldDelimiters = [...line.matchAll(/\*\*/g)];
		for (let markerIndex = 1; markerIndex < boldDelimiters.length; markerIndex += 2) {
			const closingIndex = boldDelimiters[markerIndex].index + 2;
			const followingCharacter = line[closingIndex];
			if (followingCharacter && !/[\s，。；：！？、）】》,.!?;:)]/u.test(followingCharacter)) {
				errors.push(`${file}:${index + 1}: 加粗结束后接正文时应留一个空格`);
				break;
			}
		}

		if (/^\s*\$\$\s*$/.test(line)) {
			displayMathDelimiters += 1;
		}
	}

	if (fence) {
		errors.push(`${file}: 代码围栏未闭合`);
	}

	if (displayMathDelimiters % 2 !== 0) {
		errors.push(`${file}: 独立公式的 $$ 分隔符没有成对出现`);
	}
}

if (errors.length > 0) {
	console.error('Learning Markdown portability check failed:\n');
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exitCode = 1;
} else {
	console.log(`Checked ${files.length} learning Markdown files: portable content rules passed.`);
}
