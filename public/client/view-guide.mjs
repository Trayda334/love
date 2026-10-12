/**
 * view-guide.mjs - the setup guide, rendered from docs/SETUP_GUIDE.md so the
 * document and the app can never drift apart. All six copy-paste prompts come
 * straight from the agent modules.
 */

import { h, toast, card, copyText } from './util.mjs';
import { renderMarkdown } from './md.mjs';

export async function renderGuide(ctx) {
  const wrap = h('div', { class: 'stack' });
  const toc = h('div', { class: 'toc' });
  const doc = h('div', { class: 'doc' }, h('p', { class: 'muted', text: 'Loading the guide…' }));

  wrap.append(
    h('div', { class: 'strip strip-paper' },
      h('strong', { text: 'PAPER MODE ONLY. ' }),
      h('span', { text: 'This guide is for testing whether a six-agent system can follow rules. It is not financial advice, and the "$89 to $55,698" claim that inspired it is unverified.' }),
    ),
  );

  wrap.append(card('Prompts ready to copy',
    h('p', { class: 'muted small', text: 'The six agent prompts live in the code, so what you copy here is exactly what the deterministic engine enforces. Paste a prompt into Grok/ChatGPT together with the numbers from the desk - never on its own, because a model does not know today\'s price.' }),
    h('div', { class: 'row row-gap' }, ...ctx.state.agents.map((a) =>
      h('button', { class: 'btn btn-mini', text: `Copy Agent ${a.n} prompt`, onclick: () => copyText(a.prompt, `Agent ${a.n} (${a.name}) prompt copied.`) }),
    )),
  ));

  wrap.append(toc);
  wrap.append(doc);

  (async () => {
    try {
      const res = await fetch('/docs/SETUP_GUIDE.md');
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();
      const links = [];
      const rendered = renderMarkdown(text, { onHeading: (title, el) => links.push({ title, el }) });
      doc.replaceChildren(rendered);
      toc.replaceChildren(
        h('h3', { class: 'card-title', text: 'Contents' }),
        h('ul', { class: 'small' }, ...links.map((l) => h('li', {}, h('a', { href: '#', text: l.title, onclick: (e) => { e.preventDefault(); l.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } })))),
      );
    } catch (err) {
      doc.replaceChildren(h('p', { class: 'down', text: `Could not load docs/SETUP_GUIDE.md (${err.message}). The same document is in the repository root under docs/.` }));
      toast('Guide markdown could not be loaded.', 'warn');
    }
  })();

  return wrap;
}
