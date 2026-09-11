import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(
	process.env.BENCHDECODED_SOURCE ?? resolve(projectRoot, '..', 'benchdecoded'),
);
const destinationRoot = resolve(projectRoot, 'src', 'content', 'benchdecoded');

const ignoredDirectories = new Set(['.git', '.github', '.claude', '.cursor', '.codex', 'node_modules']);
const ignoredFiles = new Set(['AGENTS.md', 'CLAUDE.md']);

async function sourceExists() {
	try {
		return (await stat(sourceRoot)).isDirectory();
	} catch {
		return false;
	}
}

async function collectPublicContent(directory) {
	const files = [];

	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) {
			continue;
		}

		const absolutePath = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectPublicContent(absolutePath)));
			continue;
		}

		if (
			entry.isFile() &&
			(entry.name.toLowerCase().endsWith('.md') ||
				entry.name.toLowerCase().endsWith('.json')) &&
			!ignoredFiles.has(entry.name)
		) {
			files.push(absolutePath);
		}
	}

	return files;
}

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });

if (!(await sourceExists())) {
	throw new Error(
		`BenchDecoded source was not found at ${sourceRoot}. ` +
			'Set BENCHDECODED_SOURCE to a checked-out repository path.',
	);
}

const publicFiles = await collectPublicContent(sourceRoot);

for (const sourceFile of publicFiles) {
	const relativePath = relative(sourceRoot, sourceFile);
	const destinationFile = resolve(destinationRoot, relativePath);
	await mkdir(dirname(destinationFile), { recursive: true });
	await cp(sourceFile, destinationFile);
}

const displaySource = sourceRoot.split(sep).join('/');
console.log(`Synced ${publicFiles.length} public content file(s) from ${displaySource}.`);
