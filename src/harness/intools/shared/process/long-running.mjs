/** Host-side heuristic for long-lived dev servers / watchers (not one-shot builds). */
export function isLongRunningShellCommand(command) {
  const text = String(command ?? '').trim();
  if (!text) return false;
  if (/\b(vite|next|nuxt|astro|webpack)\s+build\b/i.test(text)) return false;
  if (/\b(npm|pnpm|yarn|bun)\s+run\s+build\b/i.test(text)) return false;
  return /\b(npm|pnpm|yarn|bun)(\s+run)?\s+(dev|start|serve)\b/i.test(text)
    || /\b(next|nuxt|astro)\s+dev\b/i.test(text)
    || (/\bvite\b/i.test(text) && !/\bvite\s+build\b/i.test(text))
    || /\b(webpack-dev-server|nodemon|turbo\s+dev|parcel\s+serve)\b/i.test(text)
    || /\b(uvicorn|gunicorn)\b/i.test(text)
    || /\b(flask\s+run|manage\.py\s+runserver)\b/i.test(text)
    || /\bcargo\s+watch\b/i.test(text)
    || /\b(docker\s+compose\s+up|docker-compose\s+up)\b/i.test(text);
}

/** True when the model/host asked to retain, or the command looks like a persistent server. */
export function shouldRetainShellCommand(args = {}) {
  if (args.retain === true) return true;
  if (args.retain === false) return false;
  return isLongRunningShellCommand(args.command);
}
