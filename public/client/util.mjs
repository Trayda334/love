/** util.mjs - tiny DOM + fetch helpers. No dependencies. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(4)) if (c) f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return f;
};

export const fmtUsd = (n, d = 2) =>
  Number.isFinite(Number(n)) ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : 'n/a';

export const fmtNum = (n, d = 2) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d }) : 'n/a');

export const fmtPrice = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'n/a';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(6);
  return v.toPrecision(6);
};

export const fmtPct = (n, d = 2) => (Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(d)}%` : 'n/a');

export const fmtTime = (iso) => {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const ago = (iso) => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export function pill(text, kind = 'neutral', title = '') {
  return h('span', { class: `pill pill-${kind}`, text, title });
}

export function badgeForQuality(quality = '') {
  const q = String(quality);
  if (q.startsWith('DEMO')) return pill('DEMO DATA - not real market data', 'danger', quality);
  if (q.startsWith('LIVE')) return pill(quality, 'good');
  if (q.startsWith('USER')) return pill('USER-PROVIDED', 'warn', quality);
  return pill(quality || 'unknown', 'neutral');
}

export function verdictPill(verdict) {
  const map = {
    PASS: 'good', APPROVE: 'good', TICKET: 'good', WIN: 'good', BET: 'good',
    SKIP: 'warn', REJECT: 'danger', BLOCK: 'danger', BLOCKED: 'danger', LOSS: 'danger',
    BREAKEVEN: 'neutral', OPEN: 'accent',
  };
  return pill(verdict || 'n/a', map[verdict] || 'neutral');
}

export function toast(message, kind = 'info', ms = 5200) {
  let host = $('#toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${kind}`, text: message });
  host.append(el);
  setTimeout(() => el.classList.add('toast-out'), ms - 400);
  setTimeout(() => el.remove(), ms);
}

export async function copyText(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'good');
  } catch {
    const ta = h('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(label, 'good');
  }
}

export function card(title, ...body) {
  return h('section', { class: 'card' }, title ? h('h3', { class: 'card-title', text: title }) : null, ...body);
}

export function kv(label, value, cls = '') {
  return h('div', { class: `kv ${cls}` }, h('span', { class: 'kv-k', text: label }), h('span', { class: 'kv-v' }, value instanceof Node ? value : String(value ?? 'n/a')));
}

export function checksTable(checks = []) {
  if (!checks.length) return h('p', { class: 'muted', text: 'No checks recorded.' });
  return h(
    'table',
    { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Check' }), h('th', { text: 'Status' }), h('th', { text: 'Value' }), h('th', { text: 'Threshold' }), h('th', { text: 'Why' }))),
    h(
      'tbody',
      {},
      ...checks.map((c) =>
        h('tr', { class: c.status === 'trigger' ? 'row-bad' : c.status === 'unknown' || c.status === 'note' ? 'row-warn' : '' },
          h('td', { text: c.label }),
          h('td', {}, pill(c.status, c.status === 'pass' ? 'good' : c.status === 'trigger' ? 'danger' : c.status === 'unknown' ? 'warn' : 'neutral')),
          h('td', { class: 'mono', text: c.value === null || c.value === undefined ? '—' : String(c.value) }),
          h('td', { class: 'mono muted', text: c.threshold || '—' }),
          h('td', { class: 'small', text: c.reason || '' }),
        ),
      ),
    ),
  );
}

/** Simple modal. Returns the dialog element; caller fills the body. */
export function modal(title, body, actions = []) {
  const close = () => overlay.remove();
  const dialog = h('div', { class: 'modal' }, h('h3', { text: title }), h('div', { class: 'modal-body' }, body));
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, dialog);
  if (actions.length) {
    dialog.append(h('div', { class: 'modal-actions' }, ...actions.map((a) => h('button', { class: `btn ${a.class || ''}`, text: a.label, onclick: () => a.onClick(close) }))));
  } else {
    dialog.append(h('div', { class: 'modal-actions' }, h('button', { class: 'btn', text: 'Close', onclick: close })));
  }
  document.body.append(overlay);
  return { overlay, dialog, close };
}

export function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const { close } = modal(title, h('p', { text: message }), [
      { label: 'Cancel', onClick: (c) => { c(); resolve(false); } },
      { label: confirmLabel, class: 'btn-danger', onClick: (c) => { c(); resolve(true); } },
    ]);
    void close;
  });
}
