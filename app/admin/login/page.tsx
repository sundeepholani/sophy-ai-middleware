'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentAt, setSentAt] = useState(0);

  async function requestCode() {
    setLoading(true);
    setError(null);
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, next }),
      });
      const data = await res.json() as { challengeId?: string; error?: string };
      if (res.ok && data.challengeId) {
        setChallengeId(data.challengeId);
        setCode('');
        setSentAt(Date.now());
      } else {
        setError(data.error === 'too_many_attempts' ? 'Too many attempts. Try again in 15 minutes.'
          : data.error === 'invalid_email' ? 'Enter a valid email address.' : 'Unable to send a code. Try again.');
      }
    } catch { setError('Network error. Try again.'); }
    finally { setLoading(false); }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const res = await fetch('/api/admin/login/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, code, client: 'web', next }),
      });
      const data = await res.json() as { next?: string; error?: string };
      if (res.ok) { window.location.assign(data.next ?? '/admin'); return; }
      setError(data.error === 'too_many_attempts' ? 'Too many attempts. Try again in 15 minutes.'
        : 'This code is invalid or expired. Check the latest email or request a new code.');
    } catch { setError('Network error. Try again.'); }
    finally { setLoading(false); }
  }

  function resend() {
    if (Date.now() - sentAt < 60_000) { setError('Wait one minute before requesting another code.'); return; }
    void requestCode();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">S</div>
            <CardTitle className="text-lg">Sophy</CardTitle>
          </div>
          <CardDescription>Sign in or create an account with an email code</CardDescription>
        </CardHeader>
        <CardContent>
          {challengeId ? (
            <form onSubmit={verifyCode} className="space-y-4">
              <p className="text-sm" role="status">If <span className="font-medium">{email}</span> is eligible, a six-digit code is on its way. It expires in 10 minutes. Use the most recent code.</p>
              <div className="space-y-2">
                <Label htmlFor="code">Sign-in code</Label>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} autoFocus required />
              </div>
              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading || code.length !== 6}>{loading ? 'Checking…' : 'Verify and sign in'}</Button>
              <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={resend}>Send a new code</Button>
              <Button type="button" variant="ghost" className="w-full" disabled={loading} onClick={() => { setChallengeId(null); setError(null); setCode(''); }}>Use a different email</Button>
            </form>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void requestCode(); }} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" required />
              </div>
              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading || !email}>{loading ? 'Sending…' : 'Email me a sign-in code'}</Button>
              <p className="text-xs leading-relaxed text-muted-foreground">New to Sophy? Verifying your email creates a renameable My Project and makes you its Project Admin. When joining an invitation, the invited project becomes your first project instead.</p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
