#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
DMG="dist/Manifold-${VERSION}-arm64.dmg"

echo "==> Building Manifold ${VERSION} for macOS..."
npm run build:mac

if [ ! -f "$DMG" ]; then
  echo "ERROR: ${DMG} not found. Check the build output."
  exit 1
fi

echo "==> Uploading .dmg to release ${TAG}..."
gh release upload "$TAG" "$DMG" --repo MindFabric/manifold-releases 2>/dev/null || \
  gh release upload "$TAG" "$DMG" --repo MindFabric/manifold-releases --clobber

SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)

echo "==> Updating Homebrew cask..."
TAP_DIR=$(mktemp -d)
gh repo clone MindFabric/homebrew-manifold "$TAP_DIR" -- -q

cat > "$TAP_DIR/Casks/manifold.rb" << EOF
cask "manifold" do
  version "${VERSION}"
  sha256 "${SHA}"

  url "https://github.com/MindFabric/manifold-releases/releases/download/v#{version}/Manifold-#{version}-arm64.dmg"
  name "Manifold"
  desc "Workspace manager for Claude Code"
  homepage "https://github.com/MindFabric/manifold-releases"

  app "Manifold.app"

  zap trash: [
    "~/Library/Application Support/Manifold",
  ]
end
EOF

cd "$TAP_DIR"
git add Casks/manifold.rb
git commit -m "Update Manifold to ${VERSION}"
git push
rm -rf "$TAP_DIR"

echo ""
echo "==> Done! macOS .dmg uploaded + Homebrew cask updated."
echo "==> Publish the draft release at:"
echo "    https://github.com/MindFabric/manifold-releases/releases"
