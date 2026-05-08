export interface CommsProvider {
  postSlack(channel: string, text: string, blocks?: any[]): Promise<void>;
  sendOrgOwnerEmail(organizationId: string, subject: string, html: string): Promise<void>;
  sendEmail(to: string[], subject: string, html: string): Promise<void>;
}
