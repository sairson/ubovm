'use strict';

// Myers line diff with a bounded work budget. Large rewrites report an explicit
// upper bound instead of blocking the extension host or pretending it is exact.
function lineChanges(before, after) {
  if (before === after) return { added: 0, removed: 0, approximate: false };
  const lines = text => (text ?? '').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(before), b = lines(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n || !m) return { added: m, removed: n, approximate: false };
  let frontier = new Map([[1, 0]]), work = 0;
  for (let distance = 0; distance <= n + m; distance++) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 1000000) return { added: m, removed: n, approximate: true };
      let x = diagonal === -distance || diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1)
        ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        if (++work > 1000000) return { added: m, removed: n, approximate: true };
        x++; y++;
      }
      if (x >= n && y >= m) return { added: (distance + m - n) / 2, removed: (distance + n - m) / 2, approximate: false };
      next.set(diagonal, x);
    }
    frontier = next;
  }
}

module.exports = { lineChanges };
