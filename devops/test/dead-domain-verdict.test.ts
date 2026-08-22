import Test from 'ava'
import { AreDomainsRelated, EvaluateMeasurement } from '../source/dead-domain/verdict.ts'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from '../source/dead-domain/globalping.ts'

function Measurement(...Results: Partial<GlobalpingProbeResult>[]): GlobalpingMeasurement {
  return {
    status: 'finished',
    results: Results.map(Result => ({ result: { status: 'finished', ...Result } as GlobalpingProbeResult }))
  }
}

Test('AreDomainsRelated compares registrable domains', T => {
  T.true(AreDomainsRelated('sub.example.com', 'example.com'))
  T.true(AreDomainsRelated('www.example.co.kr', 'shop.example.co.kr'))
  T.false(AreDomainsRelated('example.com', 'example.org'))
  T.false(AreDomainsRelated('example.co.kr', 'other.co.kr'))
})

Test('A redirect to a different registrable domain is dead', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 301,
    resolvedAddress: '1.2.3.4',
    headers: { location: 'https://example.org/' }
  }))

  T.is(Result.Verdict, 'Dead')
  T.true(Result.Warnings.some(Warning => Warning.includes('example.org')))
})

Test('A redirect inside the same registrable domain is only a warning', T => {
  const Result = EvaluateMeasurement('sub.example.com', Measurement({
    statusCode: 301,
    resolvedAddress: '1.2.3.4',
    headers: { location: 'https://example.com/' }
  }))

  T.not(Result.Verdict, 'Dead')
  T.is(Result.Warnings.length, 1)
  T.true(Result.Warnings[0].includes('example.com'))
})

Test('A relative redirect produces no warning', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 302,
    resolvedAddress: '1.2.3.4',
    headers: { location: '/new-path' }
  }))

  T.not(Result.Verdict, 'Dead')
  T.deepEqual(Result.Warnings, [])
})

Test('A failed TLS certificate validation is dead and warns', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    tls: { authorized: false, error: 'certificate has expired' }
  }))

  T.is(Result.Verdict, 'Dead')
  T.true(Result.Reason.includes('TLS'))
  T.true(Result.Warnings.some(Warning => Warning.includes('plain HTTP')))
})

Test('A TLS error reported only in the raw output is dead', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    rawOutput: 'Error: CERT_HAS_EXPIRED'
  }))

  T.is(Result.Verdict, 'Dead')
})

Test('A valid certificate does not trigger the TLS rule', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 200,
    resolvedAddress: '1.2.3.4',
    tls: { authorized: true }
  }))

  T.is(Result.Verdict, 'Alive')
  T.deepEqual(Result.Warnings, [])
})

Test('DNS resolution failures stay dead', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: null,
    rawOutput: 'queryA ENOTFOUND example.com'
  }))

  T.is(Result.Verdict, 'Dead')
})

Test('A 2xx response stays alive', T => {
  T.is(EvaluateMeasurement('example.com', Measurement({ statusCode: 200, resolvedAddress: '1.2.3.4' })).Verdict, 'Alive')
})

Test('A timeout stays alive', T => {
  const Result = EvaluateMeasurement('example.com', Measurement({
    status: 'failed',
    resolvedAddress: '1.2.3.4',
    rawOutput: 'Error: ETIMEDOUT'
  }))

  T.is(Result.Verdict, 'Alive')
})

Test('An empty measurement is unknown', T => {
  T.is(EvaluateMeasurement('example.com', Measurement()).Verdict, 'Unknown')
})
