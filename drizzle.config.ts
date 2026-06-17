import { defineConfig } from 'drizzle-kit';

// Migrations run against the UNPOOLED (direct) connection string — not the
// Supavisor transaction pooler. Accepts manual (DATABASE_URL*) or the Vercel↔
// Supabase integration (POSTGRES_URL*) naming.
const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  '';

export default defineConfig({
  schema: './db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
