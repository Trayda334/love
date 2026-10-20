/**
 * chart.mjs - thin wrapper around Chart.js (loaded as a local vendored file).
 * If the vendored file is missing the app still works: it says so instead of
 * pretending a chart is there.
 */

let missing = false;

export function chartAvailable() {
  return typeof window.Chart !== 'undefined' && !missing;
}

export function noteIfMissing(host) {
  if (chartAvailable()) return false;
  host.append(
    Object.assign(document.createElement('p'), {
      className: 'muted small',
      textContent: 'Chart.js is not available locally, so this chart is skipped. Everything else still works.',
    }),
  );
  return true;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function themed(options = {}) {
  const grid = 'rgba(148,163,184,0.12)';
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: css('--text-dim') || '#94a3b8', boxWidth: 12, font: { size: 11 } } },
      tooltip: { backgroundColor: 'rgba(10,15,25,0.95)', borderColor: grid, borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#cbd5e1' },
    },
    scales: {
      x: { ticks: { color: css('--text-dim') || '#94a3b8', maxTicksLimit: 6, font: { size: 10 } }, grid: { color: grid } },
      y: { ticks: { color: css('--text-dim') || '#94a3b8', font: { size: 10 } }, grid: { color: grid } },
    },
  };
  return { ...base, ...options, plugins: { ...base.plugins, ...(options.plugins || {}) }, scales: { ...base.scales, ...(options.scales || {}) } };
}

export function priceChart(canvas, candles, { stop = null, target = null, entryArea = null, token = '' } = {}) {
  if (!chartAvailable()) return null;
  const labels = candles.map((c) => new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const datasets = [
    { label: `${token} price`, data: candles.map((c) => c.c), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.14)', borderWidth: 1.6, pointRadius: 0, fill: true, tension: 0.15 },
  ];
  if (Number.isFinite(stop)) datasets.push({ label: 'Stop (invalidation)', data: labels.map(() => stop), borderColor: '#f87171', borderWidth: 1.2, borderDash: [6, 4], pointRadius: 0, fill: false });
  if (Number.isFinite(target)) datasets.push({ label: 'Target', data: labels.map(() => target), borderColor: '#4ade80', borderWidth: 1.2, borderDash: [6, 4], pointRadius: 0, fill: false });
  if (entryArea && Number.isFinite(entryArea.low)) datasets.push({ label: 'Entry area top', data: labels.map(() => entryArea.high), borderColor: '#fbbf24', borderWidth: 1, pointRadius: 0, fill: false });
  if (entryArea && Number.isFinite(entryArea.low)) datasets.push({ label: 'Entry area bottom', data: labels.map(() => entryArea.low), borderColor: '#fbbf24', borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false });

  return new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: themed({ scales: { y: { ticks: { color: '#94a3b8', font: { size: 10 } } } } }),
  });
}

export function volumeChart(canvas, candles) {
  if (!chartAvailable()) return null;
  return new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels: candles.map((c) => new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      datasets: [{ label: 'Volume (base units)', data: candles.map((c) => c.v), backgroundColor: candles.map((c) => (c.c >= c.o ? 'rgba(74,222,128,0.55)' : 'rgba(248,113,113,0.55)')) }],
    },
    options: themed({ plugins: { legend: { display: false } } }),
  });
}

export function equityChart(canvas, curve) {
  if (!chartAvailable()) return null;
  const points = curve.filter((p) => Number.isFinite(p.equity));
  return new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map((p, i) => (p.label === 'start' ? 'start' : `#${i}`)),
      datasets: [{ label: 'Paper equity (USD)', data: points.map((p) => p.equity), borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.15)', borderWidth: 2, pointRadius: 2, fill: true, tension: 0.2 }],
    },
    options: themed({ plugins: { legend: { display: false } } }),
  });
}

export function blockChart(canvas, blockedByAgent = {}) {
  if (!chartAvailable()) return null;
  const labels = Object.keys(blockedByAgent);
  if (!labels.length) {
    labels.push('no blocks yet');
    blockedByAgent = { 'no blocks yet': 0 };
  }
  return new window.Chart(canvas, {
    type: 'bar',
    data: { labels: labels.map((l) => l.replace(/([A-Z])/g, ' $1').trim()), datasets: [{ label: 'Blocked setups by agent', data: labels.map((l) => blockedByAgent[l]), backgroundColor: 'rgba(251,191,36,0.6)' }] },
    options: themed({ indexAxis: 'y', plugins: { legend: { display: false } } }),
  });
}
