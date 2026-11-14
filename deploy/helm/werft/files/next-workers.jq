# The images.workers values of the next upgrade, from the deployed release's
# values and a packaged release's worker images:
#
#   jq -n -f next-workers.jq --arg phase final|control \
#     --slurpfile deployed <helm get values --all --revision <deployed> -o json> \
#     --slurpfile release <files/release-images.json of the target chart> \
#     --argjson known '{"sha256:…": {"runtime": {…}, "releasedAt": "…"}}'
#
# control  the deployed list as it is, with egressProxy, for the upgrade that
#          replaces the control plane first. A list install only.
# final    the target's images added to the deployed ones (a list, or for a
#          single-image install images.worker and images.workerPrevious),
#          each engine's newest first, at most two unretracted per engine.
#          A deployed image without runtime takes it from $known by digest,
#          and so does every releasedAt of a single-image install. A
#          deployed image the trim drops is the upgrade check's to judge.
#
# Both clear images.worker and images.workerPrevious, which the chart refuses
# beside a list (a packaged chart fills images.worker).

def fail($message): error("next-workers: " + $message);

# Milliseconds since the epoch of an RFC 3339 time with seconds, as the chart
# and the readers accept it.
def epoch_ms:
  . as $text
  | (capture("^(?<day>[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.(?<fraction>[0-9]{1,3}))?(?<zone>Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$")
     // fail("releasedAt \($text | tojson) is not an RFC 3339 time, e.g. \"2026-11-10T00:00:00Z\""))
  | ((.day + "Z") | fromdateiso8601) as $seconds
  | if ($seconds | todateiso8601) != .day + "Z" then fail("releasedAt \($text) is not a day that exists") else . end
  | (((.fraction // "") + "000")[0:3] | tonumber) as $fraction
  | (if .zone == "Z" then 0
     else (if .zone[0:1] == "+" then 1 else -1 end) * ((.zone[1:3] | tonumber) * 3600 + (.zone[4:6] | tonumber) * 60)
     end) as $offset
  | ($seconds - $offset) * 1000 + $fraction;

def cleared: {worker: {digest: "", runtime: null}, workerPrevious: {digest: "", runtime: null}};

def entry($where):
  if (.digest | type) != "string" or (.digest | test("^sha256:[0-9a-f]{64}$") | not) then fail("\($where) has digest \(.digest | tojson)")
  elif (.runtime | type) != "object" or (.runtime.engine | type) != "string" then fail("\($where) \(.digest) has no runtime: set it from the release manifest (workerRuntime) in $known")
  elif (.releasedAt | type) != "string" then fail("\($where) \(.digest) has no releasedAt: set it in $known (its commit's committer time)")
  else {repository, digest, runtime, releasedAt} + (if .retracted == true then {retracted: true} else {} end) + {ms: (.releasedAt | epoch_ms)}
  end;

($deployed[0].images // fail("the deployed values have no images")) as $images
| (($images.workers // []) | length > 0) as $listed
| if $phase == "control" then
    if $listed | not then fail("the deployed release has no images.workers: a single-image install keeps the single-image control phase") else . end
    | {images: (cleared + {workers: $images.workers, egressProxy: $images.egressProxy})}
  elif $phase != "final" then fail("phase must be control or final, not \($phase | tojson)")
  else
    (if $listed then $images.workers
     # A single-image install's releasedAt is the chart default, which names
     # the packaged digest whatever digest the install set: only $known counts.
     else [$images.worker, $images.workerPrevious | select((.digest // "") != "")]
       | map(del(.releasedAt) | if (.runtime // {}) == {} then del(.runtime) else . end)
     end
     | map(($known[.digest] // {}) * . | entry("deployed image"))) as $old
    | ($release[0] | if type != "array" or length == 0 then fail("the release images are not a list of entries") else . end
       | map(del(.retracted) | entry("release image"))) as $new
    | ($old + $new | group_by(.digest) | map(select(length > 1 and (map(.repository) | unique | length) > 1)) | .[0][0].digest) as $moved
    | if $moved != null then fail("\($moved) is listed under two repositories") else . end
    | ($old | group_by(.digest) | map(select(length > 1)) | .[0][0].digest) as $twice
    | if $twice != null then fail("the deployed images list \($twice) twice") else . end
    | ($new | map(. as $image
        | ($old | map(select(.digest == $image.digest)) | first) as $same
        | if $same == null then
            ($old | map(select(.runtime.engine == $image.runtime.engine) | .ms) | max) as $newest
            | if $newest != null and $image.ms <= $newest then
                fail("\($image.digest) (\($image.runtime.engine), \($image.releasedAt)) is not newer than every deployed \($image.runtime.engine) image: an older release cannot go in front")
              else $image end
          elif $same.runtime != $image.runtime then fail("\($image.digest) is deployed with another runtime")
          elif $same.ms != $image.ms then fail("\($image.digest) is deployed with releasedAt \($same.releasedAt), not \($image.releasedAt)")
          else empty
          end)) as $added
    | {images: (cleared + {workers: (
        $old + $added
        | group_by(.runtime.engine)
        | map(
            sort_by(-.ms) as $sorted
            | ($sorted | [range(1; length) as $i | select($sorted[$i].ms == $sorted[$i - 1].ms) | $sorted[$i].digest] | first) as $tie
            | if $tie != null then fail("\($tie) has the releasedAt of the \($sorted[0].runtime.engine) image above it") else . end
            | ($sorted | map(select(.retracted != true)) | .[0:2]) as $kept
            | ($kept | last | .ms) as $oldest
            | $sorted
            | map(select(
                if .retracted == true then $oldest == null or .ms > $oldest
                else (.digest as $digest | $kept | any(.digest == $digest))
                end)))
        | add
        | map(del(.ms)))})}
  end
