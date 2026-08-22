import Test from 'ava'
import { RewriteFilterContent, RewriteRule } from '../source/dead-domain/rewrite-filters.ts'
import { CollectDomainOccurrencesFromContent } from '../source/dead-domain/collect-domains.ts'

const DeadDomains = new Set(['example.com', 'example.org'])

Test('RewriteRule keeps a cosmetic rule that still has live domains', T => {
  const Result = RewriteRule('example.org,live.com##.ads', new Set(['example.org']))

  T.is(Result.Text, 'live.com##.ads')
  T.deepEqual(Result.RemovedDomains, ['example.org'])
})

Test('RewriteRule drops a cosmetic rule that loses every domain', T => {
  const Result = RewriteRule('example.com,example.org##.ads', DeadDomains)

  T.is(Result.Text, null)
  T.deepEqual(Result.RemovedDomains, ['example.com', 'example.org'])
})

Test('RewriteRule drops a network rule whose $domain becomes empty', T => {
  const Result = RewriteRule('||powerads.org^$domain=example.com|example.org', DeadDomains)

  T.is(Result.Text, null)
})

Test('RewriteRule shrinks a network rule that keeps at least one domain', T => {
  const Result = RewriteRule('||powerads.org^$domain=example.com|alive.com', DeadDomains)

  T.is(Result.Text, '||powerads.org^$domain=alive.com')
})

Test('RewriteRule leaves the network pattern host untouched', T => {
  const Result = RewriteRule('||example.com^', DeadDomains)

  T.is(Result.Text, '||example.com^')
  T.deepEqual(Result.RemovedDomains, [])
})

Test('RewriteRule keeps negated domains and removes only dead permitted ones', T => {
  const Result = RewriteRule('example.com,live.com,~sub.live.com##.ads', DeadDomains)

  T.is(Result.Text, 'live.com,~sub.live.com##.ads')
})

Test('RewriteRule drops a rule that keeps only negated domains', T => {
  const Result = RewriteRule('example.com,~sub.example.com##.ads', DeadDomains)

  T.is(Result.Text, null)
})

Test('RewriteRule handles scriptlet and HTML filtering rules', T => {
  T.is(RewriteRule('example.com,live.com#%#//scriptlet(\'abort-on-property-read\', \'foo\')', DeadDomains).Text,
    'live.com#%#//scriptlet(\'abort-on-property-read\', \'foo\')')
  T.is(RewriteRule('example.com$$script[tag-content="ads"]', DeadDomains).Text, null)
})

Test('RewriteFilterContent removes lines and preserves everything else', T => {
  const Content = [
    '! Title: test',
    'example.com,live.com##.ads',
    'example.com,example.org##.banner',
    '||tracker.example^$third-party',
    ''
  ].join('\n')

  const Result = RewriteFilterContent('test.txt', Content, DeadDomains)

  T.true(Result.Changed)
  T.is(Result.Content, [
    '! Title: test',
    'live.com##.ads',
    '||tracker.example^$third-party',
    ''
  ].join('\n'))
  T.is(Result.ModifiedRules.length, 1)
  T.is(Result.RemovedRules.length, 1)
})

Test('RewriteFilterContent is a no-op when no dead domain is present', T => {
  const Content = 'live.com##.ads\n'

  T.false(RewriteFilterContent('test.txt', Content, DeadDomains).Changed)
})

Test('CollectDomainOccurrencesFromContent reports line numbers and skips non-domains', T => {
  const Content = [
    '! comment',
    'example.com##.ads',
    '||ads.example^$domain=shop.example|~sub.shop.example',
    '/regexp/##.ads',
    '*##.ads'
  ].join('\n')

  T.deepEqual(CollectDomainOccurrencesFromContent('test.txt', Content), [
    { Domain: 'example.com', FilePath: 'test.txt', LineNumber: 2 },
    { Domain: 'shop.example', FilePath: 'test.txt', LineNumber: 3 }
  ])
})
