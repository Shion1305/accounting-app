import { hc } from "hono/client";
import type { AppType } from "server";

const apiUrl = import.meta.env.VITE_API_URL as string;
console.log(apiUrl)

export const apiClient: ReturnType<typeof hc<AppType>> = hc<AppType>(apiUrl, {
  init: { credentials: "include" },
});
