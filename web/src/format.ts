/** Round display only; accounting keeps the original integer counters. */
export function tokens(value: number | null | undefined): string {
  return value == null
    ? "未知"
    : (value / 1_000_000).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + " M";
}

/** Costs use two decimals; sub-cent positive estimates remain distinguishable from zero. */
export function dollars(value: number | null | undefined): string {
  if (value == null) return "未定价 / 计数不足";
  if (value > 0 && value < 0.01) return "< US$0.01";
  return (
    "US$" +
    value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
