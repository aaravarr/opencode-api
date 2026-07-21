import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { redirect } from "next/navigation";
import { getAuthService } from "@/server/auth";
export const dynamic = "force-dynamic";
export default function LoginPage() { if (getAuthService().setupRequired()) redirect("/setup"); return <Suspense><LoginForm /></Suspense>; }
