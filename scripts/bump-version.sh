#!/bin/bash
# Called by Craft during `craft prepare`. Only sets the version; Craft commits and tags it.
set -euo pipefail

node -e '
const fs = require("node:fs");
const path = "packages/pi/package.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.version = process.env.CRAFT_NEW_VERSION;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
'
