import Link from 'next/link';
import { listPrompts } from '@/lib/admin/queries';
import { CreatePrompt } from '@/components/admin/create-prompt';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function PromptsPage() {
  const prompts = await listPrompts();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Prompts</h1>
        <p className="text-sm text-muted-foreground">
          Versioned master/system prompts. Publish or roll back to change live behavior instantly.
        </p>
      </div>
      <CreatePrompt />
      {prompts.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {prompts.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.name}</TableCell>
                <TableCell>
                  {p.hasActive ? <Badge>published</Badge> : <Badge variant="outline">draft only</Badge>}
                </TableCell>
                <TableCell className="text-right">
                  <Link className="text-sm underline" href={`/admin/prompts/${p.id}`}>
                    Edit
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
