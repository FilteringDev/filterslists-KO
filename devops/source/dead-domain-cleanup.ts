import * as Core from '@actions/core'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { BuildDomainCandidates, SelectOldestDomains } from './dead-domain/candidate-selection.ts'
import { CollectDomainOccurrences } from './dead-domain/collect-domains.ts'
import { ListFilterFiles } from './dead-domain/filter-files.ts'
import { GlobalpingRateLimitError, MaxMeasurementsPerRun, ProbeDomain } from './dead-domain/globalping.ts'
import { BuildPullRequestBody, BuildReportMarkdown, PullRequestBodyFileName, ReportFileName, type ReportInput } from './dead-domain/report.ts'
import { RewriteFilterContent } from './dead-domain/rewrite-filters.ts'
import { LoadState, RecordVerdict, SaveState, StateFileName } from './dead-domain/state.ts'
import { EvaluateMeasurement } from './dead-domain/verdict.ts'
import type { DomainProbeResult, RuleChange } from './dead-domain/types.ts'

const Env = await Zod.object({
  DRY_RUN: Zod.string().default('false').transform(Value => Value === 'true'),
  STATE_DIRECTORY: Zod.string().nonempty().default('dead-domain-state'),
  MAX_CANDIDATES: Zod.string().default(String(MaxMeasurementsPerRun))
    .transform(Value => Number(Value))
    .refine(Value => Number.isInteger(Value) && Value > 0 && Value <= MaxMeasurementsPerRun,
      `MAX_CANDIDATES must be an integer between 1 and ${MaxMeasurementsPerRun}`)
}).strip().parseAsync(Process.env)

const WorkingDirectory = Path.resolve(import.meta.dirname, '../..')
const StateDirectory = Path.resolve(WorkingDirectory, Env.STATE_DIRECTORY)
const StateFilePath = Path.resolve(StateDirectory, StateFileName)
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
    const { Verdict, Reason, Warnings, SameDomainRedirects } = EvaluateMeasurement(Candidate.Domain, Measurement)

    // A kept redirect means the domain moved on its own; treat it as freshly modified so it
    // does not stay at the front of the oldest-first queue forever.
    const ModifiedAtOverride = SameDomainRedirects.length > 0 && Verdict !== 'Dead' ? CheckedAt : null

    ProbeResults.push({ Domain: Candidate.Domain, Verdict, Reason, Warnings, SameDomainRedirects, ModifiedAtOverride })
    RecordVerdict(State, Candidate.Domain, Verdict, CheckedAt, Warnings, ModifiedAtOverride ?? undefined)
    Core.info(`[dead-domain] ${Candidate.Domain}: ${Verdict} (${Reason})`)

    if (ModifiedAtOverride !== null) {
      Core.notice(`[dead-domain] ${Candidate.Domain}: redirects to ${SameDomainRedirects.join(', ')} within the same registrable domain — kept, last-modified date overridden to ${new Date(ModifiedAtOverride * 1000).toISOString()}`)
    }

    for (const Warning of Warnings) {
      Core.warning(`[dead-domain] ${Candidate.Domain}: ${Warning}`)
    }
  } catch (ErrorValue) {
    if (ErrorValue instanceof GlobalpingRateLimitError) {
      RateLimited = true
      Core.warning(`[dead-domain] ${FormatError(ErrorValue)} — stopping further probes`)
      break
    }

    ProbeResults.push({
      Domain: Candidate.Domain,
      Verdict: 'Unknown',
      Reason: FormatError(ErrorValue),
      Warnings: [],
      SameDomainRedirects: [],
      ModifiedAtOverride: null
    })
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

const RunUrl = Process.env.GITHUB_SERVER_URL && Process.env.GITHUB_REPOSITORY && Process.env.GITHUB_RUN_ID
  ? `${Process.env.GITHUB_SERVER_URL}/${Process.env.GITHUB_REPOSITORY}/actions/runs/${Process.env.GITHUB_RUN_ID}`
  : null

const Report: ReportInput = {
  DryRun: Env.DRY_RUN,
  SelectedCount: SelectedCandidates.length,
  ProbeResults,
  RateLimited,
  ChangedFiles,
  ModifiedRules,
  RemovedRules,
  RunUrl
}

const ReportMarkdown = BuildReportMarkdown(Report)
const ReportFilePath = Path.resolve(StateDirectory, ReportFileName)
const PullRequestBodyFilePath = Path.resolve(StateDirectory, PullRequestBodyFileName)

Fs.writeFileSync(ReportFilePath, `${ReportMarkdown}\n`, 'utf-8')
Fs.writeFileSync(PullRequestBodyFilePath, `${BuildPullRequestBody(Report)}\n`, 'utf-8')

const WarningCount = ProbeResults.reduce((Total, Result) => Total + Result.Warnings.length, 0)
const HasChanges = ChangedFiles.length > 0

Core.setOutput('has_changes', String(HasChanges && !Env.DRY_RUN))
Core.setOutput('dead_domains', JSON.stringify([...DeadDomains]))
Core.setOutput('changed_files', JSON.stringify(ChangedFiles))
Core.setOutput('probed_count', String(ProbeResults.length))
Core.setOutput('rate_limited', String(RateLimited))
Core.setOutput('warning_count', String(WarningCount))
Core.setOutput('pr_body_path', Path.relative(WorkingDirectory, PullRequestBodyFilePath))

Core.info(ReportMarkdown)

if (Process.env.GITHUB_STEP_SUMMARY) {
  Fs.appendFileSync(Process.env.GITHUB_STEP_SUMMARY, `${ReportMarkdown}\n`, 'utf-8')
}
