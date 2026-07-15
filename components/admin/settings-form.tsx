'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateSettings } from '@/app/admin/actions';
import type { AvailableModel } from '@/lib/gateway/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModelCombobox } from '@/components/admin/model-combobox';

export function SettingsForm({
  projectId,
  initial,
  models,
  modelsUnavailable = false,
}: {
  projectId: string;
  initial: { judgeModel: string; notifyEmail: string | null };
  models: AvailableModel[];
  modelsUnavailable?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [judgeModel, setJudgeModel] = useState(initial.judgeModel);
  const [notifyEmail, setNotifyEmail] = useState(initial.notifyEmail ?? '');

  function save() {
    if (!judgeModel.trim()) return toast.error('Judge model is required');
    startTransition(async () => {
      try {
        await updateSettings({
          projectId,
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
        <ModelCombobox
          id="judge-model"
          value={judgeModel}
          onValueChange={setJudgeModel}
          models={models.map((m) => m.id)}
          modelsUnavailable={modelsUnavailable}
          placeholder="anthropic/claude-opus-4.8"
        />
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
