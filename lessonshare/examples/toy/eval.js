#!/usr/bin/env node
// Evaluator for the toy task. Deterministic: the metric is a count of instrumented API calls, not wall time.
// Contract: the last stdout line is {"status": "ok"|"incorrect"|"build_error", "metric": n, "detail": "..."}.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const COST = { price: 12, before: 1, tableAt: 1, digestCall: 6, digestValue: 1 }
const CASES = [
  { seed: 0x5eed01, orders: 240, items: 40, queries: 60, distinctQueries: 30, table: 64 },
  { seed: 0x5eed02, orders: 200, items: 32, queries: 48, distinctQueries: 30, table: 96 },
  { seed: 0x5eed03, orders: 280, items: 48, queries: 72, distinctQueries: 36, table: 48 },
]

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle(xs, r) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
  }
  return xs
}

function makeCase(c) {
  const r = rng(c.seed)
  const names = shuffle(Array.from({ length: c.items }, (_, i) => 'item-' + String(Math.floor(r() * 9000) + 1000) + '-' + i), r)
  const rank = new Map(shuffle(names.slice(), r).map((n, i) => [n, i]))
  const price = new Map(names.map((n) => [n, Math.floor(r() * 9000) + 100]))
  const orders = Array.from({ length: c.orders }, (_, i) => (i < names.length ? names[i] : names[Math.floor(r() * names.length)]))
  shuffle(orders, r)
  let v = 0
  const table = Array.from({ length: c.table }, () => (v += 1 + Math.floor(r() * 50)))
  const qpool = Array.from({ length: c.distinctQueries }, () => Math.floor(r() * (v + 40)))
  const queries = Array.from({ length: c.queries }, (_, i) => qpool[i < qpool.length ? i : Math.floor(r() * qpool.length)])
  shuffle(queries, r)
  const salt = Math.floor(r() * 1e9)
  const digestOf = (x) => ((Math.imul((x ^ salt) >>> 0, 2654435761) >>> 0) % 1000003)
  return { names, rank, price, orders, table, queries, digestOf }
}

function expected(k) {
  return {
    total: k.orders.reduce((s, n) => s + k.price.get(n), 0),
    ranking: [...new Set(k.orders)].sort((a, b) => k.rank.get(a) - k.rank.get(b)),
    counts: k.queries.map((q) => k.table.filter((t) => t < q).length),
    digests: k.orders.map((n) => k.digestOf(k.price.get(n))),
  }
}

function emit(obj) {
  console.log(JSON.stringify(obj))
  process.exit(0)
}

function main() {
  const i = process.argv.indexOf('--candidate')
  const dir = i >= 0 ? process.argv[i + 1] : null
  if (!dir) {
    console.error('usage: eval.js --candidate <dir>')
    process.exit(64)
  }
  let code
  try {
    code = fs.readFileSync(path.join(dir, 'solution.js'), 'utf8')
  } catch {
    emit({ status: 'build_error', detail: 'solution.js not found in the candidate' })
  }
  const sandbox = { module: { exports: {} } }
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox, { filename: 'solution.js', timeout: 2000 })
  } catch (e) {
    emit({ status: 'build_error', detail: 'solution.js failed to load: ' + String(e && e.message).slice(0, 300) })
  }
  if (typeof sandbox.module.exports !== 'function') emit({ status: 'build_error', detail: 'solution.js must end with "module.exports = solve" where solve is a function' })

  const spent = { price: 0, before: 0, tableAt: 0, digest: 0 }
  for (let ci = 0; ci < CASES.length; ci++) {
    const k = makeCase(CASES[ci])
    const bad = (msg) => {
      throw new Error('API misuse: ' + msg)
    }
    const api = {
      price(name) {
        if (!k.price.has(name)) bad('price() of an unknown item name')
        spent.price += COST.price
        return k.price.get(name)
      },
      before(a, b) {
        if (!k.rank.has(a) || !k.rank.has(b)) bad('before() of an unknown item name')
        spent.before += COST.before
        return k.rank.get(a) < k.rank.get(b)
      },
      tableAt(idx) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= k.table.length) bad('tableAt() index out of range')
        spent.tableAt += COST.tableAt
        return k.table[idx]
      },
      digest(values) {
        if (!Array.isArray(values) && !(values && typeof values.length === 'number')) bad('digest() needs an array')
        if (values.length > 32) bad('digest() accepts at most 32 values per call')
        spent.digest += COST.digestCall + COST.digestValue * values.length
        return Array.from(values, (x) => {
          if (typeof x !== 'number') bad('digest() values must be numbers')
          return k.digestOf(x)
        })
      },
    }
    sandbox.__input = { orders: k.orders.slice(), queries: k.queries.slice(), tableSize: k.table.length }
    sandbox.__api = api
    let out
    try {
      out = vm.runInContext('module.exports(__input, __api)', sandbox, { timeout: 2000 })
    } catch (e) {
      emit({ status: 'incorrect', detail: `test input ${ci + 1}: solve() threw: ${String(e && e.message).slice(0, 300)}` })
    }
    const exp = expected(k)
    if (!out || typeof out !== 'object') emit({ status: 'incorrect', detail: `test input ${ci + 1}: solve() must return an object` })
    if (out.total !== exp.total) emit({ status: 'incorrect', detail: `test input ${ci + 1}: field "total" is wrong` })
    for (const f of ['ranking', 'counts', 'digests']) {
      const got = out[f]
      if (!got || typeof got.length !== 'number') emit({ status: 'incorrect', detail: `test input ${ci + 1}: field "${f}" must be an array` })
      if (got.length !== exp[f].length) emit({ status: 'incorrect', detail: `test input ${ci + 1}: field "${f}" has length ${got.length}, expected ${exp[f].length}` })
      for (let j = 0; j < got.length; j++) if (got[j] !== exp[f][j]) emit({ status: 'incorrect', detail: `test input ${ci + 1}: field "${f}" first differs at index ${j}` })
    }
  }
  const total = spent.price + spent.before + spent.tableAt + spent.digest
  emit({ status: 'ok', metric: total, detail: `all ${CASES.length} test inputs match; cost by call: price=${spent.price}, before=${spent.before}, tableAt=${spent.tableAt}, digest=${spent.digest}` })
}
main()
