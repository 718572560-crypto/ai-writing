#!/usr/bin/env bash
# Update an existing, running single-server deployment from origin/main.
set -Eeuo pipefail

# Parse the whole function before Git can update this script on disk.
main() {
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

for program in git docker flock; do
  command -v "$program" >/dev/null || { printf 'Missing command: %s\n' "$program" >&2; exit 1; }
done
docker compose version >/dev/null
[[ -f .env && -f .env.production ]] || { echo 'Configure .env and .env.production first.' >&2; exit 1; }
[[ "$(git branch --show-current)" == main ]] || { echo 'Switch to the main branch before updating.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'The source checkout has local changes; refusing to overwrite them.' >&2; exit 1; }
exec 9>"$(git rev-parse --git-path youshu-deploy.lock)"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
docker compose config --quiet

previous=$(git rev-parse HEAD)
git fetch origin main
target=$(git rev-parse FETCH_HEAD)
git merge-base --is-ancestor "$previous" "$target" || { echo 'Local history has diverged from origin/main; resolve it before updating.' >&2; exit 1; }
if [[ "$previous" == "$target" ]]; then
  echo 'Source is already at origin/main. No containers were changed.'
  docker compose ps
  exit 0
fi

echo 'Creating an online SQLite backup with the currently running version...'
# Abort before changing source or containers when the existing database cannot be backed up.
backup=$(docker compose exec -T app node scripts/backup.cjs)
printf 'Database snapshot: %s\n' "$backup"
printf 'Previous source commit: %s\nTarget source commit: %s\n' "$previous" "$target"

on_failure() {
  local status=$?
  printf 'Deployment failed (exit %s). Previous source commit: %s\n' "$status" "$previous" >&2
  echo 'Inspect: docker compose logs --tail=100 app' >&2
  echo 'See GITHUB_DEPLOYMENT.md for code rollback. Database snapshots were not restored automatically.' >&2
  exit "$status"
}
trap on_failure ERR
git merge --ff-only "$target"
docker compose build app
# Keep the existing Caddy container and its TLS state while replacing only the application.
docker compose up -d --no-deps --wait --wait-timeout 120 app
printf '%s previous=%s current=%s backup=%s\n' "$(date -u +%FT%TZ)" "$previous" "$target" "$backup" >> data/deployments.log
trap - ERR
docker compose ps
printf 'Deployment completed: %s\n' "$target"
}

main "$@"
