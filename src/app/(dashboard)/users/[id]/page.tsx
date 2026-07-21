import { UserAccountsPage } from "@/components/dashboard/user-accounts-page";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <UserAccountsPage userId={id}/>; }
