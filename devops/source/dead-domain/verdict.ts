import { registrableDomain } from '@structured-world/structured-public-domains'
import type { DomainVerdict } from './types.ts'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from './globalping.ts'

// Name resolution failures reported by Globalping probes.
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

const TlsFailurePatterns = [
  /\bCERT_HAS_EXPIRED\b/i,
  /\bCERT_NOT_YET_VALID\b/i,
  /\bDEPTH_ZERO_SELF_SIGNED_CERT\b/i,
  /\bSELF_SIGNED_CERT_IN_CHAIN\b/i,
  /\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/i,
  /\bUNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?\b/i,
  /\bERR_TLS_CERT_ALTNAME_INVALID\b/i,
  /\bHOSTNAME_MISMATCH\b/i
]

export type MeasurementEvaluation = {
  Verdict: DomainVerdict
  Reason: string
  Warnings: string[]
  /** Redirect targets sharing the probed domain's registrable domain — detected, never removed. */
  SameDomainRedirects: string[]
}

export function NormalizeHost(Host: string): string {
  return Host.trim().toLowerCase().replace(/\.$/, '')
}

/** `sub.example.com` and `example.com` share a registrable domain, `example.org` does not. */
export function AreDomainsRelated(Left: string, Right: string): boolean {
  const A = NormalizeHost(Left)
  const B = NormalizeHost(Right)

  if (A === B) {
    return true
  }

  const RegistrableA = registrableDomain(A)
  const RegistrableB = registrableDomain(B)

  // Hosts outside the public suffix list fall back to a plain sub-domain check.
  if (!RegistrableA || !RegistrableB) {
    return A.endsWith(`.${B}`) || B.endsWith(`.${A}`)
  }

  return RegistrableA === RegistrableB
}

function GetProbeOutput(Result: GlobalpingProbeResult): string {
  return [Result.rawOutput ?? '', Result.rawHeaders ?? ''].join('\n')
}

function GetHeaderValue(Result: GlobalpingProbeResult, HeaderName: string): string | null {
  for (const [Key, Value] of Object.entries(Result.headers ?? {})) {
    if (Key.toLowerCase() !== HeaderName) {
      continue
    }

    const Resolved = Array.isArray(Value) ? Value[0] : Value

    return Resolved ? String(Resolved) : null
  }

  return null
}

export function GetRedirectTargetHost(Domain: string, Result: GlobalpingProbeResult): string | null {
  const Location = GetHeaderValue(Result, 'location')
  if (!Location) {
    return null
  }

  try {
    return NormalizeHost(new URL(Location, `https://${Domain}/`).hostname)
  } catch {
    return null
  }
}

function IsSuccessfulStatusCode(Result: GlobalpingProbeResult): boolean {
  return typeof Result.statusCode === 'number' && Result.statusCode >= 200 && Result.statusCode < 300
}

function IsTimeout(Result: GlobalpingProbeResult): boolean {
  return AliveTimeoutPatterns.some(Pattern => Pattern.test(GetProbeOutput(Result)))
}

function IsDnsFailure(Result: GlobalpingProbeResult): boolean {
  if (Result.resolvedAddress) {
    return false
  }

  return DeadDnsPatterns.some(Pattern => Pattern.test(GetProbeOutput(Result)))
}

/** A TLS connection that was established but failed certificate validation. */
export function IsTlsValidationFailure(Result: GlobalpingProbeResult): boolean {
  if (Result.tls && Result.tls.authorized === false) {
    return true
  }

  return TlsFailurePatterns.some(Pattern => Pattern.test(GetProbeOutput(Result)))
}

function GetTlsFailureDetail(Result: GlobalpingProbeResult): string {
  return Result.tls?.error ?? Result.tls?.authorizationError ?? 'certificate validation failed'
}

/**
 * HTTP 2xx and request timeouts count as alive. DNS resolution failures, TLS certificate
 * validation failures and redirects that leave the registrable domain count as dead.
 * Redirects that stay inside the same registrable domain are reported as warnings only.
 * Everything else stays unknown so that ambiguous results never delete rules.
 */
export function EvaluateMeasurement(Domain: string, Measurement: GlobalpingMeasurement): MeasurementEvaluation {
  const Results = Measurement.results.map(Entry => Entry.result)
  const Warnings: string[] = []
  const SameDomainRedirects: string[] = []

  if (Results.length === 0) {
    return { Verdict: 'Unknown', Reason: 'No probe results were returned', Warnings, SameDomainRedirects }
  }

  const RedirectTargets = Results
    .map(Result => GetRedirectTargetHost(Domain, Result))
    .filter((Host): Host is string => Host !== null)

  for (const Target of new Set(RedirectTargets)) {
    if (AreDomainsRelated(Domain, Target) && NormalizeHost(Domain) !== Target) {
      SameDomainRedirects.push(Target)
    }
  }

  if (Results.every(IsTlsValidationFailure)) {
    Warnings.push(`removed because TLS certificate validation failed (${GetTlsFailureDetail(Results[0])}) — the host may still be reachable over plain HTTP`)

    return {
      Verdict: 'Dead',
      Reason: `TLS certificate validation failed on every probe (${GetTlsFailureDetail(Results[0])})`,
      Warnings,
      SameDomainRedirects
    }
  }

  const ForeignRedirectTargets = [...new Set(RedirectTargets.filter(Target => !AreDomainsRelated(Domain, Target)))]
  if (ForeignRedirectTargets.length > 0 && RedirectTargets.length === Results.length) {
    Warnings.push(`removed because it redirects to \`${ForeignRedirectTargets.join('`, `')}\` — if this is an intentional rebrand, add rules for the new domain`)

    return {
      Verdict: 'Dead',
      Reason: `Redirects to a different registrable domain (${ForeignRedirectTargets.join(', ')})`,
      Warnings,
      SameDomainRedirects
    }
  }

  if (Results.some(IsSuccessfulStatusCode)) {
    return { Verdict: 'Alive', Reason: 'HTTP 2xx response', Warnings, SameDomainRedirects }
  }

  if (Results.some(IsTimeout)) {
    return { Verdict: 'Alive', Reason: 'HTTP request timed out', Warnings, SameDomainRedirects }
  }

  if (Results.every(IsDnsFailure)) {
    return { Verdict: 'Dead', Reason: 'DNS name resolution failed on every probe', Warnings, SameDomainRedirects }
  }

  const StatusCodes = Results.map(Result => Result.statusCode ?? 'n/a').join(', ')

  return { Verdict: 'Unknown', Reason: `Inconclusive probe outcome (status codes: ${StatusCodes})`, Warnings, SameDomainRedirects }
}
