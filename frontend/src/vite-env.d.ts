/// <reference types="vite/client" />

/**
 * Typed env. Without this every import.meta.env.VITE_* read is `any`, which is
 * how a typo in a variable name becomes a silent `undefined` at runtime.
 */
interface ImportMetaEnv {
  readonly VITE_USE_MOCKS?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_AUTH_ENFORCED?: string
  readonly VITE_MOCK_SCENARIO?: string
  readonly VITE_WS_BASE_URL?: string
  readonly VITE_WS_AUTH_MODE?: string
  readonly VITE_WS_AUTH_QUERY_PARAM?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
