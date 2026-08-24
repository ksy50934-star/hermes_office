import { readdir } from "node:fs/promises";
import path from "node:path";

const EXCLUDED_NAMES = new Set([
  "legacy-conversations",
  "node_modules",
  "__pycache__",
]);

function isVisibleDirectory(entry) {
  return entry.isDirectory()
    && !entry.isSymbolicLink()
    && !entry.name.startsWith(".")
    && !EXCLUDED_NAMES.has(entry.name);
}

export async function collectDocumentTree({ root, profileId, maxDepth = 12, maxDirectories = 2000, readdirImpl = readdir }) {
  const profileRoot = path.resolve(String(root || ""), String(profileId || ""));
  const directories = [];

  async function walk(absolute, relative = "", depth = 0) {
    if (depth >= maxDepth || directories.length >= maxDirectories) return;
    const entries = await readdirImpl(absolute, { withFileTypes: true });
    const visible = entries.filter(isVisibleDirectory).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    for (const entry of visible) {
      if (directories.length >= maxDirectories) break;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      directories.push(childRelative);
      await walk(path.join(absolute, entry.name), childRelative, depth + 1);
    }
  }

  try {
    await walk(profileRoot);
    return { directories, collectionError: null };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") {
      return { directories: [], collectionError: error.code === "ENOENT" ? "profile-root-missing" : "profile-root-unreadable" };
    }
    throw error;
  }
}
