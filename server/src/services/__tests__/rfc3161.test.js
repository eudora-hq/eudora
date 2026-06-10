import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forge from 'node-forge'
import {
  requestTimestamp,
  verifyTimestamp,
} from '../rfc3161.js'

const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2'
const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4'

function node(type, constructed, value) {
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    type,
    constructed,
    value
  )
}

function oid(value) {
  return node(forge.asn1.Type.OID, false, forge.asn1.oidToDer(value).getBytes())
}

function integer(value) {
  return node(
    forge.asn1.Type.INTEGER,
    false,
    forge.asn1.integerToDer(value).getBytes()
  )
}

function validTimestampResponse(data, timestamp = new Date('2026-06-10T14:23:01Z')) {
  const hash = createHash('sha256').update(data).digest().toString('binary')
  const tstInfo = node(forge.asn1.Type.SEQUENCE, true, [
    integer(1),
    oid('1.2.3.4.1'),
    node(forge.asn1.Type.SEQUENCE, true, [
      node(forge.asn1.Type.SEQUENCE, true, [
        oid(SHA256_OID),
        node(forge.asn1.Type.NULL, false, ''),
      ]),
      node(forge.asn1.Type.OCTETSTRING, false, hash),
    ]),
    integer(1),
    node(
      forge.asn1.Type.GENERALIZEDTIME,
      false,
      forge.asn1.dateToGeneralizedTime(timestamp)
    ),
  ])
  const tstInfoDer = forge.asn1.toDer(tstInfo).getBytes()
  const signedData = node(forge.asn1.Type.SEQUENCE, true, [
    integer(3),
    node(forge.asn1.Type.SET, true, []),
    node(forge.asn1.Type.SEQUENCE, true, [
      oid(TST_INFO_OID),
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        node(forge.asn1.Type.OCTETSTRING, false, tstInfoDer),
      ]),
    ]),
  ])
  const response = node(forge.asn1.Type.SEQUENCE, true, [
    node(forge.asn1.Type.SEQUENCE, true, [integer(0)]),
    node(forge.asn1.Type.SEQUENCE, true, [
      oid(SIGNED_DATA_OID),
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData]),
    ]),
  ])
  return Buffer.from(forge.asn1.toDer(response).getBytes(), 'binary')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('RFC 3161 timestamp service', () => {
  it('posts a DER timestamp request and verifies a valid response', async () => {
    const data = Buffer.from('signed report bytes')
    const timestampResponse = validTimestampResponse(data)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => timestampResponse,
    })
    vi.stubGlobal('fetch', fetchMock)

    const token = await requestTimestamp(data)
    const verification = await verifyTimestamp(data, token)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://freetsa.org/tsr',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/timestamp-query',
        }),
      })
    )
    expect(Buffer.isBuffer(fetchMock.mock.calls[0][1].body)).toBe(true)
    expect(verification).toEqual({
      valid: true,
      timestamp: '2026-06-10T14:23:01.000Z',
      tsa: 'https://freetsa.org/tsr',
    })
  })

  it('rejects an HTTP 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    await expect(requestTimestamp(Buffer.from('report'))).rejects.toThrow('HTTP 500')
  })

  it('aborts the TSA request after ten seconds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })))

    const pending = requestTimestamp(Buffer.from('report'))
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
  })
})
