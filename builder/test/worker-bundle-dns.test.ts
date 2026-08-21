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

Test('FilterForDns strips network rules with DNS-incompatible modifiers', T => {
  const FiltersList = ParseFilterList([
    '||example.com^$script',
    '||example.com/ads.css^$stylesheet',
    '||example.com^$csp=script-src \'none\'',
    '||example.com^$removeparam=utm_source',
    '||example.net^'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), ['||example.net^'])
})

Test('FilterForDns keeps network rules with DNS-compatible modifiers', T => {
  const FiltersList = ParseFilterList([
    '||example.com^$important',
    '@@||example.com^$third-party',
    '||example.com^$dnsrewrite=127.0.0.1',
    '||example.com^$client=192.168.0.1'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), [
    '||example.com^$important',
    '@@||example.com^$third-party',
    '||example.com^$dnsrewrite=127.0.0.1',
    '||example.com^$client=192.168.0.1'
  ])
})

Test('FilterForDns keeps host rules and plain domain-blocking rules', T => {
  const FiltersList = ParseFilterList([
    '0.0.0.0 example.com',
    '||example.com^',
    '||example.org^'
  ].join('\n'))

  T.deepEqual(RawTexts(Builder.FilterForDns(FiltersList)), [
    '0.0.0.0 example.com',
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
