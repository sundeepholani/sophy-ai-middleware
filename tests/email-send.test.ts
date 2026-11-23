import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '@/lib/email/send';
import { invitationEmail, signInEmail } from '@/lib/email/auth';

const { send, configure, oidc } = vi.hoisted(() => ({
  send: vi.fn(),
  configure: vi.fn(),
  oidc: vi.fn(),
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    constructor(options: unknown) { configure(options); }
    send = send;
    destroy() {}
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@vercel/oidc-aws-credentials-provider', () => ({ awsCredentialsProvider: oidc }));

const roleArn = 'arn:aws:iam::123456789012:role/sophy-test-ses';
const from = 'notifications@example.test';
const recipient = 'recipient@example.test';
const testInbox = 'test-inbox@example.test';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SOPHY_SES_REGION', 'ap-south-1');
  vi.stubEnv('SOPHY_SES_FROM', from);
  vi.stubEnv('SOPHY_SES_ROLE_ARN', roleArn);
  vi.stubEnv('SOPHY_MAIL_TEST_TO', testInbox);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Sophy transactional emails', () => {
  it('uses Vercel OIDC and sends both formats to the requested production recipient', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const message = signInEmail('001234');

    await expect(sendEmail(recipient, message)).resolves.toBe(true);
    expect(oidc).toHaveBeenCalledWith({ roleArn, clientConfig: { region: 'ap-south-1' } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: {
        FromEmailAddress: from,
        Destination: { ToAddresses: [recipient] },
        Content: { Simple: {
          Subject: { Data: 'Your Sophy sign-in code', Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
        } },
      },
    }));
    expect(message.html).toContain('001234');
    expect(message.text).toContain('001234');
  });

  it.each(['preview', undefined])('routes mail in %s to the configured test inbox', async (environment) => {
    vi.stubEnv('VERCEL_ENV', environment);
    await expect(sendEmail(recipient, signInEmail('001234'))).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Destination: { ToAddresses: [testInbox] } }),
    }));
  });

  it('skips preview delivery without a test inbox and Vercel delivery without a role', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('SOPHY_MAIL_TEST_TO', undefined);
    await expect(sendEmail(recipient, signInEmail('001234'))).resolves.toBe(false);

    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('SOPHY_SES_ROLE_ARN', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(sendEmail(recipient, signInEmail('001234'))).resolves.toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });

  it('excludes provider response details from thrown errors and logs', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    send.mockRejectedValueOnce(new Error(`Rejected ${recipient}: 001234`));

    await expect(sendEmail(recipient, signInEmail('001234'))).rejects.toThrow('SES did not accept the email');
    expect(log).toHaveBeenCalledExactlyOnceWith('[email] SES send failed', { name: 'Error' });
  });

  it('escapes invitation content and includes the same destination in plain text', () => {
    const url = 'https://sophy.example.test/invite?token=example&view=details';
    const message = invitationEmail({ inviterEmail: from, projectName: '<Example>', role: 'editor', url });

    expect(message.html).toContain('&lt;Example&gt;');
    expect(message.html).toContain('token=example&amp;view=details');
    expect(message.text).toContain(url);
  });
});
