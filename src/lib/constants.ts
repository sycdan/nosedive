export const MANAGED_EXCLUDE_BEGIN = "# BEGIN nosedive-managed exclude";
export const MANAGED_EXCLUDE_END = "# END nosedive-managed exclude";
export const FOUNDATION_EXCLUDE_BEGIN = "# BEGIN nosedive-managed package-foundation exclude";
export const FOUNDATION_EXCLUDE_END = "# END nosedive-managed package-foundation exclude";
export const CONFIG_EXCLUDE_BEGIN = "# BEGIN nosedive-managed config exclude";
export const CONFIG_EXCLUDE_END = "# END nosedive-managed config exclude";
export const REPO_MARKER_EXCLUDE_BEGIN = "# BEGIN nosedive-managed repo-marker exclude";
export const REPO_MARKER_EXCLUDE_END = "# END nosedive-managed repo-marker exclude";

/**
 * The dive-body heading `record.dive --brief` writes and `jump` requires. Not
 * "brief as understood": this is not a readback of the pilot's ask, it is an
 * instruction written for the different agent that will work the dive.
 */
export const DIVE_BRIEF_HEADING = "## Brief";
export const DIVE_BRIEF_HEADING_PATTERN = /^##\s+Brief\s*$/m;

/**
 * Printed when nothing in the kb can be picked up. A `nose:` line addresses the
 * agent rather than the pilot, and preflight names the command instead of
 * running it: a preflight that minted its own dive would leave
 * `record.dive --free` with no caller at all.
 */
export const PREFLIGHT_NO_DIVE_LINE =
	"nose: no dive to pick up; run `record.dive --free` before acting on the pilot's first instruction";

/** Quotes a value for a `/bin/sh` hook body. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Render a hook with the invocation that installed it, never an ambient CLI.
 *
 * `originalHookPath` is the pre-push the pilot already had. Wrapping it rather
 * than replacing it is what lets nosedive own the hooks path without switching
 * anyone's own gate off; it must be posix, because the body runs under `sh`.
 *
 * The ref updates arrive on stdin and a stream is consumed once, so the wrapper
 * reads them and replays them into both hooks. The pilot's exit status is the
 * push's answer: a gate that says no is not worth a second opinion.
 */
export function prePushHook(nosediveInvocation: string, originalHookPath?: string): string {
	if (!originalHookPath) {
		return `#!/bin/sh\n# nosedive-managed\nexec ${nosediveInvocation} _pre-push.hook "$@"\n`;
	}
	return [
		"#!/bin/sh",
		"# nosedive-managed",
		"refs=$(cat)",
		`original_hook=${shellQuote(originalHookPath)}`,
		'if [ -x "$original_hook" ]; then',
		`  printf '%s\\n' "$refs" | "$original_hook" "$@" || exit $?`,
		"fi",
		`printf '%s\\n' "$refs" | ${nosediveInvocation} _pre-push.hook "$@"`,
		"",
	].join("\n");
}

export const PRE_PUSH_WORKSPACE_COMMIT_ERROR_ID = "019fce99-1d6e-7fa4-aa0c-a548d7049643";
export const HANDOFF_RUNBOOK_ID = "019f9f95-750a-7b26-a53e-6c277e8f148f";
export const HYDRATE_UNPUBLISHED_COMMIT_ERROR_ID = "019fcb35-d660-7318-ac4c-3d5aeed3a81e";
export const NO_ACTIVE_DIVE_ERROR_ID = "019fe2f7-5922-72d5-abda-b5b8cb7300cf";
export const SEED_LEVEL_DOWNGRADE_ERROR_ID = "019fee38-0674-7e46-be0c-a3405ece099e";

/**
 * Set for the lifetime of a `land` and inherited by every process it spawns, so
 * a pre-push hook that shells back into `nosedive land` refuses instead of
 * re-entering. Unset it in a hook to allow a nested land on purpose.
 *
 * @see kb/019ff969-4126-79f0-9af7-451afe898c0e.md
 */
export const LAND_IN_FLIGHT_ENV = "NOSEDIVE_LAND_IN_FLIGHT";

export const GIT_LOCAL_ENV_KEYS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
];

export const USAGE_HEADER = "Usage: nosedive <command>";

export const DEFAULT_RC = {
	workspace: "./workspace",
	backlog: "./backlog",
	kb: "./kb",
	"work-branch-prefix": "work/",
};

export const BRIDGE_STATE_DIRNAME = ".nosedive";
export const BASE_CONFIG_FILENAME = "config.yaml";
export const LEGACY_CONFIG_FILENAME = ".nosediverc";
export const MIGRATION_BACKUP_DIRNAME = "migration-backups";

export const CURRENT_COMPATIBILITY_LEVEL = 2;

export const BASE_CONFIG_KNOWN_KEYS = [
	"compatibility-level",
	"workspace",
	"backlog",
	"kb",
	"bridge",
	"work-branch-prefix",
] as const;

/**
 * Agent instruction files nosedive knows about. `seed` picks these up when no
 * `--file` names one, and `preflight` reads the same set back to check them for
 * drift -- one list, because two would eventually disagree about which files
 * are managed and preflight would go quiet on a file seed writes.
 */
export const KNOWN_INSTRUCTION_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
] as const;

export const MANAGED_INSTRUCTIONS_BEGIN = "<!-- BEGIN nosedive managed instructions -->";
export const MANAGED_INSTRUCTIONS_END = "<!-- END nosedive managed instructions -->";
