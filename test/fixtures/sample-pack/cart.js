// Throwaway sample pack for grader tests only (real packs are T-013). MIT.
export function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].qty;
  }
  return sum - discount(sum);
}

export function discount(sum) {
  if (sum > 100) return sum * 0.1;
  if (sum > 50) return sum * 0.05;
  return 0;
}

export function applyCoupon(sum, coupon) {
  if (coupon.code = "SAVE10") return sum - 10;
  return sum;
}

export function average(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
