import { createHash, randomBytes } from 'crypto'
import forge from 'node-forge'

export const TSA_URL = 'https://freetsa.org/tsr'
export const TSA_CERT_URL = 'https://freetsa.org/files/tsa.crt'

const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4'
const TIMEOUT_MS = 10_000

function asn1Integer(bytes) {
  const positive = (bytes[0] & 0x80) !== 0
    ? Buffer.concat([Buffer.from([0]), bytes])
    : bytes
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.INTEGER,
    false,
    positive.toString('binary')
  )
}

function buildTimestampRequest(hash, nonce) {
  const asn1 = forge.asn1
  const request = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.INTEGER,
      false,
      asn1.integerToDer(1).getBytes()
    ),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(
          asn1.Class.UNIVERSAL,
          asn1.Type.OID,
          false,
          asn1.oidToDer(SHA256_OID).getBytes()
        ),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
      ]),
      asn1.create(
        asn1.Class.UNIVERSAL,
        asn1.Type.OCTETSTRING,
        false,
        hash.toString('binary')
      ),
    ]),
    asn1Integer(nonce),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ])

  return Buffer.from(asn1.toDer(request).getBytes(), 'binary')
}

function oid(node) {
  if (
    node?.tagClass !== forge.asn1.Class.UNIVERSAL
    || node?.type !== forge.asn1.Type.OID
  ) return null
  return forge.asn1.derToOid(node.value)
}

function findTstInfo(node) {
  if (!node || !Array.isArray(node.value)) return null

  for (let index = 0; index < node.value.length; index++) {
    if (oid(node.value[index]) !== TST_INFO_OID) continue
    const content = node.value[index + 1]
    if (!content) continue
    const octet = findOctetString(content)
    if (octet) return octet
  }

  for (const child of node.value) {
    const found = findTstInfo(child)
    if (found) return found
  }
  return null
}

function findOctetString(node) {
  if (!node) return null
  if (
    node.tagClass === forge.asn1.Class.UNIVERSAL
    && node.type === forge.asn1.Type.OCTETSTRING
  ) {
    if (Array.isArray(node.value)) {
      return node.value.map(part => part.value || '').join('')
    }
    return node.value
  }
  if (!Array.isArray(node.value)) return null
  for (const child of node.value) {
    const found = findOctetString(child)
    if (found) return found
  }
  return null
}

function parseTimestampResponse(timestampToken) {
  const root = forge.asn1.fromDer(
    forge.util.createBuffer(Buffer.from(timestampToken).toString('binary')),
    true
  )
  const statusInfo = root.value?.[0]
  const statusNode = statusInfo?.value?.[0]
  const status = statusNode
    ? forge.asn1.derToInteger(statusNode.value)
    : -1
  if (![0, 1].includes(status)) {
    throw new Error(`Timestamp Authority rejected request with status ${status}`)
  }

  const tstInfoDer = findTstInfo(root)
  if (!tstInfoDer) throw new Error('Timestamp response does not contain TSTInfo')
  const tstInfo = forge.asn1.fromDer(forge.util.createBuffer(tstInfoDer), true)
  const messageImprint = tstInfo.value?.[2]
  const hashAlgorithm = oid(messageImprint?.value?.[0]?.value?.[0])
  const hashedMessage = messageImprint?.value?.[1]?.value
  const genTimeNode = tstInfo.value?.[4]
  const timestamp = genTimeNode
    ? forge.asn1.generalizedTimeToDate(genTimeNode.value).toISOString()
    : null

  return {
    hashAlgorithm,
    hashedMessage: hashedMessage
      ? Buffer.from(hashedMessage, 'binary')
      : null,
    timestamp,
  }
}

export async function requestTimestamp(dataBuffer) {
  const hash = createHash('sha256').update(dataBuffer).digest()
  const requestBody = buildTimestampRequest(hash, randomBytes(8))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(TSA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
      },
      body: requestBody,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Timestamp Authority returned HTTP ${response.status}`)
    }
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifyTimestamp(dataBuffer, timestampToken) {
  try {
    const parsed = parseTimestampResponse(timestampToken)
    const actualHash = createHash('sha256').update(dataBuffer).digest()
    const valid = parsed.hashAlgorithm === SHA256_OID
      && parsed.hashedMessage?.length === actualHash.length
      && parsed.hashedMessage.equals(actualHash)

    return {
      valid,
      timestamp: parsed.timestamp,
      tsa: TSA_URL,
    }
  } catch {
    return { valid: false, timestamp: null, tsa: TSA_URL }
  }
}

export function embedTimestampMetadata(pdfBuffer, timestampToken) {
  const pdfText = pdfBuffer.toString('binary')
  const startXrefMatches = [...pdfText.matchAll(/startxref\s+(\d+)\s+%%EOF/g)]
  const trailerMatches = [...pdfText.matchAll(/trailer\s*<<(.*?)>>\s*startxref/gs)]
  const lastXref = startXrefMatches.at(-1)
  const lastTrailer = trailerMatches.at(-1)
  if (!lastXref || !lastTrailer) {
    throw new Error('PDF does not use a supported cross-reference table')
  }

  const trailer = lastTrailer[1]
  const size = Number(trailer.match(/\/Size\s+(\d+)/)?.[1])
  const root = trailer.match(/\/Root\s+(\d+\s+\d+\s+R)/)?.[1]
  if (!size || !root) throw new Error('PDF trailer is missing Size or Root')

  const token = Buffer.from(timestampToken).toString('base64')
  const objectOffset = pdfBuffer.length + 1
  const object = `\n${size} 0 obj\n<< /Keywords (eudora-tsr: ${token}) >>\nendobj\n`
  const xrefOffset = objectOffset + Buffer.byteLength(object.slice(1), 'binary')
  const incremental = `${object}xref\n${size} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n`
    + `trailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${lastXref[1]} >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.concat([pdfBuffer, Buffer.from(incremental, 'binary')])
}

export function extractTimestampedContent(pdfBuffer) {
  const marker = Buffer.from('\n<< /Keywords (eudora-tsr: ')
  const markerIndex = pdfBuffer.lastIndexOf(marker)
  if (markerIndex < 0) return Buffer.from(pdfBuffer)

  const objectStart = pdfBuffer.lastIndexOf(Buffer.from('\n'), markerIndex - 1)
  return Buffer.from(pdfBuffer.subarray(0, objectStart >= 0 ? objectStart : markerIndex))
}
