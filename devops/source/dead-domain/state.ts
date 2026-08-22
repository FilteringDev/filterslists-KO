import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Zod from 'zod'
import type { DomainVerdict } from './types.ts'

export const StateFileName = 'dead-domain-state.json'

const StateSchema = Zod.object({
  Version: Zod.literal(1),
  Domains: Zod.record(Zod.string(), Zod.object({
    LastCheckedAt: Zod.number(),
    LastVerdict: Zod.enum(['Alive', 'Dead', 'Unknown']),
    LastWarnings: Zod.array(Zod.string()).optional()
  }))
})

export type DeadDomainState = Zod.infer<typeof StateSchema>

export function CreateEmptyState(): DeadDomainState {
  return { Version: 1, Domains: {} }
}

/** Reads the state carried over from the previous run; falls back to an empty state. */
export function LoadState(StateFilePath: string): DeadDomainState {
  if (!Fs.existsSync(StateFilePath)) {
    return CreateEmptyState()
  }

  try {
    return StateSchema.parse(JSON.parse(Fs.readFileSync(StateFilePath, 'utf-8')))
  } catch {
    return CreateEmptyState()
  }
}

export function GetLastCheckedAt(State: DeadDomainState, Domain: string): number {
  return State.Domains[Domain]?.LastCheckedAt ?? 0
}

export function RecordVerdict(State: DeadDomainState, Domain: string, Verdict: DomainVerdict, CheckedAt: number, Warnings: string[]): void {
  State.Domains[Domain] = {
    LastCheckedAt: CheckedAt,
    LastVerdict: Verdict,
    ...(Warnings.length > 0 ? { LastWarnings: Warnings } : {})
  }
}

/** Drops entries for domains that no longer exist in the filters lists, then persists the state. */
export function SaveState(StateFilePath: string, State: DeadDomainState, KnownDomains: Set<string>): void {
  const Pruned = CreateEmptyState()

  for (const [Domain, Entry] of Object.entries(State.Domains)) {
    if (KnownDomains.has(Domain)) {
      Pruned.Domains[Domain] = Entry
    }
  }

  Fs.mkdirSync(Path.dirname(StateFilePath), { recursive: true })
  Fs.writeFileSync(StateFilePath, `${JSON.stringify(Pruned, null, 2)}\n`, 'utf-8')
}
