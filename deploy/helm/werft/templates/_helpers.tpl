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

{{/*
The Codex sandbox's seccomp profile under the kubelet's seccomp directory.
Fixed, as the scheduler's CODEX_SECCOMP_PROFILE is: a value that would move
it is refused rather than ignored.
*/}}
{{- define "ap.codexSeccompProfile" -}}
{{- if hasKey .Values.codexSandbox "localhostProfile" -}}
{{- fail "codexSandbox.localhostProfile is not a setting: the profile is always werft/codex-sandbox.json under the kubelet's seccomp directory (codexSandbox.installer.kubeletDir moves that directory)" -}}
{{- end -}}
{{- if hasKey .Values.codexSandbox.installer "enabled" -}}
{{- fail "codexSandbox.installer.enabled is removed: the Codex sandbox has codexSandbox.provider instead. installer.enabled=true is provider=installer, installer.enabled=false is provider=external (a cluster administrator puts the profile on the nodes and labels them); the default is disabled, which renders no cluster-scoped object" -}}
{{- end -}}
{{- if not (has .Values.codexSandbox.provider (list "disabled" "installer" "external")) -}}
{{- fail (printf "codexSandbox.provider must be disabled, installer or external (got %v)" .Values.codexSandbox.provider) -}}
{{- end -}}
werft/codex-sandbox.json
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

{{/* The checkpoint object store settings the api and its two object store jobs share. */}}
{{- define "ap.checkpointEnv" -}}
- name: AWS_REGION
  value: {{ .Values.config.aws.region | quote }}
- name: S3_BUCKET
  value: {{ .Values.config.checkpoints.bucket | quote }}
- name: CHECKPOINT_OBJECT_STORE
  value: {{ .Values.config.checkpoints.objectStore | quote }}
- name: CHECKPOINT_OBJECT_PROTECTION
  value: {{ .Values.config.checkpoints.protection | quote }}
- name: CHECKPOINT_OBJECT_ENCRYPTION_CHECK
  value: {{ .Values.config.checkpoints.encryptionCheck | quote }}
- name: CHECKPOINT_OBJECTS_LOST
  value: {{ .Values.config.checkpoints.objectsLost | quote }}
- name: INSTALLATION_PROFILE
  value: {{ .Values.config.installation.profile | quote }}
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
PENDING_REQUEST_TTL_SEC QUEUED_INPUT_LIMIT_PER_SESSION STORAGE_LIMIT_BYTES SESSION_COST_LIMIT_USD SESSION_TOKEN_LIMIT WORKSPACE_ENFORCE MAX_TURN_SECONDS PROVIDER_MAX_RETRIES SESSION_ARCHIVE_AFTER_DAYS SESSION_ARCHIVE_DRY_RUN EXECUTION_WORKSPACE_STOPPED_TTL_SEC EXECUTION_WORKSPACE_PAUSED_TTL_SEC
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
The carried settings where earlier releases took them from, in the order
the reading role's env let win: for the worker limits and the workspace
TTLs the scheduler's (scheduler.extraEnv, then config.limits), for the rest
the api's (api.extraEnv, then config.limits, then api.workspaceEnforce), and
for the archive settings sessionArchive.afterDays and dryRun alone, which
were all its CronJob read. Not merge: it takes a 0 for unset and lets a
later source win. An empty TTL stopped the scheduler before; migrate reads
"" as unset, so it goes as a blank it refuses.
*/}}
{{- define "ap.carriedSettingsEnv" -}}
{{- $apiSources := list (.Values.api.extraEnv | default dict) (.Values.config.limits | default dict) -}}
{{- with .Values.api.workspaceEnforce }}
{{- $apiSources = append $apiSources (dict "WORKSPACE_ENFORCE" .) -}}
{{- end }}
{{- $schedulerSources := list (.Values.scheduler.extraEnv | default dict) (.Values.config.limits | default dict) -}}
{{- $archive := dict -}}
{{- $archiveValues := .Values.sessionArchive | default dict -}}
{{- if hasKey $archiveValues "afterDays" }}
{{- $_ := set $archive "SESSION_ARCHIVE_AFTER_DAYS" $archiveValues.afterDays -}}
{{- end }}
{{- if hasKey $archiveValues "dryRun" }}
{{- $_ := set $archive "SESSION_ARCHIVE_DRY_RUN" $archiveValues.dryRun -}}
{{- end }}
{{- range $name := splitList " " (include "ap.carriedSettingNames" .) }}
{{- $sources := $apiSources }}
{{- $ttl := hasPrefix "EXECUTION_WORKSPACE_" $name }}
{{- if or $ttl (has $name (list "MAX_TURN_SECONDS" "PROVIDER_MAX_RETRIES")) }}
{{- $sources = $schedulerSources }}
{{- else if hasPrefix "SESSION_ARCHIVE_" $name }}
{{- $sources = list $archive }}
{{- end }}
{{- $found := false }}
{{- range $source := $sources }}
{{- if and (not $found) (hasKey $source $name) }}
{{- $found = true }}
{{- $value := index $source $name | toString }}
{{- if and $ttl (eq $value "") }}
{{- $value = " " }}
{{- end }}
- name: {{ $name | quote }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Fails when a values-named variable is PREVIEW_NAMESPACE: preview.enabled is
the only way to declare a preview install (demo-accounts.ts).
*/}}
{{- define "ap.previewEnvReserved" -}}
{{- $names := keys .Values.config.limits -}}
{{- range $key := list "api" "scheduler" "reconciler" "slack" "egressProxy" -}}
{{- $names = concat $names (keys (index $.Values $key).extraEnv) -}}
{{- end -}}
{{- if has "PREVIEW_NAMESPACE" $names -}}
{{- fail "PREVIEW_NAMESPACE must not be set through extraEnv or config.limits; preview.enabled is the only way to declare a preview install" -}}
{{- end -}}
{{- end -}}

{{/*
Fails when a values-named variable is one of the worker image variables:
the upgrade check reads them from images.* and would otherwise judge other
images than the scheduler launches.
*/}}
{{- define "ap.workerEnvReserved" -}}
{{- $names := keys .Values.config.limits -}}
{{- range $key := list "api" "scheduler" "reconciler" "slack" "egressProxy" -}}
{{- $names = concat $names (keys (index $.Values $key).extraEnv) -}}
{{- end -}}
{{- range $name := list "WORKER_IMAGE" "WORKER_IMAGES" "WORKER_IMAGE_PREVIOUS" "WORKER_IMAGE_RUNTIME" "WORKER_IMAGE_PREVIOUS_RUNTIME" -}}
{{- if has $name $names -}}
{{- fail (printf "%s must not be set through extraEnv or config.limits; set images.workers, or images.worker and images.workerPrevious" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Fails when a values-named variable is one the object store reads. The api, its
checkpoint-gc and session-archive jobs and the scheduler must read one store,
mode and signer, and only ap.checkpointEnv reaches all of them; an extraEnv
reaches one role. Every AWS_ name counts: with no endpoint or keys set, the
SDK reads its own (AWS_ENDPOINT_URL_S3, AWS_ROLE_ARN, AWS_PROFILE, ...).
*/}}
{{- define "ap.checkpointEnvReserved" -}}
{{- $names := keys .Values.config.limits -}}
{{- range $key := list "api" "scheduler" "reconciler" "slack" "egressProxy" "metrics" -}}
{{- $names = concat $names (keys (index $.Values $key).extraEnv) -}}
{{- end -}}
{{- $keys := dict
  "S3_BUCKET" "config.checkpoints.bucket"
  "AWS_REGION" "config.aws.region"
  "AWS_ENDPOINT_URL" "config.aws.endpointUrl"
  "AWS_ACCESS_KEY_ID" "secrets.objectStoreKeys and the Secret's AWS_ACCESS_KEY_ID"
  "AWS_SECRET_ACCESS_KEY" "secrets.objectStoreKeys and the Secret's AWS_SECRET_ACCESS_KEY"
  "CHECKPOINT_OBJECT_STORE" "config.checkpoints.objectStore"
  "CHECKPOINT_OBJECT_PROTECTION" "config.checkpoints.protection"
  "CHECKPOINT_OBJECT_ENCRYPTION_CHECK" "config.checkpoints.encryptionCheck"
  "CHECKPOINT_OBJECTS_LOST" "config.checkpoints.objectsLost"
  "INSTALLATION_PROFILE" "config.installation.profile"
-}}
{{- range $name := sortAlpha $names -}}
{{- if hasKey $keys $name -}}
{{- fail (printf "%s must not be set through extraEnv or config.limits; set %s" $name (get $keys $name)) -}}
{{- else if or (hasPrefix "AWS_" $name) (hasPrefix "CHECKPOINT_OBJECT_" $name) -}}
{{- fail (printf "%s must not be set through extraEnv or config.limits; the api, its object store jobs and the scheduler share one AWS environment, set only from config.aws, config.checkpoints and secrets.objectStoreKeys" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Fails on the values that handed the api model and MCP keys by environment or
Secrets Manager, or a bootstrap token: the api reads them nowhere now, and a
silent render would leave a connection without its key, or an operator
waiting on a token that no longer opens anything.
*/}}
{{- define "ap.removedCredentialValues" -}}
{{- if hasKey .Values.secrets "catalogEnv" -}}
{{- fail "secrets.catalogEnv is removed: credentials are entered in the console and kept in the database; enter each key there, then delete secrets.catalogEnv" -}}
{{- end -}}
{{- if hasKey .Values.secrets "bootstrapToken" -}}
{{- fail "secrets.bootstrapToken is removed: the first owner comes from a one-time link the admin bootstrap-owner command writes to a file in the api pod (bun run apps/control-host/src/main.ts admin bootstrap-owner --email <address> --out <file>); delete secrets.bootstrapToken, and BOOTSTRAP_TOKEN from the Secret" -}}
{{- end -}}
{{- if hasKey .Values.config.aws "secretsManagerEndpointUrl" -}}
{{- fail "config.aws.secretsManagerEndpointUrl is removed: the api reads no credential from Secrets Manager; delete it" -}}
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
{{- fail "images.workers replaces images.worker and images.workerPrevious: leave their digest and runtime empty, or set images.workers: [] to deploy images.worker alone (a packaged chart lists its images in images.workers)" -}}
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

{{/*
The image the conversation runtime runs: the newest Claude worker image that
is not retracted. Its turns need an engine that can be started with every
built-in tool denied, which the Codex runtime does not offer.
*/}}
{{- define "ap.conversationRuntimeImage" -}}
{{- if .Values.images.workers -}}
{{- $image := "" -}}
{{- range $index, $entry := .Values.images.workers -}}
{{- if and (not $image) (kindIs "map" $entry) (kindIs "map" $entry.runtime) (eq $entry.runtime.engine "claude") (not (eq $entry.retracted true)) -}}
{{- $image = include "ap.imageRef" (dict "root" $ "label" (printf "images.workers[%d]" $index) "image" $entry) -}}
{{- end -}}
{{- end -}}
{{- if not $image -}}
{{- fail "conversationRuntime.enabled needs a Claude worker image: images.workers lists none that is not retracted" -}}
{{- end -}}
{{- $image -}}
{{- else -}}
{{- $runtime := .Values.images.worker.runtime -}}
{{- if and $runtime (ne (toString $runtime.engine) "claude") -}}
{{- fail "conversationRuntime.enabled needs a Claude worker image: images.worker.runtime.engine is not claude" -}}
{{- end -}}
{{- include "ap.image" (dict "root" . "name" "worker") -}}
{{- end -}}
{{- end -}}

{{- define "ap.apiHost" -}}{{ include "ap.fullname" . }}-api{{- end -}}
{{- /* The api's /internal listener, on a ClusterIP Service of its own. */}}
{{- define "ap.apiInternalHost" -}}{{ include "ap.apiHost" . }}-internal{{- end -}}
{{- define "ap.workerGatewayUrl" -}}http://{{ include "ap.apiInternalHost" . }}:3200{{- end -}}
{{- define "ap.privateAllowlist" -}}{{ .Values.config.egress.privateAllowlist | default (printf "%s:3200" (include "ap.apiInternalHost" .)) }}{{- end -}}
{{- define "ap.proxyHost" -}}{{ include "ap.fullname" . }}-egress-proxy{{- end -}}
