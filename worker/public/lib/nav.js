// The header navigation every form shares (Dean, 2026-09-24): the same pills,
// in the same order, on every page — including the one you are already on,
// shown rather than hidden, so the row itself never changes shape as you move
// around. Ordered by the process, not alphabetically: a delivery is booked in
// (Goods In), sits in storage until it is used or thrown away (Stock),
// becomes a batch (Batching, and Batches for one already started), leaves for
// a customer (Dispatch), and the two screens that are not a step in that
// chain — Count and Reports — come last.
export const NAV = [
  { path: '/', label: 'Goods In' },
  { path: '/stock', label: 'Stock' },
  { path: '/batching', label: 'Batching' },
  { path: '/batches', label: 'Batches', badgeId: 'open-count' },
  { path: '/dispatch', label: 'Dispatch' },
  { path: '/count', label: 'Count' },
  { path: '/reports', label: 'Reports' },
];

// Fills `container` (a `<nav>` already sitting in the page's header) with one
// pill per page. The current page is a pill too, not a link — there is
// nowhere for it to go — marked `aria-current` so it can be told apart from
// the sighted, visual styling that also marks it.
export function mountNav(container, currentPath) {
  container.replaceChildren();
  for (const item of NAV) {
    const here = item.path === currentPath;
    const el = document.createElement(here ? 'span' : 'a');
    el.className = `pill nav-pill${here ? ' current' : ''}`;
    el.append(item.label);
    if (item.badgeId) {
      const badge = document.createElement('span');
      badge.id = item.badgeId;
      el.append(badge);
    }
    if (here) el.setAttribute('aria-current', 'page');
    else el.href = item.path;
    container.append(el);
  }
}
