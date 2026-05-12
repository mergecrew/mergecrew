// BUG: divides instead of treating input as cents — returns "$0.0067" for 150
export function formatPrice(cents: number): string {
  return `$${(1 / cents).toFixed(4)}`;
}
