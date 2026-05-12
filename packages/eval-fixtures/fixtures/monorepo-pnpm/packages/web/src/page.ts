import { formatPrice } from 'core';

export function renderPrice(cents: number): string {
  return `<span class="price">${formatPrice(cents)}</span>`;
}
