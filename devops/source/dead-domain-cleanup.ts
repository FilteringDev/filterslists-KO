import * as Core from '@actions/core'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { BuildDomainCandidates, SelectOldestDomains } from './dead-domain/candidate-selection.ts'
import { CollectDomainOccurrences } from './dead-domain/collect-domains.ts'
import { ListFilterFiles } from './dead-domain/filter-files.ts'
import { GlobalpingRateLimitError, MaxMeasurementsPerRun, ProbeDomain } from './dead-domain/globalping.ts'
import { RewriteFilterContent } from './dead-domain/rewrite-filters.ts'
import { LoadState, RecordVerdict, SaveState, StateFileName } from './dead-domain/state.ts'
import { EvaluateMeasurement } from './dead-domain/verdict.ts'
import type { DomainProbeResult, RuleChange } from './dead-domain/types.ts'

const Env = await Zod.object({
  DRY_RUN: Zod.string().default('false').transform(Value => Value === 'true'),
  STATE_DIRECTORY: Zod.string().nonempty().default('.dead-domain-state'),
  MAX_CANDIDATES: Zod.string().default(String(MaxMeasurementsPerRun))
    .transform(Value => Number(Value))
    .refine(Value => Number.isInteger(Value) && Value > 0 && Value <= MaxMeasurementsPerRun,
      `MAX_CANDIDATES must be an integer between 1 and ${MaxMeasurementsPerRun}`)
}).strip().parseAsync(Process.env)

const WorkingDirectory = Path.resolve(import.meta.dirname, '../..')
const StateFilePath = Path.resolve(WorkingDirectory, Env.STATE_DIRECTORY, StateFileName)
const CheckedAt = Math.floor(Date.now() / 1000)

function FormatError(ErrorValue: unknown): string {
  return ErrorValue instanceof Error ? ErrorValue.message : String(ErrorValue)
}

const FilterFiles = ListFilterFiles(WorkingDirectory)
Core.info(`[dead-domain] Loaded ${FilterFiles.length} filters list files`)

const Occurrences = CollectDomainOccurrences(WorkingDirectory, FilterFiles)
const KnownDomains = new Set(Occurrences.map(Occurrence => Occurrence.Domain))
Core.info(`[dead-domain] Found ${KnownDomains.size} unique domains in ${Occurrences.length} occurrences`)

const State = LoadState(StateFilePath)
const Candidates = BuildDomainCandidates({
  WorkingDirectory,
  Occurrences,
  State,
  FallbackAuthorTime: CheckedAt
})
const SelectedCandidates = SelectOldestDomains(Candidates, Env.MAX_CANDIDATES)
Core.info(`[dead-domain] Selected ${SelectedCandidates.length} oldest domains for probing`)

const ProbeResults: DomainProbeResult[] = []
let RateLimited = false

for (const Candidate of SelectedCandidates) {
  if (RateLimited) {
    break
  }

  try {
    const Measurement = await ProbeDomain(Candidate.Domain)
    const { Verdict, Reason } = EvaluateMeasurement(Measurement)

    ProbeResults.push({ Domain: Candidate.Domain, Verdict, Reason })
    RecordVerdict(State, Candidate.Domain, Verdict, CheckedAt)
    Core.info(`[dead-domain] ${Candidate.Domain}: ${Verdict} (${Reason})`)
  } catch (ErrorValue) {
    if (ErrorValue instanceof GlobalpingRateLimitError) {
      RateLimited = true
      Core.warning(`[dead-domain] ${FormatError(ErrorValue)} — stopping further probes`)
      break
    }

    ProbeResults.push({ Domain: Candidate.Domain, Verdict: 'Unknown', Reason: FormatError(ErrorValue) })
    Core.warning(`[dead-domain] ${Candidate.Domain}: probe failed — ${FormatError(ErrorValue)}`)
  }
}

const DeadDomains = new Set(ProbeResults.filter(Result => Result.Verdict === 'Dead').map(Result => Result.Domain))
Core.info(`[dead-domain] ${DeadDomains.size} domains judged dead`)

const AffectedFiles = new Set(
  SelectedCandidates
    .filter(Candidate => DeadDomains.has(Candidate.Domain))
    .flatMap(Candidate => Candidate.Occurrences.map(Occurrence => Occurrence.FilePath))
)

const ModifiedRules: RuleChange[] = []
const RemovedRules: RuleChange[] = []
const ChangedFiles: string[] = []

for (const FilePath of [...AffectedFiles].sort((A, B) => A.localeCompare(B))) {
  const AbsolutePath = Path.resolve(WorkingDirectory, FilePath)
  const Content = Fs.readFileSync(AbsolutePath, 'utf-8')
  const Result = RewriteFilterContent(FilePath, Content, DeadDomains)

  if (!Result.Changed) {
    continue
  }

  ModifiedRules.push(...Result.ModifiedRules)
  RemovedRules.push(...Result.RemovedRules)
  ChangedFiles.push(FilePath)

  if (!Env.DRY_RUN) {
    Fs.writeFileSync(AbsolutePath, Result.Content, 'utf-8')
  }
}

SaveState(StateFilePath, State, KnownDomains)

const HasChanges = ChangedFiles.length > 0
Core.setOutput('has_changes', String(HasChanges && !Env.DRY_RUN))
Core.setOutput('dead_domains', JSON.stringify([...DeadDomains]))
Core.setOutput('changed_files', JSON.stringify(ChangedFiles))
Core.setOutput('probed_count', String(ProbeResults.length))
Core.setOutput('rate_limited', String(RateLimited))

const SummaryLines = [
  '## Dead domain cleanup',
  '',
  `- Dry run: \`${Env.DRY_RUN}\``,
  `- Probed domains: ${ProbeResults.length} / ${SelectedCandidates.length}${RateLimited ? ' (stopped early: rate limited)' : ''}`,
  `- Dead domains: ${DeadDomains.size}`,
  `- Changed files: ${ChangedFiles.length}`,
  `- Modified rules: ${ModifiedRules.length}`,
  `- Removed rules: ${RemovedRules.length}`,
  ''
]

if (DeadDomains.size > 0) {
  SummaryLines.push('### Dead domains', '', ...[...DeadDomains].map(Domain => `- \`${Domain}\``), '')
}

for (const Change of RemovedRules) {
  SummaryLines.push(`- removed \`${Change.Before}\` (${Change.FilePath}:${Change.LineNumber})`)
}

for (const Change of ModifiedRules) {
  SummaryLines.push(`- changed \`${Change.Before}\` → \`${Change.After}\` (${Change.FilePath}:${Change.LineNumber})`)
}

const Summary = SummaryLines.join('\n')
Core.info(Summary)

if (Process.env.GITHUB_STEP_SUMMARY) {
  Fs.appendFileSync(Process.env.GITHUB_STEP_SUMMARY, `${Summary}\n`, 'utf-8')
}
