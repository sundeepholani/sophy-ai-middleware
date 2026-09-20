import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * USD for a SINGLE event. Keeps the console's usual 4 decimals, and extends
 * precision only when a real sub-cent amount would otherwise render as
 * "$0.0000" — an evaluation call costs ~$0.0000116, which 4 decimals erase
 * entirely. Aggregates keep plain toFixed(4): 6 decimals is noise on a total.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  const four = n.toFixed(4)
  if (Number(four) !== 0) return `$${four}`
  if (n === 0) return `$${four}`
  return `$${n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`
}
