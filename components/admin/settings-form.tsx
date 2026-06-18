'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateSettings } from '@/app/admin/actions';
import type { AvailableModel } from '@/lib/gateway/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function SettingsForm({
  initial,
  models,
  modelsUnavailable = false,
}: {
  initial: { judgeModel: string; notifyEmail: string | null };
  models: AvailableModel[];
  modelsUnavailable?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [judgeModel, setJudgeModel] = useState(initial.judgeModel);
  const [notifyEmail, setNotifyEmail] = useState(initial.notifyEmail ?? '');

  // Saved judge model that's no longer in the live catalog — keep it selectable.
  const staleJudge =
    judgeModel && !models.some((m) => m.id === judgeModel) ? judgeModel : null;

  function save() {
    if (!judgeModel.trim()) return toast.error('Judge model is required');
    startTransition(async () => {
      try {
        await updateSettings({
          judgeModel: judgeModel.trim(),
          notifyEmail: notifyEmail.trim() || null,
        });
        toast.success('Settings saved');
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        toast.error(
          msg === 'unauthorized'
            ? 'Your session expired — please sign in again.'
            : msg || 'Could not save settings',
        );
      }
    });
  }

  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="judge-model" className="text-sm">
          Eval judge model
        </Label>
        <p className="text-xs text-muted-foreground">
          The model that blindly compares champion vs challenger outputs during an eval run. A
          strong, neutral model is recommended.
        </p>
        {models.length > 0 ? (
          <Select value={judgeModel} onValueChange={(v) => v != null && setJudgeModel(v)}>
            <SelectTrigger id="judge-model" className="w-full">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.id}
                </SelectItem>
              ))}
              {staleJudge && <SelectItem value={staleJudge}>{staleJudge} (unavailable)</SelectItem>}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              id="judge-model"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              placeholder="anthropic/claude-opus-4.8"
            />
            {modelsUnavailable && (
              <p className="text-xs text-muted-foreground">
                Couldn’t load the gateway model list — enter the model id as free text.
              </p>
            )}
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notify-email" className="text-sm">
          Notification email
        </Label>
        <p className="text-xs text-muted-foreground">
          Where eval summary reports are sent when a run completes.
        </p>
        <Input
          id="notify-email"
          type="email"
          value={notifyEmail}
          onChange={(e) => setNotifyEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <Button onClick={save} disabled={isPending}>
        {isPending ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  );
}
