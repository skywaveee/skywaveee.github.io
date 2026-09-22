import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

// Keep repository-relative Markdown usable in both the kit and the website.
export default function remarkMindspaceLinks() {
  return (tree, file) => {
    const marker = '/src/content/mindspace/';
    const path = String(file.path || '').replaceAll('\\', '/');
    if (!path.includes(marker)) return;
    const current = path.split(marker)[1];
    const manifest = JSON.parse(readFileSync(new URL('../src/content/mindspace/site-manifest.json', import.meta.url), 'utf8'));
    function visit(node) {
      if (node.type === 'link' && node.url && !/^(?:[a-z]+:|\/|#)/i.test(node.url)) {
        const [relative, hash] = node.url.split('#');
        const target = posix.normalize(posix.join(posix.dirname(current), relative));
        const page = manifest.pages.find(page => page.file === target);
        if (page) node.url = `/mindspace/${page.slug}/${hash ? `#${hash}` : ''}`;
        else if (target.startsWith('prompts/') && manifest.files.includes(target)) node.url = `/mindspace/${target}${hash ? `#${hash}` : ''}`;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
