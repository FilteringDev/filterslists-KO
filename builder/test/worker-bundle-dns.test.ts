import * as AGTree from '@adguard/agtree'
import Test from 'ava'
import { BuildBundledDnsFiltersList } from '../source/worker-bundle-dns.ts'

const ParserOptions: AGTree.ParserOptions = {
  ...AGTree.defaultParserOptions,
  parseAbpSpecificRules: true,
  parseUboSpecificRules: true,
  includeRaws: true
}

function ParseFilterList(RawFilterList: string): AGTree.FilterList {
  return AGTree.FilterListParser.parse(RawFilterList, ParserOptions)
}

function RawTexts(FiltersList: AGTree.FilterList): string[] {
  return FiltersList.children.map(Filter => Filter.raws?.text ?? AGTree.RuleGenerator.generate(Filter))
}

const Builder = new BuildBundledDnsFiltersList({
  FiltersProcessableCache: new Map(),
  WorkingDirectory: '/tmp',
  FiltersListDirectory: '/tmp',
  OutputDirectory: '/tmp'
})

Test('FilterForDns strips cosmetic rules', T => {
  const FiltersList = ParseFilterList([
    'example.com##.ad',
    'example.com#@#.ad',
    'example.com#%#//scriptlet("abort-on-property-read", "foo")',
    'example.com#$#.ad { display: none; }',
    '||example.com^'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), ['||example.com^'])
})

Test('FilterForDns strips network rules with modifiers', T => {
  const FiltersList = ParseFilterList([
    '||example.com^$script',
    '||example.com/ads.css^$stylesheet',
    '||example.com^$csp=script-src \'none\'',
    '||example.com^$removeparam=utm_source',
    '||example.net^'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), ['||example.net^'])
})

Test('FilterForDns strips exception rules', T => {
  const FiltersList = ParseFilterList([
    '@@||example.com^',
    '@@||example.org^$third-party',
    '||example.net^'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), ['||example.net^'])
})

Test('FilterForDns keeps only plain domain-blocking rules', T => {
  const FiltersList = ParseFilterList([
    '0.0.0.0 example.com',
    '||example.com^',
    '||example.org^',
    '||example.com/ads^',
    '||*.example.net^',
    '/ads[0-9]+/'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), [
    '||example.com^',
    '||example.org^'
  ])
})

Test('FilterForDns deduplicates identical rules', T => {
  const FiltersList = ParseFilterList([
    '||example.com^',
    '||example.com^',
    '||example.org^'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), ['||example.com^', '||example.org^'])
})
