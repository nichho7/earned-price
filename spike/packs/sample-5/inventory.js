// Provisional 5-bug spike pack (T-003 part c). Not a real pack (those are T-013). MIT.
export function lowStock(items, threshold) {
  return items.filter((it) => it.qty < threshold).map((it) => it.sku);
}

export function restock(stock, sku, amount) {
  const current = stock.get(sku) || 0;
  stock.set(sku, current + amount);
  return stock;
}

export function removeItem(list, sku) {
  const i = list.findIndex((it) => it.sku === sku);
  list.splice(i, 1);
  return list;
}

export function pageOf(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size - 1);
}

export function totalWeight(items) {
  return items.reduce((sum, it) => sum + it.weight * it.qty);
}

export function isExpired(item, now) {
  return item.expiresAt > now;
}

export function bySku(items) {
  const out = {};
  for (const it of items) out[it.sku] = it;
  return out;
}

export function parseQty(input) {
  const n = parseInt(input);
  if (n === NaN) return 0;
  return n;
}
