/**
 * Lane Permission Resolver
 *
 * Resolves permission_level from thread ID via lane-registry
 */

import fs from "node:fs";
import path from "node:path";

// Permission levels (higher = more privileges)
export const PERMISSION_LEVELS = {
  restricted: 0,
  worker: 1,
  operator: 2,
  coo: 3,
} as const;

export type PermissionLevel = keyof typeof PERMISSION_LEVELS;

/**
 * Get permission level for a thread
 */
export function getThreadPermission(threadId: number | string | undefined): PermissionLevel | null {
  if (threadId === undefined) return null;

  const threadNum = typeof threadId === "string" ? parseInt(threadId) : threadId;
  if (isNaN(threadNum)) return null;

  // Read lane-registry
  const laneRegistryPath = path.join(process.cwd(), "os", "coordination", "lane-registry.md");
  if (!fs.existsSync(laneRegistryPath)) return null;

  const content = fs.readFileSync(laneRegistryPath, "utf-8");
  const lines = content.split("\n");

  let inTargetLane = false;
  for (const line of lines) {
    // Track lane sections and enter only the target lane.
    const laneMatch = line.match(/###\s+(\S+)\s+\(topic\s+(\d+)\)/);
    if (laneMatch) {
      const topicId = parseInt(laneMatch[2]);
      inTargetLane = topicId === threadNum;
      continue;
    }

    // Look for permission_level only within the target lane section.
    if (inTargetLane && line.includes("permission_level:")) {
      const permMatch = line.match(/permission_level:\s*(\S+)/);
      if (permMatch) {
        const level = permMatch[1] as PermissionLevel;
        if (level in PERMISSION_LEVELS) return level;
      }
    }
  }

  return null; // Default: no spawn allowed
}

/**
 * Check if spawning is allowed for a thread
 */
export function canSpawnInThread(threadId: number | string | undefined): boolean {
  const permission = getThreadPermission(threadId);
  if (!permission) return false; // Default deny

  return PERMISSION_LEVELS[permission] >= PERMISSION_LEVELS.operator;
}
