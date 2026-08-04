export const MANAGED_EXCLUDE_BEGIN = "# BEGIN nosedive-managed exclude";
export const MANAGED_EXCLUDE_END = "# END nosedive-managed exclude";
export const FOUNDATION_EXCLUDE_BEGIN = "# BEGIN nosedive-managed package-foundation exclude";
export const FOUNDATION_EXCLUDE_END = "# END nosedive-managed package-foundation exclude";
export const CONFIG_EXCLUDE_BEGIN = "# BEGIN nosedive-managed config exclude";
export const CONFIG_EXCLUDE_END = "# END nosedive-managed config exclude";
export const REPO_MARKER_EXCLUDE_BEGIN = "# BEGIN nosedive-managed repo-marker exclude";
export const REPO_MARKER_EXCLUDE_END = "# END nosedive-managed repo-marker exclude";

export const PRE_PUSH_HOOK =
	'#!/bin/sh\n# nosedive-managed\nexec npx nosedive _pre-push.hook "$@"\n';
export const MANUAL_PRE_PUSH_LINE = 'npx nosedive _pre-push.hook "$@" || exit 1';
export const PRE_PUSH_WORKSPACE_COMMIT_ERROR_ID = "019fce99-1d6e-7fa4-aa0c-a548d7049643";
export const HANDOFF_RUNBOOK_ID = "019f9f95-750a-7b26-a53e-6c277e8f148f";
export const HYDRATE_UNPUBLISHED_COMMIT_ERROR_ID = "019fcb35-d660-7318-ac4c-3d5aeed3a81e";

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
	"home-branch": "main",
	"work-branch-prefix": "work/",
};

export const SPLIT_CONFIG_DIRNAME = ".nosedive";
export const BASE_CONFIG_FILENAME = "config.yaml";
export const LEGACY_CONFIG_FILENAME = ".nosediverc";
export const MIGRATION_BACKUP_DIRNAME = "migration-backups";

export const CURRENT_COMPATIBILITY_LEVEL = 1;

export const BASE_CONFIG_KNOWN_KEYS = [
	"compatibility-level",
	"workspace",
	"backlog",
	"kb",
	"home-branch",
	"work-branch-prefix",
] as const;
