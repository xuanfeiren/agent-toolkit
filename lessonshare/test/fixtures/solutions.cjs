// Parametric solutions for the toy task. Each flag is one independent, stackable technique.
// Used by the scripted fake writers; not shipped to real writers.
function makeSolution(f = {}) {
  const L = []
  L.push('function solve(input, api) {', '  const orders = input.orders, queries = input.queries')
  if (f.memo) L.push('  const P = new Map()', '  const price = (n) => { if (!P.has(n)) P.set(n, api.price(n)); return P.get(n) }')
  else L.push('  const price = (n) => api.price(n)')
  L.push('  let total = 0', '  for (const o of orders) total += price(o)')
  L.push('  const distinct = [...new Set(orders)]')
  if (f.sort) L.push(
    '  const msort = (xs) => { if (xs.length < 2) return xs; const m = xs.length >> 1, a = msort(xs.slice(0, m)), b = msort(xs.slice(m)), r = []; let i = 0, j = 0',
    '    while (i < a.length && j < b.length) r.push(api.before(b[j], a[i]) ? b[j++] : a[i++])',
    '    while (i < a.length) r.push(a[i++]); while (j < b.length) r.push(b[j++]); return r }',
    '  const ranking = msort(distinct)')
  else L.push('  const ranking = distinct.slice()', '  for (let i = 0; i < ranking.length; i++) for (let j = i + 1; j < ranking.length; j++) if (api.before(ranking[j], ranking[i])) { const t = ranking[i]; ranking[i] = ranking[j]; ranking[j] = t }')
  if (f.table) L.push('  const T = []', '  for (let i = 0; i < input.tableSize; i++) T.push(api.tableAt(i))', '  const counts = queries.map((q) => { let k = 0; while (k < T.length && T[k] < q) k++; return k })')
  else if (f.bsearch) L.push('  const counts = queries.map((q) => { let lo = 0, hi = input.tableSize; while (lo < hi) { const m = (lo + hi) >> 1; if (api.tableAt(m) < q) lo = m + 1; else hi = m } return lo })')
  else L.push('  const counts = queries.map((q) => { let k = 0; while (k < input.tableSize && api.tableAt(k) < q) k++; return k })')
  if (f.batch) L.push(
    '  const vals = orders.map(price)',
    f.dedupe ? '  const uniq = [...new Set(vals)]' : '  const uniq = vals',
    '  const D = new Map()',
    '  for (let i = 0; i < uniq.length; i += 32) { const part = uniq.slice(i, i + 32); const d = api.digest(part); part.forEach((v, k) => D.set(v, d[k])) }',
    '  const digests = vals.map((v) => D.get(v))')
  else L.push('  const digests = orders.map((o) => api.digest([price(o)])[0])')
  if (f.wrong) L.push('  counts[0] = counts[0] + 1')
  if (f.tag) L.push('  // variant ' + f.tag)
  L.push('  return { total, ranking, counts, digests }', '}', f.broken ? 'module.exports = solve(' : 'module.exports = solve')
  return L.join('\n') + '\n'
}
module.exports = { makeSolution }
