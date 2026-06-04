import { test, expect } from '@playwright/test'
import {
  addAuthToPage,
  completeOnboarding,
  expectNoConsoleErrors,
  registerAndLogin,
  uniqueEmail,
  watchConsole,
} from './helpers.js'

test('workflows nav item on trial account shows upgrade message and lock', async ({ page, request }) => {
  const consoleErrors = watchConsole(page)
  const auth = await registerAndLogin(request, { email: uniqueEmail('tier') })
  await completeOnboarding(request, auth)
  await addAuthToPage(page, auth)

  await page.goto('/dashboard')

  await expect(page.getByText(/available on team and pro plans/i)).toBeVisible()
  await expect(page.locator('aside').getByText('lock')).toBeVisible()
  await expectNoConsoleErrors(consoleErrors)
})
