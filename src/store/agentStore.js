import { create } from 'zustand'

export const useAgentStore = create((set) => ({
  agents: [],
  activeAgent: null,

  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((state) => ({ agents: [agent, ...state.agents] })),
  updateAgent: (id, updates) => set((state) => ({
    agents: state.agents.map((a) => a.id === id ? { ...a, ...updates } : a),
  })),
  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter((a) => a.id !== id),
    activeAgent: state.activeAgent?.id === id ? null : state.activeAgent,
  })),
  setActiveAgent: (agent) => set({ activeAgent: agent }),
}))
