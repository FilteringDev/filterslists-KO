import Test from 'ava'
import { BuildDomainCandidates } from '../source/dead-domain/candidate-selection.ts'
import { CreateEmptyState, GetModifiedAtOverride, RecordVerdict } from '../source/dead-domain/state.ts'
import type { DomainOccurrence } from '../source/dead-domain/types.ts'

const Occurrences: DomainOccurrence[] = [
  { Domain: 'old.example', FilePath: 'a.txt', LineNumber: 1 },
  { Domain: 'redirected.example', FilePath: 'a.txt', LineNumber: 2 }
]

Test('RecordVerdict persists a modification date override', T => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 1000, [], 1000)

  T.is(GetModifiedAtOverride(State, 'redirected.example'), 1000)
})

Test('RecordVerdict carries a previous override forward', T => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 1000, [], 1000)
  RecordVerdict(State, 'redirected.example', 'Alive', 2000, [])

  T.is(State.Domains['redirected.example'].LastCheckedAt, 2000)
  T.is(GetModifiedAtOverride(State, 'redirected.example'), 1000)
})

Test('RecordVerdict stores no override when none was ever recorded', T => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'old.example', 'Alive', 2000, [])

  T.false('ModifiedAtOverride' in State.Domains['old.example'])
})

Test('An override pushes a domain to the back of the queue', T => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 500, [], 9000)

  const Candidates = BuildDomainCandidates({
    // Outside a git repository blame yields nothing, so every line uses the fallback time.
    WorkingDirectory: '/',
    Occurrences,
    State,
    FallbackAuthorTime: 1000
  })

  T.deepEqual(Candidates.map(Candidate => Candidate.Domain), ['old.example', 'redirected.example'])
  T.is(Candidates[1].SortKey, 9000)
})
