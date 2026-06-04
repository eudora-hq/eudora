import { expect } from '@playwright/test'

export const API_URL = 'http://localhost:3001'
export const PASSWORD = 'EudoraTest123'

export function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
}

export function watchConsole(page) {
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (/Failed to load resource: the server responded with a status of \(?(400|401|403|429)\)?/i.test(text)) return
    errors.push(text)
  })
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

export async function expectNoConsoleErrors(errors) {
  expect(errors, `Browser console errors:\n${errors.join('\n')}`).toEqual([])
}

export async function registerAndLogin(request, { email = uniqueEmail('e2e'), password = PASSWORD, name = 'E2E Operator' } = {}) {
  const register = await request.post(`${API_URL}/auth/register`, {
    data: { name, email, password },
  })
  expect(register.ok()).toBeTruthy()
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email, password },
  })
  expect(login.ok()).toBeTruthy()
  const auth = await login.json()
  return {
    email,
    password,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: { ...auth.user, onboardingCompleted: auth.onboardingCompleted, plan: 'trial' },
  }
}

export async function completeOnboarding(request, auth) {
  await request.patch(`${API_URL}/users/me`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
    data: { onboarding_completed: true },
  })
  auth.user.onboardingCompleted = true
}

export async function addAuthToPage(page, auth) {
  await page.addInitScript((storedAuth) => {
    window.localStorage.setItem('eudora-auth', JSON.stringify({
      state: {
        user: storedAuth.user,
        accessToken: storedAuth.accessToken,
        refreshToken: storedAuth.refreshToken,
        isAuthenticated: true,
        plan: storedAuth.user.plan || 'trial',
        trialDaysLeft: 14,
      },
      version: 0,
    }))
  }, auth)
}

export async function seedApiKey(request, auth) {
  const res = await request.post(`${API_URL}/api-keys`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
    data: {
      provider: 'openai',
      label: 'E2E fake key',
      key: 'sk-e2e-fake-key',
    },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

export async function seedAgent(request, auth, apiKeyId = null) {
  const res = await request.post(`${API_URL}/agents`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
    data: {
      name: 'E2E AGENT',
      purpose: 'Help with end to end tests',
      model_provider: 'openai',
      api_key_id: apiKeyId,
      system_prompt: 'You are a concise test assistant.',
    },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

export async function loginThroughUi(page, email, password) {
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/auth/login')),
    page.getByRole('button', { name: /initialize secure session/i }).click(),
  ])
}
