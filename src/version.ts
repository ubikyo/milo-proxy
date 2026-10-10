// The proxy's version, from package.json: set by the bundle (scripts/build.mjs),
// "dev" when run from the compiled sources.

declare const __VERSION__: string | undefined;

export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
