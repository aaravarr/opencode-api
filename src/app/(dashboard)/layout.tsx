import { SessionProvider } from "@/components/dashboard/admin-context";
import { AppShell } from "@/components/dashboard/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TooltipProvider>
        <AppShell>{children}</AppShell>
      </TooltipProvider>
    </SessionProvider>
  );
}
