'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; devLink?: string };
      if (res.ok) {
        setSent(true);
        setDevLink(data.devLink ?? null);
      } else if (data.error === 'too_many_attempts') {
        setError('Too many attempts. Try again in a few minutes.');
      } else if (data.error === 'invalid_email') {
        setError('Enter a valid email address.');
      } else {
        setError('Something went wrong. Try again.');
      }
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              ai
            </div>
            <CardTitle className="text-lg">Sophy</CardTitle>
          </div>
          <CardDescription>Sign in with your email</CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-3">
              <p className="text-sm">
                If <span className="font-medium">{email}</span> has an account, a sign-in link is on
                its way. The link works once and expires in 15 minutes.
              </p>
              {devLink && (
                <div className="rounded-md border bg-muted/50 p-2 text-xs">
                  <p className="mb-1 font-medium text-muted-foreground">Dev link (email not configured):</p>
                  <a href={devLink} className="break-all text-primary underline">
                    {devLink}
                  </a>
                </div>
              )}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setSent(false);
                  setDevLink(null);
                }}
              >
                Use a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@company.com"
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading || !email}>
                {loading ? 'Sending…' : 'Email me a sign-in link'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
