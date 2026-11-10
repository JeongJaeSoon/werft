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
{{- $image := index .root.Values.images .name -}}
{{- $repository := required (printf "images.%s.repository is required" .name) $image.repository -}}
{{- if regexMatch "@|:[^/]+$" $repository -}}
{{- fail (printf "images.%s.repository must not carry a tag or digest (got %q); set images.%s.digest" .name $repository .name) -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" (toString $image.digest)) -}}
{{- fail (printf "images.%s.digest must be sha256:<64 hex> (got %q): every image is pinned by digest" .name (toString $image.digest)) -}}
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
{{- range $name := list "WORKER_IMAGE" "WORKER_IMAGE_PREVIOUS" "WORKER_IMAGE_RUNTIME" "WORKER_IMAGE_PREVIOUS_RUNTIME" -}}
{{- if has $name $names -}}
{{- fail (printf "%s must not be set through extraEnv, config.limits or secrets.catalogEnv; set images.worker and images.workerPrevious" $name) -}}
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
The worker images' runtime combinations. The api and slack judge profile
pins against them and the scheduler picks each session's image by them, so
all three render this one definition and cannot disagree.
*/}}
{{- define "ap.workerRuntimeEnv" -}}
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
{{- /* The same rules as parseImageRuntime, which every reader starts with. */ -}}
{{- if $runtime -}}
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
{{- end -}}
{{- with $current }}
- name: WORKER_IMAGE_RUNTIME
  value: {{ toJson . | quote }}
{{- end }}
{{- with $previous.runtime }}
- name: WORKER_IMAGE_PREVIOUS_RUNTIME
  value: {{ toJson . | quote }}
{{- end }}
{{- end -}}

{{/* The previous worker image, for what launches on it: the scheduler. */}}
{{- define "ap.workerPreviousImageEnv" -}}
{{- if .Values.images.workerPrevious.digest }}
- name: WORKER_IMAGE_PREVIOUS
  value: {{ include "ap.image" (dict "root" . "name" "workerPrevious") | quote }}
{{- end }}
{{- end -}}

{{- define "ap.apiHost" -}}{{ include "ap.fullname" . }}-api{{- end -}}
{{- define "ap.proxyHost" -}}{{ include "ap.fullname" . }}-egress-proxy{{- end -}}
