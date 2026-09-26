import type { ElementHandle, JSHandle, Locator, Page } from 'playwright';
import type { Candidate } from './types.js';

/**
 * Candidate collection: every visible element a user could operate, described only by what the
 * browser can observe. Two sources, because React attaches click handlers invisibly:
 *   1. semantic interactive elements (button, a[href], form controls, interactive ARIA roles, tabindex)
 *   2. the outermost element of any `cursor: pointer` region (e.g. the <li> device rows with onClick)
 * Roles are computed here approximately and then CONFIRMED with Playwright's own accessibility engine
 * (`getByRole`) before a candidate is ever used — see `locatorFor()`. (Playwright 1.63 has no
 * page.accessibility API; getByRole/ariaSnapshot are the supported mechanisms.)
 */

export interface CandidateSet {
  candidates: Candidate[];
  handle: JSHandle<Element[]>;
  page: { title: string; path: string; landmarks: string[] };
  dispose: () => Promise<void>;
}

export async function collectCandidates(page: Page): Promise<CandidateSet> {
  const handle = (await page.evaluateHandle(() => {
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [tabindex]:not([tabindex="-1"])';
    const set = new Set<Element>(Array.from(document.querySelectorAll(sel)));
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      const p = el.parentElement;
      if (!p || getComputedStyle(p).cursor !== 'pointer') set.add(el);
    }
    // Document order, deterministic.
    return Array.from(set).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  })) as JSHandle<Element[]>;

  const described = await handle.evaluate((els) => {
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const implicitRole = (el: Element): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.split(/\s+/)[0];
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'li') return 'listitem';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.getAttribute('type') ?? 'text').toLowerCase();
        return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider' } as Record<string, string>)[t] ?? 'textbox';
      }
      return 'generic';
    };
    const nameOf = (el: Element): string => {
      const label = el.getAttribute('aria-label');
      if (label) return norm(label);
      const by = el.getAttribute('aria-labelledby');
      if (by) return norm(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
      const text = norm((el as HTMLElement).innerText ?? el.textContent);
      if (text) return text;
      return norm(el.getAttribute('title') ?? el.getAttribute('alt') ?? (el as HTMLInputElement).placeholder ?? '');
    };
    const LANDMARK: Record<string, string> = { header: 'banner', main: 'main', aside: 'complementary', nav: 'navigation', footer: 'contentinfo', form: 'form' };
    const contextOf = (el: Element): { chain: string; heading: string | null } => {
      const parts: string[] = [];
      let heading: string | null = null;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const tag = p.tagName.toLowerCase();
        const role = p.getAttribute('role') ?? LANDMARK[tag] ?? (tag === 'section' ? 'region' : tag === 'ul' || tag === 'ol' ? 'list' : null);
        const label = p.getAttribute('aria-label');
        if (!heading && (tag === 'section' || role === 'region' || role === 'group')) {
          const h = p.querySelector('h1,h2,h3,h4,h5,h6');
          if (h) heading = norm(h.childNodes[0]?.textContent ?? h.textContent).toLowerCase() || null;
        }
        if (role || label) parts.unshift(`${role ?? tag}${label ? `:${norm(label).toLowerCase()}` : ''}`);
      }
      return { chain: parts.join(' > '), heading };
    };
    return els.map((el, index) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const ctx = contextOf(el);
      const attrs: Record<string, string> = {};
      for (const a of ['type', 'name', 'id']) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v;
      }
      const href = el.getAttribute('href');
      if (href) attrs.href_path = href.replace(/^https?:\/\/[^/]+/, '');
      return {
        id: `candidate-${index + 1}`,
        index,
        tag: el.tagName.toLowerCase(),
        role: implicitRole(el),
        name: nameOf(el).slice(0, 120),
        text: norm((el as HTMLElement).innerText ?? el.textContent).slice(0, 120),
        testid: el.getAttribute('data-testid'),
        aria_label: el.getAttribute('aria-label'),
        aria_pressed: el.getAttribute('aria-pressed'),
        title: el.getAttribute('title'),
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0,
        context: ctx.chain,
        heading: ctx.heading,
        attrs,
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      };
    });
  });

  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    path: location.pathname,
    landmarks: Array.from(document.querySelectorAll('header, main, aside, nav, [role=group][aria-label], section h2')).map((e) => {
      const tag = e.tagName.toLowerCase();
      return tag === 'h2' ? `section:${(e.childNodes[0]?.textContent ?? '').trim()}` : `${e.getAttribute('role') ?? tag}${e.getAttribute('aria-label') ? `:${e.getAttribute('aria-label')}` : ''}`;
    }),
  }));

  return { candidates: described, handle, page: pageInfo, dispose: () => handle.dispose() };
}

export async function elementOf(set: CandidateSet, c: Candidate): Promise<ElementHandle<Element>> {
  return (await set.handle.evaluateHandle((els, i) => els[i], c.index)) as ElementHandle<Element>;
}

/**
 * Build a Locator that selects exactly this element, using Playwright's role engine:
 * getByRole(role).nth(k) where the k-th match IS the element. Doubles as role confirmation —
 * if Playwright does not compute the same role, no locator is returned and the candidate is unusable.
 */
export async function locatorFor(page: Page, set: CandidateSet, c: Candidate): Promise<{ locator: Locator | null; role_confirmed: boolean; name_confirmed: boolean }> {
  const el = await elementOf(set, c);
  try {
    const byRole = page.getByRole(c.role as Parameters<Page['getByRole']>[0]);
    const n = await byRole.count();
    for (let k = 0; k < n; k++) {
      if (await byRole.nth(k).evaluate((node, target) => node === target, el)) {
        let name_confirmed = false;
        if (c.name) {
          const byName = page.getByRole(c.role as Parameters<Page['getByRole']>[0], { name: c.name, exact: true });
          const m = await byName.count();
          for (let j = 0; j < m && !name_confirmed; j++) name_confirmed = await byName.nth(j).evaluate((node, target) => node === target, el);
        }
        return { locator: byRole.nth(k), role_confirmed: true, name_confirmed };
      }
    }
    return { locator: null, role_confirmed: false, name_confirmed: false };
  } finally {
    await el.dispose();
  }
}
