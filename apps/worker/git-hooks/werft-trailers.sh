# Commit message attribution shared by everything in the image that writes a
# commit message: the hook dispatcher (werft-hook), the attribution repair
# tool and werft-commit source this file. Sourcing it only defines functions.
#
# The worker writes both inputs under $HOME/.werft from each claim: the
# session's trailers in git-trailers, and in git-strip the engine emails whose
# co-author lines go (the claim's git_strip, one email per line).

# Removes every Co-authored-by line (key in any case) whose email git-strip
# lists. Whole lines only: a line folded over several lines is not removed
# (the push check refuses it instead), so no text of the author is ever taken
# with it. Other lines, other co-authors included, are kept as written.
werft_strip_engine_coauthors() {
  _werft_file=$1
  _werft_strip=${HOME:-/nonexistent}/.werft/git-strip
  [ -n "$_werft_file" ] && [ -f "$_werft_file" ] && [ -f "$_werft_strip" ] ||
    return 0
  WERFT_STRIP_EMAILS=$(cat "$_werft_strip") awk '
    BEGIN {
      n = split(ENVIRON["WERFT_STRIP_EMAILS"], list, "\n")
      for (i = 1; i <= n; i++) {
        email = tolower(list[i])
        if (email != "" && email !~ /[ \t\r<>]/) engine[email] = 1
      }
    }
    {
      line = tolower($0)
      sub(/\r$/, "", line)
      if (line ~ /^co-authored-by:/ && match(line, /<[^<>]*>[ \t]*$/)) {
        email = substr(line, RSTART + 1, RLENGTH - 1)
        sub(/>[ \t]*$/, "", email)
        if (email in engine) next
      }
      # Blank lines are held until a line follows, so a removed last line
      # leaves no blank tail for a verbatim commit-tree -F.
      if ($0 ~ /^[ \t\r]*$/) { held = held $0 "\n"; next }
      printf "%s%s\n", held, $0
      held = ""
    }
  ' "$_werft_file" >"$_werft_file.werft-strip" || {
    rm -f "$_werft_file.werft-strip"
    return 1
  }
  cat "$_werft_file.werft-strip" >"$_werft_file" || return 1
  rm -f "$_werft_file.werft-strip"
}

# Adds the session's Co-authored-by and Agent-Session trailers unless the
# message already has the same line. Each line goes to git as one argv, never
# through the shell; a line with a CR or another key is skipped.
werft_add_trailers() {
  _werft_file=$1
  _werft_trailers=${HOME:-/nonexistent}/.werft/git-trailers
  [ -n "$_werft_file" ] && [ -f "$_werft_trailers" ] || return 0
  (
    # Outside any repository and with no config at all: a repository's or a
    # `git -c` trailer.* setting could otherwise rename these keys or run a
    # command that writes other lines.
    case $_werft_file in /*) ;; *) _werft_file=$PWD/$_werft_file ;; esac
    unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CONFIG GIT_CONFIG_PARAMETERS
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0
    cd / || exit 1
    cr=$(printf '\r')
    # The block git reads as the message's trailers (the push check counts
    # only that block). --no-divider: a `---` line is ordinary text to it.
    last=$(git interpret-trailers --parse --no-divider "$_werft_file") || exit 1
    set --
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        *"$cr"*) continue ;;
        "Co-authored-by: "* | "Agent-Session: "*)
          printf '%s\n' "$last" | grep -qxF -- "$line" && continue
          # --if-exists addIfDifferent compares with the last block only. A
          # hook that appended a paragraph after ours (husky's `Husky-Ran:`)
          # leaves our line in an earlier one, where the push check does not
          # count it.
          WERFT_DROP=$line awk '
            $0 == ENVIRON["WERFT_DROP"] { removed = 1; next }
            /^[ \t]*$/ { if (removed && blank) next; blank = 1; print; next }
            { blank = 0; removed = 0; print }
          ' "$_werft_file" >"$_werft_file.werft-move" || {
            rm -f "$_werft_file.werft-move"
            exit 1
          }
          cat "$_werft_file.werft-move" >"$_werft_file" || exit 1
          rm -f "$_werft_file.werft-move"
          set -- "$@" --trailer "$line"
          ;;
      esac
    done <"$_werft_trailers"
    [ $# -gt 0 ] || exit 0
    exec git interpret-trailers --no-divider --if-exists addIfDifferent --in-place "$@" "$_werft_file"
  )
}

# Both, in that order. Running it again changes nothing.
werft_fix_message() {
  werft_strip_engine_coauthors "$1" && werft_add_trailers "$1"
}
