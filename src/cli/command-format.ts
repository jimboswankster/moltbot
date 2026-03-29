import { replaceCliName, resolveCliName } from "./cli-name.js";
import { rewriteGatewayRestartCommandForHydra } from "./gateway-restart-preference.js";
import { normalizeProfileName } from "./profile-utils.js";

const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const cliName = resolveCliName();
  const normalizedCommand = replaceCliName(command, cliName);
  // Rewrite restart hints before profile decoration. The Hydra path resolves
  // from OPENCLAW_STATE_DIR/OPENCLAW_PROFILE, so appending --profile is not
  // required and would produce an invalid command form.
  const hydraPreferredCommand = rewriteGatewayRestartCommandForHydra(normalizedCommand, env);
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (!profile) {
    return hydraPreferredCommand;
  }
  if (!CLI_PREFIX_RE.test(hydraPreferredCommand)) {
    return hydraPreferredCommand;
  }
  if (PROFILE_FLAG_RE.test(hydraPreferredCommand) || DEV_FLAG_RE.test(hydraPreferredCommand)) {
    return hydraPreferredCommand;
  }
  return hydraPreferredCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
}
