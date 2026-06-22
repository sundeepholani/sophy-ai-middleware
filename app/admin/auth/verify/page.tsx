import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { confirmSignIn } from './actions';

export const dynamic = 'force-dynamic';

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const invalid = sp.error || !sp.token;

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
          <CardDescription>
            {invalid ? 'Sign-in link problem' : 'Confirm sign in'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invalid ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This sign-in link is invalid or has expired. Request a new one.
              </p>
              <Button className="w-full" nativeButton={false} render={<Link href="/admin/login" />}>
                Back to sign in
              </Button>
            </div>
          ) : (
            <form action={confirmSignIn} className="space-y-4">
              <input type="hidden" name="token" value={sp.token} />
              {sp.next ? <input type="hidden" name="next" value={sp.next} /> : null}
              <p className="text-sm text-muted-foreground">
                Click below to finish signing in to the Sophy console.
              </p>
              <Button type="submit" className="w-full">
                Confirm sign in
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
