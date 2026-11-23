import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import type { EmailMessage } from './frame';

/** Returns true when SES accepts the email and false when sending is disabled. */
export async function sendEmail(to: string, message: EmailMessage): Promise<boolean> {
  const region = process.env.SOPHY_SES_REGION?.trim();
  const from = process.env.SOPHY_SES_FROM?.trim();
  const roleArn = process.env.SOPHY_SES_ROLE_ARN?.trim();
  const isVercel = Boolean(process.env.VERCEL_ENV);
  const recipient = process.env.VERCEL_ENV === 'production'
    ? to
    : process.env.SOPHY_MAIL_TEST_TO?.trim();

  if (!recipient) return false;
  if (!region || !from || (isVercel && !roleArn)) {
    console.warn('[email] SES configuration incomplete');
    return false;
  }

  const client = new SESv2Client({
    region,
    credentials: roleArn ? awsCredentialsProvider({ roleArn, clientConfig: { region } }) : undefined,
  });
  try {
    await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [recipient] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
        },
      },
    }));
    return true;
  } catch (error) {
    // Provider responses can include addresses or message content.
    const name = error instanceof Error && /^[a-zA-Z]+$/.test(error.name) ? error.name : 'Error';
    console.error('[email] SES send failed', { name });
    throw new Error('SES did not accept the email');
  } finally {
    client.destroy();
  }
}
