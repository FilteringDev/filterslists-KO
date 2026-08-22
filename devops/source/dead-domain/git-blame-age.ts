import * as ChildProcess from 'node:child_process'

const BlameMaxBuffer = 256 * 1024 * 1024

/**
 * Maps 1-based line numbers of a file to the author timestamp (epoch seconds) of their last change.
 * Returns an empty map when the file has no git history (e.g. it is untracked).
 */
export function GetLineAuthorTimes(WorkingDirectory: string, FilePath: string): Map<number, number> {
  const AuthorTimes = new Map<number, number>()

  let BlameOutput: string
  try {
    BlameOutput = ChildProcess.execFileSync(
      'git',
      ['blame', '--line-porcelain', '--', FilePath],
      { cwd: WorkingDirectory, encoding: 'utf-8', maxBuffer: BlameMaxBuffer, stdio: ['ignore', 'pipe', 'ignore'] }
    )
  } catch {
    return AuthorTimes
  }

  let CurrentLineNumber = 0

  for (const Line of BlameOutput.split('\n')) {
    const HeaderMatch = /^[0-9a-f]{40}\s+\d+\s+(\d+)(?:\s+\d+)?$/.exec(Line)
    if (HeaderMatch) {
      CurrentLineNumber = Number(HeaderMatch[1])
      continue
    }

    if (CurrentLineNumber > 0 && Line.startsWith('author-time ')) {
      const AuthorTime = Number(Line.slice('author-time '.length).trim())
      if (Number.isFinite(AuthorTime)) {
        AuthorTimes.set(CurrentLineNumber, AuthorTime)
      }
    }
  }

  return AuthorTimes
}
