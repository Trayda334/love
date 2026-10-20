/**
 * md.mjs - a deliberately small Markdown renderer for the in-app guide.
 * Supports: # headings, lists (2-space nesting), paragraphs, **bold**, *italic*,
 * `inline code`, fenced code blocks, > quotes, --- rules and [links](url).
 * That is exactly what the guide documents use - no more.
 */

import { h } from './util.mjs';

const inline = (text) => {
  const frag = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) frag.append(h('strong', { text: tok.slice(2, -2) }));
    else if (tok.startsWith('`')) frag.append(h('code', { text: tok.slice(1, -1) }));
    else if (tok.startsWith('*')) frag.append(h('em', { text: tok.slice(1, -1) }));
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      const external = /^https?:/.test(mm[2]);
      frag.append(h('a', { href: mm[2], target: external ? '_blank' : null, rel: external ? 'noreferrer' : null, text: mm[1] }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
};

export function renderMarkdown(markdown, { onHeading } = {}) {
  const wrap = h('div', { class: 'md' });
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const listStack = [];

  const closeLists = (depth = 0) => {
    while (listStack.length > depth) wrap.append(listStack.pop());
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      closeLists();
      wrap.append(h('pre', { class: 'prompt', text: buf.join('\n') }));
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^---+$/.test(line.trim())) { i++; closeLists(); wrap.append(h('hr')); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      closeLists();
      const text = heading[2];
      const el = h(`h${Math.min(level + 1, 5)}`, { class: `md-h md-h${level}` }, inline(text));
      if (onHeading && level <= 2) onHeading(text, el);
      wrap.append(el);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeLists();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      wrap.append(h('blockquote', { class: 'md-quote' }, renderMarkdown(buf.join('\n'))));
      continue;
    }

    const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line);
    const ordered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const indent = ((bullet || ordered)[1] || '').length;
      const depth = Math.floor(indent / 2) + 1;
      const tag = ordered ? 'ol' : 'ul';
      while (listStack.length < depth) listStack.push(h(tag, { class: 'md-list' }));
      while (listStack.length > depth) wrap.append(listStack.pop());
      const top = listStack[listStack.length - 1];
      if (top.tagName.toLowerCase() !== tag && top.children.length === 0) {
        listStack[listStack.length - 1] = h(tag, { class: 'md-list' });
      }
      listStack[listStack.length - 1].append(h('li', {}, inline(bullet ? bullet[3] : ordered[2])));
      i++;
      continue;
    }

    closeLists();
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i]) && !/^>/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    wrap.append(h('p', {}, inline(buf.join(' '))));
  }
  closeLists();
  return wrap;
}
