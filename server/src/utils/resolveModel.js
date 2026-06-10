/**
 * Resolves which configured model to use for an agent run.
 * Priority: agent.model_override > connection.default_model > null.
 */
export function resolveModel(agent, connection) {
  return agent?.model_override || connection?.default_model || null
}
