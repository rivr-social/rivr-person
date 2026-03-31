# Repo Status

This directory is now the standalone extraction target for the `rivr-person` GitHub repo.

What is ready:

- extracted runnable person app source
- standalone `package.json`
- standalone `Dockerfile`, `.dockerignore`, and `.env.example`
- person export/import/cutover/verification scripts
- deployment and cutover docs under `docs/`
- PM Core / Docker Lab links in the repo README

What still needs proof:

- fresh `pnpm install` inside this repo
- standalone `pnpm build` inside this repo
- optional Docker image build verification
