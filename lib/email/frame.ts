export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmail({
  subject,
  headline,
  intro,
  details,
  action,
  notes = [],
  reason,
}: {
  subject: string;
  headline: string;
  intro: string;
  details: { label: string; value: string }[];
  action?: { label: string; url: string };
  notes?: { label: string; value: string }[];
  reason: string;
}): EmailMessage {
  const e = escapeHtml;
  const greeting = 'Hi there,';
  const footer = `This is an automated email from Sophy. ${reason}`;
  const detailRows = details.map(({ label, value }) => `
    <tr><td style="padding:5px 14px;color:#475569;font-size:13px;font-weight:bold;">${e(label)}</td></tr>
    <tr><td style="padding:0 14px 9px;overflow-wrap:anywhere;">${e(value)}</td></tr>`).join('');
  const noteParagraphs = notes.map(({ label, value }) =>
    `<p style="margin:12px 0 0;"><b>${e(label)}</b>: ${e(value)}</p>`).join('');
  const button = action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:20px;"><tr>
        <td bgcolor="#4f46e5" style="border-radius:6px;mso-padding-alt:10px 16px;"><a href="${e(action.url)}"
          style="display:inline-block;padding:10px 16px;color:#ffffff;text-decoration:none;font-weight:bold;">${e(action.label)}</a></td>
      </tr></table>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#eef2f7;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#eef2f7">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#ffffff"
       style="max-width:600px;font-family:Arial,sans-serif;color:#172033;font-size:15px;line-height:1.5;border-radius:10px;overflow:hidden;">
  <tr><td bgcolor="#4f46e5" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:20px 24px;color:#ffffff;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:bold;letter-spacing:1.2px;">SOPHY</p>
    <h1 style="margin:0;font-size:24px;line-height:1.25;">${e(headline)}</h1>
  </td></tr>
  <tr><td style="padding:24px;">
    <p style="margin:0 0 8px;">${greeting}</p>
    <p style="margin:0 0 16px;">${e(intro)}</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f5f5ff"
           style="border-left:4px solid #6366f1;table-layout:fixed;">${detailRows}</table>
    ${button}
    ${noteParagraphs}
  </td></tr>
  <tr><td bgcolor="#f4f6f8" style="padding:14px 24px;font-size:12px;color:#475569;">${e(footer)}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  const text = [
    headline,
    greeting,
    intro,
    details.map(({ label, value }) => `${label}: ${value}`).join('\n'),
    action && `${action.label}: ${action.url}`,
    notes.map(({ label, value }) => `${label}: ${value}`).join('\n'),
    footer,
  ].filter(Boolean).join('\n\n');
  return { subject, html, text };
}
