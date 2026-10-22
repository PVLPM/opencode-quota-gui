/** Public metadata only. No runtime filesystem, environment, or backend dependency. */
export interface BuildIdentity {
  readonly version: string;
  readonly build: string;
}

declare const __OPENCODE_QUOTA_BUILD_IDENTITY__: BuildIdentity;

/** Vite injects this literal; the build runner replaces the backend compiler output. */
export const BUILD_IDENTITY: BuildIdentity = Object.freeze(
  typeof __OPENCODE_QUOTA_BUILD_IDENTITY__ === "undefined"
    ? { version: "unknown", build: "unknown" }
    : __OPENCODE_QUOTA_BUILD_IDENTITY__,
);
