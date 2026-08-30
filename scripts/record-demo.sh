#!/bin/bash
#
# The landing-page cast and the proof that the demo still works are one run.
#
# `walk` is meant to be the command asciinema records, so everything it prints
# is the demo. Every command a viewer sees is executed, not echoed: `step`
# prints its argument and then evals that same string, so exactly one copy of
# each command exists and the recording cannot drift from what ran.
#
#   step   shown in the cast, must exit 0
#   fails  shown in the cast, must exit NON-zero -- the beat that sells it
#   check  never shown, writes to fd 3, a file outside the recording
#
# `reset` wipes the throwaway remote and is deliberately NOT part of the walk:
# it is setup, and setup has no business on the landing page. Run it first,
# outside the recorder.
#
# @see kb/01a04e21-40d3-733f-bbc9-5274bc42a31c.md

set -u

REMOTE="${CAST_REMOTE:-git@github.com:sycdan/nosedive-cast.git}"
DWELL="${DWELL:-1.0}"
ASSERT_LOG="${ASSERT_LOG:-/tmp/record-demo-assertions.log}"
WORKDIR="${WORKDIR:-/tmp/record-demo}"

WORK_BRANCH="work/add-a-hello-note"
HELLO="Hello from nosedive."
NOTE="workspace/__self/hello.md"

PROMPT=$'\e[32m~\e[0m \e[34m$\e[0m '
CONT=$'\e[34m>\e[0m '

# Reset the throwaway remote to a single empty commit.
#
# No clone: everything a clone brings down is discarded by the next command,
# and `git init` supplies the repository a force-push needs. Identity is passed
# per-command because a fresh init inherits none and the runner may have none.
#
# `main` is overwritten rather than deleted -- deleting a GitHub default branch
# needs the API and leaves the repo unclonable in between.
cmd_reset() {
	local dir="$WORKDIR/reset"
	rm -rf "$dir"
	mkdir -p "$dir"
	git init -q "$dir"
	git -C "$dir" \
		-c user.name="nosedive cast" \
		-c user.email=cast@nosedive.invalid \
		commit -q --allow-empty -m "tabula rasa"
	git -C "$dir" push --force "$REMOTE" HEAD:main

	# Every other branch goes too. A run that found the previous run's work
	# branch still there refused to fast-forward onto it, correctly, since the
	# two share no history. Resetting main alone is not a fresh start.
	local stale
	stale="$(git -C "$dir" ls-remote --heads "$REMOTE" |
		awk '{print $2}' | grep -v '^refs/heads/main$' || true)"
	if [ -n "$stale" ]; then
		# shellcheck disable=SC2086
		git -C "$dir" push "$REMOTE" --delete $stale
	fi
	rm -rf "$dir"
}

# ---------------------------------------------------------------------------

failed=0

# Opened here rather than left to the caller: an unopened fd 3 makes every
# assertion write "Bad file descriptor" to stderr, and stderr is inside the
# recording -- the one place assertion noise must never appear.
open_log() { exec 3>>"$ASSERT_LOG"; }

say() { printf '%s\n' "$*" >&3; }

fail() {
	failed=1
	say "ASSERTION FAILED: $*"
}

# A pasted command carries real newlines into the cast, each continuation
# prefixed with the shell's continuation prompt. Writing the break as an escape
# instead renders as one line with a literal backslash-n in the middle of it,
# which is what shipped once already and had to be re-cut.
step() {
	local cmd="$1" first rest rc
	first="${cmd%%$'\n'*}"
	rest="${cmd#*$'\n'}"
	printf '%s%s\r\n' "$PROMPT" "$first"
	if [ "$rest" != "$cmd" ]; then
		while IFS= read -r line; do
			printf '%s%s\r\n' "$CONT" "$line"
		done <<<"$rest"
	fi
	eval "$cmd"
	rc=$?
	[ $rc -eq 0 ] || fail "step exited $rc: $cmd"
	sleep "$DWELL"
	return 0
}

# Shown, and required to fail. `pack` banks the commit as a patch artifact and
# resets the worktree to its pin, so the note leaves disk. If this ever
# succeeds, pack reset nothing and the demo is showing a lie.
fails() {
	local cmd="$1" rc
	printf '%s%s\r\n' "$PROMPT" "$cmd"
	eval "$cmd"
	rc=$?
	[ $rc -ne 0 ] || fail "expected non-zero, got 0: $cmd"
	sleep "$DWELL"
	return 0
}

# Not shown. No prompt line is printed, so nothing enters the cast.
check() {
	local what="$1"
	shift
	say "check: $what"
	eval "$*" >&3 2>&3 || fail "$what"
}

# An agent step. Shown in the cast, and deliberately NOT fatal when it fails.
#
# The gate's contract is "there is a fresh cast to review", not "the model had
# a good afternoon". A rate limit or a flubbed take must never read as nosedive
# being broken -- could-not-start and ran-and-failed are different things, and
# only the first is the gate's business. The failure is recorded on fd 3 so the
# reviewer sees it; the walk keeps going so there is something to watch.
agent() {
	local cmd="$1" rc
	printf '%s%s\r\n' "$PROMPT" "$cmd"
	eval "$cmd"
	rc=$?
	[ $rc -eq 0 ] || say "NOTE: agent step exited $rc (not fatal): $cmd"
	sleep "$DWELL"
	return 0
}

cmd_walk() {
	open_log

	if [ -z "${AGENT_CMD:-}" ]; then
		say "AGENT_CMD is unset; the walk cannot delegate anything"
		echo "AGENT_CMD is unset -- nothing to delegate to." >&2
		return 2
	fi

	rm -rf "$WORKDIR/BASE"
	mkdir -p "$WORKDIR"
	cd "$WORKDIR" || exit 1

	step "git clone $REMOTE BASE"
	cd BASE || exit 1

	# --headless because CI has nobody to press Enter. A human's first run
	# answers three prompts, so the cast diverges from a real first run at this
	# one step. Known, deliberate, and the quickstart gate makes the same trade.
	step "nosedive seed --headless"

	# seed publishes the bridge itself -- no git command left for the pilot to
	# type and none printed. That the remote actually received it is a claim no
	# exit code makes.
	check "seed published main to the remote" \
		'test -n "$(git ls-remote origin main)"'

	# No --name: the slug derived from the gist is what every later command
	# names the feat by, so passing one would hide a change to that derivation.
	step 'nosedive record.feat --gist "Add a hello note"'
	# The brief names the exact line, because an agent writes this file and the
	# grep two beats later has to find something known. "Write a hello note" is
	# what a human would say and is exactly what makes the walk unrepeatable.
	step "nosedive record.dive --feat add-a-hello-note \\
    --gist \"Add a hello note to the bridge\" \\
    --brief \"Write workspace/__self/hello.md containing exactly: $HELLO -- then commit it. Do not land.\""

	# Delegate the jump. Two steps and a file, never a pipe -- the handoff is
	# written to disk and then handed over by path. Piping `jump` straight into
	# an agent loses it: a cold hydrate takes longer than a headless agent will
	# wait on stdin, and opencode does not read stdin at all.
	# @see kb/01a04ef3-d01e-727c-bf3d-54f7cc29c292.md
	#
	# `-f` is opencode's flag for attaching a file to the message. Swapping
	# agents means swapping this line as well as AGENT_CMD.
	# The bridge root, not workspace/. The documented method writes to
	# workspace/input.md, which does not exist until a jump has hydrated into it
	# -- and the shell opens a redirect target before the command runs, so on a
	# fresh bridge that line dies before jump starts.
	# @see kb/01a04ff2-6174-7ec0-9b0c-b3c5bc92dea3.md
	step "nosedive jump > input.md"
	# Message first, `-f` last. opencode declares --file as an array, so a
	# trailing positional after it is swallowed as another filename:
	# `-f input.md "Follow..."` fails with `File not found: Follow...`.
	agent "$AGENT_CMD \"Follow the nosedive handoff in the attached file.\" -f input.md"

	check "jump hydrated the bridge worktree" 'test -d workspace/__self'
	check "the agent wrote the note" "test -f '$NOTE'"
	check "the agent left nothing uncommitted" \
		'test -z "$(git -C workspace/__self status --porcelain)"'

	step "nosedive pack"

	# The three beats. Absence alone is what a mistake looks like; absence plus
	# the artifact is what a design looks like. Never cut one of these three.
	fails "cat $NOTE"
	step "grep -r \"$HELLO\" kb/"

	# The second delegation, and the one the whole demo is for: a human says
	# what done looks like, in English, and the agent works out that this means
	# jump, verify, land. Its jump is the cold jump -- the one that replays the
	# packed artifact back onto disk.
	agent "$AGENT_CMD \"jump and land. done when: a hello note exists in the bridge worktree\""

	# The payoff, run by the human: the note is back, from an artifact, put
	# there by an agent that was told an outcome rather than a command.
	step "cat $NOTE"

	check "the replayed note holds the original line" \
		"grep -qF '$HELLO' '$NOTE'"

	# Read after the round trip, not before it: `git am` replays the patch under
	# a fresh committer, so the commit land published is the one the re-jump
	# produced, not the one the work was first committed as. `land` leaves each
	# scoped worktree hydrated at exactly the commit it pushed, so this is that
	# commit.
	local landing_sha published
	landing_sha="$(git -C workspace/__self rev-parse HEAD)"
	say "commit the dive landed: $landing_sha"

	# The assertion no exit code makes. `land` has been seen to exit 0 having
	# pushed nothing and closed nothing.
	# @see kb/01a04f78-23a0-732f-957f-5e0cd8a3ba46.md
	published="$(git ls-remote "$REMOTE" "$WORK_BRANCH" | awk '{print $1}')"
	say "remote $WORK_BRANCH is at: ${published:-<absent>}"
	if [ -z "$published" ]; then
		fail "land published no $WORK_BRANCH"
	elif [ "$published" != "$landing_sha" ]; then
		fail "$WORK_BRANCH is at $published, not the dive commit $landing_sha"
	fi

	# The closing id resolves from the installed package, not from this bridge,
	# so a viewer who types it gets the gates quickstart on a machine that has
	# never seen this repo.
	step "nosedive note nosedive render 01a031cd-a1e1-7c6d-9a71-4ab49b96da0a to learn about gates"

	# A cast ends at its last event, so trailing idle time does not exist in the
	# file -- hold the tail by emitting, not by waiting. The player also caps any
	# single gap at its idleTimeLimit, so two beats a second apart give a real
	# two seconds where one two-second pause gives 1.5.
	printf '%s' "$PROMPT"
	sleep 1
	printf '\e[0m'
	sleep 1
	printf '\e[0m'

	say "walk finished with failed=$failed"
	return "$failed"
}

case "${1:-}" in
reset) cmd_reset ;;
walk) cmd_walk ;;
*)
	echo "usage: $0 reset|walk" >&2
	exit 2
	;;
esac
