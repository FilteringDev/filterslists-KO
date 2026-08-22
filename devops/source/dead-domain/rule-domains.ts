import * as AGTree from '@adguard/agtree'

export const DomainModifierNames = new Set(['domain', 'from'])

export const ParserOptions: AGTree.ParserOptions = {
  ...AGTree.defaultParserOptions,
  tolerant: true,
  parseAbpSpecificRules: true,
  parseUboSpecificRules: true,
  includeRaws: true
}

export type ParsedLine = {
  Raw: string
  LineEnding: string
  Rule: AGTree.AnyRule | null
}

export function IsCosmeticRule(Filter: AGTree.AnyRule): Filter is AGTree.AnyCosmeticRule {
  return Filter.category === AGTree.RuleCategory.Cosmetic
}

export function IsNetworkRule(Filter: AGTree.AnyRule): Filter is AGTree.NetworkRule {
  return Filter.category === AGTree.RuleCategory.Network && Filter.type === AGTree.NetworkRuleType.NetworkRule
}

export function ParseRule(RawRule: string): AGTree.AnyRule | null {
  if (RawRule.trim().length === 0) {
    return null
  }

  try {
    const Rule = AGTree.RuleParser.parse(RawRule, ParserOptions)

    return Rule.category === AGTree.RuleCategory.Invalid ? null : Rule
  } catch {
    return null
  }
}

export function ParseDomainList(RawDomainList: string, BaseOffset: number, Separator?: AGTree.DomainListSeparator): AGTree.DomainList | null {
  try {
    return AGTree.DomainListParser.parse(RawDomainList, ParserOptions, BaseOffset, Separator)
  } catch {
    return null
  }
}

/**
 * Returns a comparable domain, or `null` when the entry is not a plain hostname
 * (wildcards, regular expressions, IP literals, `*` placeholders and so on).
 */
export function NormalizeDomain(RawDomain: string): string | null {
  const Domain = RawDomain.trim().toLowerCase().replace(/\.$/, '')

  if (!Domain || Domain.includes('*') || Domain.includes('/') || !Domain.includes('.')) {
    return null
  }

  if (Domain.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(Domain)) {
    return null
  }

  return AGTree.DomainUtils.isValidDomainOrHostname(Domain) ? Domain : null
}

/** Domain lists attached to a rule that make it apply to specific domains only. */
export function GetRuleDomainLists(Filter: AGTree.AnyRule): AGTree.DomainList[] {
  const DomainLists: AGTree.DomainList[] = []

  if (IsCosmeticRule(Filter) && Filter.domains) {
    DomainLists.push(Filter.domains)
  }

  const Modifiers = IsCosmeticRule(Filter) || IsNetworkRule(Filter) ? Filter.modifiers : undefined

  for (const Modifier of Modifiers?.children ?? []) {
    if (!Modifier.value || !DomainModifierNames.has(Modifier.name.value)) {
      continue
    }

    const DomainList = ParseDomainList(Modifier.value.value, Modifier.value.start ?? 0, AGTree.PIPE_MODIFIER_SEPARATOR)
    if (DomainList) {
      DomainLists.push(DomainList)
    }
  }

  return DomainLists
}

/** Normalized, non-negated domains a rule is restricted to. */
export function GetRuleDomains(Filter: AGTree.AnyRule): string[] {
  const Domains: string[] = []

  for (const DomainList of GetRuleDomainLists(Filter)) {
    for (const Domain of DomainList.children) {
      if (Domain.exception) {
        continue
      }

      const Normalized = NormalizeDomain(Domain.value)
      if (Normalized) {
        Domains.push(Normalized)
      }
    }
  }

  return Domains
}

export function SerializeDomainList(Domains: AGTree.Domain[]): string {
  return Domains
    .map(Domain => `${Domain.exception ? AGTree.NEGATION_MARKER : ''}${Domain.value}`)
    .join(AGTree.PIPE_MODIFIER_SEPARATOR)
}

/** Splits raw file content into lines while remembering the original line endings. */
export function SplitLines(Content: string): { Text: string, LineEnding: string }[] {
  return Content.split('\n').map((Line, Index, All) => {
    const HasCarriageReturn = Line.endsWith('\r')
    const IsLastLine = Index === All.length - 1

    return {
      Text: HasCarriageReturn ? Line.slice(0, -1) : Line,
      LineEnding: IsLastLine ? '' : (HasCarriageReturn ? '\r\n' : '\n')
    }
  })
}
