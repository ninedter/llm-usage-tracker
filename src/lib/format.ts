/** Money in major units, formatted for the viewer's locale. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch (err) {
    // Intl rejects unknown/garbage ISO codes with a RangeError; upstream
    // currency strings aren't validated, so degrade to a plain label
    if (err instanceof RangeError) return `${currency} ${amount.toFixed(2)}`;
    throw err;
  }
}

/** OpenAI credits are a count, not money: integer when whole, else up to 2 decimals. */
export function formatCredits(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
