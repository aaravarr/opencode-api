import { SetupForm } from "@/components/auth/setup-form";
import { redirect } from "next/navigation";
import { getAuthService } from "@/server/auth";
export const dynamic = "force-dynamic";
export default function SetupPage() { if (!getAuthService().setupRequired()) redirect("/login"); return <SetupForm />; }
