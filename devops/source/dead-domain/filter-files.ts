import * as Fs from 'node:fs'
import * as Path from 'node:path'

export const FiltersListsDirectoryName = 'filterslists'

const RotatingFileSuffix = '.rotating.txt'
const FilterFileExtension = '.txt'
const IgnoredDirectoryNames = new Set(['node_modules', '.git'])

// Generated bundles that live next to the sources and must never be edited by hand.
const GeneratedRootFilePattern = /^(filterslist-.*|unified-domains)\.txt$/

function IsIgnoredRootFile(RelativePath: string): boolean {
  const Segments = RelativePath.split(Path.sep)

  return Segments.length === 1 && GeneratedRootFilePattern.test(Segments[0])
}

function CollectRecursively(AbsoluteDirectory: string, BaseDirectory: string, Collected: string[]): void {
  const Entries = Fs.readdirSync(AbsoluteDirectory, { withFileTypes: true })

  for (const Entry of Entries) {
    const AbsoluteEntryPath = Path.join(AbsoluteDirectory, Entry.name)

    if (Entry.isDirectory()) {
      if (IgnoredDirectoryNames.has(Entry.name)) {
        continue
      }

      CollectRecursively(AbsoluteEntryPath, BaseDirectory, Collected)
      continue
    }

    if (!Entry.isFile() || !Entry.name.endsWith(FilterFileExtension)) {
      continue
    }

    if (Entry.name.endsWith(RotatingFileSuffix)) {
      continue
    }

    const RelativePath = Path.relative(BaseDirectory, AbsoluteEntryPath)
    if (IsIgnoredRootFile(RelativePath)) {
      continue
    }

    Collected.push(RelativePath)
  }
}

/** Returns repository-relative paths of every loadable filters list file, sorted for stable output. */
export function ListFilterFiles(WorkingDirectory: string): string[] {
  const FiltersListsDirectory = Path.resolve(WorkingDirectory, FiltersListsDirectoryName)

  if (!Fs.existsSync(FiltersListsDirectory)) {
    return []
  }

  const Collected: string[] = []
  CollectRecursively(FiltersListsDirectory, WorkingDirectory, Collected)

  return Collected.sort((A, B) => A.localeCompare(B))
}
