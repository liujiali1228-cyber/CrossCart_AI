# Repository Guidelines

## Project Structure

CrossCart AI is an npm workspace in `crosscart/`. Paths below are relative to that directory unless noted.

- `packages/core/src/` holds pure TypeScript logic for plans, pricing, delivery, preferences, and scene selection. `packages/bridge/src/` owns persistence, HTTP and server-sent events, chat, and provider integration.
- `packages/dsh-plugin/` exposes tools to the dsh runtime, and `packages/dsh-client-ui/` renders plan cards in dsh chat.
- `studio/` contains the browser UI and `studio/assets/` its visual assets. Find catalog fixtures in `data/seed/`, verification scripts in `scripts/`, and screenshots in `shots/`. The workspace-level `docs/` holds design notes alongside the implementation reports in `crosscart/docs/`.

## Build, Test, and Development

Run these commands from `crosscart/` using Node.js 22.18 or newer.

- `npm install` installs workspace dependencies.
- `npm run build` compiles the core into `packages/core/dist/`.
- `npm run studio` starts the app at `http://127.0.0.1:8790`. See `README.md` for dsh setup.
- `npm test` builds the core and runs the Node test suites.
- `npm run verify` exercises the running Studio in Microsoft Edge via Playwright and writes screenshots. `npm run verify:stage3` starts isolated instances with a mock image provider.

## Coding Style

Follow nearby code. Use two-space indentation, single quotes, and omit trailing semicolons in TypeScript and JavaScript. Use kebab-case for multiword filenames, camelCase for functions, and PascalCase for types. Core uses strict TypeScript with NodeNext resolution and `.js` extensions in relative imports. The root package defines no lint or format script. Keep pricing and plan rules in core, and have Studio render the bridge's view model.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name tests `*.test.ts` in `packages/core/test/` or `*.test.mjs` in `packages/bridge/test/`. Add new test files to the explicit list in `package.json`. Cover changed behavior with deterministic fixtures or local mocks. Keep provider credentials and runtime state out of commits.

## Commits and Pull Requests

Use a short, imperative commit subject, such as `Preserve locked slots during swaps`. In PRs, summarize the behavior change, list the checks you ran, link related issues when available, and include desktop and mobile screenshots for Studio changes.
