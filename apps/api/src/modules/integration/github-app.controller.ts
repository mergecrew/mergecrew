import { Controller, Get, Query, Redirect } from '@nestjs/common';

/**
 * Minimal GitHub App install entrypoint. The Next.js BFF redirects the user
 * here, we redirect them to the GitHub App install URL, and GitHub redirects
 * back to the BFF (which calls our API to persist the installation).
 */
@Controller('v1/integrations/github')
export class GitHubAppController {
  @Get('install')
  @Redirect()
  install(@Query('state') state?: string) {
    const slug = process.env.GITHUB_APP_SLUG ?? 'mergecrew-app';
    return {
      url: `https://github.com/apps/${slug}/installations/new${state ? `?state=${encodeURIComponent(state)}` : ''}`,
      statusCode: 302,
    };
  }
}
