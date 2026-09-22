import { redirect } from 'next/navigation';
import { safeNextPath } from '@/lib/auth/safe-next';

/** Previously emailed login links cannot establish sessions after OTP cutover. */
export default async function VerifyPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  redirect(`/admin/login?next=${encodeURIComponent(safeNextPath(next))}`);
}
