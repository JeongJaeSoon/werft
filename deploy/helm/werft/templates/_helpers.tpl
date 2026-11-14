{{- define "ap.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Labels every resource carries; `component` names the workload. */}}
{{- define "ap.labels" -}}
{{ include "ap.selectorLabels" . }}
app.kubernetes.io/part-of: werft
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{- define "ap.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
<registry>/<repository>@<digest>, or a failed render: the scheduler's
kubernetes backend refuses a bare tag, and so does this chart for every image.
*/}}
{{- define "ap.image" -}}
{{- include "ap.imageRef" (dict "root" .root "label" (printf "images.%s" .name) "image" (index .root.Values.images .name)) -}}
{{- end -}}

{{- define "ap.imageRef" -}}
{{- $image := .image -}}
{{- $repository := required (printf "%s.repository is required" .label) $image.repository -}}
{{- if regexMatch "@|:[^/]+$" $repository -}}
{{- fail (printf "%s.repository must not carry a tag or digest (got %q); set %s.digest" .label $repository .label) -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" (toString $image.digest)) -}}
{{- fail (printf "%s.digest must be sha256:<64 hex> (got %q): every image is pinned by digest" .label (toString $image.digest)) -}}
{{- end -}}
{{- $registry := .root.Values.images.registry | trimSuffix "/" -}}
{{- if $registry -}}
{{- printf "%s/%s@%s" $registry $repository $image.digest -}}
{{- else -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- end -}}
{{- end -}}

{{- define "ap.installationId" -}}
{{- $id := toString .Values.installationId -}}
{{- if not (regexMatch "^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$" $id) -}}
{{- fail (printf "installationId must be a Kubernetes label value (got %q)" $id) -}}
{{- end -}}
{{- $id -}}
{{- end -}}

{{- define "ap.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "ap.containerSecurityContext" -}}
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "ap.imagePullSecrets" -}}
{{- with .Values.images.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "ap.secretEnv" -}}
- name: {{ .key | quote }}
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.secrets.name }}
      key: {{ .key | quote }}
{{- end -}}

{{/* The checkpoint object store settings the api and the checkpoint GC share. */}}
{{- define "ap.checkpointEnv" -}}
- name: AWS_REGION
  value: {{ .Values.config.aws.region | quote }}
- name: S3_BUCKET
  value: {{ .Values.config.checkpoints.bucket | quote }}
- name: CHECKPOINT_OBJECT_PROTECTION
  value: {{ .Values.config.checkpoints.protection | quote }}
{{- with .Values.config.aws.endpointUrl }}
- name: AWS_ENDPOINT_URL
  value: {{ . | quote }}
{{- end }}
{{- /* Without them the object store uses the AWS default credential chain
(IRSA). Set in the environment, the keys would also win over the role. */}}
{{- if .Values.secrets.objectStoreKeys }}
{{ include "ap.secretEnv" (dict "root" . "key" "AWS_ACCESS_KEY_ID") }}
{{ include "ap.secretEnv" (dict "root" . "key" "AWS_SECRET_ACCESS_KEY") }}
{{- end }}
{{- end -}}

{{/* Names are quoted: a YAML-quoted key would otherwise render as another name. */}}
{{- define "ap.extraEnv" -}}
{{- range $name, $value := . }}
- name: {{ $name | quote }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- end -}}

{{/*
The settings the console keeps (INSTALLATION_CONFIG in packages/contracts),
by the env names earlier releases read. No role reads them now: the migrate
Job carries one an earlier release set in, once, while it has nothing saved.
*/}}
{{- define "ap.carriedSettingNames" -}}
PENDING_REQUEST_TTL_SEC QUEUED_INPUT_LIMIT_PER_SESSION STORAGE_LIMIT_BYTES SESSION_COST_LIMIT_USD SESSION_TOKEN_LIMIT WORKSPACE_ENFORCE
{{- end -}}

{{/* config.limits as a role reads them: the carried settings left out. */}}
{{- define "ap.limitsEnv" -}}
{{- $carried := splitList " " (include "ap.carriedSettingNames" .) -}}
{{- range $name, $value := .Values.config.limits }}
{{- if not (has $name $carried) }}
- name: {{ $name | quote }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
The carried settings where earlier releases took them from, the last of
which the api's env let win: api.extraEnv, then config.limits, then
api.workspaceEnforce. Not merge: it takes a 0 for unset and lets a later
source win.
*/}}
{{- define "ap.carriedSettingsEnv" -}}
{{- $sources := list (.Values.api.extraEnv | default dict) (.Values.config.limits | default dict) -}}
{{- with .Values.api.workspaceEnforce }}
{{- $sources = append $sources (dict "WORKSPACE_ENFORCE" .) -}}
{{- end }}
{{- range $name := splitList " " (include "ap.carriedSettingNames" .) }}
{{- $found := false }}
{{- range $source := $sources }}
{{- if and (not $found) (hasKey $source $name) }}
{{- $found = true }}
- name: {{ $name | quote }}
  value: {{ index $source $name | toString | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Fails when a values-named variable is PREVIEW_NAMESPACE: preview.enabled is
the only way to declare a preview install (demo-accounts.ts).
*/}}
{{- define "ap.previewEnvReserved" -}}
{{- $names := concat (keys .Values.config.limits) .Values.secrets.catalogEnv -}}
{{- range $key := list "api" "scheduler" "reconciler" "slack" "egressProxy" -}}
{{- $names = concat $names (keys (index $.Values $key).extraEnv) -}}
{{- end -}}
{{- if has "PREVIEW_NAMESPACE" $names -}}
{{- fail "PREVIEW_NAMESPACE must not be set through extraEnv, config.limits or secrets.catalogEnv; preview.enabled is the only way to declare a preview install" -}}
{{- end -}}
{{- end -}}

{{/*
Fails when a values-named variable is one of the worker image variables:
the upgrade check reads them from images.* and would otherwise judge other
images than the scheduler launches.
*/}}
{{- define "ap.workerEnvReserved" -}}
{{- $names := concat (keys .Values.config.limits) .Values.secrets.catalogEnv -}}
{{- range $key := list "api" "scheduler" "reconciler" "slack" "egressProxy" -}}
{{- $names = concat $names (keys (index $.Values $key).extraEnv) -}}
{{- end -}}
{{- range $name := list "WORKER_IMAGE" "WORKER_IMAGES" "WORKER_IMAGE_PREVIOUS" "WORKER_IMAGE_RUNTIME" "WORKER_IMAGE_PREVIOUS_RUNTIME" -}}
{{- if has $name $names -}}
{{- fail (printf "%s must not be set through extraEnv, config.limits or secrets.catalogEnv; set images.workers, or images.worker and images.workerPrevious" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* /tmp is the only writable path: the root filesystem is read-only. */}}
{{- define "ap.tmpVolume" -}}
- name: tmp
  emptyDir:
    sizeLimit: 1Gi
{{- end -}}

{{- define "ap.tmpMount" -}}
- name: tmp
  mountPath: /tmp
{{- end -}}

{{/*
The worker images' runtime combinations: images.workers as WORKER_IMAGES, or
the runtimes of images.worker and images.workerPrevious. The api and slack
judge release spec pins against them and the scheduler picks each session's
image by them, so all three render this one definition and cannot disagree.
*/}}
{{- define "ap.workerRuntimeEnv" -}}
{{- if .Values.images.workers }}
- name: WORKER_IMAGES
  value: {{ include "ap.workerImages" . | quote }}
{{- else -}}
{{- $current := .Values.images.worker.runtime -}}
{{- $previous := .Values.images.workerPrevious -}}
{{- if and $previous.digest (not $previous.runtime) -}}
{{- fail "images.workerPrevious.runtime is required with images.workerPrevious.digest: set the runtime images.yml recorded for it" -}}
{{- end -}}
{{- if and $previous.runtime (not $previous.digest) -}}
{{- fail "images.workerPrevious.digest is required with images.workerPrevious.runtime" -}}
{{- end -}}
{{- if and $previous.digest (not $current) -}}
{{- fail "images.workerPrevious needs images.worker.runtime beside it" -}}
{{- end -}}
{{- range $name, $runtime := dict "images.worker.runtime" $current "images.workerPrevious.runtime" $previous.runtime -}}
{{- if $runtime -}}
{{- $_ := include "ap.checkRuntime" (dict "name" $name "runtime" $runtime) -}}
{{- end -}}
{{- end -}}
{{- with $current }}
- name: WORKER_IMAGE_RUNTIME
  value: {{ toJson . | quote }}
{{- end }}
{{- with $previous.runtime }}
- name: WORKER_IMAGE_PREVIOUS_RUNTIME
  value: {{ toJson . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
images.workers as the WORKER_IMAGES JSON, newest first. Order, release times
and how many images of one engine are checked where the list is read: every
reader fails to start, and the upgrade check before it, on a list the
scheduler would refuse.
*/}}
{{- define "ap.workerImages" -}}
{{- $workers := .Values.images.workers -}}
{{- if not (kindIs "slice" $workers) -}}
{{- fail "images.workers must be a list of {repository, digest, runtime, releasedAt, retracted?}" -}}
{{- end -}}
{{- with .Values.images -}}
{{- if or .worker.digest .worker.runtime .workerPrevious.digest .workerPrevious.runtime -}}
{{- fail "images.workers replaces images.worker and images.workerPrevious: leave their digest and runtime empty (a packaged chart fills images.worker; clear it with --set images.worker.digest= --set-json 'images.worker.runtime=null')" -}}
{{- end -}}
{{- end -}}
{{- /* By engine: each engine's images are ordered and counted on their own. */ -}}
{{- $unretracted := dict -}}
{{- $entries := list -}}
{{- $digests := list -}}
{{- $newer := dict -}}
{{- range $index, $entry := $workers -}}
{{- $name := printf "images.workers[%d]" $index -}}
{{- if not (kindIs "map" $entry) -}}
{{- fail (printf "%s must be a map of repository, digest, runtime, releasedAt and retracted" $name) -}}
{{- end -}}
{{- with without (keys $entry) "repository" "digest" "runtime" "releasedAt" "retracted" -}}
{{- fail (printf "%s has unknown field(s): %s" $name (join ", " (sortAlpha .))) -}}
{{- end -}}
{{- if and (hasKey $entry "retracted") (not (kindIs "bool" $entry.retracted)) -}}
{{- fail (printf "%s.retracted must be true or false" $name) -}}
{{- end -}}
{{- $retracted := eq $entry.retracted true -}}
{{- if not (and (kindIs "map" $entry.runtime) $entry.runtime) -}}
{{- fail (printf "%s.runtime is required: set the runtime images.yml recorded for it" $name) -}}
{{- end -}}
{{- $_ := include "ap.checkRuntime" (dict "name" (printf "%s.runtime" $name) "runtime" $entry.runtime) -}}
{{- $engine := $entry.runtime.engine -}}
{{- if not $retracted -}}
{{- $_ := set $unretracted $engine (add1 (get $unretracted $engine | default 0)) -}}
{{- end -}}
{{- if not (and (kindIs "string" $entry.releasedAt) $entry.releasedAt) -}}
{{- fail (printf "%s.releasedAt must be the image's release time as a string, e.g. \"2026-11-10T00:00:00Z\"" $name) -}}
{{- end -}}
{{- /* RFC 3339 with seconds, a subset of what the readers accept: they compare in milliseconds (Date.parse) and read years below 100 as 19xx. */ -}}
{{- $at := toDate "2006-01-02T15:04:05Z07:00" $entry.releasedAt -}}
{{- if or (not (regexMatch `^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$` $entry.releasedAt)) $at.IsZero -}}
{{- fail (printf "%s.releasedAt %q is not an RFC 3339 time, e.g. \"2026-11-10T00:00:00Z\"" $name $entry.releasedAt) -}}
{{- end -}}
{{- if and (hasKey $newer $engine) (not ($at.Before (get $newer $engine))) -}}
{{- fail (printf "%s.releasedAt %s is not before the %s image above it: list each engine's newest image first" $name $entry.releasedAt $engine) -}}
{{- end -}}
{{- $_ := set $newer $engine $at -}}
{{- $image := include "ap.imageRef" (dict "root" $ "label" $name "image" $entry) -}}
{{- /* The distribution reference grammar the readers hold every image to. */ -}}
{{- if not (regexMatch `^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::\d+)?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[0-9a-f]{64}$` $image) -}}
{{- fail (printf "%s.repository: %q is not an image reference the scheduler accepts" $name $image) -}}
{{- end -}}
{{- if has $entry.digest $digests -}}
{{- fail (printf "%s.digest %s is listed twice" $name $entry.digest) -}}
{{- end -}}
{{- $digests = append $digests $entry.digest -}}
{{- $rendered := dict "image" $image "runtime" $entry.runtime "released_at" $entry.releasedAt -}}
{{- if $retracted -}}
{{- $_ := set $rendered "retracted" true -}}
{{- end -}}
{{- $entries = append $entries $rendered -}}
{{- end -}}
{{- /* WORKER_IMAGES_PER_ENGINE, as workerImageListFromEnv: a retracted image stays listed beside its fix. */ -}}
{{- range $engine, $count := $unretracted -}}
{{- if gt $count 2 -}}
{{- fail (printf "images.workers lists %d unretracted %s images: at most 2 per engine, the newest and the release before it" $count $engine) -}}
{{- end -}}
{{- end -}}
{{- toJson $entries -}}
{{- end -}}

{{/* The same rules as parseImageRuntime, which every reader starts with. */}}
{{- define "ap.checkRuntime" -}}
{{- $name := .name -}}
{{- $runtime := .runtime -}}
{{- with without (keys $runtime) "engine" "sdkVersion" "cliVersion" "profileDigestScheme" "profiles" "restorableSchemes" -}}
{{- fail (printf "%s has unknown field(s): %s" $name (join ", " (sortAlpha .))) -}}
{{- end -}}
{{- range $key := list "engine" "sdkVersion" "cliVersion" -}}
{{- $value := index $runtime $key -}}
{{- if not (and (kindIs "string" $value) $value) -}}
{{- fail (printf "%s.%s must be a non-empty string: set the runtime images.yml recorded" $name $key) -}}
{{- end -}}
{{- end -}}
{{- /* The engines with a checkpoint codec (the codecs package registers each). */ -}}
{{- $engines := list "claude" "codex" -}}
{{- if not (has (index $runtime "engine") $engines) -}}
{{- fail (printf "%s.engine must be one of: %s" $name (join ", " $engines)) -}}
{{- end -}}
{{- if hasKey $runtime "profileDigestScheme" -}}
{{- $scheme := index $runtime "profileDigestScheme" -}}
{{- if not (and (or (kindIs "float64" $scheme) (kindIs "int64" $scheme) (kindIs "int" $scheme)) (eq (float64 $scheme) (floor $scheme)) (ge (float64 $scheme) 1.0)) -}}
{{- fail (printf "%s.profileDigestScheme must be a positive integer" $name) -}}
{{- end -}}
{{- end -}}
{{- if hasKey $runtime "restorableSchemes" -}}
{{- $own := 1.0 -}}
{{- if hasKey $runtime "profileDigestScheme" -}}{{- $own = float64 (index $runtime "profileDigestScheme") -}}{{- end -}}
{{- $schemes := index $runtime "restorableSchemes" -}}
{{- $valid := kindIs "slice" $schemes -}}
{{- $hasOwn := false -}}
{{- if $valid -}}
{{- range $scheme := $schemes -}}
{{- if not (and (or (kindIs "float64" $scheme) (kindIs "int64" $scheme) (kindIs "int" $scheme)) (eq (float64 $scheme) (floor $scheme)) (ge (float64 $scheme) 1.0)) -}}
{{- $valid = false -}}
{{- else if eq (float64 $scheme) $own -}}
{{- $hasOwn = true -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (and $valid $hasOwn) -}}
{{- fail (printf "%s.restorableSchemes must be positive integers that include profileDigestScheme" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The images the scheduler launches, and the upgrade check judges: the list
rides in ap.workerRuntimeEnv, so only single-image settings render here.
*/}}
{{- define "ap.workerImageEnv" -}}
{{- if not .Values.images.workers }}
- name: WORKER_IMAGE
  value: {{ include "ap.image" (dict "root" . "name" "worker") | quote }}
{{- if .Values.images.workerPrevious.digest }}
- name: WORKER_IMAGE_PREVIOUS
  value: {{ include "ap.image" (dict "root" . "name" "workerPrevious") | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "ap.apiHost" -}}{{ include "ap.fullname" . }}-api{{- end -}}
{{- define "ap.proxyHost" -}}{{ include "ap.fullname" . }}-egress-proxy{{- end -}}
