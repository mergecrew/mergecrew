import { DocumentBuilder } from '@nestjs/swagger';

export function buildOpenApiDocumentConfig() {
  return new DocumentBuilder()
    .setTitle('Mergecrew API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
}
