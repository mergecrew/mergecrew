import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { RunnerProfileService } from './runner-profile.service.js';

const ALL_KINDS = [
  'none',
  'instance_builtin',
  'agent',
  'fargate_byo',
  'github_actions',
] as const;
type ProfileKind = (typeof ALL_KINDS)[number];

class UpdateProfileDto {
  @IsString()
  @IsIn(ALL_KINDS as unknown as string[])
  kind!: ProfileKind;

  // fargate_byo fields (validated server-side too — issue #769 lands
  // the real wiring; for #767 we just accept + persist).
  @IsOptional()
  @IsString()
  @MaxLength(200)
  awsRoleArn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  awsRegion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fargateCluster?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fargateTaskDefinition?: string;

  @IsOptional()
  fargateSubnets?: string[];

  @IsOptional()
  fargateSecurityGroups?: string[];

  // github_actions fields (#772).
  @IsOptional()
  @IsString()
  @MaxLength(120)
  githubRepoFullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  githubWorkflowFileName?: string;

  /**
   * GitHub PAT (classic or fine-grained) with `repo` + `workflow`
   * scope. Posted in plaintext on PATCH; the server immediately
   * envelope-encrypts and persists the ciphertext (ADR-0007). Only
   * the sha256 is computable from the stored blob — same posture
   * as project secrets / slack webhooks.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  githubPat?: string;
}

/**
 * Per-org runner profile endpoints (V2.af / ADR-0002).
 *
 *   GET  — read-only view of profile + enrolled agents.
 *   PATCH — change the profile kind + per-kind config. Admin-only;
 *           server enforces the trusted-org gate for `instance_builtin`
 *           (ADR-0006) regardless of UI state.
 */
@Controller('v1')
export class RunnerProfileController {
  constructor(private readonly runnerProfile: RunnerProfileService) {}

  @Get('orgs/:slug/runner-profile')
  @UseGuards(RoleGuard)
  async get(@Param('slug') _slug: string) {
    return this.runnerProfile.get();
  }

  @Patch('orgs/:slug/runner-profile')
  @UseGuards(RoleGuard)
  @RequireRole('admin')
  async update(@Param('slug') _slug: string, @Body() body: UpdateProfileDto) {
    return this.runnerProfile.update(body);
  }
}
