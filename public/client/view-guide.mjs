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
      h('strong', { text: 'PAPER RESEARCH GUIDE. ' }),
      h('span', { text: 'This guide applies to simulated research, not the separate manual live ticket. It is not financial advice, and the "$89 to $55,698" claim that inspired it is unverified.' }),
    ),
  );

  wrap.append(card('Start with Polymarket',
    h('p', { text: 'Open the Polymarket page, fetch public markets, and read the official resolution rules before researching. Supply your own sourced reasoning and probability range. Agent 4 checks liquidity, spread, time, evidence, edge and the paper-risk cap; it is a deterministic checklist, not an AI forecaster.' }),
    h('p', { text: 'Use Positions & results to inspect YES/NO paper bets and skips, then manually record a verified YES or NO settlement. The whole stake is at risk. Crypto stop-loss rules in the original guide below apply only to the optional Crypto tools, not to Polymarket.' }),
    h('p', { class: 'muted small', text: 'Live data may be unavailable if the public API blocks requests. No wallet or credentials are needed. Respect Polymarket’s eligibility and local restrictions; this app does not bypass them.' }),
  ));

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
