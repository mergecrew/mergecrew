'use client';

import { type AdapterFormProps, Field, Select } from './shared';

type Mode = 'lambda' | 'ecs' | 'cf-s3';

interface AwsDirectBase {
  mode?: Mode;
  region?: string;
  publicUrl?: string;
}

interface AwsLambda extends AwsDirectBase {
  mode: 'lambda';
  functionName?: string;
  s3Bucket?: string;
  s3KeyTemplate?: string;
  alias?: string;
}

interface AwsEcs extends AwsDirectBase {
  mode: 'ecs';
  cluster?: string;
  service?: string;
  containerName?: string;
  imageTemplate?: string;
}

interface AwsCfS3 extends AwsDirectBase {
  mode: 'cf-s3';
  distributionId?: string;
  invalidationPaths?: string[];
}

type AwsConfig = AwsLambda | AwsEcs | AwsCfS3 | AwsDirectBase;

export function AwsDirectForm({ config, onChange }: AdapterFormProps) {
  const c = config as AwsConfig;
  const mode: Mode = (c.mode as Mode) ?? 'lambda';
  const update = (patch: Record<string, unknown>) => onChange({ ...(c as object), ...patch });

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select
        label="Sub-mode"
        value={mode}
        options={[
          { value: 'lambda', label: 'lambda (UpdateFunctionCode + alias)' },
          { value: 'ecs', label: 'ecs (rolling update via UpdateService)' },
          { value: 'cf-s3', label: 'cf-s3 (CloudFront invalidation)' },
        ]}
        onChange={(v) => {
          // Reset mode-specific fields when switching sub-modes so the
          // saved blob always matches the discriminated union.
          if (v === 'lambda') onChange({ mode: v, region: c.region, publicUrl: c.publicUrl });
          else if (v === 'ecs') onChange({ mode: v, region: c.region, publicUrl: c.publicUrl });
          else onChange({ mode: v, region: c.region, publicUrl: c.publicUrl });
        }}
      />
      <Field
        label="Region"
        value={c.region ?? ''}
        onChange={(v) => update({ region: v })}
        placeholder="us-east-1"
      />
      <Field
        label="Public URL (optional)"
        value={c.publicUrl ?? ''}
        onChange={(v) => update({ publicUrl: v })}
        placeholder="https://api-dev.acme.dev"
      />

      {mode === 'lambda' && (
        <>
          <Field
            label="Function name"
            value={(c as AwsLambda).functionName ?? ''}
            onChange={(v) => update({ functionName: v })}
            placeholder="acme-api-dev"
          />
          <Field
            label="S3 bucket"
            value={(c as AwsLambda).s3Bucket ?? ''}
            onChange={(v) => update({ s3Bucket: v })}
            placeholder="acme-deploys"
          />
          <Field
            label="S3 key template"
            value={(c as AwsLambda).s3KeyTemplate ?? ''}
            onChange={(v) => update({ s3KeyTemplate: v })}
            placeholder="api/${ref}.zip"
            hint="${ref} → opts.ref at trigger time."
          />
          <Field
            label="Alias (optional)"
            value={(c as AwsLambda).alias ?? ''}
            onChange={(v) => update({ alias: v })}
            placeholder="live"
          />
        </>
      )}

      {mode === 'ecs' && (
        <>
          <Field
            label="Cluster"
            value={(c as AwsEcs).cluster ?? ''}
            onChange={(v) => update({ cluster: v })}
            placeholder="acme-prod"
          />
          <Field
            label="Service"
            value={(c as AwsEcs).service ?? ''}
            onChange={(v) => update({ service: v })}
            placeholder="acme-api-dev"
          />
          <Field
            label="Container name"
            value={(c as AwsEcs).containerName ?? ''}
            onChange={(v) => update({ containerName: v })}
            placeholder="api"
          />
          <Field
            label="Image template"
            value={(c as AwsEcs).imageTemplate ?? ''}
            onChange={(v) => update({ imageTemplate: v })}
            placeholder="1234.dkr.ecr.us-east-1.amazonaws.com/acme-api:${ref}"
          />
        </>
      )}

      {mode === 'cf-s3' && (
        <>
          <Field
            label="Distribution ID"
            value={(c as AwsCfS3).distributionId ?? ''}
            onChange={(v) => update({ distributionId: v })}
            placeholder="EXXXXXXXXXXXXX"
          />
          <Field
            label="Invalidation paths (comma-separated)"
            value={((c as AwsCfS3).invalidationPaths ?? ['/*']).join(',')}
            onChange={(v) => update({ invalidationPaths: v.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder="/*"
          />
        </>
      )}
    </div>
  );
}

export function awsDirectDefaultConfig(): Record<string, unknown> {
  return { mode: 'lambda', region: 'us-east-1' };
}
