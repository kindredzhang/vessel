# Releasing Vessel

Two artifacts come out of `apps/desktop`: a macOS disk image and an iOS app.
What you can do with them depends on one thing — whether you have a **paid Apple
Developer Program membership** (99 USD/year). Everything below is honest about
which half you are in.

| | Free Apple ID | Paid membership |
| --- | --- | --- |
| macOS `.dmg`, ad-hoc signed | ✅ runs on your Mac | ✅ |
| macOS `.dmg` others can open without warnings | ❌ Gatekeeper blocks it | ✅ notarized |
| iOS simulator build | ✅ | ✅ |
| iOS on your own iPhone | ✅ 7-day expiry, 3 apps | ✅ 1 year |
| TestFlight (any tester, no UDID) | ❌ | ✅ |
| App Store | ❌ | ✅ |

## Versioning

`mygo.config.ts` holds `version`; `VESSEL_BUILD_NUMBER` overrides
`CFBundleVersion`. App Store Connect rejects a build number it has already seen
for a version, so a release is: bump `version`, then tag `desktop-v<version>`.

The updater reads GitHub releases of `kindredzhang/vessel` tagged `desktop-v*`,
verifies them with the public key in `mygo.config.ts`, and installs them through
`mygo.Updater`. Releases must therefore carry the built `.dmg` assets — the
release workflow below does that.

## macOS

```bash
cd apps/desktop
bun run build            # build/darwin-arm64/Vessel.app, vessel-0.1.0-arm64.dmg
```

Without `VESSEL_SIGNING_IDENTITY` the app is ad-hoc signed. That is fine for
your own machine; anyone who downloads it sees "Vessel is damaged" or "cannot be
opened because Apple cannot check it". They can still open it with
right-click → Open, or:

```bash
xattr -dr com.apple.quarantine /Applications/Vessel.app
```

Do not tell users to disable Gatekeeper globally. The real fix is notarization.

### Notarization (needs the paid membership)

1. In Xcode → Settings → Accounts, add your Apple ID and create a **Developer ID
   Application** certificate (or download it from developer.apple.com). It lands
   in your login keychain.
2. Store notary credentials once:

   ```bash
   xcrun notarytool store-credentials vessel \
     --apple-id you@example.com \
     --team-id ABCDE12345 \
     --password "$(security find-generic-password -s 'AC_PASSWORD' -w)"
   ```

   The password is an **app-specific password** from appleid.apple.com, not your
   Apple ID password.
3. Build signed and notarized:

   ```bash
   export VESSEL_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
   export VESSEL_NOTARY_PROFILE=vessel
   bun run build            # mygo signs, notarizes and staples app + dmg
   ```

4. Verify:

   ```bash
   spctl -a -vvv -t install build/darwin-arm64/Vessel.app
   xcrun stapler validate build/vessel-0.1.0-arm64.dmg
   ```

`mygo build` notarizes the app and the disk image and staples both, so the DMG
opens without a warning on any Mac with a network connection.

## iOS

### Simulator (no account needed)

```bash
bun run dev:ios                   # builds, boots a simulator, installs, streams logs
bun run build -- -platform ios    # or explicitly: build/vessel-0.1.0-ios/…
xcrun simctl install booted <path to Vessel.app>
xcrun simctl launch booted com.vesselhq.vessel
```

Simulator builds are unsigned and are the fastest way to check the UI.

### Your own iPhone with a free Apple ID

1. Install Xcode (App Store), then `sudo xcode-select -s /Applications/Xcode.app`.
2. Open Xcode → Settings → Accounts → add your Apple ID → select your team →
   *Manage Certificates* → `+` → **Apple Development**.
3. Connect the iPhone, enable Developer Mode (Settings → Privacy & Security).
4. In Vessel: give the app its bundle id `com.vesselhq.vessel` — with a free
   account, Xcode must register it under your personal team, so either open
   `apps/desktop` once in Xcode, or keep the identifier unique to your account
   (`com.<you>.vessel`) via `VESSEL_` override in `mygo.config.ts`.
5. Build for the device:

   ```bash
   export VESSEL_IOS_TEAM=ABCDE12345
   bun run build -- -platform ios -device
   ```

Free-account builds expire after 7 days and allow 3 apps per device; re-run the
build to renew.

### TestFlight (needs the paid membership)

TestFlight is how iOS users normally install a beta without Xcode or a UDID.
Apple hosts the build; testers install the **TestFlight app** from the App Store
and accept an invite or a public link. No provisioning profile ever touches the
tester's device.

Once you have the membership:

1. **Register the App ID**: developer.apple.com → Certificates, Identifiers &
   Profiles → Identifiers → `com.vesselhq.vessel`. Nothing else is needed unless
   you use capabilities.
2. **Create the app record**: App Store Connect → My Apps → `+` → New App →
   iOS, bundle id above, SKU `vessel`.
3. **Upload API key**: App Store Connect → Users and Access → Integrations →
   App Store Connect API → generate a key with *App Manager* access. Note the
   Key ID and Issuer ID, and download the `.p8` **once**:

   ```bash
   export MYGO_ASC_KEY_ID=XXXXXXXXXX
   export MYGO_ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
   export MYGO_ASC_KEY=$PWD/AuthKey_XXXXXXXXXX.p8
   ```

4. **Build and upload**:

   ```bash
   export VESSEL_IOS_TEAM=ABCDE12345
   export VESSEL_BUILD_NUMBER=2
   bun run build -- -platform ios            # distribution: app-store
   bun run publish -- -platform ios          # mygo publish → App Store Connect
   ```

   `mygo publish` uploads the `.ipa`; it appears in App Store Connect → TestFlight
   after Apple finishes processing (usually 5–30 minutes).
5. **Testers**: TestFlight → *Internal testing* (up to 100 people on your team,
   no review) or *External testing* (up to 10 000, one short beta review the
   first time). Create a group, add the build, then share the public link —
   testers open it on their iPhone, install TestFlight, and get the app.
6. Each build lives 90 days. Bump `VESSEL_BUILD_NUMBER` for every upload.

The first upload of an app must go through Xcode or Transporter once; afterwards
`mygo publish` handles it. Apple also requires an app icon and a valid
`Info.plist` — `resources/icon.png` covers the icon.

## CI

`.github/workflows/release.yml` builds the DMG on every `desktop-v*` tag and, when
the Apple secrets are present, also builds, signs, uploads the iOS build and
attaches both to the GitHub release.

Secrets to add under *Settings → Secrets and variables → Actions*:

| Secret | Used for |
| --- | --- |
| `VESSEL_UPDATER_PRIVATE_KEY` | signing the update archive (contents of `mygo-update.key`) |
| `VESSEL_SIGNING_IDENTITY` | Developer ID identity name |
| `VESSEL_NOTARY_PROFILE`, `VESSEL_NOTARY_*` | notarization (or use an API key) |
| `VESSEL_IOS_TEAM` | team id for signing |
| `VESSEL_IOS_CERT_P12`, `VESSEL_IOS_CERT_PASSWORD` | distribution certificate |
| `VESSEL_IOS_PROFILE` | base64 `.mobileprovision` |
| `MYGO_ASC_KEY_ID`, `MYGO_ASC_ISSUER_ID`, `MYGO_ASC_KEY` | TestFlight upload |

Without them the workflow still produces an ad-hoc signed DMG, which is what a
fork without an Apple account needs.
