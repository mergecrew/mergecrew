'use client';

import { type ReactElement } from 'react';
import { GitHubActionsForm, githubActionsDefaultConfig } from './github-actions';
import { VercelForm, vercelDefaultConfig } from './vercel';
import { NetlifyForm, netlifyDefaultConfig } from './netlify';
import { RenderForm, renderDefaultConfig } from './render';
import { FlyForm, flyDefaultConfig } from './fly';
import { RailwayForm, railwayDefaultConfig } from './railway';
import { AwsDirectForm, awsDirectDefaultConfig } from './aws-direct';
import type { AdapterFormProps } from './shared';

export type AdapterId =
  | 'github-actions'
  | 'vercel'
  | 'netlify'
  | 'render'
  | 'fly'
  | 'railway'
  | 'aws-direct';

export const ADAPTERS: Array<{ id: AdapterId; label: string }> = [
  { id: 'github-actions', label: 'GitHub Actions' },
  { id: 'vercel', label: 'Vercel' },
  { id: 'netlify', label: 'Netlify' },
  { id: 'render', label: 'Render' },
  { id: 'fly', label: 'Fly.io' },
  { id: 'railway', label: 'Railway' },
  { id: 'aws-direct', label: 'AWS (direct SDK)' },
];

const FORMS: Record<AdapterId, (props: AdapterFormProps) => ReactElement> = {
  'github-actions': GitHubActionsForm,
  vercel: VercelForm,
  netlify: NetlifyForm,
  render: RenderForm,
  fly: FlyForm,
  railway: RailwayForm,
  'aws-direct': AwsDirectForm,
};

const DEFAULTS: Record<AdapterId, () => Record<string, unknown>> = {
  'github-actions': githubActionsDefaultConfig,
  vercel: vercelDefaultConfig,
  netlify: netlifyDefaultConfig,
  render: renderDefaultConfig,
  fly: flyDefaultConfig,
  railway: railwayDefaultConfig,
  'aws-direct': awsDirectDefaultConfig,
};

export function DeployTargetFormFor({
  adapterId,
  ...rest
}: AdapterFormProps & { adapterId: AdapterId }) {
  const Form = FORMS[adapterId];
  return <Form {...rest} />;
}

export function defaultConfigFor(adapterId: AdapterId): Record<string, unknown> {
  return DEFAULTS[adapterId]();
}
