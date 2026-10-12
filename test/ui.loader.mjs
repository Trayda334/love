/**
 * ui.loader.mjs - ESM resolver hook used only by the UI smoke test.
 *
 * The browser client imports shared market math with browser-absolute paths
 * (`/shared/feedcore.mjs`), which the server maps to `src/shared/`. jsdom cannot
 * execute module scripts, so the test imports the client modules directly and
 * this hook teaches Node the same mapping the server uses.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/shared/')) {
    const url = new URL(`../src/shared/${specifier.slice('/shared/'.length)}`, import.meta.url);
    return { url: url.href, shortCircuit: true };
  }
  if (specifier.startsWith('/client/')) {
    const url = new URL(`../public/client/${specifier.slice('/client/'.length)}`, import.meta.url);
    return { url: url.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
