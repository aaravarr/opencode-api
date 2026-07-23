import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";

export function AuthShell({ title, description, children, eyebrow }: { title: string; description: string; children: ReactNode; eyebrow: string }) {
  return (
    <main className="grid min-h-[100dvh] grid-cols-1 bg-[#fafafa] lg:grid-cols-[minmax(0,1fr)_480px]">
      <section className="hidden border-r bg-white px-12 py-10 lg:flex lg:flex-col lg:justify-between">
        <Brand />
        <div className="max-w-xl pb-8">
          <div className="mb-5 flex size-10 items-center justify-center rounded-lg border bg-[#fafafa]">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <h1 className="max-w-lg text-4xl font-semibold tracking-[-0.045em] text-balance">一个入口，管理多个 Provider 账号池。</h1>
          <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">账号、API 密钥、路由偏好与使用记录严格按用户隔离。管理员可查看系统健康，但不会借用其他用户的账号。</p>
        </div>
        <p className="font-mono text-xs text-muted-foreground">SELF-HOSTED · TENANT ISOLATED</p>
      </section>
      <section className="flex min-h-[100dvh] items-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 lg:hidden"><Brand /></div>
          <p className="mb-3 font-mono text-[10px] font-medium tracking-[.12em] text-muted-foreground">{eyebrow}</p>
          <h2 className="text-2xl font-semibold tracking-[-0.035em]">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          <div className="mt-8">{children}</div>
        </div>
      </section>
    </main>
  );
}

export function Brand() {
  return <div className="flex items-center gap-2.5" aria-label="Provider Gateway Console"><span className="grid size-7 place-items-center rounded-md bg-[#171717] text-[11px] font-semibold text-white">P</span><span className="text-sm font-semibold tracking-[-0.025em]">Provider Gateway</span></div>;
}
