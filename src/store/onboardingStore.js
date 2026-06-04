import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useOnboardingStore = create(
  persist(
    (set) => ({
      currentStep: 1,
      apiKeyId: null,
      apiKeyProvider: null,
      generatedAgent: null,
      agentId: null,
      cronJobId: null,

      setStep: (step) => set({ currentStep: step }),
      setApiKey: (id, provider) => set({ apiKeyId: id, apiKeyProvider: provider }),
      setGeneratedAgent: (agent) => set({ generatedAgent: agent }),
      setAgentId: (id) => set({ agentId: id }),
      setCronJobId: (id) => set({ cronJobId: id }),
      reset: () => set({
        currentStep: 1,
        apiKeyId: null,
        apiKeyProvider: null,
        generatedAgent: null,
        agentId: null,
        cronJobId: null,
      }),
    }),
    { name: 'eudora-onboarding' }
  )
)
