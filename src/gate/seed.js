// A few months of believable household history, so "new store" and
// "3x your usual" checks have something to compare against.
export function seedHistory() {
  const purchases = [];
  const groceries = [42.1, 47.85, 39.6, 51.2, 44.3, 46.75, 40.9, 49.4];
  for (const amount of groceries) purchases.push({ merchant: 'FreshCart', category: 'groceries', amount });
  purchases.push(
    { merchant: 'FreshCart', category: 'household', amount: 18.4 },
    { merchant: 'FreshCart', category: 'household', amount: 22.0 },
    { merchant: 'FreshCart', category: 'electronics', amount: 34.99 },
    { merchant: 'FreshCart', category: 'electronics', amount: 89.0 },
    { merchant: 'FreshCart', category: 'digital_games', amount: 19.99 },
  );
  return { purchases, payees: ['Sam Rivera', 'Rivera Family Dentist', 'City Water'] };
}
