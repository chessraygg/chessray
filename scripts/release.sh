#!/usr/bin/env bash
#
# LOCAL OVERRIDE — for manual releases outside the normal PR flow.
#
# Normal flow: merge a PR into main with a "major", "minor", or "patch" label.
#              CI auto-bumps version, tags, builds, and creates a GitHub Release.
#
# This script is for exceptional cases only (e.g., hotfix from local).
#
# Usage:
#   ./scripts/release.sh patch    # 0.2.0 → 0.2.1
#   ./scripts/release.sh minor    # 0.2.0 → 0.3.0
#   ./scripts/release.sh major    # 0.2.0 → 1.0.0
#   ./scripts/release.sh 2.1.0   # explicit version

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <patch|minor|major|x.y.z>"
  echo ""
  echo "NOTE: The normal release flow is automatic — merge a PR with a"
  echo "      'major', 'minor', or 'patch' label. Use this script only"
  echo "      for exceptional manual releases."
  exit 1
fi

BUMP="$1"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure on main branch
BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "Error: releases must be created from the main branch (currently on '$BRANCH')."
  exit 1
fi

# Get current version from root package.json
CURRENT="$(node -p "require('./package.json').version")"
echo "Current version: $CURRENT"

# Compute new version
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case "$BUMP" in
    major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
    patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    *) echo "Error: argument must be patch, minor, major, or x.y.z"; exit 1 ;;
  esac
fi

echo "New version: $NEW_VERSION"

# Update version in all package.json files
for pkg in package.json packages/*/package.json; do
  if [ -f "$pkg" ]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
      pkg.version = '$NEW_VERSION';
      fs.writeFileSync('$pkg', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "  Updated $pkg"
  fi
done

# Commit and tag
git add package.json packages/*/package.json
git commit -m "Release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

echo ""
echo "Created commit and tag v$NEW_VERSION"
echo ""
echo "To publish the release, push the commit and tag:"
echo "  git push && git push origin v$NEW_VERSION"
echo ""
echo "CI will build binaries for all platforms and create a GitHub Release."
