import { defineConfig } from "mygo-cli";

// Signing credentials never live in the repository: export them before a
// release build, or set them as CI secrets (see docs/releasing.md).
const env = process.env;

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

  // Signed self-updates from GitHub releases (the public key pairs with
  // mygo-update.key, which stays out of the repository).
  updates: {
    publicKey: "u+CP792EYCONGHJ+0W19peAe25KLTKKyrlRZHFefmn4=",
    github: "kindredzhang/vessel",
    tagPrefix: "desktop-v",
    changelog: "CHANGELOG.md",
  },

  // macOS: an ad-hoc signature without VESSEL_SIGNING_IDENTITY, which runs on
  // this Mac and warns on anyone else's. Notarization needs a paid Apple
  // Developer account plus `xcrun notarytool store-credentials vessel`;
  // set VESSEL_NOTARY_PROFILE to turn it on.
  macos: {
    signingIdentity: env.VESSEL_SIGNING_IDENTITY,
    notarize: env.VESSEL_NOTARY_PROFILE
      ? { keychainProfile: env.VESSEL_NOTARY_PROFILE }
      : undefined,
  },

  // iOS: simulator builds need nothing; device installs need a team (a free
  // Apple ID works, though the app expires after 7 days); TestFlight needs a
  // paid membership plus App Store Connect API credentials.
  ios: {
    minimumSystemVersion: "17.0",
    team: env.VESSEL_IOS_TEAM,
    provisioningProfile: env.VESSEL_IOS_PROFILE,
    distribution: "app-store",
    buildNumber: env.VESSEL_BUILD_NUMBER,
  },
});
