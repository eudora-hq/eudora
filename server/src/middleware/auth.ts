import { verifyAccessToken } from '../utils/auth.ts'

export async function authenticate(request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  const token = authHeader.slice(7)
  try {
    const payload = verifyAccessToken(token)
    request.user = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
    }
  } catch {
    return reply.code(401).send({ error: 'unauthorized' })
  }
}

export default authenticate
