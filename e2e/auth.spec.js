import { test, expect } from '@playwright/test'
import {
  PASSWORD,
  completeOnboarding,
  expectNoConsoleErrors,
  loginThroughUi,
  registerAndLogin,
  uniqueEmail,
  watchConsole,
} from './helpers.js'

test('signup with new email lands on onboarding', async ({ page }) => {
  const consoleErrors = watchConsole(page)
  const email = uniqueEmail('signup')

  await page.goto('/login')
  await page.getByRole('button', { name: /create account/i }).click()
  await page.locator('input[placeholder="Alexander Vance"]').fill('Signup Operator')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').nth(0).fill(PASSWORD)
  await page.locator('input[type="password"]').nth(1).fill(PASSWORD)
  await page.getByRole('button', { name: /initialize account/i }).click()

  await expect(page).toHaveURL(/\/onboarding/)
  await expect(page.getByText(/connect your model/i)).toBeVisible()
  await expectNoConsoleErrors(consoleErrors)
})

test('login with wrong password shows error and stays on login page', async ({ page, request }) => {
  const consoleErrors = watchConsole(page)
  const auth = await registerAndLogin(request, { email: uniqueEmail('wrong-password') })

  await loginThroughUi(page, auth.email, 'NotThePassword123')

  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText(/invalid email or password/i)).toBeVisible()
  await expectNoConsoleErrors(consoleErrors)
})

test('login with correct credentials lands on correct page', async ({ page, request }) => {
  const consoleErrors = watchConsole(page)
  const auth = await registerAndLogin(request, { email: uniqueEmail('correct-login') })
  await completeOnboarding(request, auth)

  await loginThroughUi(page, auth.email, auth.password)

  await expect(page).toHaveURL(/\/agents/)
  await expect(page.getByRole('heading', { name: /agent fleet/i })).toBeVisible()
  await expectNoConsoleErrors(consoleErrors)
})
