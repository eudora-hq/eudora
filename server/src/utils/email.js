import { Resend } from 'resend'

let resend = null
let resendApiKey = null

function getResend() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || apiKey === 're_your_key_here') return null

  if (!resend || resendApiKey !== apiKey) {
    resend = new Resend(apiKey)
    resendApiKey = apiKey
  }
  return resend
}

function getFromAddress() {
  return process.env.RESEND_FROM || 'security@geteudora.com'
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export async function sendPasswordResetEmail({ to, resetUrl, name }) {
  const client = getResend()
  if (!client) {
    console.log(`[email] RESEND_API_KEY not set - reset URL for ${to}: ${resetUrl}`)
    return { success: false, reason: 'no_api_key' }
  }

  try {
    const safeName = name ? escapeHtml(name) : null
    const safeResetUrl = escapeHtml(resetUrl)
    const { data, error } = await client.emails.send({
      from: `Eudora Security <${getFromAddress()}>`,
      to: [to],
      subject: 'Reset your Eudora password',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#050505;font-family:'JetBrains Mono',monospace,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #1a1a1a;max-width:560px;width:100%;">
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #1a1a1a;">
              <p style="margin:0;font-family:monospace;font-size:11px;color:#10b981;letter-spacing:0.15em;text-transform:uppercase;">EUDORA</p>
              <p style="margin:4px 0 0;font-family:monospace;font-size:9px;color:#666;letter-spacing:0.1em;text-transform:uppercase;">AI Behavioral Compliance</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px;">
              <h1 style="margin:0 0 16px;font-family:monospace;font-size:20px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:-0.01em;">
                Reset your password
              </h1>
              <p style="margin:0 0 24px;font-family:monospace;font-size:12px;color:#888;line-height:1.6;">
                ${safeName ? `Hi ${safeName},` : 'Hi,'}<br><br>
                We received a request to reset the password for your Eudora account.
                Click the button below to set a new password.
                This link expires in <strong style="color:#fff;">1 hour</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#10b981;padding:0;">
                    <a href="${safeResetUrl}"
                       style="display:inline-block;padding:14px 32px;font-family:monospace;font-size:11px;font-weight:700;color:#050505;text-decoration:none;text-transform:uppercase;letter-spacing:0.15em;">
                      Reset Password &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-family:monospace;font-size:10px;color:#555;line-height:1.6;">
                If the button doesn't work, copy and paste this URL:
              </p>
              <p style="margin:0;font-family:monospace;font-size:10px;color:#10b981;word-break:break-all;">
                ${safeResetUrl}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #1a1a1a;">
              <p style="margin:0;font-family:monospace;font-size:9px;color:#444;line-height:1.6;">
                If you didn't request a password reset, ignore this email - your password won't change.<br>
                This link expires in 1 hour for your security.
              </p>
              <p style="margin:12px 0 0;font-family:monospace;font-size:9px;color:#333;">
                &copy; 2026 Eudora &middot; <a href="https://geteudora.com" style="color:#555;text-decoration:none;">geteudora.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
      text: `Reset your Eudora password\n\nClick the link below to reset your password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n© 2026 Eudora · geteudora.com`,
    })

    if (error) {
      console.error('[email] Resend error:', error)
      return { success: false, reason: error.message }
    }

    console.log(`[email] Password reset sent to ${to} - id: ${data?.id}`)
    return { success: true, id: data?.id }
  } catch (err) {
    console.error('[email] Failed to send email:', err.message)
    return { success: false, reason: err.message }
  }
}

export async function sendWelcomeEmail({ to, name }) {
  const client = getResend()
  if (!client) return { success: false, reason: 'no_api_key' }

  try {
    const safeName = name ? escapeHtml(name) : null
    const { data, error } = await client.emails.send({
      from: `Eudora <${getFromAddress()}>`,
      to: [to],
      subject: 'Welcome to Eudora',
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#050505;font-family:monospace,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #1a1a1a;max-width:560px;width:100%;">
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #1a1a1a;">
              <p style="margin:0;font-family:monospace;font-size:11px;color:#10b981;letter-spacing:0.15em;text-transform:uppercase;">EUDORA</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px;">
              <h1 style="margin:0 0 16px;font-family:monospace;font-size:20px;font-weight:700;color:#fff;text-transform:uppercase;">
                Welcome to Eudora
              </h1>
              <p style="margin:0 0 24px;font-family:monospace;font-size:12px;color:#888;line-height:1.6;">
                ${safeName ? `Hi ${safeName},` : 'Hi,'}<br><br>
                Your account is active and your 14-day trial has started.
                Eudora is your AI behavioral compliance layer - every agent action is now audited.
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#10b981;">
                    <a href="https://app.geteudora.com"
                       style="display:inline-block;padding:14px 32px;font-family:monospace;font-size:11px;font-weight:700;color:#050505;text-decoration:none;text-transform:uppercase;letter-spacing:0.15em;">
                      Open Eudora &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #1a1a1a;">
              <p style="margin:0;font-family:monospace;font-size:9px;color:#333;">
                &copy; 2026 Eudora &middot; <a href="https://geteudora.com" style="color:#555;text-decoration:none;">geteudora.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
      text: 'Welcome to Eudora\n\nYour 14-day trial is active. Open Eudora: https://app.geteudora.com\n\n© 2026 Eudora',
    })

    if (error) {
      console.error('[email] Resend error:', error)
      return { success: false, reason: error.message }
    }
    return { success: true, id: data?.id }
  } catch (err) {
    console.error('[email] Failed to send welcome email:', err.message)
    return { success: false, reason: err.message }
  }
}

export async function sendInviteEmail({ to, inviterName, inviteUrl, role, tenantName }) {
  const client = getResend()
  if (!client) {
    console.log(`[email] Invite URL for ${to}: ${inviteUrl}`)
    return { success: false, reason: 'no_api_key' }
  }

  try {
    const safeInviterName = escapeHtml(inviterName)
    const safeTenantName = escapeHtml(tenantName)
    const safeRole = escapeHtml(role)
    const safeInviteUrl = escapeHtml(inviteUrl)
    const { data, error } = await client.emails.send({
      from: `Eudora <${getFromAddress()}>`,
      to: [to],
      subject: `${inviterName} invited you to join Eudora`,
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#050505;font-family:monospace,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #1a1a1a;max-width:560px;width:100%;">
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid #1a1a1a;">
            <p style="margin:0;font-family:monospace;font-size:11px;color:#10b981;letter-spacing:0.15em;text-transform:uppercase;">EUDORA</p>
            <p style="margin:4px 0 0;font-family:monospace;font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.1em;">AI Behavioral Compliance</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h1 style="margin:0 0 16px;font-family:monospace;font-size:18px;font-weight:700;color:#fff;text-transform:uppercase;">
              You've been invited
            </h1>
            <p style="margin:0 0 24px;font-family:monospace;font-size:12px;color:#888;line-height:1.6;">
              <strong style="color:#fff;">${safeInviterName}</strong> has invited you to join
              <strong style="color:#fff;">${safeTenantName}</strong> on Eudora as a <strong style="color:#10b981;">${safeRole}</strong>.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td style="background:#10b981;">
                  <a href="${safeInviteUrl}"
                     style="display:inline-block;padding:14px 32px;font-family:monospace;font-size:11px;font-weight:700;color:#050505;text-decoration:none;text-transform:uppercase;letter-spacing:0.15em;">
                    Accept Invitation &rarr;
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-family:monospace;font-size:10px;color:#555;">
              This invite expires in 7 days. If you didn't expect this, ignore it.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px;border-top:1px solid #1a1a1a;">
            <p style="margin:0;font-family:monospace;font-size:9px;color:#333;">
              &copy; 2026 Eudora &middot; <a href="https://geteudora.com" style="color:#555;text-decoration:none;">geteudora.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
      `,
      text: `${inviterName} invited you to join ${tenantName} on Eudora.\n\nAccept invitation: ${inviteUrl}\n\nThis invite expires in 7 days.\n\n© 2026 Eudora`,
    })

    if (error) return { success: false, reason: error.message }
    return { success: true, id: data?.id }
  } catch (err) {
    return { success: false, reason: err.message }
  }
}

export async function sendApprovalRequiredEmail({
  to,
  name,
  agentName,
  riskScore,
  riskReason,
  approvalUrl,
  expiresAt,
  reminder = false,
}) {
  const client = getResend()
  if (!client) {
    console.log(`[email] Approval URL for ${to}: ${approvalUrl}`)
    return { success: false, reason: 'no_api_key' }
  }

  const safeName = escapeHtml(name || 'Approver')
  const safeAgentName = escapeHtml(agentName || 'AI agent')
  const safeRiskReason = escapeHtml(riskReason || 'Risk threshold exceeded')
  const safeApprovalUrl = escapeHtml(approvalUrl)
  const safeExpiry = escapeHtml(new Date(expiresAt).toLocaleString('en-GB', { timeZone: 'UTC' }))

  try {
    const { data, error } = await client.emails.send({
      from: `Eudora Security <${getFromAddress()}>`,
      to: [to],
      subject: `${reminder ? 'Reminder: ' : ''}Action required: AI agent awaiting your approval`,
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#050505;font-family:monospace,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #262626;max-width:560px;width:100%;">
        <tr><td style="padding:24px 40px;border-bottom:1px solid #1a1a1a;">
          <p style="margin:0;color:#f59e0b;font-size:11px;letter-spacing:.15em;text-transform:uppercase;">EUDORA APPROVAL GATE</p>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <h1 style="margin:0 0 16px;color:#fff;font-size:18px;text-transform:uppercase;">Human approval required</h1>
          <p style="margin:0 0 20px;color:#888;font-size:12px;line-height:1.7;">
            Hi ${safeName},<br><br>
            <strong style="color:#fff;">${safeAgentName}</strong> is waiting for approval before continuing.
          </p>
          <p style="margin:0 0 8px;color:#f59e0b;font-size:12px;">Risk score: ${Math.round(Number(riskScore) || 0)}/100</p>
          <p style="margin:0 0 24px;color:#888;font-size:11px;line-height:1.6;">${safeRiskReason}</p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#f59e0b;">
            <a href="${safeApprovalUrl}" style="display:inline-block;padding:14px 28px;color:#050505;text-decoration:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;">
              Review action &rarr;
            </a>
          </td></tr></table>
          <p style="margin:20px 0 0;color:#555;font-size:10px;">Approval window closes ${safeExpiry} UTC.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text: `Action required: ${agentName} is awaiting approval.\n\nRisk score: ${riskScore}/100\nReason: ${riskReason}\nReview: ${approvalUrl}\nExpires: ${expiresAt}`,
    })

    if (error) return { success: false, reason: error.message }
    return { success: true, id: data?.id }
  } catch (err) {
    return { success: false, reason: err.message }
  }
}
