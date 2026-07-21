"use client";

import { useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "./admin-context";
import { ErrorState, PageIntro, Panel } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";
import type { LogsCleanupResponse } from "./types";

interface Settings {
  upstreamBaseUrl: string;
  upstreamRequestTimeoutMs: number;
  maintenanceEnabled: boolean;
  maintenanceIntervalMs: number;
  refreshBatchLimit: number;
  refreshConcurrency: number;
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
}
interface SettingsPayload {
  settings?: Settings;
  secrets?: {
    masterKeyReady?: boolean;
    apiKeyPepperReady?: boolean;
    cronSecretReady?: boolean;
  };
}

export function SettingsPage() {
  const { isAdmin, sessionFetch } = useSession();
  const resource = useAdminResource<SettingsPayload>("/api/admin/settings");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [oneTimeCronSecret, setOneTimeCronSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [stripDialogOpen, setStripDialogOpen] = useState(false);
  const form = draft ?? resource.data?.settings ?? null;
  if (!isAdmin)
    return (
      <Panel>
        <ErrorState message="系统配置仅对管理员开放。" />
      </Panel>
    );

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await sessionFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "保存失败");
      setDraft(payload.settings);
      setMessage("系统配置已保存，即时生效");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  async function rotate(name: "cron_secret" | "api_key_pepper") {
    if (
      !window.confirm(
        name === "api_key_pepper"
          ? "轮换 API Key Pepper 会使现有 API 密钥全部失效。继续？"
          : "轮换后外部定时任务需要使用新密钥。继续？",
      )
    )
      return;
    const response = await sessionFetch("/api/admin/settings/secrets", {
      method: "POST",
      body: JSON.stringify(name === "api_key_pepper" ? { name, confirmInvalidateAllKeys: true } : { name }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) { setMessage(payload?.error?.message || "轮换失败"); return; }
    if (name === "cron_secret") {
      setOneTimeCronSecret(payload?.secret ?? null);
      setCopied(false);
      setMessage("定时任务密钥已轮换，请立即保存新密钥");
    } else {
      setMessage(`API Key Pepper 已轮换，${payload?.invalidatedApiKeys ?? 0} 个现有 API Key 已停用`);
    }
  }
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({
      ...(current ?? resource.data!.settings!),
      [key]: value,
    }));
  async function cleanupLogs(options: { retentionDays?: number; stripBodies?: boolean }) {
    setCleanupBusy(true);
    setMessage(null);
    try {
      const response = await sessionFetch("/api/admin/logs/cleanup", {
        method: "POST",
        body: JSON.stringify(options),
      });
      const payload = await response.json().catch(() => null) as LogsCleanupResponse | { error?: { message?: string } } | null;
      if (!response.ok) throw new Error((payload as { error?: { message?: string } })?.error?.message || "清理失败");
      const result = payload as LogsCleanupResponse;
      const parts: string[] = [];
      if (result.deletedRequests != null) parts.push(`删除 ${result.deletedRequests} 条请求`);
      if (result.deletedBodies != null) parts.push(`删除 ${result.deletedBodies} 条 body`);
      if (result.stripped != null) parts.push(`剥离 ${result.stripped} 条 body`);
      setMessage(parts.length ? parts.join("，") : "没有需要清理的数据");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "清理失败");
    } finally {
      setCleanupBusy(false);
    }
  }
  return (
    <>
      <PageIntro
        eyebrow="SYSTEM SETTINGS"
        title="系统设置"
        description="Go 请求地址和额度维护策略统一保存在数据库中，无需编辑 .env。修改后对所有用户生效。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void resource.refresh()}
          >
            <RefreshCw data-icon="inline-start" />
            重新载入
          </Button>
        }
      />
      {resource.error ? (
        <Panel>
          <ErrorState
            message={resource.error}
            onRetry={() => void resource.refresh()}
          />
        </Panel>
      ) : null}
      {form ? (
        <form onSubmit={save} className="space-y-4">
          <Panel
            title="OpenCode 连接"
            description="Go API Key 调用的官方上游地址。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2">
              <Field label="请求上游地址">
                <Input
                  type="url"
                  value={form.upstreamBaseUrl}
                  onChange={(e) => update("upstreamBaseUrl", e.target.value)}
                  required
                />
              </Field>
              <Field label="上游请求超时（毫秒）">
                <Input
                  type="number"
                  min={1000}
                  max={600000}
                  value={form.upstreamRequestTimeoutMs}
                  onChange={(e) =>
                    update("upstreamRequestTimeoutMs", Number(e.target.value))
                  }
                  required
                />
              </Field>
            </div>
          </Panel>
          <Panel
            title="维护任务"
            description="只刷新当前路由或近期使用账号的 Console 额度，不对长期闲置账号反复探测。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-3">
              <Field label="执行间隔（毫秒）">
                <Input
                  type="number"
                  min={10000}
                  value={form.maintenanceIntervalMs}
                  onChange={(e) =>
                    update("maintenanceIntervalMs", Number(e.target.value))
                  }
                />
              </Field>
              <Field label="每批检查账号数">
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={form.refreshBatchLimit}
                  onChange={(e) =>
                    update("refreshBatchLimit", Number(e.target.value))
                  }
                />
              </Field>
              <Field label="检查并发数">
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={form.refreshConcurrency}
                  onChange={(e) =>
                    update("refreshConcurrency", Number(e.target.value))
                  }
                />
              </Field>
              <Toggle
                checked={form.maintenanceEnabled}
                onChange={(value) => update("maintenanceEnabled", value)}
                label="启用额度维护调度"
                description="常驻 Node/Docker 部署建议开启；失效的 Console 会话会标记为需要重新登录。"
              />
            </div>
          </Panel>
          <Panel
            title="自动生成的安全密钥"
            description="首次启动自动生成并安全保存。通常无需查看或手动配置。"
          >
            <div className="divide-y">
              <SecretRow
                label="主加密密钥"
                ready={resource.data?.secrets?.masterKeyReady}
              />
              <SecretRow
                label="API Key Pepper"
                ready={resource.data?.secrets?.apiKeyPepperReady}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void rotate("api_key_pepper")}
                  >
                    <RotateCcw />
                    轮换
                  </Button>
                }
              />
              <SecretRow
                label="定时任务密钥"
                ready={resource.data?.secrets?.cronSecretReady}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void rotate("cron_secret")}
                  >
                    <RotateCcw />
                    轮换
                  </Button>
                }
              />
            </div>
          </Panel>
          <Panel
            title="请求日志"
            description="默认只记元数据，调试时才开 body。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2">
              <Toggle
                checked={form.loggingEnabled}
                onChange={(value) => update("loggingEnabled", value)}
                label="启用日志"
                description="关闭后不再记录新请求的元数据和 body。"
              />
              <Toggle
                checked={form.logBodies}
                onChange={(value) => update("logBodies", value)}
                label="记录请求/响应体"
                description="数据量大，仅调试开启。"
                danger
              />
              <Toggle
                checked={form.logBodiesOnError}
                onChange={(value) => update("logBodiesOnError", value)}
                label="失败时记录响应体"
                description="默认开启，便于排查错误。"
              />
              <Field label="保留天数">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={form.logRetentionDays}
                  onChange={(e) => update("logRetentionDays", Number(e.target.value))}
                  required
                />
              </Field>
              <Field label="body 截断字节">
                <Input
                  type="number"
                  min={1024}
                  value={form.maxBodyCaptureBytes}
                  onChange={(e) => update("maxBodyCaptureBytes", Number(e.target.value))}
                  required
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t bg-[#fafafa] px-4 py-3 sm:px-5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cleanupBusy}
                onClick={() => void cleanupLogs({ retentionDays: form.logRetentionDays })}
              >
                <Trash2 data-icon="inline-start" />
                {cleanupBusy ? "正在清理" : "立即清理过期日志"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cleanupBusy}
                onClick={() => setStripDialogOpen(true)}
              >
                <Trash2 data-icon="inline-start" />
                剥离历史 body
              </Button>
            </div>
          </Panel>
          <div className="sticky bottom-4 flex items-center justify-between rounded-lg border bg-white/95 p-3 shadow-lg backdrop-blur">
            <p className="text-xs text-muted-foreground" role="status">
              {message || "配置保存在持久数据目录和数据库中。"}
            </p>
            <Button type="submit" disabled={saving}>
              <Save data-icon="inline-start" />
              {saving ? "正在保存" : "保存设置"}
            </Button>
          </div>
        </form>
      ) : null}
      <Dialog open={Boolean(oneTimeCronSecret)} onOpenChange={(open) => { if (!open) { setOneTimeCronSecret(null); setCopied(false); } }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>立即保存新的 Cron Secret</DialogTitle>
            <DialogDescription>该密钥只显示一次。关闭后无法再次查看，只能重新轮换。</DialogDescription>
          </DialogHeader>
          <div className="break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{oneTimeCronSecret}</div>
          <Button variant="outline" className="w-full" onClick={async () => { if (!oneTimeCronSecret) return; await navigator.clipboard.writeText(oneTimeCronSecret); setCopied(true); }}>
            {copied ? <Check /> : <Copy />}{copied ? "已复制" : "复制密钥"}
          </Button>
          <DialogFooter><Button onClick={() => { setOneTimeCronSecret(null); setCopied(false); }}>我已安全保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={stripDialogOpen} onOpenChange={setStripDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>剥离历史 body</DialogTitle>
            <DialogDescription>
              该操作会清除所有历史请求记录的请求体和响应体，保留元数据。不可恢复，确认继续？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStripDialogOpen(false)}>取消</Button>
            <Button
              onClick={async () => {
                setStripDialogOpen(false);
                await cleanupLogs({ stripBodies: true });
              }}
            >
              确认剥离
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Toggle({
  checked,
  onChange,
  label,
  description,
  danger,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
  danger?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3 ${danger && checked ? "border-destructive/25 bg-destructive/5" : "bg-[#fafafa]"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}
function SecretRow({
  label,
  ready,
  action,
}: {
  label: string;
  ready?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <span
        className={`grid size-8 place-items-center rounded-md border ${ready ? "border-success/20 bg-success-soft" : "bg-[#fafafa]"}`}
      >
        {ready ? (
          <ShieldCheck className="size-4 text-success" />
        ) : (
          <AlertTriangle className="size-4 text-warning" />
        )}
      </span>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {ready ? "已安全生成" : "尚未就绪"}
        </p>
      </div>
      {action}
    </div>
  );
}
