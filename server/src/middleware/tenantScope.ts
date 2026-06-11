export function scopeToTenant(request, reply, done) {
  if (!request.user?.tenantId) {
    reply.code(401).send({ error: 'unauthorized' })
    return done()
  }
  request.tenantId = request.user.tenantId
  done()
}
