import { readFile, writeFile, mkdir, stat, lstat, rm } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.MINDSPACE_SOURCE || resolve(root, '..', 'mindspace'));
const snapshot = resolve(root, 'src/content/mindspace');
const exists = async (path) => { try { return (await stat(path)).isDirectory(); } catch { return false; } };
const from = await exists(source) ? source : snapshot;
if (process.env.MINDSPACE_SOURCE && from === snapshot) throw new Error(`MINDSPACE_SOURCE does not exist: ${source}`);
if (from === snapshot) console.log('Mindspace: using the committed public snapshot.');
const manifest = JSON.parse(await readFile(resolve(from, 'site-manifest.json'), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.pages)) throw new Error('Invalid Mindspace public manifest');
const entries = [];
const seen = new Set();
for (const name of manifest.files) {
  if (typeof name !== 'string' || name.includes('\\') || isAbsolute(name) || name.split('/').some(p => !p || p === '..' || p === '.' || (p.startsWith('.') && p !== '.gitignore')) || seen.has(name)) throw new Error(`Unsafe or duplicate public path: ${name}`);
  seen.add(name);
  let parent = from;
  for (const segment of name.split('/')) {
    parent = resolve(parent, segment);
    if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Public files must not be symlinks: ${name}`);
  }
  if (!/\.(md|json|svg|py)$/.test(name) && !['LICENSE', '.gitignore', 'template/.gitignore'].includes(name)) throw new Error(`Unexpected public file type: ${name}`);
  const data = await readFile(resolve(from, name));
  if (data.length > 2_000_000) throw new Error(`Public file is unexpectedly large: ${name}`);
  entries.push({ name, data });
}
for (const required of ['README.md','site.json','site-manifest.json','assets/mindspace.svg','scripts/init.py','template/HOME.md','template/WORKFLOW.md']) if (!seen.has(required)) throw new Error(`Missing required public file: ${required}`);
const slugs = new Set();
for (const page of manifest.pages) {
  if (!seen.has(page.file) || !/^docs\/[a-z-]+\.md$/.test(page.file) || !/^[a-z-]+$/.test(page.slug) || slugs.has(page.slug)) throw new Error('Invalid public page');
  slugs.add(page.slug);
}
// Validate the complete allowlist before replacing the generated snapshot.
if (from !== snapshot) {
  await rm(snapshot, { recursive: true, force: true });
  for (const { name, data } of entries) {
    const target = resolve(snapshot, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}
// Deterministic, uncompressed ZIP: no dependencies, timestamps or machine paths.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let n=0;n<8;n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
const locals = [], centrals = [];
let offset = 0;
for (const { name, data } of entries.toSorted((a,b) => a.name < b.name ? -1 : 1)) {
  const filename = Buffer.from(`mindspace/${name}`), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6); local.writeUInt16LE(33,12);
  local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(filename.length,26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x800,8); central.writeUInt16LE(33,14);
  central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(filename.length,28); central.writeUInt32LE(offset,42);
  locals.push(local,filename,data); centrals.push(central,filename); offset += local.length+filename.length+data.length;
}
const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
const output = resolve(root,'public/downloads/mindspace-v0.1.zip');
await mkdir(dirname(output),{recursive:true});
await writeFile(output,Buffer.concat([...locals,directory,end]));
await mkdir(resolve(root,'public/mindspace'),{recursive:true});
await writeFile(resolve(root,'public/mindspace/cover.svg'), entries.find(e => e.name === 'assets/mindspace.svg').data);
console.log(`Mindspace: ${entries.length} public files, ${manifest.pages.length} guides, reproducible download (${relative(root,output)}).`);

// Expose only allowlisted prompt files linked from the rendered guides.
const promptDirectory = resolve(root, "public/mindspace/prompts");
await rm(promptDirectory, { recursive: true, force: true });
await mkdir(promptDirectory, { recursive: true });
for (const {name, data} of entries.filter(entry => /^prompts\/[a-z-]+\.md$/.test(entry.name))) {
  await writeFile(resolve(root, "public/mindspace", name), data);
}
