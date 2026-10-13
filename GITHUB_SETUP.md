# Scbuild v6 — GitHub setup

The bot is configured for the repository `BalzyOfficial/Scbuild-v6` by default. The repository must be created under the BalzyOfficial account before running the bot. This package does not create repositories automatically.

## 1. Create the repository

1. Sign in to https://github.com/BalzyOfficial
2. Create a repository named **Scbuild-v6** (Public or Private).
3. Upload/push all files from this project, including the `.github/workflows/` directory, to the repository's `main` branch.
4. In the repository, open **Settings → Actions → General** and allow actions as appropriate for your policy.

## 2. Configure environment variables on the bot host

Set these environment variables in your hosting panel. Do not commit tokens or paste them into source code.

- `GITHUB_TOKEN` — a fine-grained personal access token owned by an authorized account, with access to `BalzyOfficial/Scbuild-v6`; grant **Contents: Read and write**, **Actions: Read and write**, and **Metadata: Read-only**. For classic tokens, the required scopes may differ.
- `GITHUB_OWNER=BalzyOfficial`
- `GITHUB_REPO=Scbuild-v6`
- `GITHUB_WORKFLOW_ID=build-apk.yml`
- `GITHUB_WEB2APK_WORKFLOW_ID=web2apk.yml`
- `GITHUB_WORKFLOW_REF=main`
- `TELEGRAM_BOT_TOKEN` — create/retrieve a fresh token using BotFather.
- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` — set your own Telegram API credentials if GramJS features are used.

Restart the bot after saving environment variables. Use the bot's GitHub status/self-test to verify the token and repository permissions.

## Important security note

Credentials had been embedded in the original source ZIP. Treat them as exposed and revoke/rotate them before deployment. This version removes the embedded Telegram credentials and the hard-coded GitHub token; it never includes a secret value in this guide.

## What the workflows do

Both included workflows expect the bot to create a GitHub Release for a build tag and upload one project ZIP asset. They download that ZIP, find `pubspec.yaml`, run `flutter pub get`, build a release APK, and publish the APK as a GitHub Actions artifact. The `web2apk.yml` file currently uses the same Flutter APK pipeline; it is a separate workflow entry for compatibility with the bot's existing menu.
