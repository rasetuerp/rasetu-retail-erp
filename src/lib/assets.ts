const viteBaseUrl = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';

export const BRAND_LOGO_DARK = `${viteBaseUrl}branding/rasetu-logo-full-dark.png`;
export const BRAND_LOGO_LIGHT = `${viteBaseUrl}branding/rasetu-logo-full-light.png`;
