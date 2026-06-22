/**
 * Generic transactional email via ZeptoMail.
 *
 * Feature-gated: sending is a no-op (returns false) unless ZEPTOMAIL_TOKEN and
 * ZEPTOMAIL_FROM are set — so local dev and unconfigured environments degrade
 * gracefully (the caller can fall back, e.g. log a magic link in non-prod).
 * Throws only on a hard send failure (non-2xx from the API).
 */
const ZEPTOMAIL_ENDPOINT = 'https://api.zeptomail.com/v1.1/email';

/** Returns true if the email was sent; false if email isn't configured. */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const token = process.env.ZEPTOMAIL_TOKEN;
  const from = process.env.ZEPTOMAIL_FROM;
  if (!token || !from) {
    console.warn('[email] not configured (ZEPTOMAIL_TOKEN/ZEPTOMAIL_FROM unset) — skipping send');
    return false;
  }
  const res = await fetch(ZEPTOMAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Zoho-enczapikey ${token}`,
    },
    body: JSON.stringify({
      from: { address: from },
      to: [{ email_address: { address: to } }],
      subject,
      htmlbody: html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ZeptoMail send failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return true;
}

/** Minimal HTML escaping for interpolating user/content strings into email bodies. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
