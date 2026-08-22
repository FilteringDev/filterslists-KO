import * as AGTree from '@adguard/agtree'
import type { FileRewriteResult, RuleChange } from './types.ts'
import {
  DomainModifierNames,
  IsCosmeticRule,
  IsNetworkRule,
  NormalizeDomain,
  ParseDomainList,
  ParseRule,
  SerializeDomainList,
  SplitLines
} from './rule-domains.ts'

type DomainListRewrite = {
  RemovedDomains: string[]
  HadPermittedDomains: boolean
  HasPermittedDomains: boolean
}

function CountPermitted(Domains: AGTree.Domain[]): number {
  return Domains.filter(Domain => !Domain.exception).length
}

function RewriteDomainListChildren(Domains: AGTree.Domain[], DeadDomains: Set<string>): {
  Kept: AGTree.Domain[]
  Rewrite: DomainListRewrite
} {
  const RemovedDomains: string[] = []
  const Kept: AGTree.Domain[] = []

  for (const Domain of Domains) {
    const Normalized = Domain.exception ? null : NormalizeDomain(Domain.value)

    if (Normalized && DeadDomains.has(Normalized)) {
      RemovedDomains.push(Normalized)
      continue
    }

    Kept.push(Domain)
  }

  return {
    Kept,
    Rewrite: {
      RemovedDomains,
      HadPermittedDomains: CountPermitted(Domains) > 0,
      HasPermittedDomains: CountPermitted(Kept) > 0
    }
  }
}

function RewriteModifiers(Modifiers: AGTree.ModifierList | undefined, DeadDomains: Set<string>): DomainListRewrite[] {
  const Rewrites: DomainListRewrite[] = []

  for (const Modifier of Modifiers?.children ?? []) {
    if (!Modifier.value || !DomainModifierNames.has(Modifier.name.value)) {
      continue
    }

    const DomainList = ParseDomainList(Modifier.value.value, Modifier.value.start ?? 0, AGTree.PIPE_MODIFIER_SEPARATOR)
    if (!DomainList) {
      continue
    }

    const { Kept, Rewrite } = RewriteDomainListChildren(DomainList.children, DeadDomains)
    if (Rewrite.RemovedDomains.length === 0) {
      continue
    }

    Modifier.value.value = SerializeDomainList(Kept)
    Rewrites.push(Rewrite)
  }

  return Rewrites
}

type RuleRewriteResult = {
  Text: string | null
  RemovedDomains: string[]
}

/**
 * Removes dead domains from a single rule.
 * Returns `null` text when the rule loses every domain it was restricted to, because such a rule
 * would silently become a global one.
 */
export function RewriteRule(RawRule: string, DeadDomains: Set<string>): RuleRewriteResult {
  const Rule = ParseRule(RawRule)

  if (!Rule || (!IsCosmeticRule(Rule) && !IsNetworkRule(Rule))) {
    return { Text: RawRule, RemovedDomains: [] }
  }

  const NewRule = structuredClone(Rule)
  const Rewrites: DomainListRewrite[] = []

  if (IsCosmeticRule(NewRule) && NewRule.domains) {
    const { Kept, Rewrite } = RewriteDomainListChildren(NewRule.domains.children, DeadDomains)

    if (Rewrite.RemovedDomains.length > 0) {
      NewRule.domains.children = Kept
      Rewrites.push(Rewrite)
    }
  }

  Rewrites.push(...RewriteModifiers(NewRule.modifiers, DeadDomains))

  const RemovedDomains = Rewrites.flatMap(Rewrite => Rewrite.RemovedDomains)
  if (RemovedDomains.length === 0) {
    return { Text: RawRule, RemovedDomains: [] }
  }

  const LostAllDomains = Rewrites.some(Rewrite => Rewrite.HadPermittedDomains && !Rewrite.HasPermittedDomains)
  if (LostAllDomains) {
    return { Text: null, RemovedDomains }
  }

  return { Text: AGTree.RuleGenerator.generate(NewRule), RemovedDomains }
}

export function RewriteFilterContent(FilePath: string, Content: string, DeadDomains: Set<string>): FileRewriteResult {
  const Lines = SplitLines(Content)
  const OutputParts: string[] = []
  const ModifiedRules: RuleChange[] = []
  const RemovedRules: RuleChange[] = []

  for (let Index = 0; Index < Lines.length; Index += 1) {
    const Line = Lines[Index]
    const { Text, RemovedDomains } = RewriteRule(Line.Text, DeadDomains)

    if (RemovedDomains.length === 0) {
      OutputParts.push(Line.Text + Line.LineEnding)
      continue
    }

    const Change: RuleChange = {
      FilePath,
      LineNumber: Index + 1,
      Before: Line.Text,
      After: Text,
      RemovedDomains
    }

    if (Text === null) {
      RemovedRules.push(Change)
      continue
    }

    ModifiedRules.push(Change)
    OutputParts.push(Text + Line.LineEnding)
  }

  const NewContent = OutputParts.join('')

  return {
    Content: NewContent,
    Changed: NewContent !== Content,
    ModifiedRules,
    RemovedRules
  }
}
