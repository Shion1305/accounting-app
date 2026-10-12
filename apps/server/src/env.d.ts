export {};

declare global {
  // Secrets are injected at runtime and are not required for local type generation.
  interface Env {
    BETTER_AUTH_SECRET: string;
  }
}
