import * as AGTree from '@adguard/agtree'
import * as ActionCore from '@actions/core'
import * as Piscina from 'piscina'
import * as Path from 'node:path'
import * as Fs from 'node:fs'
import * as Process from 'node:process'
import * as WorkerThread from 'node:worker_threads'
import type { FiltersListsConfigWithVersion } from './filterslists-config.ts'
import { BuildBundledFiltersLists } from './worker-bundle-core.ts'

type WorkerData = {
  FiltersProcessableCache: Map<string, boolean>
  WorkingDirectory: string
  FiltersListDirectory: string
  OutputDirectory: string
}

// Modifiers that still carry meaning for DNS-level (client-agnostic, no request context) filtering.
const DnsCompatibleModifierNames = new Set([
  'important',
  'badfilter',
  'third-party',
  'match-case',
  'denyallow',
  'dnstype',
  'dnsrewrite',
  'client',
  'ctag'
])

export class BuildBundledDnsFiltersList extends BuildBundledFiltersLists {
  protected IsNetworkRule(Filter: AGTree.AnyRule): Filter is AGTree.NetworkRule {
    return Filter.category === AGTree.RuleCategory.Network && Filter.type === AGTree.NetworkRuleType.NetworkRule
  }

  protected HasDnsIncompatibleModifier(Filter: AGTree.NetworkRule): boolean {
    return (Filter.modifiers?.children ?? []).some(Modifier => !DnsCompatibleModifierNames.has(Modifier.name.value))
  }

  FilterForDns(FiltersList: AGTree.FilterList): AGTree.FilterList {
    const SeenRuleTexts = new Set<string>()
    const FiltersChildren: AGTree.AnyRule[] = []

    for (const Filter of FiltersList.children) {
      if (Filter.category === AGTree.RuleCategory.Cosmetic) {
        continue
      }

      if (this.IsNetworkRule(Filter) && this.HasDnsIncompatibleModifier(Filter)) {
        continue
      }

      const RuleText = Filter.raws?.text ?? AGTree.RuleGenerator.generate(Filter)
      if (SeenRuleTexts.has(RuleText)) {
        continue
      }
      SeenRuleTexts.add(RuleText)

      FiltersChildren.push(Filter)
    }

    return {
      ...FiltersList,
      children: FiltersChildren
    }
  }

  Build(FiltersList: AGTree.FilterList, FiltersListDefinition: FiltersListsConfigWithVersion[number]): void {
    ActionCore.info(`[bundle-dns pid=${Process.pid} threadid=${WorkerThread.threadId}] Building DNS variant for ${FiltersListDefinition.DefinitionFileName}`)

    const BundledFiltersList = this.AppendUnifiedExternalRules(this.BundleIncludes(FiltersList), FiltersListDefinition)
    const ResolvedFiltersList = this.ResolveForPlatform(BundledFiltersList, { adguard: true })
    const DnsFiltersList = this.FilterForDns(ResolvedFiltersList)
    const HeaderFilterList = this.BuildHeaderFilterList(FiltersListDefinition)
    const OutputFileName = FiltersListDefinition.DnsOutputFileName
    if (!OutputFileName) {
      ActionCore.debug(`[bundle-dns pid=${Process.pid} threadid=${WorkerThread.threadId}] Skipped ${FiltersListDefinition.DefinitionFileName} (no DnsOutputFileName)`)
      return
    }

    const OutputFilePath = Path.resolve(this.OutputDirectory, OutputFileName)

    Fs.mkdirSync(this.OutputDirectory, { recursive: true })
    Fs.writeFileSync(
      OutputFilePath,
      this.StringifyFilterList({
        ...DnsFiltersList,
        children: [...HeaderFilterList.children, ...DnsFiltersList.children]
      }),
      'utf-8'
    )

    ActionCore.info(`[bundle-dns pid=${Process.pid} threadid=${WorkerThread.threadId}] Wrote DNS variant to ${OutputFilePath}`)
  }
}

export default function WorkerBundleDns(FiltersListDefinition: FiltersListsConfigWithVersion[number]): void {
  if (!FiltersListDefinition.DnsOutputFileName) {
    return
  }

  const WorkerData = Piscina.workerData as WorkerData
  const FiltersListDefPath = Path.resolve(WorkerData.FiltersListDirectory, FiltersListDefinition.DefinitionFileName)
  const FiltersListDef = AGTree.FilterListParser.parse(Fs.readFileSync(FiltersListDefPath, 'utf-8'), { parseUboSpecificRules: true })

  new BuildBundledDnsFiltersList(WorkerData).Build(FiltersListDef, FiltersListDefinition)
}
