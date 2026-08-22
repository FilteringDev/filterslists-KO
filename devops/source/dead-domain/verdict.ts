import type { DomainVerdict } from './types.ts'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from './globalping.ts'

// Name resolution failures reported by Globalping probes — the only signal we treat as "dead".
const DeadDnsPatterns = [
  /\bENOTFOUND\b/i,
  /\bEAI_NONAME\b/i,
  /\bNXDOMAIN\b/i,
  /\bno\s+name\b/i,
  /\bname\s+or\s+service\s+not\s+known\b/i,
  /\bcould\s+not\s+resolve\b/i,
  /\bresolution\s+failed\b/i
]

const AliveTimeoutPatterns = [
  /\bETIMEDOUT\b/i,
  /\bESOCKETTIMEDOUT\b/i,
  /\btimeout\b/i,
  /\btimed\s+out\b/i
]

function GetProbeOutput(Result: GlobalpingProbeResult): string {
  return Result.rawOutput ?? ''
}

function IsSuccessfulStatusCode(Result: GlobalpingProbeResult): boolean {
  return typeof Result.statusCode === 'number' && Result.statusCode >= 200 && Result.statusCode < 300
}

function IsTimeout(Result: GlobalpingProbeResult): boolean {
  const Output = GetProbeOutput(Result)

  return AliveTimeoutPatterns.some(Pattern => Pattern.test(Output))
}

function IsDnsFailure(Result: GlobalpingProbeResult): boolean {
  if (Result.resolvedAddress) {
    return false
  }

  const Output = GetProbeOutput(Result)

  return DeadDnsPatterns.some(Pattern => Pattern.test(Output))
}

/**
 * HTTP 2xx and request timeouts count as alive, DNS name resolution failures count as dead.
 * Everything else stays unknown so that ambiguous results never delete rules.
 */
export function EvaluateMeasurement(Measurement: GlobalpingMeasurement): { Verdict: DomainVerdict, Reason: string } {
  const Results = Measurement.results.map(Entry => Entry.result)

  if (Results.length === 0) {
    return { Verdict: 'Unknown', Reason: 'No probe results were returned' }
  }

  if (Results.some(IsSuccessfulStatusCode)) {
    return { Verdict: 'Alive', Reason: 'HTTP 2xx response' }
  }

  if (Results.some(IsTimeout)) {
    return { Verdict: 'Alive', Reason: 'HTTP request timed out' }
  }

  if (Results.every(IsDnsFailure)) {
    return { Verdict: 'Dead', Reason: 'DNS name resolution failed on every probe' }
  }

  const StatusCodes = Results.map(Result => Result.statusCode ?? 'n/a').join(', ')

  return { Verdict: 'Unknown', Reason: `Inconclusive probe outcome (status codes: ${StatusCodes})` }
}
