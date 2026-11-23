import { renderEmail } from './frame';

export function signInEmail(code: string) {
  return renderEmail({
    subject: 'Your Sophy sign-in code',
    headline: 'Continue to Sophy',
    intro: 'Enter this code in the browser or terminal where you requested it.',
    details: [
      { label: 'Sign-in code', value: code },
      { label: 'Expires in', value: '10 minutes' },
    ],
    notes: [{ label: 'Keep it private', value: 'This code works once. If you didn’t request it, ignore this email.' }],
    reason: 'A sign-in code was requested for your email address.',
  });
}

export function invitationEmail(input: {
  inviterEmail: string;
  projectName: string;
  role: 'admin' | 'editor';
  url: string;
}) {
  return renderEmail({
    subject: `Join ${input.projectName} in Sophy`,
    headline: `You’re invited to join ${input.projectName}`,
    intro: `${input.inviterEmail} invited you to join a project in Sophy.`,
    details: [
      { label: 'Project', value: input.projectName },
      { label: 'Role', value: input.role === 'admin' ? 'Project Admin' : 'Editor' },
      { label: 'Expires in', value: '7 days' },
    ],
    action: { label: 'Review invitation', url: input.url },
    reason: 'A project admin invited this email address.',
  });
}
