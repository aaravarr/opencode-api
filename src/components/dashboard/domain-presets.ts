// Known upstream hostnames grouped by the provider pool type that uses them.
// Surfaced as a dropdown in the settings UI for the domain-mirror map so
// operators can pick a real target host instead of typing a bare hostname.

export interface DomainPreset {
  domain: string
  label: string
  description: string
}

export interface DomainPresetGroup {
  poolType: string
  label: string
  domains: DomainPreset[]
}

export const PROVIDER_DOMAIN_PRESETS: DomainPresetGroup[] = [
  {
    poolType: "opencode-go",
    label: "OpenCode Go",
    domains: [
      { domain: "opencode.ai", label: "opencode.ai", description: "OpenCode Go callback / quota sync upstream." },
    ],
  },
  {
    poolType: "openai-cpa",
    label: "OpenAI CPA / OAuth",
    domains: [
      { domain: "chatgpt.com", label: "chatgpt.com", description: "Codex responses + wham/usage endpoints." },
      { domain: "auth.openai.com", label: "auth.openai.com", description: "PAT whoami + OAuth token refresh." },
    ],
  },
  {
    poolType: "github",
    label: "GitHub",
    domains: [
      { domain: "github.com", label: "github.com", description: "Release download pages (extension auto-update)." },
      { domain: "api.github.com", label: "api.github.com", description: "Releases API for extension version checks." },
      { domain: "raw.githubusercontent.com", label: "raw.githubusercontent.com", description: "Raw release assets / metadata." },
      { domain: "objects.githubusercontent.com", label: "objects.githubusercontent.com", description: "Release asset download CDN." },
    ],
  },
]

// Flat lookup domain -> preset, for quick match checks in the UI.
export const PRESET_DOMAIN_SET: Set<string> = new Set(
  PROVIDER_DOMAIN_PRESETS.flatMap((group) => group.domains.map((domain) => domain.domain)),
)
