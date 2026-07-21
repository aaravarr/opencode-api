"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSession, type SessionUser } from "./admin-context";
import {
  EmptyState,
  ErrorState,
  LoadingTable,
  PageIntro,
  Panel,
  formatDate,
} from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";

interface UserSummary extends SessionUser {
  accountCount?: number;
  apiKeyCount?: number;
  lastLoginAt?: string | null;
}
interface UsersPayload {
  users?: UserSummary[];
}

export function UsersPage() {
  const { isAdmin, user: current, sessionFetch } = useSession();
  const resource = useAdminResource<UsersPayload>("/api/admin/users");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isAdmin)
    return (
      <Panel>
        <ErrorState message="只有管理员可以管理用户。" />
      </Panel>
    );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await sessionFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          displayName: form.get("displayName"),
          password: form.get("password"),
          role: form.get("role"),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(payload?.error?.message || "用户创建失败");
      setOpen(false);
      await resource.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "用户创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function update(user: UserSummary, input: Record<string, unknown>) {
    const response = await sessionFetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    if (response.ok) await resource.refresh();
    else
      setError(
        (await response.json().catch(() => null))?.error?.message || "操作失败",
      );
  }

  async function resetPassword(user: UserSummary) {
    const password = window.prompt(
      `为 ${user.username} 输入新密码（至少 6 个字符）`,
    );
    if (!password) return;
    await update(user, { password });
  }

  async function revoke(user: UserSummary) {
    if (!window.confirm(`注销 ${user.username} 的全部登录会话？`)) return;
    const response = await sessionFetch(
      `/api/admin/users/${user.id}/sessions`,
      { method: "DELETE" },
    );
    if (!response.ok)
      setError(
        (await response.json().catch(() => null))?.error?.message ||
          "注销会话失败",
      );
  }

  const users = resource.data?.users ?? [];
  return (
    <>
      <PageIntro
        eyebrow="TENANT ACCESS"
        title="用户管理"
        description="每位用户拥有独立的账号池、API 密钥和路由状态。管理员查看全局状态时也不会跨用户路由。"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resource.refresh()}
            >
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus data-icon="inline-start" />
              新增用户
            </Button>
          </>
        }
      />
      {error ? (
        <p className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Panel
        title="系统用户"
        description={`${users.length} 位用户。停用用户会立即失去控制台和网关访问权限。`}
      >
        {resource.loading ? (
          <LoadingTable rows={5} columns={6} />
        ) : resource.error ? (
          <ErrorState
            message={resource.error}
            onRetry={() => void resource.refresh()}
          />
        ) : !users.length ? (
          <EmptyState
            title="暂无用户"
            description="初始化管理员后会显示在这里。"
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader className="bg-[#fafafa]">
              <TableRow>
                <TableHead className="px-4">用户</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>Go 账号</TableHead>
                <TableHead>API 密钥</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="px-4">
                    <div className="flex items-center gap-3">
                      <span className="grid size-8 place-items-center rounded-md border bg-[#fafafa]">
                        <UserRound className="size-4 text-muted-foreground" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">
                          {user.displayName || user.username}
                          {user.id === current.id ? "（你）" : ""}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {user.username}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.role === "ADMIN" ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <ShieldCheck className="size-3.5" />
                        管理员
                      </span>
                    ) : (
                      <span className="text-xs">普通用户</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={user.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/users/${user.id}`} className="underline-offset-4 hover:underline">
                      {user.accountCount ?? 0} · 查看
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {user.apiKeyCount ?? 0}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="用户操作"
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() =>
                            void update(user, {
                              role: user.role === "ADMIN" ? "USER" : "ADMIN",
                            })
                          }
                          disabled={user.id === current.id}
                        >
                          {user.role === "ADMIN"
                            ? "改为普通用户"
                            : "设为管理员"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => void resetPassword(user)}
                        >
                          重置密码
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void revoke(user)}>
                          注销全部会话
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={
                            user.status === "ACTIVE"
                              ? "text-destructive"
                              : undefined
                          }
                          disabled={user.id === current.id}
                          onSelect={() =>
                            void update(user, {
                              status:
                                user.status === "ACTIVE"
                                  ? "DISABLED"
                                  : "ACTIVE",
                            })
                          }
                        >
                          {user.status === "ACTIVE" ? "停用用户" : "重新启用"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增用户</DialogTitle>
            <DialogDescription>
              账号池和 API 密钥将自动与该用户隔离。
            </DialogDescription>
          </DialogHeader>
          <form id="create-user" onSubmit={create} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-display-name">显示名称</Label>
              <Input id="new-display-name" name="displayName" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-username">用户名</Label>
              <Input
                id="new-username"
                name="username"
                minLength={3}
                maxLength={64}
                autoCapitalize="none"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">初始密码</Label>
              <Input
                id="new-password"
                name="password"
                type="password"
                minLength={6}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-role">角色</Label>
              <Select name="role" defaultValue="USER">
                <SelectTrigger id="new-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">普通用户</SelectItem>
                  <SelectItem value="ADMIN">管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button form="create-user" type="submit" disabled={busy}>
              {busy ? "正在创建" : "创建用户"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
