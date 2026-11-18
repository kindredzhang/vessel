import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "Vessel",
  slug: "vessel",
  identifier: "com.vesselhq.vessel",
  version: "0.1.0",
  copyright: "© 2026 Vessel contributors",
  license: "Apache-2.0",

  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs buildCommand
  // and embeds frontendDist into the app.
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",

  // Phones: `bun run dev:ios` needs Xcode (`mygo doctor` says what is missing),
  // and store builds need a team and a provisioning profile:
  // ios: { team: "ABCDE12345" },
  // Signing for distribution on macOS:
  // macos: { signingIdentity: "Developer ID Application: … (TEAMID)" },
});
