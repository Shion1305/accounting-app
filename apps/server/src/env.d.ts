export {};

declare global {
  // Secret values are provided at runtime; type checking also works without .dev.vars.
  interface Env {
    BETTER_AUTH_SECRET: string;
  }
}
