import type { DomainCandidate, DomainOccurrence } from './types.ts'
import { GetLastCheckedAt, GetModifiedAtOverride, type DeadDomainState } from './state.ts'
import { GetLineAuthorTimes } from './git-blame-age.ts'

export type BuildCandidatesOptions = {
  WorkingDirectory: string
  Occurrences: DomainOccurrence[]
  State: DeadDomainState
  /** Used when a line has no git history yet, so brand new lines are ranked as the newest ones. */
  FallbackAuthorTime: number
}

/**
 * Deduplicates domains, resolves the newest modification time of every domain and returns them
 * sorted from the least recently touched one to the most recent one.
 */
export function BuildDomainCandidates(Options: BuildCandidatesOptions): DomainCandidate[] {
  const AuthorTimesByFile = new Map<string, Map<number, number>>()
  const CandidatesByDomain = new Map<string, DomainCandidate>()

  for (const Occurrence of Options.Occurrences) {
    let AuthorTimes = AuthorTimesByFile.get(Occurrence.FilePath)
    if (!AuthorTimes) {
      AuthorTimes = GetLineAuthorTimes(Options.WorkingDirectory, Occurrence.FilePath)
      AuthorTimesByFile.set(Occurrence.FilePath, AuthorTimes)
    }

    const ModifiedAt = AuthorTimes.get(Occurrence.LineNumber) ?? Options.FallbackAuthorTime
    const Existing = CandidatesByDomain.get(Occurrence.Domain)

    if (!Existing) {
      const LastCheckedAt = GetLastCheckedAt(Options.State, Occurrence.Domain)
      const ModifiedAtOverride = GetModifiedAtOverride(Options.State, Occurrence.Domain)

      CandidatesByDomain.set(Occurrence.Domain, {
        Domain: Occurrence.Domain,
        LatestModifiedAt: ModifiedAt,
        LastCheckedAt,
        ModifiedAtOverride,
        SortKey: Math.max(ModifiedAt, LastCheckedAt, ModifiedAtOverride),
        Occurrences: [Occurrence]
      })
      continue
    }

    Existing.Occurrences.push(Occurrence)
    // The most recent mention of a domain decides how "fresh" that domain is.
    Existing.LatestModifiedAt = Math.max(Existing.LatestModifiedAt, ModifiedAt)
    Existing.SortKey = Math.max(Existing.LatestModifiedAt, Existing.LastCheckedAt, Existing.ModifiedAtOverride)
  }

  return [...CandidatesByDomain.values()].sort((A, B) => {
    return A.SortKey - B.SortKey || A.Domain.localeCompare(B.Domain)
  })
}

export function SelectOldestDomains(Candidates: DomainCandidate[], MaxCandidates: number): DomainCandidate[] {
  return Candidates.slice(0, Math.max(0, MaxCandidates))
}
