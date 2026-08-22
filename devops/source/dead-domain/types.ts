export type DomainOccurrence = {
  Domain: string
  FilePath: string
  LineNumber: number
}

export type DomainCandidate = {
  Domain: string
  LatestModifiedAt: number
  LastCheckedAt: number
  /** Replaces the git history date once a same-domain redirect has been detected. */
  ModifiedAtOverride: number
  SortKey: number
  Occurrences: DomainOccurrence[]
}

export type DomainVerdict = 'Alive' | 'Dead' | 'Unknown'

export type DomainProbeResult = {
  Domain: string
  Verdict: DomainVerdict
  Reason: string
  Warnings: string[]
  SameDomainRedirects: string[]
  ModifiedAtOverride: number | null
}

export type RuleChange = {
  FilePath: string
  LineNumber: number
  Before: string
  After: string | null
  RemovedDomains: string[]
}

export type FileRewriteResult = {
  Content: string
  Changed: boolean
  ModifiedRules: RuleChange[]
  RemovedRules: RuleChange[]
}
