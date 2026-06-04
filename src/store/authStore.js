import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useAuthStore = create(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      plan: 'trial',
      trialDaysLeft: 14,

      setAuth: (user, accessToken, refreshToken) => {
        const plan = user?.plan || 'trial'
        const trialEndsAt = user?.trial_ends_at ?? null
        const trialDaysLeft = user?.trialDaysLeft ?? (
          trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000))) : 14
        )

        return set({
          user: {
            ...user,
            plan,
            trial_ends_at: trialEndsAt,
          },
          accessToken,
          refreshToken,
          isAuthenticated: true,
          plan,
          trialDaysLeft,
        })
      },

      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),

      clearAuth: () => set({
        user: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        plan: 'trial',
        trialDaysLeft: 14,
      }),
    }),
    { name: 'eudora-auth' }
  )
)
