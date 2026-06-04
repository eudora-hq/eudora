import { test, expect } from '@playwright/test'
import {
  addAuthToPage,
  completeOnboarding,
  expectNoConsoleErrors,
  registerAndLogin,
  seedApiKey,
  uniqueEmail,
  watchConsole,
} from './helpers.js'

test.beforeEach(async ({ page, request }) => {
  const auth = await registerAndLogin(request, { email: uniqueEmail('agents') })
  await completeOnboarding(request, auth)
  await seedApiKey(request, auth)
  await addAuthToPage(page, auth)
})

test('agents page loads and shows agent list or empty state', async ({ page }) => {
  const consoleErrors = watchConsole(page)

  await page.goto('/agents')

  await expect(page.getByRole('heading', { name: /agent fleet/i })).toBeVisible()
  await expect(page.getByText(/fleet registry/i)).toBeVisible()
  await expect(page.getByText(/no agents deployed|access interface/i).first()).toBeVisible()
  await expectNoConsoleErrors(consoleErrors)
})

test('create agent via intent input adds the new agent to the list', async ({ page }) => {
  const consoleErrors = watchConsole(page)

  await page.route('**/onboarding/generate-agent', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'E2E BUILDER',
        purpose: 'Created by the Playwright agent builder test',
        systemPrompt: 'You are an agent created during an end to end test.',
        suggestedTags: ['general', 'testing'],
      }),
    })
  })

  await page.goto('/agents')
  await page.locator('textarea[placeholder^="Input natural language mission"]').fill('Create an agent for Playwright validation')
  await page.getByRole('button', { name: /^deploy$/i }).click()

  await expect(page.getByText(/review_generated_agent/i)).toBeVisible()
  await page.getByRole('button', { name: /create agent/i }).click()

  await expect(page.getByText('E2E BUILDER')).toBeVisible({ timeout: 10000 })
  await expectNoConsoleErrors(consoleErrors)
})
