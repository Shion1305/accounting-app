import { hc } from "hono/client";
import type { AppType } from "server";

const apiUrl = (import.meta.env.VITE_API_URL as string) || window.location.origin;

export const apiClient = hc<AppType>(apiUrl, {
  init: { credentials: "include" },
});
