export function score(sanitiserResult, guardResult, scopeResult) {
  try {
    let total = 0

    if (sanitiserResult?.flagged === true) {
      total += 40
      const extra = (sanitiserResult.patterns?.length ?? 1) - 1
      if (extra > 0) total += extra * 10
    }

    if (guardResult?.allowed === false) total += 35

    if (scopeResult?.compliant === false) total += 25

    return Math.min(100, total)
  } catch {
    return 0
  }
}
