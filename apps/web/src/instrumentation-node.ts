import { productionSecretsError } from './lib/secrets';

const err = productionSecretsError();
if (err) {
  console.error(err);
  process.exit(1);
}
