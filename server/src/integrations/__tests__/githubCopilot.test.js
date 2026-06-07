import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCopilotUsageStats,
  pullCopilotAuditLogs,
  testGithubConnection,
} from '../githubCopilot.js'

const config = {
  org: 'eudora-org',
  token: 'github-token',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub Copilot integration client', () => {
  it('tests the organization with required GitHub headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        login: 'eudora-org',
        plan: { name: 'business' },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await testGithubConnection(config)

    expect(result).toEqual({
      success: true,
      org: 'eudora-org',
      plan: 'business',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/orgs/eudora-org',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      })
    )
  })

  it('paginates Copilot audit events and normalizes timestamps', async () => {
    const nextUrl = 'https://api.github.com/orgs/eudora-org/audit-log?after=cursor'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => `<${nextUrl}>; rel="next"` },
        json: async () => [{
          '@timestamp': 1_717_689_600,
          action: 'copilot.access_granted',
          actor: 'octocat',
          user: 'developer',
          repo: 'eudora/app',
          data: { editor: 'vscode' },
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => [{
          '@timestamp': '2026-06-07T12:00:00.000Z',
          action: 'copilot.policy_changed',
          actor: 'admin',
        }],
      })
    vi.stubGlobal('fetch', fetchMock)

    const events = await pullCopilotAuditLogs(config, Date.now() - 1000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(nextUrl)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      timestamp: 1_717_689_600_000,
      action: 'copilot.access_granted',
      actor: 'octocat',
      userLogin: 'developer',
      repo: 'eudora/app',
    })
    expect(events[1].timestamp).toBe(new Date('2026-06-07T12:00:00.000Z').getTime())
  })

  it('returns Copilot billing usage when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ seat_breakdown: { total: 12, active_this_cycle: 8 } }),
    }))

    await expect(getCopilotUsageStats(config)).resolves.toEqual({
      seat_breakdown: { total: 12, active_this_cycle: 8 },
    })
  })

  it('returns null when Copilot billing is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    await expect(getCopilotUsageStats(config)).resolves.toBeNull()
  })
})
