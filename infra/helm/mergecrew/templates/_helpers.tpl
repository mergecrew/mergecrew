{{/*
  Helpers for the mergecrew chart. Keep names short — they show up in
  manifest annotations and kubectl outputs.
*/}}

{{- define "mergecrew.fullname" -}}
{{- printf "%s" .Release.Name -}}
{{- end -}}

{{- define "mergecrew.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "mergecrew.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
  Common env block: pulls all sensitive vars from the existingSecret
  and all non-sensitive vars from the chart's env map. Use with:
    {{- include "mergecrew.env" . | nindent 8 }}
*/}}
{{- define "mergecrew.env" -}}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- $secret := .Values.secrets.existingSecret -}}
{{- range $k := list "DATABASE_URL" "DATABASE_MIGRATE_URL" "REDIS_URL" "KMS_MASTER_KEY" "JWT_SECRET" "NEXTAUTH_SECRET" "BFF_TRUST_TOKEN" "ANTHROPIC_API_KEY" "OPENAI_API_KEY" "GITHUB_APP_PRIVATE_KEY" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" "TRANSCRIPT_S3_BUCKET" "S3_ENDPOINT_URL" }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $k }}
      optional: true
{{- end }}
{{- end -}}
