export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { startMaintenanceScheduler } = await import("@/server/opencode/maintenance")
  startMaintenanceScheduler()
  const { startImportJobRunner } = await import("@/server/import-jobs")
  startImportJobRunner()
}
