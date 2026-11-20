# Toy task: catalog report

Edit `solution.js`. It must define `solve(input, api)` and end with `module.exports = solve`.
It runs in a bare JavaScript sandbox: no `require`, no file or network access, 2 second limit.

## Input

- `input.orders`: array of item names (strings). Many names repeat.
- `input.queries`: array of numbers. Values may repeat.
- `input.tableSize`: length of a hidden table of numbers sorted in ascending order.

## Output

Return an object with four fields:

- `total`: sum of `api.price(name)` over every entry of `orders` (repeats count each time).
- `ranking`: the distinct names of `orders`, sorted by the hidden catalog order (`api.before`).
- `counts`: for each query `q`, in order, the number of table entries strictly smaller than `q`.
- `digests`: for each entry of `orders`, in order, the digest of that order's price.

## API and cost

Every call adds to the cost. The metric is the total cost over all hidden test inputs. Lower is better.
Plain JavaScript (loops, arrays, Map, arithmetic) is free.

| call | returns | cost |
|---|---|---|
| `api.price(name)` | price of an item; the same name always has the same price | 12 |
| `api.before(a, b)` | `true` if item `a` comes before item `b` in the catalog order; a strict total order | 1 |
| `api.tableAt(i)` | entry `i` of the sorted table, `0 <= i < input.tableSize` | 1 |
| `api.digest(values)` | array with the digest of each number in `values`; at most 32 values per call; the same value always has the same digest | 6 per call + 1 per value |

Catalog order, prices, table contents and digests are hidden and differ between test inputs.
They cannot be computed from the names; they are only available through the API.

## Feedback

The evaluator reports the total cost and its breakdown per API call. When the output is wrong it names
the test input and the field that differs, without showing hidden values.
