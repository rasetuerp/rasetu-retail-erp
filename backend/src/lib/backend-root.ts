import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Absolute path to backend/, resolved from this compiled file's own location
// (dist/lib/backend-root.js -> up two levels -> backend/) rather than
// process.cwd(). Several paths in this codebase used to resolve relative to
// process.cwd() (template.db, config/profiles/profile-cloth.json,
// RASETU_DATA_DIR's dev fallback, the packaged frontend dist) — that only
// worked by coincidence when the process happened to be launched with cwd
// set to backend/ (e.g. `cd backend && npm run dev`). Electron's main.ts
// spawns the compiled backend via `spawn(process.execPath, [backendEntry],
// {...})` with no explicit cwd, so it inherits Electron's own cwd (the repo
// root), not backend/ — every process.cwd()-relative path silently resolved
// one directory too shallow. Found live: company creation failed with
// ENOENT on template.db, misreported as "drive disconnected" by app.ts's
// generic enoent-matching error handler.
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
