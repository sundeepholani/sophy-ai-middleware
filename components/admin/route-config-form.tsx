'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { publishRouteConfig } from '@/app/admin/actions';
import type { RouteMode, RouteParams, RouteParamBounds } from '@/db/schema';
import type { AvailableModel } from '@/lib/gateway/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const NONE = '__none__';

function numOrUndef(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function RouteConfigForm(props: {
  routeId: string;
  mode: RouteMode;
  model: string;
  params: RouteParams;
  paramBounds: RouteParamBounds;
  promptId: string | null;
  outputSchema: Record<string, unknown> | null;
  fallbackModels: string[];
  prompts: { id: string; name: string }[];
  models: AvailableModel[];
}) {
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<RouteMode>(props.mode);
  const [model, setModel] = useState(props.model);
  const [temperature, setTemperature] = useState(props.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(props.params.maxOutputTokens?.toString() ?? '');
  const [topP, setTopP] = useState(props.params.topP?.toString() ?? '');
  const [tempMax, setTempMax] = useState(props.paramBounds.temperature?.max?.toString() ?? '');
  const [maxTokensMax, setMaxTokensMax] = useState(
    props.paramBounds.maxOutputTokens?.max?.toString() ?? '',
  );
  const [promptId, setPromptId] = useState(props.promptId ?? NONE);
  const [schemaText, setSchemaText] = useState(
    props.outputSchema ? JSON.stringify(props.outputSchema, null, 2) : '',
  );
  const [fallbacksCsv, setFallbacksCsv] = useState(props.fallbackModels.join(', '));

  function publish() {
    let outputSchema: Record<string, unknown> | null = null;
    if (schemaText.trim()) {
      try {
        outputSchema = JSON.parse(schemaText) as Record<string, unknown>;
      } catch {
        toast.error('Output schema is not valid JSON');
        return;
      }
    }
    if (!model.trim()) {
      toast.error('Model is required');
      return;
    }
    const params: RouteParams = {
      temperature: numOrUndef(temperature),
      maxOutputTokens: numOrUndef(maxTokens),
      topP: numOrUndef(topP),
    };
    const paramBounds: RouteParamBounds = {
      temperature: numOrUndef(tempMax) != null ? { max: numOrUndef(tempMax) } : undefined,
      maxOutputTokens:
        numOrUndef(maxTokensMax) != null ? { max: numOrUndef(maxTokensMax) } : undefined,
    };
    const fallbackModels = fallbacksCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    startTransition(async () => {
      try {
        await publishRouteConfig({
          routeId: props.routeId,
          model: model.trim(),
          params,
          paramBounds,
          promptId: promptId === NONE ? null : promptId,
          outputSchema,
          fallbackModels,
          mode,
        });
        toast.success('Published — live traffic now uses this config');
      } catch {
        toast.error('Failed to publish');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Active configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Provider / model</Label>
            {props.models.length > 0 ? (
              <Select value={model} onValueChange={(v) => setModel(v ?? '')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {props.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                placeholder="anthropic/claude-sonnet-4.6"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as RouteMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="locked">locked (operator owns everything)</SelectItem>
                <SelectItem value="overridable">overridable (client may pass params/schema)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">Temperature</Label>
            <Input value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Max output tokens</Label>
            <Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="1024" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Top P</Label>
            <Input value={topP} onChange={(e) => setTopP(e.target.value)} placeholder="1" />
          </div>
        </div>

        {mode === 'overridable' && (
          <div className="grid gap-4 rounded-md border p-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Client temperature max</Label>
              <Input value={tempMax} onChange={(e) => setTempMax(e.target.value)} placeholder="1" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Client max-tokens cap</Label>
              <Input
                value={maxTokensMax}
                onChange={(e) => setMaxTokensMax(e.target.value)}
                placeholder="2048"
              />
            </div>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-xs">Master prompt</Label>
          <Select value={promptId} onValueChange={(v) => setPromptId(v ?? NONE)}>
            <SelectTrigger>
              <SelectValue placeholder="No prompt" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— none —</SelectItem>
              {props.prompts.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Output JSON schema (blank = unstructured text)</Label>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            placeholder='{ "type": "object", "properties": { ... }, "required": [...] }'
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Failover is disabled automatically on schema routes to protect output fidelity.
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Fallback models (comma-sep, text routes only)</Label>
          <Input
            value={fallbacksCsv}
            onChange={(e) => setFallbacksCsv(e.target.value)}
            placeholder="openai/gpt-4o, anthropic/claude-haiku-4.5"
          />
        </div>

        <Button onClick={publish} disabled={isPending}>
          {isPending ? 'Publishing…' : 'Publish'}
        </Button>
      </CardContent>
    </Card>
  );
}
