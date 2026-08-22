import { SimpleSecureReq } from '@typescriptprime/securereq'
import * as Zod from 'zod'

export const GlobalpingApiBaseUrl = 'https://api.globalping.io/v1'

/**
 * Globalping applies a per-IP hourly credit budget to anonymous callers.
 * Runs are capped well below it because GitHub-hosted runners share their egress addresses.
 */
export const MaxMeasurementsPerRun = 50

const MeasurementPollIntervalMs = 1500
const MeasurementTimeoutMs = 60000
const RequestTimeoutMs = 30000

const CreatedMeasurementSchema = Zod.object({
  id: Zod.string().nonempty()
}).loose()

const MeasurementSchema = Zod.object({
  status: Zod.string(),
  results: Zod.array(Zod.object({
    result: Zod.object({
      status: Zod.string().optional(),
      statusCode: Zod.number().nullish(),
      resolvedAddress: Zod.string().nullish(),
      rawOutput: Zod.string().nullish(),
      rawHeaders: Zod.string().nullish(),
      headers: Zod.record(Zod.string(), Zod.union([Zod.string(), Zod.array(Zod.string())])).nullish(),
      tls: Zod.object({
        authorized: Zod.boolean().nullish(),
        error: Zod.string().nullish(),
        authorizationError: Zod.string().nullish()
      }).loose().nullish()
    }).loose()
  }).loose()).default([])
}).loose()

export type GlobalpingMeasurement = Zod.infer<typeof MeasurementSchema>
export type GlobalpingProbeResult = GlobalpingMeasurement['results'][number]['result']

export class GlobalpingRateLimitError extends Error {
  constructor(Message: string) {
    super(Message)
    this.name = 'GlobalpingRateLimitError'
  }
}

function Delay(DurationMs: number): Promise<void> {
  return new Promise(Resolve => setTimeout(Resolve, DurationMs))
}

async function CreateMeasurement(Domain: string): Promise<string> {
  const Payload = JSON.stringify({
    type: 'http',
    target: Domain,
    locations: [{ country: 'KR' }],
    limit: 1,
    inProgressUpdates: false,
    measurementOptions: {
      protocol: 'HTTPS',
      request: { method: 'GET', path: '/' }
    }
  })

  const Response = await SimpleSecureReq.Request(new URL(`${GlobalpingApiBaseUrl}/measurements`), {
    HttpMethod: 'POST',
    HttpHeaders: { 'content-type': 'application/json' },
    Payload,
    ExpectedAs: 'JSON',
    FollowRedirects: true,
    MaxRedirects: 3,
    TimeoutMs: RequestTimeoutMs
  })

  if (Response.StatusCode === 429) {
    throw new GlobalpingRateLimitError('Globalping rate limit reached while creating a measurement')
  }

  if (Response.StatusCode < 200 || Response.StatusCode >= 300) {
    throw new Error(`Globalping measurement creation failed with HTTP ${Response.StatusCode}`)
  }

  return CreatedMeasurementSchema.parse(Response.Body).id
}

async function FetchMeasurement(MeasurementId: string): Promise<GlobalpingMeasurement> {
  const Response = await SimpleSecureReq.Request(new URL(`${GlobalpingApiBaseUrl}/measurements/${MeasurementId}`), {
    HttpMethod: 'GET',
    ExpectedAs: 'JSON',
    FollowRedirects: true,
    MaxRedirects: 3,
    TimeoutMs: RequestTimeoutMs
  })

  if (Response.StatusCode === 429) {
    throw new GlobalpingRateLimitError('Globalping rate limit reached while polling a measurement')
  }

  if (Response.StatusCode < 200 || Response.StatusCode >= 300) {
    throw new Error(`Globalping measurement lookup failed with HTTP ${Response.StatusCode}`)
  }

  return MeasurementSchema.parse(Response.Body)
}

/** Creates an HTTP measurement restricted to Korean probes and waits for it to settle. */
export async function ProbeDomain(Domain: string): Promise<GlobalpingMeasurement> {
  const MeasurementId = await CreateMeasurement(Domain)
  const Deadline = Date.now() + MeasurementTimeoutMs

  for (;;) {
    await Delay(MeasurementPollIntervalMs)

    const Measurement = await FetchMeasurement(MeasurementId)
    if (Measurement.status !== 'in-progress') {
      return Measurement
    }

    if (Date.now() > Deadline) {
      throw new Error(`Globalping measurement ${MeasurementId} for ${Domain} did not finish in time`)
    }
  }
}
