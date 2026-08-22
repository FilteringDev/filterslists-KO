import type { DomainProbeResult, RuleChange } from './types.ts'

export const ReportFileName = 'dead-domain-report.md'
export const PullRequestBodyFileName = 'pull-request-body.md'

export type ReportInput = {
  DryRun: boolean
  SelectedCount: number
  ProbeResults: DomainProbeResult[]
  RateLimited: boolean
  ChangedFiles: string[]
  ModifiedRules: RuleChange[]
  RemovedRules: RuleChange[]
  RunUrl: string | null
}

function GetWarningEntries(ProbeResults: DomainProbeResult[]): { Domain: string, Warning: string }[] {
  return ProbeResults.flatMap(Result => Result.Warnings.map(Warning => ({ Domain: Result.Domain, Warning })))
}

function BuildBody(Input: ReportInput): string[] {
  const DeadResults = Input.ProbeResults.filter(Result => Result.Verdict === 'Dead')
  const RedirectResults = Input.ProbeResults.filter(Result => Result.ModifiedAtOverride !== null)
  const Warnings = GetWarningEntries(Input.ProbeResults)
  const Lines: string[] = []

  Lines.push(
    `- Dry run: \`${Input.DryRun}\``,
    `- Probed domains: ${Input.ProbeResults.length} / ${Input.SelectedCount}${Input.RateLimited ? ' (stopped early: rate limited)' : ''}`,
    `- Dead domains: ${DeadResults.length}`,
    `- Redirects detected (kept): ${RedirectResults.length}`,
    `- Warnings: ${Warnings.length}`,
    `- Changed files: ${Input.ChangedFiles.length}`,
    `- Modified rules: ${Input.ModifiedRules.length}`,
    `- Removed rules: ${Input.RemovedRules.length}`,
    ''
  )

  if (DeadResults.length > 0) {
    Lines.push('### Dead domains', '')
    Lines.push(...DeadResults.map(Result => `- \`${Result.Domain}\` — ${Result.Reason}`))
    Lines.push('')
  }

  if (RedirectResults.length > 0) {
    Lines.push(
      '### Redirect detected (kept)',
      '',
      'These domains redirect inside their own registrable domain. Nothing was removed; their',
      'last-modified date is overridden to the timestamp below so they are not re-probed daily.',
      ''
    )
    Lines.push(...RedirectResults.map(Result => {
      const OverriddenAt = new Date((Result.ModifiedAtOverride ?? 0) * 1000).toISOString()

      return `- \`${Result.Domain}\` → \`${Result.SameDomainRedirects.join('`, `')}\` — last-modified date overridden to ${OverriddenAt}`
    }))
    Lines.push('')
  }

  if (Warnings.length > 0) {
    Lines.push('### Warnings', '')
    Lines.push(...Warnings.map(Entry => `- \`${Entry.Domain}\` — ${Entry.Warning}`))
    Lines.push('')
  }

  if (Input.RemovedRules.length > 0) {
    Lines.push('### Removed rules', '')
    Lines.push(...Input.RemovedRules.map(Change => `- \`${Change.Before}\` (${Change.FilePath}:${Change.LineNumber})`))
    Lines.push('')
  }

  if (Input.ModifiedRules.length > 0) {
    Lines.push('### Modified rules', '')
    Lines.push(...Input.ModifiedRules.map(Change => `- \`${Change.Before}\` → \`${Change.After}\` (${Change.FilePath}:${Change.LineNumber})`))
    Lines.push('')
  }

  if (Input.RunUrl) {
    Lines.push(`Run: ${Input.RunUrl}`, '')
  }

  return Lines
}

export function BuildReportMarkdown(Input: ReportInput): string {
  return ['## Dead domain cleanup', '', ...BuildBody(Input)].join('\n')
}

export function BuildPullRequestBody(Input: ReportInput): string {
  const Intro = [
    'Domains probed over HTTP from Korean [Globalping](https://globalping.io) probes.',
    '',
    'A domain is treated as dead when DNS resolution fails, when TLS certificate validation fails,',
    'or when it redirects to a different registrable domain. Redirects that stay inside the same',
    'registrable domain are only detected and reported — those domains are kept and their',
    'last-modified date is overridden to this run so they are not re-probed daily.',
    ''
  ]

  return [...Intro, ...BuildBody(Input)].join('\n')
}
