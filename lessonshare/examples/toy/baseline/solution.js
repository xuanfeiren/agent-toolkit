// Seed candidate for the toy "catalog report" task. Correct but wasteful.
// See API.md for the cost of every api call. Lower total cost is better.
function solve(input, api) {
  const orders = input.orders
  const queries = input.queries

  // 1. total price of all orders
  let total = 0
  for (let i = 0; i < orders.length; i++) {
    total += api.price(orders[i])
  }

  // 2. distinct item names in catalog order (selection sort)
  const distinct = []
  for (let i = 0; i < orders.length; i++) {
    if (distinct.indexOf(orders[i]) < 0) distinct.push(orders[i])
  }
  const ranking = distinct.slice()
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      if (api.before(ranking[j], ranking[i])) {
        const t = ranking[i]
        ranking[i] = ranking[j]
        ranking[j] = t
      }
    }
  }

  // 3. for every query, how many table entries are smaller than it (linear scan)
  const counts = []
  for (let q = 0; q < queries.length; q++) {
    let k = 0
    while (k < input.tableSize && api.tableAt(k) < queries[q]) k++
    counts.push(k)
  }

  // 4. digest of every order's price, one call per order
  const digests = []
  for (let i = 0; i < orders.length; i++) {
    digests.push(api.digest([api.price(orders[i])])[0])
  }

  return { total: total, ranking: ranking, counts: counts, digests: digests }
}
module.exports = solve
